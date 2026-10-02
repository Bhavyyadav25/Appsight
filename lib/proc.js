// SPDX-License-Identifier: GPL-3.0-or-later
// Samples system-wide and per-process statistics from /proc.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {listOwnersSync, listPidsSync, parseKeyValues, procOwnerSync, readProcSync, readText} from './fsutil.js';

// USER_HZ is fixed at 100 in the Linux userspace ABI on every mainstream architecture.
export const TICKS_PER_SECOND = 100;

// Process owners are looked up again in full every this many scans.
const OWNER_REFRESH = 10;

function parseCgroup(text) {
    if (!text)
        return '';
    let legacy = '';
    for (const line of text.split('\n')) {
        if (line.startsWith('0::'))
            return line.slice(3);
        if (line.includes(':name=systemd:'))
            legacy = line.slice(line.indexOf(':name=systemd:') + 14);
    }
    return legacy;
}

export class ProcReader {
    constructor() {
        const credentials = new Gio.Credentials();
        this.uid = credentials.get_unix_user();
        this.shellPid = credentials.get_unix_pid();
        this.ncpu = Math.max(1, GLib.get_num_processors());
        this.pageSize = 4096;
        this.bootTime = 0;

        this._meta = new Map(); // pid -> {start, cgroup, args}
        this._owners = new Map(); // pid -> uid
        this._scans = 0;
        this._prevCpu = new Map(); // pid -> {start, ticks}
        this._prevTime = 0;
        this._prevSys = null;
        this._initialized = false;
    }

    async _init(cancellable) {
        // Work out the page size by comparing statm (pages) with status (kB) for ourselves.
        const [statm, status, stat] = await Promise.all([
            readText('/proc/self/statm', cancellable),
            readText('/proc/self/status', cancellable),
            readText('/proc/stat', cancellable),
        ]);
        const pages = Number(statm?.split(' ')[1]);
        const rss = parseKeyValues(status).VmRSS;
        if (pages > 0 && rss > 0) {
            const guess = rss / pages;
            for (const size of [4096, 16384, 65536]) {
                if (Math.abs(guess - size) / size < 0.25)
                    this.pageSize = size;
            }
        }
        const btime = stat?.match(/^btime\s+(\d+)/m);
        this.bootTime = btime ? Number(btime[1]) : 0;
        this._initialized = true;
    }

    /** Forget CPU baselines, e.g. after the menu was closed for a while. */
    resetCpuBaseline() {
        this._prevCpu.clear();
        this._prevTime = 0;
    }

    /**
     * Drop what's cached per process when the menu closes. The cgroup and command
     * line of each process are kept: they're small, keyed by start time so they
     * can't go stale, and re-reading them all on every open costs hundreds of
     * async reads. Entries of processes that exited are dropped at the next scan.
     */
    releaseCaches() {
        this.resetCpuBaseline();
        this._owners.clear();
        this._scans = 0;
    }

    /**
     * System-wide numbers. `full` is false when only the panel text is needed, so
     * just the one or two files it shows are read.
     */
    async sampleSystem(cancellable = null, {cpu: wantCpu = true, mem: wantMem = true, full = true} = {}) {
        if (!this._initialized)
            await this._init(cancellable);

        // These are tiny counter files; a sync read is far cheaper than an async one.
        const stat = full || wantCpu ? readProcSync('/proc/stat') : null;
        const meminfo = full || wantMem ? readProcSync('/proc/meminfo') : null;
        const loadavg = full ? readProcSync('/proc/loadavg') : null;

        let cpu = null;
        if (stat) {
            const fields = stat.slice(0, stat.indexOf('\n')).trim().split(/\s+/).slice(1).map(Number);
            const idle = fields[3] + (fields[4] || 0);
            const total = fields.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
            if (this._prevSys && total > this._prevSys.total)
                cpu = Math.max(0, Math.min(100, (1 - (idle - this._prevSys.idle) / (total - this._prevSys.total)) * 100));
            this._prevSys = {total, idle};
        }

        const mem = parseKeyValues(meminfo);
        const load = (loadavg ?? '').split(' ');
        const [running, total] = (load[3] ?? '0/0').split('/').map(Number);

        return {
            cpu,
            ncpu: this.ncpu,
            memTotal: mem.MemTotal ?? 0,
            memAvailable: mem.MemAvailable ?? 0,
            memUsed: (mem.MemTotal ?? 0) - (mem.MemAvailable ?? 0),
            memCached: (mem.Cached ?? 0) + (mem.Buffers ?? 0),
            swapTotal: mem.SwapTotal ?? 0,
            swapUsed: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0),
            load: [Number(load[0]) || 0, Number(load[1]) || 0, Number(load[2]) || 0],
            tasksRunning: running || 0,
            tasksTotal: total || 0,
        };
    }

    /**
     * Read the cheap per-process numbers (stat + statm) for every visible process.
     * CPU is a percentage of the whole machine (all cores), like GNOME System Monitor.
     */
    async sampleProcesses(includeOtherUsers, cancellable = null) {
        if (!this._initialized)
            await this._init(cancellable);

        // stat/statm/the /proc listing are read synchronously (see readProcSync);
        // only cmdline and cgroup of newly seen processes are read async.
        const procs = [];
        const needMeta = [];
        // Owners rarely change (exec of a setuid program, a daemon dropping root),
        // so they're cached: every few scans all are listed with their owners,
        // in between only the pids are listed and new ones looked up.
        const refresh = this._scans++ % OWNER_REFRESH === 0;
        const known = refresh ? listOwnersSync() : this._owners;
        const owners = new Map();
        for (const pid of refresh ? known.keys() : listPidsSync()) {
            let uid = known.get(pid);
            if (uid === undefined)
                uid = procOwnerSync(pid);
            if (uid < 0)
                continue;
            owners.set(pid, uid);
            if (!includeOtherUsers && uid !== this.uid)
                continue;
            const p = this._readProcess(pid, uid);
            if (!p)
                continue;
            procs.push(p);
            const meta = this._meta.get(p.pid);
            if (meta?.start === p.start) {
                p.cgroup = meta.cgroup;
                p.args = meta.args;
            } else {
                needMeta.push(p);
            }
        }
        this._owners = owners;
        await Promise.all(needMeta.map(p => this._readMeta(p, cancellable)));

        const now = GLib.get_monotonic_time() / 1e6;
        const dt = this._prevTime ? now - this._prevTime : 0;
        const nextCpu = new Map();
        for (const p of procs) {
            const prev = this._prevCpu.get(p.pid);
            p.cpu = prev && prev.start === p.start && dt > 0
                ? Math.max(0, (p.ticks - prev.ticks) / TICKS_PER_SECOND / dt / this.ncpu * 100)
                : null;
            nextCpu.set(p.pid, {start: p.start, ticks: p.ticks});
        }
        this._prevCpu = nextCpu;
        this._prevTime = now;

        for (const pid of this._meta.keys()) {
            if (!nextCpu.has(pid))
                this._meta.delete(pid);
        }
        return procs;
    }

    _readProcess(pid, uid) {
        const base = `/proc/${pid}`;
        const stat = readProcSync(`${base}/stat`);
        if (!stat)
            return null;

        const open = stat.indexOf('(');
        const close = stat.lastIndexOf(')');
        const comm = stat.slice(open + 1, close);
        const f = stat.slice(close + 2).split(' ');
        const ppid = Number(f[1]);
        if (pid === 2 || ppid === 2)
            return null; // kernel threads

        const start = Number(f[19]);
        const statm = readProcSync(`${base}/statm`);
        const m = statm ? statm.trim().split(' ').map(Number) : [];
        const resident = (m[1] || 0) * this.pageSize;
        const shared = (m[2] || 0) * this.pageSize;
        return {
            pid,
            uid,
            ppid,
            comm,
            state: f[0],
            ticks: Number(f[11]) + Number(f[12]),
            nice: Number(f[16]),
            threads: Number(f[17]),
            start,
            startedAt: this.bootTime + start / TICKS_PER_SECOND,
            rss: resident,
            shared,
            priv: Math.max(0, resident - shared),
            cgroup: '',
            args: [],
            cpu: null,
        };
    }

    /**
     * cgroup and command line, read once per process. cmdline is read async
     * because it takes the target's memory-map lock and can stall.
     */
    async _readMeta(p, cancellable) {
        const base = `/proc/${p.pid}`;
        const [cgroup, cmdline] = await Promise.all([
            readText(`${base}/cgroup`, cancellable),
            readText(`${base}/cmdline`, cancellable),
        ]);
        const meta = {
            start: p.start,
            cgroup: parseCgroup(cgroup),
            args: cmdline ? cmdline.split('\0').filter(Boolean) : [],
        };
        this._meta.set(p.pid, meta);
        p.cgroup = meta.cgroup;
        p.args = meta.args;
    }

    /** True if the pid still refers to the same process (guards against pid reuse). */
    async isAlive(pid, start, cancellable = null) {
        const stat = await readText(`/proc/${pid}/stat`, cancellable);
        if (!stat)
            return false;
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return Number(f[19]) === start && f[0] !== 'Z';
    }
}
