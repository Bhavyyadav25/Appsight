// SPDX-License-Identifier: GPL-3.0-or-later
// Deep, more expensive statistics for one app group. Only sampled while the
// details view of that group is open.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {isCancelled, lowPriority, parseKeyValues, readProcLinksSync, readProcSync, readText, run} from './fsutil.js';
import {TICKS_PER_SECOND} from './proc.js';

const STATUS_KEYS = ['VmRSS', 'RssAnon', 'RssFile', 'RssShmem', 'VmSwap',
    'voluntary_ctxt_switches', 'nonvoluntary_ctxt_switches'];
const IO_KEYS = ['rchar', 'wchar', 'read_bytes', 'write_bytes'];

function parsePressure(text) {
    const m = text?.match(/^some avg10=([\d.]+)/m);
    return m ? Number(m[1]) : null;
}

// smaps_rollup makes the kernel walk every memory mapping, which is slow for big
// apps, so PSS is only re-read every few samples.
const PSS_EVERY = 5;

// Reading the target of every open file costs one readlink per fd, often
// hundreds per process, and the counts change slowly, so they're re-read every
// few samples too.
const FD_EVERY = 3;

// Listing sockets walks the kernel's whole TCP hash table (often 500k buckets),
// ~4 ms per /proc/net file and ~25 ms per address family for `ss`, so the
// network is sampled less often than everything else.
const NET_INTERVAL = 3.5; // seconds
const TCP_ESTABLISHED = '01';
const TCP_LISTEN = '0A';
const UDP_UNCONNECTED = '07';
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
// Looked up once: searching PATH touches the disk, which must not happen on
// the main loop every time a details view opens.
const SS_INSTALLED = GLib.find_program_in_path('ss') !== null;
const NET_TABLES = [['tcp', 'tcp', false], ['tcp6', 'tcp', true], ['udp', 'udp', false], ['udp6', 'udp', true]];

/** Decode a /proc/net address such as "0100007F:0035" into {host, port}. */
export function decodeAddress(hex) {
    const [addr, port] = hex.split(':');
    const bytes = new Uint8Array(addr.length / 2);
    // Each 32-bit word is printed in host byte order.
    for (let w = 0; w < bytes.length; w += 4) {
        for (let b = 0; b < 4; b++)
            bytes[w + b] = parseInt(addr.substr((LITTLE_ENDIAN ? w + 3 - b : w + b) * 2, 2), 16);
    }
    const host = bytes.length === 4
        ? bytes.join('.')
        : Gio.InetAddress.new_from_bytes(bytes, Gio.SocketFamily.IPV6).to_string();
    return {host, port: parseInt(port, 16)};
}

/** "[::ffff:1.2.3.4]:443" or "10.0.0.2%wlan0:53" as printed by ss -> "host:port" like decodeAddress gives. */
export function canonicalEndpoint(text) {
    const i = text.lastIndexOf(':');
    let host = text.slice(0, i).replace(/%[^\]]*$/, '').replace(/^\[|\]$/g, '');
    if (host.includes(':'))
        host = Gio.InetAddress.new_from_string(host)?.to_string() ?? host;
    return `${host}:${text.slice(i + 1)}`;
}

/** The app's sockets from /proc/net/{tcp,tcp6,udp,udp6}, matched by inode. */
export function parseNetTables(texts, inodes) {
    const sockets = [];
    NET_TABLES.forEach(([, proto, v6], t) => {
        const lines = (texts[t] ?? '').split('\n');
        for (let k = 1; k < lines.length; k++) {
            const cols = lines[k].trim().split(/\s+/);
            if (cols.length < 10 || !inodes.has(cols[9]))
                continue;
            const local = decodeAddress(cols[1]);
            const peer = decodeAddress(cols[2]);
            sockets.push({proto, v6, state: cols[3], local, peer, key: `${local.host}:${local.port}>${peer.host}:${peer.port}`});
        }
    });
    return sockets;
}

/**
 * Byte counters per connection from `ss -t -n -i`, keyed like parseNetTables.
 * Without -e/-p, ss neither resolves cgroups nor scans every process's fds.
 */
export function parseSsCounters(text) {
    const counters = new Map();
    let current = null;
    for (const line of (text ?? '').split('\n')) {
        if (!line.trim())
            continue;
        if (/^\s/.test(line)) {
            if (current) {
                current.sent = Number(line.match(/\bbytes_sent:(\d+)/)?.[1] ?? 0);
                current.recv = Number(line.match(/\bbytes_received:(\d+)/)?.[1] ?? 0);
            }
            continue;
        }
        const cols = line.trim().split(/\s+/);
        current = {sent: 0, recv: 0};
        if (cols[0] === 'State')
            continue; // header (-H, which hides it, needs iproute2 4.15+)
        if (cols.length >= 5)
            counters.set(`${canonicalEndpoint(cols[3])}>${canonicalEndpoint(cols[4])}`, current);
    }
    return counters;
}

export class DetailSampler {
    constructor() {
        this.reset();
    }

    reset() {
        this._prev = null;
        this._ssAvailable = SS_INSTALLED;
        this._net = null; // {key, time, byKey, net} from the last network sample
        this._pss = new Map(); // pid -> {start, pss}
        this._fds = new Map(); // pid -> {start, fds, socketInodes}
        this._count = 0;
    }

    async sample(group, cancellable = null) {
        const count = this._count++;
        const readPss = count % PSS_EVERY === 0;
        const readFds = count % FD_EVERY === 0;
        const [perPid, cg] = await Promise.all([
            Promise.all(group.procs.map(p => this._readPid(p, readPss, readFds, cancellable))),
            group.dedicatedCgroup ? this._cgroups([...group.cgroups], cancellable) : null,
        ]);
        const live = new Set(group.procs.map(p => p.pid));
        for (const cache of [this._pss, this._fds]) {
            for (const pid of cache.keys()) {
                if (!live.has(pid))
                    cache.delete(pid);
            }
        }
        const socketInodes = new Set();
        for (const d of perPid) {
            for (const inode of d?.socketInodes ?? [])
                socketInodes.add(inode);
        }
        const now = GLib.get_monotonic_time() / 1e6;
        const net = await this._sampleNetwork(group.key, socketInodes, now, cancellable);
        const totals = {
            pss: 0, rss: 0, anon: 0, file: 0, shmem: 0, swap: 0, ctx: 0,
            rchar: 0, wchar: 0, readBytes: 0, writeBytes: 0, ioKnown: false,
            fds: 0, sockets: 0, pipes: 0, files: 0, fdKnown: false,
            pssKnown: false,
        };
        const ioByPid = new Map();
        for (const d of perPid) {
            if (!d)
                continue;
            totals.rss += d.status.VmRSS ?? 0;
            totals.anon += d.status.RssAnon ?? 0;
            totals.file += d.status.RssFile ?? 0;
            totals.shmem += d.status.RssShmem ?? 0;
            totals.swap += d.status.VmSwap ?? 0;
            totals.ctx += (d.status.voluntary_ctxt_switches ?? 0) + (d.status.nonvoluntary_ctxt_switches ?? 0);
            if (d.pss !== null) {
                totals.pss += d.pss;
                totals.pssKnown = true;
            }
            if (d.io) {
                totals.ioKnown = true;
                totals.rchar += d.io.rchar ?? 0;
                totals.wchar += d.io.wchar ?? 0;
                totals.readBytes += d.io.read_bytes ?? 0;
                totals.writeBytes += d.io.write_bytes ?? 0;
                ioByPid.set(d.pid, d.io);
            }
            if (d.fds) {
                totals.fdKnown = true;
                totals.fds += d.fds.total;
                totals.sockets += d.fds.sockets;
                totals.pipes += d.fds.pipes;
                totals.files += d.fds.files;
            }
        }

        const cpuTime = group.procs.reduce((a, p) => a + p.ticks, 0) / TICKS_PER_SECOND;
        const prev = this._prev?.key === group.key ? this._prev : null;
        const dt = prev ? now - prev.time : 0;

        // Disk and context-switch rates are computed per pid so processes that
        // start or exit between samples don't create bogus spikes.
        const rates = {readBytes: null, writeBytes: null, rchar: null, wchar: null, ctx: null,
            down: net?.down ?? null, up: net?.up ?? null};
        if (prev && dt > 0) {
            let rb = 0, wb = 0, rc = 0, wc = 0;
            for (const [pid, io] of ioByPid) {
                const p = prev.ioByPid.get(pid);
                if (!p)
                    continue;
                rb += Math.max(0, (io.read_bytes ?? 0) - (p.read_bytes ?? 0));
                wb += Math.max(0, (io.write_bytes ?? 0) - (p.write_bytes ?? 0));
                rc += Math.max(0, (io.rchar ?? 0) - (p.rchar ?? 0));
                wc += Math.max(0, (io.wchar ?? 0) - (p.wchar ?? 0));
            }
            if (totals.ioKnown) {
                rates.readBytes = rb / dt;
                rates.writeBytes = wb / dt;
                rates.rchar = rc / dt;
                rates.wchar = wc / dt;
            }
            rates.ctx = Math.max(0, totals.ctx - prev.ctx) / dt;
        }

        this._prev = {key: group.key, time: now, ioByPid, ctx: totals.ctx};

        return {totals, rates, net, cgroup: cg, cpuTime};
    }

    async _readPid(proc, readPss, readFds, cancellable) {
        const {pid, start} = proc;
        const base = `/proc/${pid}`;
        const cachedPss = this._pss.get(pid);
        const needPss = readPss || cachedPss?.start !== start;
        const cachedFds = this._fds.get(pid);
        const needFds = readFds || cachedFds?.start !== start;
        // status, io and fd are generated from counters without stalling, so they
        // are read synchronously (far cheaper). smaps_rollup takes the target's
        // memory-map lock, so it stays async.
        const status = readProcSync(`${base}/status`);
        const io = readProcSync(`${base}/io`);
        const fdTargets = needFds ? readProcLinksSync(`${base}/fd`) : null;
        const smaps = needPss ? await readText(`${base}/smaps_rollup`, cancellable) : null;
        if (!status)
            return null;

        const parsed = parseKeyValues(status);
        const statusOut = {};
        for (const k of STATUS_KEYS)
            statusOut[k] = parsed[k];

        let ioOut = null;
        if (io) {
            const kv = parseKeyValues(io);
            ioOut = {};
            for (const k of IO_KEYS)
                ioOut[k] = kv[k];
        }

        let pss = cachedPss?.start === start ? cachedPss.pss : null;
        if (needPss) {
            const pssMatch = smaps?.match(/^Pss:\s+(\d+) kB/m);
            pss = pssMatch ? Number(pssMatch[1]) * 1024 : null;
            this._pss.set(pid, {start, pss});
        }

        let fds = cachedFds?.start === start ? cachedFds.fds : null;
        let socketInodes = cachedFds?.start === start ? cachedFds.socketInodes : [];
        if (needFds) {
            fds = null;
            socketInodes = [];
            if (fdTargets) {
                fds = {total: fdTargets.length, sockets: 0, pipes: 0, files: 0};
                for (const target of fdTargets) {
                    if (target.startsWith('socket:')) {
                        fds.sockets++;
                        socketInodes.push(target.slice(8, -1)); // socket:[12345]
                    } else if (target.startsWith('pipe:'))
                        fds.pipes++;
                    else if (target.startsWith('/'))
                        fds.files++;
                }
            }
            this._fds.set(pid, {start, fds, socketInodes});
        }

        return {pid, status: statusOut, io: ioOut, pss, fds, socketInodes};
    }

    /**
     * The app's sockets and TCP traffic, re-sampled at most every NET_INTERVAL
     * seconds (as soon as possible until the first rates are known). Sockets
     * come from /proc/net; `ss` is only run for the byte counters, only for the
     * address families the app has TCP connections in, and not at all if it has
     * none. UDP traffic (e.g. QUIC) has no counters; it's only counted.
     */
    async _sampleNetwork(key, inodes, now, cancellable) {
        if (!this._ssAvailable)
            return null;
        const last = this._net?.key === key ? this._net : null;
        if (last && last.net.down !== null && now - last.time < NET_INTERVAL)
            return last.net;

        const texts = inodes.size > 0
            ? await Promise.all(NET_TABLES.map(([file]) => readText(`/proc/net/${file}`, cancellable)))
            : [];
        const sockets = parseNetTables(texts, inodes);
        const connected = sockets.filter(s => s.proto === 'tcp' && s.state !== TCP_LISTEN);
        let counters = new Map();
        if (connected.length > 0) {
            const v4 = connected.some(s => !s.v6);
            const v6 = connected.some(s => s.v6);
            const argv = ['ss', '-t', '-n', '-i'];
            if (v4 !== v6)
                argv.push(v4 ? '-4' : '-6');
            try {
                counters = parseSsCounters(await run(lowPriority(argv), cancellable));
            } catch (e) {
                if (isCancelled(e))
                    throw e;
                this._ssAvailable = false;
                return null;
            }
        }

        const byKey = new Map();
        const listening = new Set();
        const hosts = new Map();
        let established = 0, totalSent = 0, totalRecv = 0, udp = 0;
        for (const s of sockets) {
            if (s.proto === 'udp') {
                udp++;
                if (s.state === UDP_UNCONNECTED && s.peer.port === 0)
                    listening.add(`${s.local.port}/udp`);
                continue;
            }
            if (s.state === TCP_LISTEN) {
                listening.add(`${s.local.port}/tcp`);
                continue;
            }
            if (byKey.has(s.key))
                continue;
            const c = counters.get(s.key) ?? {sent: 0, recv: 0};
            byKey.set(s.key, c);
            if (s.state === TCP_ESTABLISHED)
                established++;
            totalSent += c.sent;
            totalRecv += c.recv;
            const host = s.peer.host.replace(/^::ffff:/, '');
            const h = hosts.get(host) ?? {host, connections: 0, bytes: 0};
            h.connections++;
            h.bytes += c.sent + c.recv;
            hosts.set(host, h);
        }

        let down = null, up = null;
        const dt = last ? now - last.time : 0;
        if (dt > 0) {
            down = up = 0;
            for (const [k, c] of byKey) {
                const p = last.byKey.get(k);
                down += Math.max(0, c.recv - (p?.recv ?? 0));
                up += Math.max(0, c.sent - (p?.sent ?? 0));
            }
            down /= dt;
            up /= dt;
        }

        const net = {
            tcp: byKey.size,
            established,
            udp,
            listening: [...listening].sort(),
            totalSent,
            totalRecv,
            topHosts: [...hosts.values()].sort((a, b) => b.bytes - a.bytes || b.connections - a.connections).slice(0, 5),
            down,
            up,
        };
        this._net = {key, time: now, byKey, net};
        return net;
    }

    /** Totals from the app's own cgroup(s): includes page cache and pressure stalls. */
    async _cgroups(paths, cancellable) {
        const per = await Promise.all(paths.map(async path => {
            const base = `/sys/fs/cgroup${path}`;
            // Single counters are read synchronously; memory.stat may first flush
            // per-CPU statistics, so it stays async.
            const current = readProcSync(`${base}/memory.current`);
            if (current === null)
                return null;
            const swap = readProcSync(`${base}/memory.swap.current`);
            const cpuP = readProcSync(`${base}/cpu.pressure`);
            const memP = readProcSync(`${base}/memory.pressure`);
            const ioP = readProcSync(`${base}/io.pressure`);
            const stat = await readText(`${base}/memory.stat`, cancellable);
            const st = {};
            for (const line of (stat ?? '').split('\n')) {
                const [k, v] = line.split(' ');
                if (k)
                    st[k] = Number(v);
            }
            return {
                current: Number(current),
                anon: st.anon ?? 0,
                file: st.file ?? 0,
                kernel: st.kernel ?? 0,
                sock: st.sock ?? 0,
                swap: Number(swap) || 0,
                cpuPressure: parsePressure(cpuP),
                memPressure: parsePressure(memP),
                ioPressure: parsePressure(ioP),
            };
        }));

        const valid = per.filter(Boolean);
        if (valid.length === 0)
            return null;
        const max = k => {
            const vals = valid.map(v => v[k]).filter(v => v !== null);
            return vals.length ? Math.max(...vals) : null;
        };
        const sum = k => valid.reduce((a, v) => a + v[k], 0);
        return {
            current: sum('current'),
            anon: sum('anon'),
            file: sum('file'),
            kernel: sum('kernel'),
            sock: sum('sock'),
            swap: sum('swap'),
            cpuPressure: max('cpuPressure'),
            memPressure: max('memPressure'),
            ioPressure: max('ioPressure'),
        };
    }
}
