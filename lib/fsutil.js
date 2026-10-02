// SPDX-License-Identifier: GPL-3.0-or-later
// Small async helpers around Gio so nothing blocks the compositor.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const decoder = new TextDecoder();

export function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/** Read a whole file as text. Returns null if it can't be read (e.g. the process exited). */
export async function readText(path, cancellable = null) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return decoder.decode(bytes);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

/**
 * Read a small kernel-generated file synchronously. Only for /proc and cgroup
 * files that the kernel fills from in-memory counters (/proc/stat, meminfo,
 * loadavg, PID/stat, statm, status, io, single-value cgroup files): they never
 * touch a disk or wait on the target process, so they can't block. Anything
 * that can wait (cmdline, smaps_rollup, memory.stat) uses readText() instead.
 *
 * Measured in GNOME Shell, reading the stat and statm of ~140 processes costs
 * 3 ms of CPU this way and ~28 ms with load_contents_async(), almost all of it
 * thread-pool and promise overhead.
 */
export function readProcSync(path) {
    try {
        return decoder.decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
}

/**
 * Every pid in /proc. Only names are read: a Gio enumeration would wrap each
 * entry in a GFileInfo, which costs ~10x more and leaves garbage behind.
 */
export function listPidsSync() {
    const pids = [];
    let dir;
    try {
        dir = GLib.Dir.open('/proc', 0);
    } catch {
        return pids;
    }
    try {
        let name;
        while ((name = dir.read_name()) !== null) {
            const code = name.charCodeAt(0);
            if (code >= 48 && code <= 57)
                pids.push(Number(name));
        }
    } finally {
        dir.close();
    }
    return pids;
}

/** pid -> owner uid for every process, in one pass (cheaper than procOwnerSync() for each). */
export function listOwnersSync() {
    const owners = new Map();
    let enumerator = null;
    try {
        enumerator = Gio.File.new_for_path('/proc').enumerate_children(
            'standard::name,unix::uid', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            const code = name.charCodeAt(0);
            if (code >= 48 && code <= 57)
                owners.set(Number(name), info.get_attribute_uint32('unix::uid'));
        }
    } catch {
        // A process exiting mid-listing is fine; keep what was read.
    } finally {
        try {
            enumerator?.close(null);
        } catch {}
    }
    return owners;
}

/** Owner of a /proc entry, or -1 if it's gone. Never blocks: /proc entries are in-memory. */
export function procOwnerSync(pid) {
    try {
        return Gio.File.new_for_path(`/proc/${pid}`)
            .query_info('unix::uid', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
            .get_attribute_uint32('unix::uid');
    } catch {
        return -1;
    }
}

/** Targets of every symlink in a procfs directory (e.g. /proc/PID/fd), or null if unreadable. */
export function readProcLinksSync(path) {
    let dir;
    try {
        dir = GLib.Dir.open(path, 0);
    } catch {
        return null;
    }
    const targets = [];
    try {
        let name;
        while ((name = dir.read_name()) !== null) {
            try {
                targets.push(GLib.file_read_link(`${path}/${name}`));
            } catch {
                // The fd was closed while listing.
            }
        }
    } finally {
        dir.close();
    }
    return targets;
}

/** List a directory. Returns an array of Gio.FileInfo, or null if it can't be opened. */
export async function listDir(path, attributes, cancellable = null) {
    let enumerator;
    try {
        enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }

    const infos = [];
    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const batch = await enumerator.next_files_async(256, GLib.PRIORITY_DEFAULT, cancellable);
            if (batch.length === 0)
                break;
            infos.push(...batch);
        }
    } catch (e) {
        if (isCancelled(e))
            throw e;
    } finally {
        try {
            enumerator.close(null);
        } catch {}
    }
    return infos;
}

/** Resolve a symlink (e.g. /proc/PID/exe). Returns null on failure. */
export async function readLink(path, cancellable = null) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, cancellable);
        // Asking a non-symlink for its target logs a GLib CRITICAL.
        return info.has_attribute('standard::symlink-target') ? info.get_symlink_target() : null;
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

export async function exists(path, cancellable = null) {
    try {
        await Gio.File.new_for_path(path).query_info_async(
            'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        return true;
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return false;
    }
}

const NICE = GLib.find_program_in_path('nice');
const IONICE = GLib.find_program_in_path('ionice');

/**
 * Prefix argv so the command runs at the lowest CPU priority (and, with `idleIo`,
 * only uses the disk when nothing else does), if nice/ionice are installed.
 */
export function lowPriority(argv, {idleIo = false} = {}) {
    const prefix = [];
    if (NICE)
        prefix.push(NICE, '-n', '19');
    if (idleIo && IONICE)
        prefix.push(IONICE, '-c', '3');
    return [...prefix, ...argv];
}

/**
 * Run a command and return its stdout. Throws if the command can't be started.
 * Cancelling also kills the child.
 */
export async function run(argv, cancellable = null) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    // Gio.Cancellable.connect() is g_cancellable_connect(), not the GObject signal API.
    const id = cancellable ? cancellable.connect(() => proc.force_exit()) : 0;
    try {
        const [stdout] = await proc.communicate_utf8_async(null, cancellable);
        return stdout ?? '';
    } finally {
        if (id)
            cancellable.disconnect(id);
    }
}

/** Parse "Key:   123 kB" style files (/proc/meminfo, /proc/PID/status). kB values become bytes. */
export function parseKeyValues(text) {
    const out = {};
    if (!text)
        return out;
    for (const line of text.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;
        const key = line.slice(0, colon);
        const rest = line.slice(colon + 1).trim();
        const num = parseFloat(rest);
        if (Number.isNaN(num))
            out[key] = rest;
        else
            out[key] = rest.endsWith('kB') ? num * 1024 : num;
    }
    return out;
}
