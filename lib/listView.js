// SPDX-License-Identifier: GPL-3.0-or-later
// The overview: system summary, then one row per app, sorted and filterable.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Fmt from './format.js';
import {kindLabel} from './labels.js';
import {Bar, SharedAction, Sparkline, icon, label, setScrollChild, setText, setVariant, vbox} from './widgets.js';

const CPU_BAR_WIDTH = 52;
// Rows are created a page at a time as the list is scrolled: only ~10 fit on
// screen, and every row is ~20 actors that are laid out on every refresh.
const PAGE_SIZE = 15;
const MEM_BAR_WIDTH = 72;

const collator = new Intl.Collator();

// Bars are relative to the busiest app, but never scaled up past these floors so
// an idle machine doesn't show full bars for 0.2 % CPU.
const CPU_SCALE_FLOOR = 10; // percent of all CPUs
const MEM_SCALE_FLOOR = 0.05; // fraction of RAM

/** Which filter chip a group falls under. */
function category(group) {
    if (group.kind === 'app')
        return 'apps';
    if (group.kind === 'command' && !group.foreign)
        return 'commands';
    return 'services';
}

const GroupRow = GObject.registerClass(
class GroupRow extends PopupMenu.PopupBaseMenuItem {
    _init(callbacks, action) {
        super._init({style_class: 'as-row'});
        this._callbacks = callbacks;
        this._sharedAction = action;
        this.group = null;
        this._killable = false;
        this._cpuHot = false;
        this._memHot = false;
        this._iconKind = null;

        // Real apps show their own icon; anything else gets a symbolic glyph on a tinted tile.
        this._icon = new St.Icon({style_class: 'as-row-icon'});
        this._tile = new St.Bin({style_class: 'as-tile', child: this._icon, y_align: Clutter.ActorAlign.CENTER});
        const text = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'as-row-text'});
        this._name = label('', 'as-row-name');
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._sub = label('', 'as-row-sub');
        text.add_child(this._name);
        text.add_child(this._sub);

        const metric = (cls, width) => {
            const box = vbox({style_class: `as-metric ${cls}`, y_align: Clutter.ActorAlign.CENTER});
            const value = label('', 'as-metric-value', {x_align: Clutter.ActorAlign.END});
            const bar = new Bar({width, styleClass: cls});
            box.add_child(value);
            box.add_child(bar);
            return [box, value, bar];
        };
        let cpuBox, memBox;
        [cpuBox, this._cpu, this._cpuBar] = metric('as-col-cpu', CPU_BAR_WIDTH);
        [memBox, this._mem, this._memBar] = metric('as-col-mem', MEM_BAR_WIDTH);

        // The end button (or lock) only shows on hover/focus, so one shared
        // button moves into this slot instead of every row having its own.
        this._action = new St.Widget({
            style_class: 'as-col-action',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.connect('notify::active', () => this._syncAction());
        this.connect('destroy', () => this._sharedAction.release(this));

        for (const w of [this._tile, text, cpuBox, memBox, this._action])
            this.add_child(w);
    }

    _syncAction() {
        this._sharedAction.request(this, this._action, this._killable, this.active);
    }

    update(group, scale, sys, hot) {
        this.group = group;
        this._icon.gicon = group.gicon;
        const kind = group.shellApp ? 'app' : group.kind;
        if (kind !== this._iconKind) {
            this._iconKind = setVariant(this._tile, 'as-tile-', kind, this._iconKind);
            this._icon.icon_size = group.shellApp ? 30 : 16;
        }
        setText(this._name, group.displayName);
        const n = group.procs.length;
        setText(this._sub, n > 1
            ? `${kindLabel(group)} · ${ngettext('%d process', '%d processes', n).format(n)}`
            : kindLabel(group));
        setText(this._cpu, group.cpuKnown ? Fmt.cpu(group.cpu) : '…');
        setText(this._mem, Fmt.bytes(group.mem));
        this._cpuBar.setFraction(group.cpu / scale.cpu);
        this._memBar.setFraction(group.mem / scale.mem);

        // Toggling a style class restyles the actor, so only do it on a change.
        const memShare = sys.memTotal ? group.mem / sys.memTotal * 100 : 0;
        const cpuHot = group.cpu >= hot.cpu;
        const memHot = memShare >= hot.mem;
        if (cpuHot !== this._cpuHot) {
            this._cpuHot = cpuHot;
            this._cpu[cpuHot ? 'add_style_class_name' : 'remove_style_class_name']('as-hot');
        }
        if (memHot !== this._memHot) {
            this._memHot = memHot;
            this._mem[memHot ? 'add_style_class_name' : 'remove_style_class_name']('as-hot');
        }

        const killable = !group.protected && !group.foreign;
        if (killable !== this._killable) {
            this._killable = killable;
            if (this.active)
                this._syncAction();
        }
    }

    activate(_event) {
        // Open the details instead of closing the menu.
        this._callbacks.onOpen(this.group);
    }
});

/** One of the three system cards at the top of the list. */
function statCard(title, iconName, kind, extra) {
    const card = vbox({style_class: `as-stat as-stat-${kind}`, x_expand: true});
    const head = new St.BoxLayout({style_class: 'as-stat-head'});
    head.add_child(icon(iconName, 'as-stat-icon'));
    head.add_child(label(title, 'as-stat-title', {x_expand: true}));
    card.add_child(head);
    const value = label('–', 'as-stat-value');
    card.add_child(value);
    card.add_child(extra);
    const sub = label('', 'as-stat-sub');
    card.add_child(sub);
    return {card, value, sub};
}

export class ListView {
    constructor(callbacks) {
        this._callbacks = callbacks;
        this._rows = new Map();
        this._order = []; // group keys in the order the rows are currently shown
        this._groups = [];
        this._sys = null;
        this._sortKey = 'cpu';
        this._category = 'all';
        this._hot = {cpu: 25, mem: 15};
        this._hidden = new Set();
        this._limit = PAGE_SIZE;
        this._matchCount = 0;
        this._restoreScroll = null;
        this._action = new SharedAction({
            confirmText: _('End?'),
            accessibleName: _('End'),
            needsConfirm: callbacks.needsConfirm,
            onActivate: row => this._callbacks.onKill(row.group),
        });

        this.actor = vbox({style_class: 'as-list-view', x_expand: true});

        // System summary
        this._cpuSpark = new Sparkline({style_class: 'as-spark as-spark-cpu', capacity: 60, dot: true});
        this._memBar = new Bar({width: 128, styleClass: 'as-stat-bar as-bar-mem'});
        this._swapBar = new Bar({width: 128, styleClass: 'as-stat-bar as-bar-swap'});
        const memExtra = vbox({style_class: 'as-stat-bars', y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        memExtra.add_child(this._memBar);
        memExtra.add_child(this._swapBar);
        this._loadBar = new Bar({width: 128, styleClass: 'as-stat-bar as-bar-load'});
        const loadExtra = new St.Bin({style_class: 'as-stat-bars', y_expand: true, y_align: Clutter.ActorAlign.CENTER, child: this._loadBar});

        const stats = new St.BoxLayout({style_class: 'as-stats'});
        this._stats = stats;
        stats.layout_manager.homogeneous = true;
        this._cpuCard = statCard(_('CPU'), 'speedometer-symbolic', 'cpu', this._cpuSpark);
        this._memCard = statCard(_('Memory'), 'drive-harddisk-solidstate-symbolic', 'mem', memExtra);
        this._loadCard = statCard(_('Load'), 'system-run-symbolic', 'load', loadExtra);
        for (const c of [this._cpuCard, this._memCard, this._loadCard])
            stats.add_child(c.card);
        this.actor.add_child(stats);

        // Filter
        this.entry = new St.Entry({
            style_class: 'as-search',
            hint_text: _('Search apps, processes or PIDs…'),
            can_focus: true,
            x_expand: true,
        });
        this.entry.set_primary_icon(new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'as-search-icon'}));
        this._clearIcon = new St.Icon({icon_name: 'edit-clear-symbolic', style_class: 'as-search-icon'});
        this.entry.connect('secondary-icon-clicked', () => this.clearFilter());
        this.entry.clutter_text.connect('text-changed', () => {
            this.entry.set_secondary_icon(this.entry.get_text() ? this._clearIcon : null);
            this._resetLimit();
            this._render();
        });
        this.actor.add_child(this.entry);

        // Category chips
        const chips = new St.BoxLayout({style_class: 'as-chips'});
        this._chips = {};
        for (const [key, text] of [['all', _('All')], ['apps', _('Apps')], ['services', _('Services')], ['commands', _('Commands')]]) {
            const chip = new St.Button({
                style_class: 'as-chip',
                can_focus: true,
                toggle_mode: false,
                child: new St.BoxLayout({style_class: 'as-chip-box'}),
            });
            const name = label(text, 'as-chip-label');
            const count = label('', 'as-chip-count');
            chip.child.add_child(name);
            chip.child.add_child(count);
            chip.connect('clicked', () => this._callbacks.onCategory(key));
            this._chips[key] = {chip, count};
            chips.add_child(chip);
        }
        this.actor.add_child(chips);

        // Column headers double as sort buttons
        const columns = new St.BoxLayout({style_class: 'as-columns'});
        this._sortButtons = {};
        const addColumn = (key, text, cls, expand) => {
            const button = new St.Button({
                style_class: `as-column-button ${cls}`,
                x_expand: expand,
                can_focus: true,
                child: new St.BoxLayout({style_class: 'as-column-box', x_expand: expand}),
            });
            const textLabel = label(text, 'as-column-label', {x_expand: expand});
            const arrow = new St.Icon({icon_name: 'pan-down-symbolic', style_class: 'as-column-arrow', opacity: 0});
            button.child.add_child(textLabel);
            button.child.add_child(arrow);
            button.connect('clicked', () => this._callbacks.onSort(key));
            this._sortButtons[key] = {button, arrow};
            columns.add_child(button);
        };
        addColumn('name', _('Name'), 'as-col-name', true);
        addColumn('cpu', _('CPU'), 'as-col-cpu', false);
        addColumn('memory', _('Memory'), 'as-col-mem', false);
        columns.add_child(new St.Widget({style_class: 'as-col-action'}));
        this.actor.add_child(columns);

        // Rows
        this._section = new PopupMenu.PopupMenuSection();
        this._scroll = new St.ScrollView({
            style_class: 'as-scroll as-list-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        setScrollChild(this._scroll, this._section.actor);
        this._scroll.vadjustment.connect('notify::value', adj => {
            // Near the bottom: create the next page of rows.
            if (this._limit < this._matchCount && adj.value + adj.page_size >= adj.upper - 200) {
                this._limit += PAGE_SIZE;
                this._render();
            }
        });
        this.actor.add_child(this._scroll);

        this._empty = vbox({style_class: 'as-empty', x_align: Clutter.ActorAlign.CENTER});
        this._emptyIcon = new St.Icon({icon_name: 'content-loading-symbolic', style_class: 'as-empty-icon', x_align: Clutter.ActorAlign.CENTER});
        this._emptyLabel = label(_('Loading…'), 'as-empty-label', {x_align: Clutter.ActorAlign.CENTER});
        this._empty.add_child(this._emptyIcon);
        this._empty.add_child(this._emptyLabel);
        this.actor.add_child(this._empty);

        // Footer
        const footer = new St.BoxLayout({style_class: 'as-footer'});
        this._summary = label('', 'as-summary', {x_expand: true});
        footer.add_child(this._summary);
        const footerButton = (iconName, text, cb) => {
            const button = new St.Button({
                style_class: 'as-footer-button',
                can_focus: true,
                accessible_name: text,
                child: icon(iconName, 'as-footer-icon'),
            });
            button.connect('clicked', cb);
            footer.add_child(button);
            return button;
        };
        this._monitorButton = footerButton('utilities-system-monitor-symbolic', _('Open System Monitor'),
            () => this._callbacks.onSystemMonitor());
        this._monitorButton.visible = callbacks.hasSystemMonitor();
        footerButton('emblem-system-symbolic', _('Settings'), () => this._callbacks.onSettings());
        this.actor.add_child(footer);

        this.setCategory('all');
    }

    /**
     * @param {object} options
     * @param {boolean} options.showSummary  show the system cards
     * @param {number} options.hotCpu  highlight from this share of all CPUs
     * @param {number} options.hotMem  highlight from this percent of RAM
     * @param {string[]} options.hidden  names or unit names left out of the list
     */
    setOptions({showSummary, hotCpu, hotMem, hidden}) {
        this._stats.visible = showSummary;
        this._hot = {cpu: hotCpu, mem: hotMem};
        this._hidden = new Set(hidden.map(h => h.trim().toLowerCase()).filter(h => h));
        this._render();
    }

    _isHidden(group) {
        return this._hidden.size > 0 &&
            (this._hidden.has(group.displayName.toLowerCase()) || this._hidden.has(group.key.toLowerCase()));
    }

    setSortKey(key) {
        this._sortKey = key;
        for (const [k, {button, arrow}] of Object.entries(this._sortButtons)) {
            if (k === key) {
                button.add_style_pseudo_class('checked');
                arrow.opacity = 255;
                arrow.icon_name = key === 'name' ? 'pan-up-symbolic' : 'pan-down-symbolic';
            } else {
                button.remove_style_pseudo_class('checked');
                arrow.opacity = 0;
            }
        }
        this._render();
    }

    setCategory(key) {
        this._category = key;
        for (const [k, {chip}] of Object.entries(this._chips)) {
            if (k === key)
                chip.add_style_pseudo_class('checked');
            else
                chip.remove_style_pseudo_class('checked');
        }
        this._scroll.vadjustment.value = 0;
        this._resetLimit();
        this._render();
    }

    _resetLimit() {
        this._limit = PAGE_SIZE;
    }

    update(groups, sys, cpuHistory) {
        groups = groups.filter(g => !this._isHidden(g));
        this._groups = groups;
        this._sys = sys;

        const counts = {all: groups.length, apps: 0, services: 0, commands: 0};
        let procs = 0;
        for (const g of groups) {
            counts[category(g)]++;
            procs += g.procs.length;
        }
        for (const [k, {count}] of Object.entries(this._chips))
            setText(count, String(counts[k]));
        setText(this._summary, `${ngettext('%d process', '%d processes', procs).format(procs)} · ${
            ngettext('%d thread', '%d threads', sys.tasksTotal).format(sys.tasksTotal)}`);
        this.updateSystem(sys, cpuHistory);
        this._render();
    }

    updateSystem(sys, cpuHistory) {
        if (!sys)
            return;
        setText(this._cpuCard.value, Fmt.percent(sys.cpu));
        setText(this._cpuCard.sub, ngettext('%d core', '%d cores', sys.ncpu).format(sys.ncpu));
        if (cpuHistory)
            this._cpuSpark.setData([cpuHistory], Math.max(25, ...cpuHistory) * 1.1);

        setText(this._memCard.value, Fmt.percent(sys.memTotal ? sys.memUsed / sys.memTotal * 100 : null));
        this._memBar.setFraction(sys.memTotal ? sys.memUsed / sys.memTotal : 0);
        this._swapBar.setFraction(sys.swapTotal ? sys.swapUsed / sys.swapTotal : 0);
        this._swapBar.visible = sys.swapTotal > 0;
        setText(this._memCard.sub, `${Fmt.shortBytes(sys.memUsed)} / ${Fmt.shortBytes(sys.memTotal)}${
            sys.swapUsed > 0 ? ` · ${_('swap')} ${Fmt.shortBytes(sys.swapUsed)}` : ''}`);

        setText(this._loadCard.value, sys.load[0].toFixed(2));
        this._loadBar.setFraction(sys.load[0] / sys.ncpu);
        setText(this._loadCard.sub, `${sys.load[1].toFixed(2)} · ${sys.load[2].toFixed(2)}`);
    }

    _sorted() {
        // Hidden apps are also dropped here so a change in the settings shows at once.
        const g = this._groups.filter(x => (this._category === 'all' || category(x) === this._category) &&
            !this._isHidden(x));
        const byName = (a, b) => collator.compare(a.displayName, b.displayName);
        if (this._sortKey === 'name')
            g.sort(byName);
        else if (this._sortKey === 'memory')
            g.sort((a, b) => b.mem - a.mem || byName(a, b));
        else
            g.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem || byName(a, b));
        return g;
    }

    _render() {
        if (!this._sys)
            return;
        const filter = this.entry.get_text().trim().toLowerCase();
        const matches = g => !filter ||
            g.displayName.toLowerCase().includes(filter) ||
            g.key.toLowerCase().includes(filter) ||
            g.procs.some(p => p.comm.toLowerCase().includes(filter) || String(p.pid) === filter);

        const matching = this._sorted().filter(matches);
        this._matchCount = matching.length;
        const visible = matching.slice(0, this._limit);
        const seen = new Set(visible.map(g => g.key));
        for (const [key, row] of this._rows) {
            if (!seen.has(key)) {
                row.destroy();
                this._rows.delete(key);
            }
        }

        const scale = {cpu: CPU_SCALE_FLOOR, mem: this._sys.memTotal * MEM_SCALE_FLOOR};
        for (const g of matching) {
            scale.cpu = Math.max(scale.cpu, g.cpu);
            scale.mem = Math.max(scale.mem, g.mem);
        }

        // Moving a row relayouts the whole list, so only move rows that are out of place.
        const order = this._order.filter(key => seen.has(key));
        visible.forEach((group, position) => {
            let row = this._rows.get(group.key);
            if (!row) {
                row = new GroupRow(this._callbacks, this._action);
                this._rows.set(group.key, row);
                this._section.addMenuItem(row, position);
                order.splice(position, 0, group.key);
            } else if (order[position] !== group.key) {
                this._section.box.set_child_at_index(row, position);
                order.splice(order.indexOf(group.key), 1);
                order.splice(position, 0, group.key);
            }
            row.update(group, scale, this._sys, this._hot);
        });
        this._order = order;

        if (this._restoreScroll !== null && visible.length > 0) {
            // Rows were just recreated; scroll back once they've been laid out.
            const value = this._restoreScroll;
            this._restoreScroll = null;
            const adj = this._scroll.vadjustment;
            const id = adj.connect('changed', () => {
                adj.disconnect(id);
                adj.value = value;
            });
        }

        const empty = visible.length === 0;
        this._empty.visible = empty;
        this._scroll.visible = !empty;
        if (empty) {
            const searching = filter || this._category !== 'all';
            this._emptyIcon.icon_name = searching ? 'edit-find-symbolic' : 'content-loading-symbolic';
            setText(this._emptyLabel, searching ? _('Nothing matches') : _('Loading…'));
        }
    }

    clearFilter() {
        this.entry.set_text('');
    }

    /** Free the rows while another view is shown; the next update() recreates them where they were. */
    suspend() {
        this._restoreScroll = this._scroll.vadjustment.value;
        for (const row of this._rows.values())
            row.destroy();
        this._rows.clear();
        this._order = [];
    }

    destroy() {
        this._section.destroy();
        this._action.destroy();
        this.actor.destroy();
    }
}
