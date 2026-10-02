// SPDX-License-Identifier: GPL-3.0-or-later
// The top-bar button. It decides what to sample (Monitor) and when
// (RefreshScheduler), what to show (PanelStatus, ListView, DetailView) and
// routes actions (Terminator, AppIdentity); it does no sampling or drawing itself.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DetailView} from './detailView.js';
import * as Fmt from './format.js';
import {isCancelled} from './fsutil.js';
import {AppIdentity} from './identity.js';
import {Terminator} from './kill.js';
import {ListView} from './listView.js';
import {Monitor} from './monitor.js';
import {LIST_KEYS, PANEL_KEYS, UNIT_KEYS, listOptions, panelOptions, unitOptions} from './options.js';
import {PanelStatus} from './panelStatus.js';
import {RefreshScheduler} from './scheduler.js';
import {StorageCache} from './storage.js';
import {Timers} from './timers.js';

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, extension.metadata.name, false);

        this._name = extension.metadata.name;
        this._extension = extension;
        this._settings = extension.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._storageCancellable = null;
        this._monitor = new Monitor();
        this._identity = new AppIdentity();
        this._storage = new StorageCache();
        this._timers = new Timers();
        this._terminator = new Terminator({
            monitor: this._monitor,
            timers: this._timers,
            graceSeconds: () => this._settings.get_int('kill-timeout'),
            onSignalled: () => this._kick(400),
            onError: (name, errors) => Main.notify(this._name, _('Could not end %s: %s').format(name, errors)),
        });
        this._scheduler = new RefreshScheduler({
            timers: this._timers,
            interval: () => this._settings.get_int('refresh-interval'),
            onTick: () => this._tick(),
        });
        this._hoverId = 0;
        this._busy = false;
        this._pending = false;
        this._destroyed = false;
        this._groups = new Map();
        this._detailKey = null;

        this._panel = new PanelStatus(`${extension.path}/icons/appsight-symbolic.svg`);
        this.add_child(this._panel);
        this._applyUnits();
        this._applyPanelOptions();

        // Both views are only built while the menu is open.
        const needsConfirm = () => this._settings.get_boolean('confirm-kill');
        this.menu.box.add_style_class_name('as-menu');
        this._list = null;
        this._listCallbacks = {
            needsConfirm,
            onOpen: group => this._openDetail(group),
            onKill: group => this._terminator.endGroup(group, false),
            onSort: key => this._settings.set_string('sort-key', key),
            onCategory: key => this._settings.set_string('list-category', key),
            hasSystemMonitor: () => this._identity.hasSystemMonitor(this._systemMonitorCommand()),
            onSystemMonitor: () => {
                this.menu.close();
                this._openSystemMonitor();
            },
            onSettings: () => {
                this.menu.close();
                this._extension.openPreferences();
            },
        };
        this._detail = null;
        this._detailCallbacks = {
            needsConfirm,
            collapsedSections: () => this._settings.get_strv('collapsed-sections'),
            onCollapsedChanged: ids => this._settings.set_strv('collapsed-sections', ids),
            onBack: () => this._showList(),
            onKill: (group, force) => {
                this._terminator.endGroup(group, force);
                this._showList();
            },
            onKillProcess: proc => this._terminator.endProcess(proc),
        };
        // PopupMenu won't open while it has no visible children; this stands in for the views.
        this._placeholder = new St.Widget();
        this.menu.box.add_child(this._placeholder);

        // Signals on this actor and its menu end with them; the settings outlive
        // us, so those go through connectObject() and are dropped in _cleanup().
        this.menu.connect('open-state-changed', (_menu, open) => this._onOpenStateChanged(open));
        this.connect('destroy', () => this._cleanup());
        this.connect('enter-event', () => this._onEnter());
        this.connect('leave-event', () => {
            this._hoverId = this._timers.remove(this._hoverId);
            return Clutter.EVENT_PROPAGATE;
        });
        this._settings.connectObject(
            'changed::refresh-interval', () => this._restartTimer(),
            'changed::panel-text', () => {
                this._updatePanel();
                this._restartTimer();
                this._kick(0);
            },
            'changed::sort-key', () => this._list?.setSortKey(this._settings.get_string('sort-key')),
            'changed::list-category', () => this._list?.setCategory(this._settings.get_string('list-category')),
            'changed::show-system-processes', () => this._kick(0),
            'changed', (_settings, key) => {
                if (UNIT_KEYS.includes(key)) {
                    this._applyUnits();
                    this._updatePanel();
                    this._kick(0);
                } else if (PANEL_KEYS.includes(key)) {
                    this._applyPanelOptions();
                    this._updatePanel();
                } else if (LIST_KEYS.includes(key)) {
                    this._applyListOptions();
                }
            },
            this);
        this._applyMenuWidth();

        this._restartTimer();
        this._tick();
    }

    // ---- scheduling -------------------------------------------------------

    /** The timer only runs while something is visible: the panel text or the menu. */
    _restartTimer() {
        if (this._settings.get_string('panel-text') === 'none' && !this.menu.isOpen)
            this._scheduler.stop();
        else
            this._scheduler.start();
    }

    _kick(ms) {
        this._scheduler.kick(ms);
    }

    _onEnter() {
        if (this._settings.get_boolean('open-on-hover') && !this.menu.isOpen) {
            this._timers.remove(this._hoverId);
            this._hoverId = this._timers.after(this._settings.get_int('hover-delay'), () => {
                this._hoverId = 0;
                if (this.hover && !this.menu.isOpen)
                    this.menu.open();
            });
        }
        return Clutter.EVENT_PROPAGATE;
    }

    async _tick() {
        if (this._destroyed)
            return;
        if (this._busy) {
            this._pending = true;
            return;
        }
        this._busy = true;
        const cancellable = this._cancellable;
        const started = GLib.get_monotonic_time();
        try {
            const mode = this._settings.get_string('panel-text');
            const open = this.menu.isOpen;
            if (mode !== 'none' || open) {
                await this._monitor.sampleSystem({
                    cpu: mode === 'cpu' || mode === 'both',
                    mem: mode === 'memory' || mode === 'both',
                    full: open,
                }, cancellable);
                if (this._destroyed)
                    return;
                this._updatePanel();
            }

            if (this.menu.isOpen) {
                const groups = await this._monitor.sampleGroups(
                    this._settings.get_boolean('show-system-processes'), cancellable);
                if (this._destroyed || !this.menu.isOpen)
                    return;
                this._identity.decorate(groups);
                this._groups = groups;
                // The list is hidden while the details are shown; don't lay it out.
                if (this._detailKey)
                    await this._refreshDetail(cancellable);
                else
                    this._updateList();
            }
        } catch (e) {
            if (!isCancelled(e))
                logError(e, `${this._name}: refresh failed`);
        } finally {
            this._busy = false;
        }
        if (!this._destroyed)
            this._scheduler.noteCost((GLib.get_monotonic_time() - started) / 1000);
        if (this._pending && !this._destroyed) {
            this._pending = false;
            this._tick();
        }
    }

    // ---- options ----------------------------------------------------------

    _applyUnits() {
        Fmt.configure(unitOptions(this._settings));
    }

    _applyPanelOptions() {
        this._panel.setOptions(panelOptions(this._settings));
    }

    _applyListOptions() {
        this._applyMenuWidth();
        this._list?.setOptions(listOptions(this._settings));
    }

    _applyMenuWidth() {
        this.menu.box.set_style(`width: ${this._settings.get_int('menu-width')}px;`);
    }

    _systemMonitorCommand() {
        return this._settings.get_string('system-monitor-command').trim();
    }

    _openSystemMonitor() {
        const command = this._systemMonitorCommand();
        try {
            this._identity.openSystemMonitor(command);
        } catch (e) {
            Main.notify(this._name, _('Could not run %s: %s').format(command, e.message));
        }
    }

    // ---- views ------------------------------------------------------------

    _updatePanel() {
        const m = this._monitor;
        this._panel.update(this._settings.get_string('panel-text'), m.sys, m.cpuHistory, m.memHistory);
    }

    _updateList() {
        if (this._list && this._monitor.sys)
            this._list.update([...this._groups.values()], this._monitor.sys, this._monitor.cpuHistory);
    }

    _onOpenStateChanged(open) {
        if (this._destroyed)
            return; // the menu closes itself while being destroyed
        if (open) {
            this._hoverId = this._timers.remove(this._hoverId);
            if (!this._list) {
                this._list = new ListView(this._listCallbacks);
                this._list.setSortKey(this._settings.get_string('sort-key'));
                this._list.setCategory(this._settings.get_string('list-category'));
                this._applyListOptions();
                this.menu.box.insert_child_at_index(this._list.actor, 0);
            }
            this._placeholder.visible = false;
            this._monitor.beginSession();
            this._showList();
            this._restartTimer();
            this._tick();
            this._kick(700); // second sample so CPU numbers appear quickly
            this._timers.after(0, () => {
                if (this.menu.isOpen && !this._detailKey)
                    this._list?.entry.grab_key_focus();
            });
        } else {
            this._showList();
            // Nothing is sampled per process while closed; free what the last sample held.
            this._groups = new Map();
            this._identity.clear();
            this._monitor.endSession();
            this._list?.destroy();
            this._list = null;
            this._placeholder.visible = true;
            this._restartTimer();
        }
    }

    _showList() {
        const wasDetail = this._detailKey !== null;
        this._detailKey = null;
        this._storageCancellable?.cancel();
        this._storageCancellable = null;
        this._detail?.destroy();
        this._detail = null;
        if (!this._list)
            return;
        this._list.actor.visible = true;
        // The list wasn't updated while hidden; bring it up to date.
        if (wasDetail && this.menu.isOpen)
            this._updateList();
    }

    _openDetail(group) {
        if (!group)
            return;
        this._detailKey = group.key;
        this._monitor.resetDetail();
        this._detail?.destroy();
        this._detail = new DetailView(this._detailCallbacks);
        this.menu.box.add_child(this._detail.actor);
        this._detail.show(group);
        this._detail.updateGroup(group, this._monitor.sys);
        if (this._list)
            this._list.actor.visible = false;
        // Free the hidden list's rows, but not inside the click on one of them.
        this._timers.after(0, () => {
            if (this._detailKey)
                this._list?.suspend();
        });
        this._detail.backButton.grab_key_focus();
        this._loadStorage(group);

        this._kick(0);
        this._kick(900); // second detail sample gives the first rates
    }

    _loadStorage(group) {
        this._storageCancellable?.cancel();
        this._storageCancellable = null;
        const cached = this._storage.lookup(group.key);
        if (cached) {
            this._detail.updateStorage(cached);
            return;
        }
        const cancellable = new Gio.Cancellable();
        this._storageCancellable = cancellable;
        this._storage.measure(group, cancellable).then(storage => {
            if (!cancellable.is_cancelled() && this._detailKey === group.key)
                this._detail.updateStorage(storage);
        }).catch(e => {
            if (!isCancelled(e) && this._detailKey === group.key)
                this._detail.updateStorage(null);
        });
    }

    async _refreshDetail(cancellable) {
        const group = this._groups.get(this._detailKey);
        if (!group) {
            this._showList();
            return;
        }
        this._detail.updateGroup(group, this._monitor.sys);
        const details = await this._monitor.sampleDetail(group, cancellable);
        if (!this._destroyed && this._detailKey === group.key)
            this._detail.updateDetails(details);
    }

    // ---- lifecycle --------------------------------------------------------

    destroy() {
        this._cleanup();
        // The views own actors that aren't always in the menu (the shared end buttons).
        this._detail?.destroy();
        this._detail = null;
        this._list?.destroy();
        this._list = null;
        super.destroy();
    }

    /** Stop all work. Also runs when the shell disposes the actor without destroy(), e.g. on exit. */
    _cleanup() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._cancellable.cancel();
        this._storageCancellable?.cancel();
        this._terminator.stop();
        this._timers.clear();
        this._storage.clear();
        this._identity.clear();
        this._settings.disconnectObject(this);
        this._settings = null;
    }
});
