// SPDX-License-Identifier: GPL-3.0-or-later
// Everything about one app group, refreshed live.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Fmt from './format.js';
import {impact, processRole, unescapeUnit} from './groups.js';
import {kindLabel} from './labels.js';
import {ConfirmButton, SharedAction, Sparkline, bandScale, icon, label, setScrollChild, setText, setVariant, vbox} from './widgets.js';

// Process rows are shown a page at a time (Chromium-style apps run dozens).
const PROCESS_PAGE = 20;
const HISTORY = 60; // samples kept for the graphs (2 minutes at the default rate)
const RATE_FLOOR = 64 * 1024; // graphs of near-idle rates don't zoom in further than this

function sections() {
    return [
        ['overview', _('Overview'), 'dialog-information-symbolic', [
            ['impact', _('System impact')],
            ['procs', _('Processes')],
            ['threads', _('Threads')],
            ['states', _('States')],
            ['uptime', _('Running for')],
            ['unit', _('systemd unit')],
        ]],
        ['cpu', _('CPU'), 'speedometer-symbolic', [
            ['cpu', _('Share of all CPUs')],
            ['cpuCore', _('Equivalent cores busy')],
            ['cpuTime', _('CPU time used')],
            ['ctx', _('Context switches')],
            ['cpuPsi', _('Stalled waiting for CPU')],
        ]],
        ['memory', _('Memory'), 'drive-harddisk-solidstate-symbolic', [
            ['memPriv', _('Private (unshared)')],
            ['memPss', _('Proportional (PSS)')],
            ['memRss', _('Resident (RSS)')],
            ['memShmem', _('Shared memory')],
            ['memSwap', _('Swapped out')],
            ['memShare', _('Share of RAM')],
            ['memPsi', _('Stalled waiting for memory')],
        ]],
        ['cache', _('Cache'), 'view-refresh-symbolic', [
            ['cacheMapped', _('Mapped files in RAM')],
            ['cachePage', _('Page cache charged to app')],
            ['cacheCgroup', _('Total RAM charged to app')],
            ['cacheDisk', _('Cache folder on disk')],
        ]],
        ['disk', _('Disk I/O'), 'drive-harddisk-symbolic', [
            ['ioRead', _('Reading from disk')],
            ['ioWrite', _('Writing to disk')],
            ['ioReadTotal', _('Read from disk (total)')],
            ['ioWriteTotal', _('Written to disk (total)')],
            ['ioLogical', _('All I/O incl. cache & pipes')],
            ['ioPsi', _('Stalled waiting for I/O')],
        ]],
        ['network', _('Network'), 'network-transmit-receive-symbolic', [
            ['netDown', _('Downloading')],
            ['netUp', _('Uploading')],
            ['netConns', _('TCP connections')],
            ['netUdp', _('UDP sockets')],
            ['netListen', _('Listening on')],
            ['netTotal', _('Transferred on open connections')],
            ['netHosts', _('Top remote hosts')],
        ]],
        ['storage', _('Storage'), 'folder-symbolic', [
            ['stTotal', _('Total on disk')],
            ['stInstall', _('Installation')],
            ['stConfig', _('Configuration')],
            ['stData', _('Data')],
            ['stCache', _('Cache')],
            ['stSandbox', _('Sandbox data')],
        ]],
        ['files', _('Open files'), 'document-open-symbolic', [
            ['fdTotal', _('File descriptors')],
            ['fdFiles', _('Files')],
            ['fdSockets', _('Sockets')],
            ['fdPipes', _('Pipes')],
        ]],
    ];
}

const STATE_NAMES = {
    R: 'running', S: 'sleeping', D: 'disk wait', Z: 'zombie', T: 'stopped', t: 'traced', I: 'idle',
};

function push(history, value) {
    history.push(Number.isFinite(value) ? value : 0);
    if (history.length > HISTORY)
        history.shift();
}

class ProcessRow {
    constructor(action) {
        this._sharedAction = action;
        this._killable = false;
        this.actor = new St.BoxLayout({style_class: 'as-proc-row', x_expand: true, reactive: true, track_hover: true, can_focus: true});
        this._pid = label('', 'as-proc-pid');
        this._name = label('', 'as-proc-name', {x_expand: true});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._cpu = label('', 'as-col as-col-cpu');
        this._mem = label('', 'as-col as-col-mem');
        // Filled by the shared end button while hovered.
        this._slot = new St.Widget({style_class: 'as-col-action', layout_manager: new Clutter.BinLayout()});
        this.actor.connect('notify::hover', () => this._sync());
        this.actor.connect('key-focus-in', () => this._sync());
        this.actor.connect('key-focus-out', () => this._sync());
        this.actor.connect('destroy', () => this._sharedAction.release(this));
        for (const w of [this._pid, this._name, this._cpu, this._mem, this._slot])
            this.actor.add_child(w);
    }

    _sync() {
        this._sharedAction.request(this, this._slot, true,
            this._killable && (this.actor.hover || this.actor.has_key_focus()));
    }

    update(proc, killable) {
        this.proc = proc;
        setText(this._pid, String(proc.pid));
        const role = processRole(proc);
        const extra = (proc.args ?? []).slice(1).join(' ');
        setText(this._name, role ? `${proc.comm} · ${role}` : extra ? `${proc.comm}  ${extra}` : proc.comm);
        setText(this._cpu, proc.cpu === null ? '…' : Fmt.cpu(proc.cpu));
        setText(this._mem, Fmt.bytes(proc.priv));
        if (killable !== this._killable) {
            this._killable = killable;
            this._sync();
        }
    }
}

export class DetailView {
    constructor(callbacks) {
        this._callbacks = callbacks;
        this._values = {};
        this._procRows = new Map();
        this._procAction = new SharedAction({
            confirmText: _('End?'),
            accessibleName: _('End process'),
            needsConfirm: callbacks.needsConfirm,
            onActivate: row => callbacks.onKillProcess(row.proc),
        });
        this._collapsed = new Set(callbacks.collapsedSections?.() ?? []);
        this._impact = null;
        this.group = null;
        this._resetHistory();

        this.actor = vbox({style_class: 'as-detail-view', x_expand: true});

        // Header: back, icon, name, impact badge
        const header = new St.BoxLayout({style_class: 'as-detail-header'});
        const back = new St.Button({
            style_class: 'as-back',
            child: new St.Icon({icon_name: 'go-previous-symbolic', style_class: 'as-back-icon'}),
            can_focus: true,
            accessible_name: _('Back'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        back.connect('clicked', () => this._callbacks.onBack());
        this.backButton = back;
        header.add_child(back);

        this._icon = new St.Icon({style_class: 'as-detail-icon'});
        this._tile = new St.Bin({style_class: 'as-tile as-detail-tile', child: this._icon, y_align: Clutter.ActorAlign.CENTER});
        this._iconKind = null;
        header.add_child(this._tile);

        const titles = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'as-detail-titles'});
        this._title = label('', 'as-detail-title');
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._subtitle = label('', 'as-detail-subtitle');
        this._subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titles.add_child(this._title);
        titles.add_child(this._subtitle);
        header.add_child(titles);

        this._impactBadge = label('', 'as-badge', {y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._impactBadge);
        this.actor.add_child(header);

        // Actions
        const actions = new St.BoxLayout({style_class: 'as-actions'});
        this._endButton = new ConfirmButton({
            text: _('End app'),
            iconName: 'process-stop-symbolic',
            confirmText: _('Click again to end all processes'),
            styleClass: 'as-action as-action-end',
            needsConfirm: callbacks.needsConfirm,
        });
        this._endButton.x_expand = true;
        this._endButton.connect('activated', () => this._callbacks.onKill(this.group, false));
        this._forceButton = new ConfirmButton({
            text: _('Force kill'),
            iconName: 'dialog-warning-symbolic',
            confirmText: _('Click again to force kill'),
            styleClass: 'as-action as-action-force',
            needsConfirm: callbacks.needsConfirm,
        });
        this._forceButton.connect('activated', () => this._callbacks.onKill(this.group, true));
        this._protected = new St.BoxLayout({style_class: 'as-protected', x_expand: true});
        this._protected.add_child(new St.Icon({icon_name: 'changes-prevent-symbolic', style_class: 'as-protected-icon'}));
        this._protectedNote = label('', 'as-protected-note', {x_expand: true});
        this._protectedNote.clutter_text.line_wrap = true;
        this._protected.add_child(this._protectedNote);
        actions.add_child(this._endButton);
        actions.add_child(this._forceButton);
        actions.add_child(this._protected);
        this.actor.add_child(actions);

        // Scrollable body
        const body = vbox({style_class: 'as-detail-body', x_expand: true});

        // Live graph cards, two per row
        this._cards = {};
        const cardDefs = [
            ['cpu', _('CPU'), 'as-spark-cpu', 'speedometer-symbolic'],
            ['mem', _('Memory'), 'as-spark-mem', 'drive-harddisk-solidstate-symbolic'],
            ['net', _('Network'), 'as-spark-net', 'network-transmit-receive-symbolic'],
            ['disk', _('Disk'), 'as-spark-disk', 'drive-harddisk-symbolic'],
        ];
        for (let i = 0; i < cardDefs.length; i += 2) {
            const row = new St.BoxLayout({style_class: 'as-cards'});
            row.layout_manager.homogeneous = true;
            for (const [key, title, sparkClass, iconName] of cardDefs.slice(i, i + 2)) {
                const card = vbox({style_class: `as-card as-card-${key}`, x_expand: true});
                const head = new St.BoxLayout({style_class: 'as-card-head'});
                head.add_child(icon(iconName, 'as-card-icon'));
                head.add_child(label(title, 'as-card-title', {x_expand: true}));
                const sub = label('', 'as-card-sub');
                head.add_child(sub);
                card.add_child(head);
                const value = label('…', 'as-card-value');
                card.add_child(value);
                const spark = new Sparkline({style_class: `as-spark as-card-spark ${sparkClass}`, capacity: HISTORY, dot: true});
                card.add_child(spark);
                this._cards[key] = {value, sub, spark};
                row.add_child(card);
            }
            body.add_child(row);
        }

        // Collapsible sections in rounded groups
        this._sections = {};
        const addSection = (id, title, iconName) => {
            const button = new St.Button({style_class: 'as-section-header', can_focus: true, x_expand: true});
            const box = new St.BoxLayout({style_class: 'as-section-box', x_expand: true});
            box.add_child(icon(iconName, 'as-section-icon'));
            box.add_child(label(title, 'as-section-title', {x_expand: true}));
            const chevron = new St.Icon({icon_name: 'pan-down-symbolic', style_class: 'as-section-chevron'});
            box.add_child(chevron);
            button.set_child(box);
            body.add_child(button);
            const group = vbox({style_class: 'as-group'});
            body.add_child(group);
            const section = {button, group, chevron};
            this._sections[id] = section;
            button.connect('clicked', () => this._toggleSection(id));
            this._applySection(id);
            return group;
        };

        for (const [id, title, iconName, rows] of sections()) {
            const group = addSection(id, title, iconName);
            for (const [key, name] of rows) {
                const row = new St.BoxLayout({style_class: 'as-kv-row'});
                const keyBox = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                keyBox.add_child(label(name, 'as-kv-key'));
                const keySub = label('', 'as-kv-sub', {visible: false});
                keySub.clutter_text.line_wrap = true;
                keyBox.add_child(keySub);
                row.add_child(keyBox);
                const value = label('…', 'as-kv-value', {y_align: Clutter.ActorAlign.CENTER});
                value.clutter_text.line_wrap = true;
                row.add_child(value);
                this._values[key] = {row, value, keySub};
                group.add_child(row);
            }
        }

        this._procGroup = addSection('processes', _('Processes'), 'view-list-symbolic');
        this._procBox = vbox({style_class: 'as-proc-list'});
        this._procGroup.add_child(this._procBox);
        this._procLimit = PROCESS_PAGE;
        this._procMoreLabel = label('', 'as-proc-more-label');
        this._procMore = new St.Button({
            style_class: 'as-proc-more',
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
            child: this._procMoreLabel,
        });
        this._procMore.connect('clicked', () => {
            this._procLimit += PROCESS_PAGE;
            this.updateGroup(this.group, this._sys);
        });
        this._procGroup.add_child(this._procMore);

        this._scroll = new St.ScrollView({
            style_class: 'as-scroll as-detail-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        setScrollChild(this._scroll, body);
        this.actor.add_child(this._scroll);
    }

    _toggleSection(id) {
        if (this._collapsed.has(id))
            this._collapsed.delete(id);
        else
            this._collapsed.add(id);
        this._applySection(id);
        this._callbacks.onCollapsedChanged?.([...this._collapsed]);
        if (id === 'processes' && this.group)
            this.updateGroup(this.group, this._sys);
    }

    _applySection(id) {
        const s = this._sections[id];
        const collapsed = this._collapsed.has(id);
        s.group.visible = !collapsed;
        s.chevron.icon_name = collapsed ? 'pan-end-symbolic' : 'pan-down-symbolic';
        if (collapsed)
            s.button.add_style_pseudo_class('collapsed');
        else
            s.button.remove_style_pseudo_class('collapsed');
    }

    _resetHistory() {
        this._history = {cpu: [], mem: [], down: [], up: [], read: [], write: []};
    }

    _set(key, text, sub) {
        const v = this._values[key];
        if (!v)
            return;
        v.row.visible = text !== null;
        if (text !== null)
            setText(v.value, text);
        if (sub !== undefined) {
            v.keySub.visible = !!sub;
            setText(v.keySub, sub ?? '');
        }
    }

    show(group) {
        this.group = group;
        this._resetHistory();
        for (const v of Object.values(this._values)) {
            v.row.visible = true;
            setText(v.value, '…');
            v.keySub.visible = false;
        }
        for (const c of Object.values(this._cards)) {
            setText(c.value, '…');
            setText(c.sub, '');
            c.spark.setData([], 1);
        }
        for (const row of this._procRows.values())
            row.actor.destroy();
        this._procRows.clear();
        this._scroll.vadjustment.value = 0;
        this.updateGroup(group, null);
        this._set('netDown', _('measuring…'));
        this._set('netUp', _('measuring…'));
    }

    /** Fast numbers available from the overview sample. */
    updateGroup(group, sys) {
        this.group = group;
        this._sys = sys;
        this._icon.gicon = group.gicon;
        const kind = group.shellApp ? 'app' : group.kind;
        if (kind !== this._iconKind) {
            this._iconKind = setVariant(this._tile, 'as-tile-', kind, this._iconKind);
            this._icon.icon_size = group.shellApp ? 44 : 22;
        }
        setText(this._title, group.displayName);
        const n = group.procs.length;
        setText(this._subtitle, [kindLabel(group), ngettext('%d process', '%d processes', n).format(n),
            group.appId ?? group.unit ?? group.exe].filter(Boolean).join(' · '));

        const killable = !group.protected && !group.foreign;
        this._endButton.visible = killable;
        this._forceButton.visible = killable;
        this._protected.visible = !killable;
        setText(this._protectedNote, group.protected
            ? _('Part of your desktop session. Ending it could log you out.')
            : _('Owned by another user. It can only be ended as administrator.'));

        // Processes list. Only move rows that are out of place; every move relayouts the list.
        // A collapsed section keeps no rows at all.
        const shown = this._collapsed.has('processes') ? [] : group.procs.slice(0, this._procLimit);
        const seen = new Set(shown.map(p => p.pid));
        for (const [pid, row] of this._procRows) {
            if (!seen.has(pid)) {
                row.actor.destroy();
                this._procRows.delete(pid);
            }
        }
        const children = this._procBox.get_children();
        shown.forEach((proc, i) => {
            let row = this._procRows.get(proc.pid);
            if (!row) {
                row = new ProcessRow(this._procAction);
                this._procRows.set(proc.pid, row);
                this._procBox.insert_child_at_index(row.actor, i);
                children.splice(i, 0, row.actor);
            } else if (children[i] !== row.actor) {
                this._procBox.set_child_at_index(row.actor, i);
                children.splice(children.indexOf(row.actor), 1);
                children.splice(i, 0, row.actor);
            }
            row.update(proc, killable && proc.uid === group.procs[0].uid);
        });
        const hidden = group.procs.length - shown.length;
        this._procMore.visible = hidden > 0 && shown.length > 0;
        setText(this._procMoreLabel, ngettext('Show %d more', 'Show %d more', Math.min(hidden, PROCESS_PAGE)).format(
            Math.min(hidden, PROCESS_PAGE)));

        if (!sys)
            return;

        const memShare = sys.memTotal ? group.mem / sys.memTotal * 100 : 0;
        const level = impact(group.cpu, memShare);
        const levelText = {low: _('Low impact'), medium: _('Medium impact'), high: _('High impact')}[level];
        setText(this._impactBadge, levelText);
        this._impact = setVariant(this._impactBadge, 'as-badge-', level, this._impact);
        this._set('impact', {low: _('Low'), medium: _('Medium'), high: _('High')}[level]);
        this._set('procs', String(n));
        this._set('threads', Fmt.number(group.threads));
        const states = {};
        for (const p of group.procs)
            states[p.state] = (states[p.state] ?? 0) + 1;
        this._set('states', Object.entries(states)
            .map(([s, c]) => `${c} ${STATE_NAMES[s] ?? s}`).join(', '));
        const now = GLib.get_real_time() / 1e6;
        this._set('uptime', Number.isFinite(group.startedAt) ? Fmt.duration(now - group.startedAt) : null);
        this._set('unit', group.unit ? unescapeUnit(group.unit) : null);

        const cores = group.cpu * sys.ncpu / 100;
        setText(this._cards.cpu.value, group.cpuKnown ? Fmt.cpu(group.cpu) : '…');
        setText(this._cards.cpu.sub, group.cpuKnown ? ngettext('%s core', '%s cores', Math.ceil(cores)).format(cores.toFixed(2)) : '');
        this._set('cpu', group.cpuKnown ? Fmt.percent(group.cpu) : '…');
        this._set('cpuCore', group.cpuKnown ? cores.toFixed(2) : '…');

        setText(this._cards.mem.value, Fmt.bytes(group.mem));
        setText(this._cards.mem.sub, `${Fmt.percent(memShare)} ${_('of RAM')}`);
        this._set('memPriv', Fmt.bytes(group.mem));
        this._set('memShare', Fmt.percent(memShare));

        // Graphs: CPU scaled to at least 10 % so idle apps don't look busy.
        if (group.cpuKnown)
            push(this._history.cpu, group.cpu);
        push(this._history.mem, group.mem);
        const h = this._history;
        this._cards.cpu.spark.setData([h.cpu], Math.max(10, ...h.cpu) * 1.15);
        this._cards.mem.spark.setData([h.mem], ...bandScale(h.mem));
    }

    /** Expensive numbers from DetailSampler. */
    updateDetails(d) {
        const {totals: t, rates: r, net, cgroup: cg} = d;
        const psi = v => v !== null && v !== undefined ? Fmt.percent(v) : null;

        this._set('cpuTime', Fmt.duration(d.cpuTime));
        this._set('ctx', r.ctx === null ? '…' : `${Fmt.number(r.ctx)}/s`);
        this._set('cpuPsi', psi(cg?.cpuPressure));

        this._set('memPss', t.pssKnown ? Fmt.bytes(t.pss) : null);
        this._set('memRss', Fmt.bytes(t.rss));
        this._set('memShmem', Fmt.bytes(t.shmem));
        this._set('memSwap', Fmt.bytes(t.swap));
        this._set('memPsi', psi(cg?.memPressure));

        this._set('cacheMapped', Fmt.bytes(t.file));
        this._set('cachePage', cg ? Fmt.bytes(cg.file) : null);
        this._set('cacheCgroup', cg ? Fmt.bytes(cg.current) : null);

        const h = this._history;
        if (t.ioKnown) {
            this._set('ioRead', Fmt.rate(r.readBytes));
            this._set('ioWrite', Fmt.rate(r.writeBytes));
            this._set('ioReadTotal', Fmt.bytes(t.readBytes));
            this._set('ioWriteTotal', Fmt.bytes(t.writeBytes));
            this._set('ioLogical', r.rchar === null ? '…'
                : `↓ ${Fmt.rate(r.rchar)}  ↑ ${Fmt.rate(r.wchar)}`);
            if (r.readBytes === null) {
                setText(this._cards.disk.value, '…');
                setText(this._cards.disk.sub, '');
            } else {
                setText(this._cards.disk.value, Fmt.rate(r.readBytes + r.writeBytes));
                setText(this._cards.disk.sub, `R ${Fmt.shortBytes(r.readBytes)} · W ${Fmt.shortBytes(r.writeBytes)}`);
                push(h.read, r.readBytes);
                push(h.write, r.writeBytes);
                this._cards.disk.spark.setData([h.read, h.write], Math.max(RATE_FLOOR, ...h.read, ...h.write) * 1.15);
            }
        } else {
            for (const k of ['ioRead', 'ioWrite', 'ioReadTotal', 'ioWriteTotal', 'ioLogical'])
                this._set(k, _('not permitted'));
            setText(this._cards.disk.value, '–');
            setText(this._cards.disk.sub, _('not permitted'));
        }
        this._set('ioPsi', psi(cg?.ioPressure));

        if (net) {
            this._set('netDown', r.down === null ? _('measuring…') : Fmt.netRate(r.down));
            this._set('netUp', r.up === null ? _('measuring…') : Fmt.netRate(r.up));
            this._set('netConns', _('%d open, %d established').format(net.tcp, net.established));
            this._set('netUdp', String(net.udp));
            this._set('netListen', net.listening.length ? net.listening.join(', ') : _('nothing'));
            this._set('netTotal', `↓ ${Fmt.bytes(net.totalRecv)}  ↑ ${Fmt.bytes(net.totalSent)}`);
            this._set('netHosts', net.topHosts.length
                ? net.topHosts.map(x => `${x.host}  ${Fmt.bytes(x.bytes)}`).join('\n')
                : _('none'));
            if (r.down === null) {
                setText(this._cards.net.value, '…');
                setText(this._cards.net.sub, '');
            } else {
                setText(this._cards.net.value, Fmt.netRate(r.down + r.up));
                setText(this._cards.net.sub, `↓ ${Fmt.shortNet(r.down)} · ↑ ${Fmt.shortNet(r.up)}`);
                push(h.down, r.down);
                push(h.up, r.up);
                this._cards.net.spark.setData([h.down, h.up], Math.max(RATE_FLOOR, ...h.down, ...h.up) * 1.15);
            }
        } else {
            for (const k of ['netDown', 'netUp', 'netConns', 'netUdp', 'netListen', 'netTotal', 'netHosts'])
                this._set(k, null);
            this._set('netDown', _('unavailable (needs the “ss” tool)'));
            setText(this._cards.net.value, '–');
            setText(this._cards.net.sub, _('unavailable'));
        }

        if (t.fdKnown) {
            this._set('fdTotal', Fmt.number(t.fds));
            this._set('fdFiles', Fmt.number(t.files));
            this._set('fdSockets', Fmt.number(t.sockets));
            this._set('fdPipes', Fmt.number(t.pipes));
        } else {
            for (const k of ['fdTotal', 'fdFiles', 'fdSockets', 'fdPipes'])
                this._set(k, _('not permitted'));
        }
    }

    updateStorage(storage) {
        if (!storage) {
            for (const k of ['stTotal', 'stInstall', 'stConfig', 'stData', 'stCache', 'stSandbox'])
                this._set(k, null);
            this._set('stTotal', _('unavailable'));
            this._set('cacheDisk', null);
            return;
        }
        const keys = {install: 'stInstall', config: 'stConfig', data: 'stData', cache: 'stCache', sandbox: 'stSandbox'};
        const home = GLib.get_home_dir();
        for (const c of storage.categories) {
            const paths = c.paths.map(p => p.startsWith(home) ? `~${p.slice(home.length)}` : p);
            this._set(keys[c.label], c.paths.length ? Fmt.bytes(c.bytes) : null, paths.join('\n'));
        }
        this._set('stTotal', Fmt.bytes(storage.total));
        const cache = storage.categories.find(c => c.label === 'cache');
        this._set('cacheDisk', cache?.paths.length ? Fmt.bytes(cache.bytes) : _('none found'));
    }

    destroy() {
        for (const row of this._procRows.values())
            row.actor.destroy();
        this._procRows.clear();
        this._procAction.destroy();
        this.actor.destroy();
    }
}
