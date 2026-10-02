// SPDX-License-Identifier: GPL-3.0-or-later
// The sampling pipeline, with no UI: system numbers and their history, the
// app groups, and the deep statistics of one group. The indicator decides when
// to sample; the views only ever see the results.

import {DetailSampler} from './details.js';
import {buildGroups} from './groups.js';
import {ProcReader} from './proc.js';

const SYS_HISTORY = 60; // samples kept for the CPU/memory graphs

function push(history, value) {
    if (value === null || !Number.isFinite(value))
        return;
    history.push(value);
    if (history.length > SYS_HISTORY)
        history.shift();
}

export class Monitor {
    constructor() {
        this._reader = new ProcReader();
        this._details = new DetailSampler();
        this.cpuHistory = [];
        this.memHistory = []; // percent of RAM
        this.sys = null;
    }

    get uid() {
        return this._reader.uid;
    }

    get shellPid() {
        return this._reader.shellPid;
    }

    /**
     * System-wide numbers. `cpu`/`mem` say what the panel shows; `full` adds
     * everything the open menu needs.
     */
    async sampleSystem({cpu, mem, full}, cancellable) {
        const sys = await this._reader.sampleSystem(cancellable, {cpu, mem, full});
        push(this.cpuHistory, sys.cpu);
        if (sys.memTotal)
            push(this.memHistory, sys.memUsed / sys.memTotal * 100);
        this.sys = sys;
        return sys;
    }

    /** @returns {Promise<Map<string, object>>} group key -> group */
    async sampleGroups(includeOtherUsers, cancellable) {
        const procs = await this._reader.sampleProcesses(includeOtherUsers, cancellable);
        return buildGroups(procs, this._reader);
    }

    sampleDetail(group, cancellable) {
        return this._details.sample(group, cancellable);
    }

    isAlive(pid, start) {
        return this._reader.isAlive(pid, start);
    }

    /** A new detail view starts its rates from scratch. */
    resetDetail() {
        this._details.reset();
    }

    /** The menu opened: CPU baselines from long ago would give one bogus sample. */
    beginSession() {
        this._reader.resetCpuBaseline();
    }

    /** The menu closed: nothing is sampled per process now, so drop all per-process state. */
    endSession() {
        this._reader.releaseCaches();
        this._details.reset();
    }
}
