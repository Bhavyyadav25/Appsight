// SPDX-License-Identifier: GPL-3.0-or-later
// Owns GLib main-loop sources so every one of them can be removed in one call.

import GLib from 'gi://GLib';

export class Timers {
    constructor() {
        this._ids = new Set();
    }

    /** Run `fn` once after `ms` milliseconds. Returns the source id. */
    after(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._ids.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._ids.add(id);
        return id;
    }

    /**
     * Run `fn` every `seconds` seconds until removed. Second-granularity timers
     * are coalesced with other wakeups, so the CPU sleeps longer between them.
     */
    every(seconds, fn) {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            fn();
            return GLib.SOURCE_CONTINUE;
        });
        this._ids.add(id);
        return id;
    }

    /** Remove one source (0 or an already finished id is fine). Returns 0 for `id = timers.remove(id)`. */
    remove(id) {
        if (id && this._ids.delete(id))
            GLib.Source.remove(id);
        return 0;
    }

    clear() {
        for (const id of this._ids)
            GLib.Source.remove(id);
        this._ids.clear();
    }
}
