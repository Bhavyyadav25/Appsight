// SPDX-License-Identifier: GPL-3.0-or-later
// When to refresh: a repeating timer at the configured interval, stretched on
// slow computers so refreshing never takes more than a tenth of the time.

// Refreshing may take at most 1/BUSY_LIMIT of the time; slower computers get a
// longer interval than the one set, up to MAX_INTERVAL seconds.
const BUSY_LIMIT = 10;
const MAX_INTERVAL = 10;

export class RefreshScheduler {
    /**
     * @param {object} params
     * @param {import('./timers.js').Timers} params.timers owner of the timer
     * @param {() => number} params.interval configured interval in seconds
     * @param {() => void} params.onTick
     */
    constructor({timers, interval, onTick}) {
        this._timers = timers;
        this._setting = interval;
        this._onTick = onTick;
        this._id = 0;
        this._interval = 0; // seconds; 0 while stopped
        this._cost = 0; // ms, smoothed
    }

    /** Seconds between refreshes, or 0 while stopped. */
    get interval() {
        return this._interval;
    }

    /** Smoothed time a refresh takes, in milliseconds. */
    get cost() {
        return this._cost;
    }

    /** (Re)start the timer, e.g. after the configured interval changed. */
    start() {
        this.stop();
        this._interval = this._wanted();
        this._id = this._timers.every(this._interval, this._onTick);
    }

    stop() {
        this._id = this._timers.remove(this._id);
        this._interval = 0;
    }

    /** Run one refresh after `ms` milliseconds, outside the regular rhythm. */
    kick(ms) {
        this._timers.after(ms, this._onTick);
    }

    /** Report how long a refresh took; the timer slows down (or back up) to match. */
    noteCost(ms) {
        // Smoothed, so one slow refresh (e.g. the first scan after opening) doesn't count much.
        this._cost = this._cost * 0.7 + ms * 0.3;
        if (this._interval && this._wanted() !== this._interval)
            this.start();
    }

    _wanted() {
        const setting = Math.max(1, this._setting());
        const needed = Math.ceil(this._cost * BUSY_LIMIT / 1000);
        return Math.min(MAX_INTERVAL, Math.max(setting, needed));
    }
}
