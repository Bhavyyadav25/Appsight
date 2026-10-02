// SPDX-License-Identifier: GPL-3.0-or-later
// Ending processes: TERM, a grace period, then KILL for whatever is left.

import Gio from 'gi://Gio';

import {readText} from './fsutil.js';

/**
 * Send a signal to a list of pids with kill(1).
 * @returns {Promise<{ok: boolean, error: string}>}
 */
export async function sendSignal(pids, signal) {
    if (pids.length === 0)
        return {ok: true, error: ''};
    try {
        const proc = Gio.Subprocess.new(
            ['kill', `-${signal}`, '--', ...pids.map(String)],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        const [, stderr] = await proc.communicate_utf8_async(null, null);
        return {ok: proc.get_successful(), error: (stderr ?? '').trim()};
    } catch (e) {
        return {ok: false, error: e.message};
    }
}

export class Terminator {
    /**
     * @param {object} params
     * @param {import('./monitor.js').Monitor} params.monitor whose uid/shellPid/isAlive are used
     * @param {import('./timers.js').Timers} params.timers owner of the grace-period timers
     * @param {() => number} params.graceSeconds
     * @param {() => void} params.onSignalled called after signals were sent (to refresh the list)
     * @param {(name: string, errors: string) => void} params.onError
     */
    constructor({monitor, timers, graceSeconds, onSignalled, onError}) {
        this._monitor = monitor;
        this._timers = timers;
        this._graceSeconds = graceSeconds;
        this._onSignalled = onSignalled;
        this._onError = onError;
        this._stopped = false;
    }

    /** Whether the group may be ended from inside this session. */
    canEnd(group) {
        return !!group && !group.protected && !group.foreign;
    }

    /** End every process of a group (and, for `force`, everything else in its own cgroups). */
    endGroup(group, force) {
        if (!this.canEnd(group))
            return;
        const procs = group.procs.filter(p => p.pid !== this._monitor.shellPid && p.uid === this._monitor.uid);
        this._terminate(procs, group.dedicatedCgroup ? [...group.cgroups] : [], force, group.displayName);
    }

    endProcess(proc) {
        this._terminate([proc], [], false, proc.comm);
    }

    /** Stop acting on pending grace periods (their timers belong to `timers`). */
    stop() {
        this._stopped = true;
    }

    /** Every pid currently inside the given (app-exclusive) cgroups. */
    async _cgroupPids(cgroups) {
        const texts = await Promise.all(cgroups.map(cg => readText(`/sys/fs/cgroup${cg}/cgroup.procs`)));
        return texts.flatMap(t => (t ?? '').split('\n').filter(Boolean).map(Number))
            .filter(pid => pid !== this._monitor.shellPid);
    }

    async _terminate(procs, cgroups, force, name) {
        if (procs.length === 0)
            return;
        const pids = procs.map(p => p.pid);
        if (force)
            pids.push(...await this._cgroupPids(cgroups));

        this._report(await sendSignal([...new Set(pids)], force ? 'KILL' : 'TERM'), name);
        if (this._stopped)
            return;
        this._onSignalled();
        if (force)
            return;

        // Give the app time to quit cleanly, then kill whatever is left, including
        // processes it spawned in the meantime inside its own cgroup.
        this._timers.after(this._graceSeconds() * 1000, async () => {
            const alive = [];
            for (const p of procs) {
                // eslint-disable-next-line no-await-in-loop
                if (await this._monitor.isAlive(p.pid, p.start))
                    alive.push(p.pid);
            }
            const stragglers = [...new Set([...alive, ...await this._cgroupPids(cgroups)])];
            if (this._stopped || stragglers.length === 0)
                return;
            this._report(await sendSignal(stragglers, 'KILL'), name);
            if (!this._stopped)
                this._onSignalled();
        });
    }

    _report(result, name) {
        if (result.ok || this._stopped)
            return;
        // Processes that already exited are not an error.
        const errors = result.error.split('\n').filter(l => l && !/no such process/i.test(l));
        if (errors.length > 0)
            this._onError(name, errors.join('; '));
    }
}
