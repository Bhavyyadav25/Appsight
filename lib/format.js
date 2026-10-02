// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

const DASH = '–';

// Unit preferences, set by the indicator from the settings.
const units = {binary: false, bits: false, perCore: false, ncpu: 1};

export function configure({binary, bits, perCore, ncpu}) {
    Object.assign(units, {binary, bits, perCore, ncpu: Math.max(1, ncpu)});
}

function size(v, flags) {
    if (units.binary)
        flags |= GLib.FormatSizeFlags.IEC_UNITS;
    return GLib.format_size_full(v, flags);
}

function compact(n, base, suffix) {
    const names = ['', 'K', 'M', 'G', 'T'];
    let v = Math.max(0, n);
    let i = 0;
    while (v >= base && i < names.length - 1) {
        v /= base;
        i++;
    }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${names[i]}${suffix(i)}`;
}

export function bytes(n) {
    if (n === null || n === undefined || !Number.isFinite(n))
        return DASH;
    const v = Math.max(0, Math.round(n));
    // GLib says "0 bytes"/"512 bytes"; "0 B" reads better in a compact column.
    return v < 1000 ? `${v} B` : size(v, GLib.FormatSizeFlags.DEFAULT);
}

export function rate(n) {
    return n === null || n === undefined ? DASH : `${bytes(n)}/s`;
}

/** A network rate in bytes or bits per second, as the user prefers. */
export function netRate(n) {
    if (n === null || n === undefined || !Number.isFinite(n))
        return DASH;
    if (!units.bits)
        return rate(n);
    // Network speeds are quoted in powers of 1000 even by those who prefer KiB.
    const v = Math.max(0, Math.round(n * 8));
    return v < 1000 ? `${v} bit/s` : `${GLib.format_size_full(v, GLib.FormatSizeFlags.BITS)}/s`;
}

/** Compact size for the top bar, e.g. "4.1G" ("4.1Gi" with binary units). */
export function shortBytes(n) {
    if (units.binary)
        return compact(n, 1024, i => i > 0 ? 'i' : 'B');
    return compact(n, 1000, i => i > 0 ? '' : 'B');
}

/** Compact network rate: bytes like shortBytes(), or bits, e.g. "12Mb". */
export function shortNet(n) {
    return units.bits ? compact(n * 8, 1000, () => 'b') : shortBytes(n);
}

export function percent(p) {
    if (p === null || p === undefined || !Number.isFinite(p))
        return DASH;
    if (p >= 10)
        return `${Math.round(p)}%`;
    return `${p.toFixed(1)}%`;
}

/**
 * CPU use of an app or process, given as a share of all CPUs. In per-core mode
 * one fully busy core reads 100%.
 */
export function cpu(p) {
    if (p === null || p === undefined || !Number.isFinite(p))
        return DASH;
    return percent(units.perCore ? p * units.ncpu : p);
}

export function number(n, digits = 0) {
    if (n === null || n === undefined || !Number.isFinite(n))
        return DASH;
    return n.toLocaleString(undefined, {maximumFractionDigits: digits});
}

export function duration(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds))
        return DASH;
    const s = Math.max(0, Math.floor(seconds));
    const d = Math.floor(s / 86400);
    const h = Math.floor(s % 86400 / 3600);
    const m = Math.floor(s % 3600 / 60);
    if (d > 0)
        return `${d}d ${h}h`;
    if (h > 0)
        return `${h}h ${m}m`;
    if (m > 0)
        return `${m}m ${s % 60}s`;
    return `${s}s`;
}
