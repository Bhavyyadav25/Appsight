// SPDX-License-Identifier: GPL-3.0-or-later
// Gives each group a human name and icon by matching it to an installed app,
// and finds the system monitor app.

import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

const SYSTEM_MONITOR_IDS = [
    'org.gnome.SystemMonitor.desktop',
    'gnome-system-monitor.desktop',
    'gnome-system-monitor_gnome-system-monitor.desktop',
    'org.gnome.Usage.desktop',
    'io.missioncenter.MissionCenter.desktop',
];

/** "org.gnome.Settings" -> "Settings", "gvfs-daemon" -> "Gvfs daemon" */
function prettifyId(id) {
    const parts = id.split('.');
    const name = parts.length >= 3 ? parts.slice(2).join(' ') : parts[parts.length - 1];
    return name.replace(/[-_]+/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

export class AppIdentity {
    constructor() {
        this._appSystem = Shell.AppSystem.get_default();
        this._cache = new Map(); // group key -> {app, displayName, gicon}
        this._icons = {
            app: new Gio.ThemedIcon({name: 'application-x-executable-symbolic'}),
            service: new Gio.ThemedIcon({name: 'system-run-symbolic'}),
            system: new Gio.ThemedIcon({names: ['emblem-system-symbolic', 'preferences-system-symbolic']}),
            command: new Gio.ThemedIcon({name: 'utilities-terminal-symbolic'}),
        };
    }

    /** Set `shellApp`, `displayName`, `gicon` and `windowed` on every group. */
    decorate(groups) {
        const pidApp = new Map();
        for (const app of this._appSystem.get_running()) {
            for (const pid of app.get_pids())
                pidApp.set(pid, app);
        }

        for (const g of groups.values()) {
            let windowApp = null;
            for (const p of g.procs) {
                windowApp = pidApp.get(p.pid);
                if (windowApp)
                    break;
            }
            g.windowed = windowApp !== null;

            // Lookups are cached until clear(), i.e. for as long as the menu stays open.
            let id = this._cache.get(g.key);
            if (!id || (!id.app && windowApp)) {
                let app = null;
                for (const desktopId of g.desktopIds) {
                    app = this._appSystem.lookup_app(desktopId);
                    if (app)
                        break;
                }
                app ??= windowApp;
                if (!app && g.kind === 'command' && g.exe)
                    app = this._appSystem.lookup_heuristic_basename(g.exe);
                id = {
                    app,
                    displayName: app?.get_name() ?? (g.kind === 'command' ? g.name : prettifyId(g.name)),
                    gicon: app?.get_icon() ?? this._icons[g.kind] ?? this._icons.app,
                };
                this._cache.set(g.key, id);
            }
            g.shellApp = id.app;
            g.displayName = id.displayName;
            g.gicon = id.gicon;
        }
    }

    /** Whether the system monitor button has anything to open. */
    hasSystemMonitor(command) {
        return command !== '' || this.systemMonitorApp() !== null;
    }

    /**
     * Run `command` if one is set, otherwise open the first installed system
     * monitor. Throws if the command can't be run.
     */
    openSystemMonitor(command) {
        if (!command) {
            this.systemMonitorApp()?.activate();
            return;
        }
        Gio.AppInfo.create_from_commandline(command, null, Gio.AppInfoCreateFlags.NONE)
            .launch([], global.create_app_launch_context(0, -1));
    }

    /** The first installed system monitor app, or null. */
    systemMonitorApp() {
        for (const id of SYSTEM_MONITOR_IDS) {
            const app = this._appSystem.lookup_app(id);
            if (app)
                return app;
        }
        return null;
    }

    clear() {
        this._cache.clear();
    }
}
