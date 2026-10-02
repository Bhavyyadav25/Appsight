// SPDX-License-Identifier: GPL-3.0-or-later
// Owns GLib main-loop sources so every one of them can be removed in one call.

import GLib from 'gi://GLib';

export class Timers {
    constructor() {
        this._sourceIds = new Set();
    }

    /** Run `callback` once after `milliseconds`. Returns the source id. */
    after(milliseconds, callback) {
        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            this._sourceIds.delete(sourceId);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._sourceIds.add(sourceId);
        return sourceId;
    }

    /**
     * Run `callback` every `seconds` seconds until removed. Second-granularity
     * timers are coalesced with other wakeups, so the CPU sleeps longer between them.
     */
    every(seconds, callback) {
        const sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            callback();
            return GLib.SOURCE_CONTINUE;
        });
        this._sourceIds.add(sourceId);
        return sourceId;
    }

    /**
     * Remove one source (0 or an already finished id is fine). Returns 0, for
     * `sourceId = timers.remove(sourceId)`.
     */
    remove(sourceId) {
        if (sourceId && this._sourceIds.delete(sourceId))
            GLib.Source.remove(sourceId);
        return 0;
    }

    clear() {
        for (const sourceId of this._sourceIds)
            GLib.Source.remove(sourceId);
        this._sourceIds.clear();
    }
}
