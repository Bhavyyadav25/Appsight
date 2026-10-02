// SPDX-License-Identifier: GPL-3.0-or-later
// Estimates how much disk space an app occupies: its installation plus the
// config/data/cache folders it keeps in the home directory.

import GLib from 'gi://GLib';

import {exists, listDir, lowPriority, readLink, run} from './fsutil.js';

const GENERIC_NAMES = new Set(['bash', 'sh', 'zsh', 'fish', 'sudo', 'env', 'systemd', 'dbus', 'gjs', 'electron']);

async function installPath(exe, group) {
    if (group.launcher === 'flatpak') {
        for (const dir of [`${GLib.get_user_data_dir()}/flatpak/app/${group.appId}`, `/var/lib/flatpak/app/${group.appId}`]) {
            if (await exists(dir))
                return dir;
        }
    }
    if (!exe)
        return null;

    let m = exe.match(/^\/snap\/([^/]+)\/([^/]+)\//);
    if (m) {
        let rev = m[2];
        if (rev === 'current')
            rev = await readLink(`/snap/${m[1]}/current`) ?? rev;
        const file = `/var/lib/snapd/snaps/${m[1]}_${rev}.snap`;
        return await exists(file) ? file : `/snap/${m[1]}/${m[2]}`;
    }
    m = exe.match(/^(\/opt\/[^/]+)\//) ?? exe.match(/^(\/usr\/(?:lib|lib64|share)\/[^/]+)\//) ??
        exe.match(/^(\/home\/[^/]+\/\.local\/share\/[^/]+)\//);
    if (m)
        return m[1];
    return exe; // just the binary, e.g. /usr/bin/foo
}

function candidateNames(group, displayName, exe) {
    const names = new Set();
    const add = n => {
        if (!n)
            return;
        n = n.toLowerCase();
        if (n.length >= 3 && !GENERIC_NAMES.has(n))
            names.add(n);
    };
    add(group.appId);
    add(group.appId?.split('.').pop());
    add(group.name);
    add(group.exe ?? group.exeHint);
    add(exe ? exe.slice(exe.lastIndexOf('/') + 1) : null);
    add(displayName);
    add(displayName?.replace(/\s+/g, ''));
    add(displayName?.replace(/\s+/g, '-'));
    return names;
}

const NOISE_WORDS = new Set(['org', 'com', 'net', 'io', 'dev', 'app', 'gnome', 'kde', 'freedesktop',
    'github', 'desktop', 'browser', 'nightly', 'stable', 'beta', 'dev', 'bin', 'client', 'linux']);

/** Distinctive words (e.g. "brave" from "brave-browser-nightly") used for prefix matches. */
function candidateTokens(names, exe) {
    const tokens = new Set();
    const vendor = exe?.match(/^\/opt\/([^/]+)\//)?.[1];
    for (const n of [...names, vendor?.toLowerCase()]) {
        for (const t of n?.split(/[-_. ]+/) ?? []) {
            if (t.length >= 4 && !NOISE_WORDS.has(t) && !GENERIC_NAMES.has(t))
                tokens.add(t);
        }
    }
    return tokens;
}

async function matchingChildren(dir, names, tokens, cancellable) {
    const infos = await listDir(dir, 'standard::name', cancellable) ?? [];
    return infos.map(i => i.get_name())
        .filter(n => {
            const lower = n.toLowerCase().replace(/^\./, '');
            return names.has(lower) || [...tokens].some(t => lower.startsWith(t));
        })
        .map(n => `${dir}/${n}`);
}

async function diskUsage(paths, cancellable) {
    if (paths.length === 0)
        return new Map();
    // Walking big folders can keep a hard disk busy for seconds; stay out of the way.
    const out = await run(lowPriority(['du', '-s', '-B1', '--', ...paths], {idleIo: true}), cancellable);
    const sizes = new Map();
    for (const line of out.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab > 0)
            sizes.set(line.slice(tab + 1), Number(line.slice(0, tab)));
    }
    return sizes;
}

/**
 * @returns {Promise<{total:number, categories:{label:string, bytes:number, paths:string[]}[]}>}
 */
export async function estimateStorage(group, displayName, cancellable = null) {
    const pid = group.procs[0]?.pid;
    const exe = pid ? await readLink(`/proc/${pid}/exe`, cancellable) : null;
    const names = candidateNames(group, displayName, exe);
    const tokens = candidateTokens(names, exe);
    const home = GLib.get_home_dir();

    const install = await installPath(exe?.replace(/ \(deleted\)$/, ''), group);
    const [config, data, cache] = await Promise.all([
        matchingChildren(GLib.get_user_config_dir(), names, tokens, cancellable),
        matchingChildren(GLib.get_user_data_dir(), names, tokens, cancellable),
        matchingChildren(GLib.get_user_cache_dir(), names, tokens, cancellable),
    ]);

    const sandbox = [];
    if (group.launcher === 'flatpak' && group.appId)
        sandbox.push(`${home}/.var/app/${group.appId}`);
    if (group.launcher === 'snap' && group.appId)
        sandbox.push(`${home}/snap/${group.appId}`);
    const sandboxExisting = [];
    for (const p of sandbox) {
        if (await exists(p, cancellable))
            sandboxExisting.push(p);
    }

    const categories = [
        {label: 'install', paths: install ? [install] : []},
        {label: 'config', paths: config},
        {label: 'data', paths: data.filter(p => p !== install)},
        {label: 'cache', paths: cache},
        {label: 'sandbox', paths: sandboxExisting},
    ];
    const sizes = await diskUsage(categories.flatMap(c => c.paths), cancellable);
    let total = 0;
    for (const c of categories) {
        c.bytes = c.paths.reduce((a, p) => a + (sizes.get(p) ?? 0), 0);
        total += c.bytes;
    }
    return {total, categories, exe};
}

const STORAGE_CACHE_USEC = 10 * 60 * 1e6;

/**
 * Recent storage results per group: measuring walks whole directory trees, so
 * reopening an app's details within 10 minutes reuses the last result.
 */
export class StorageCache {
    constructor() {
        this._entries = new Map(); // group key -> {time, storage}
    }

    /** A recent result, or undefined. */
    lookup(key) {
        const now = GLib.get_monotonic_time();
        for (const [k, entry] of this._entries) {
            if (now - entry.time > STORAGE_CACHE_USEC)
                this._entries.delete(k);
        }
        return this._entries.get(key)?.storage;
    }

    async measure(group, cancellable) {
        const storage = await estimateStorage(group, group.displayName, cancellable);
        this._entries.set(group.key, {time: GLib.get_monotonic_time(), storage});
        return storage;
    }

    clear() {
        this._entries.clear();
    }
}
