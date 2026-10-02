// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Cairo from 'cairo';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PREVIEW_CSS = `
.as-preview {
    background-color: #000000;
    color: #ffffff;
    border-radius: 999px;
    padding: 6px 16px;
}
.as-preview-value { font-weight: 600; font-feature-settings: "tnum"; }
.as-preview-graph { background-color: rgba(255, 255, 255, 0.1); border-radius: 4px; }
.as-preview-dim { opacity: 0.55; }
.as-hero-version {
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 0.85em;
    font-weight: bold;
}
`;

/** Prefix a row with a symbolic icon. */
function withIcon(row, iconName) {
    row.add_prefix(new Gtk.Image({icon_name: iconName}));
    return row;
}

/** Trace a smooth curve through `points` (same drawing as the top bar graph). */
function smoothPath(cr, points, top, bottom) {
    const clamp = y => Math.max(top, Math.min(bottom, y));
    cr.moveTo(...points[0]);
    for (let i = 0; i < points.length - 1; i++) {
        const [x0, y0] = points[Math.max(0, i - 1)];
        const [x1, y1] = points[i];
        const [x2, y2] = points[i + 1];
        const [x3, y3] = points[Math.min(points.length - 1, i + 2)];
        cr.curveTo(x1 + (x2 - x0) / 6, clamp(y1 + (y2 - y0) / 6),
            x2 - (x3 - x1) / 6, clamp(y2 - (y3 - y1) / 6), x2, y2);
    }
}

/**
 * A live mock of the top bar button that follows the settings, fed with a
 * gentle random walk so the graph moves like the real one.
 */
function topBarPreview(settings, handlers, timers, iconPath) {
    const bar = new Gtk.Box({spacing: 6, halign: Gtk.Align.CENTER, css_classes: ['as-preview']});
    const icon = new Gtk.Image({gicon: Gio.icon_new_for_string(iconPath), pixel_size: 16});
    const graph = new Gtk.DrawingArea({content_height: 14, valign: Gtk.Align.CENTER, css_classes: ['as-preview-graph']});
    const value = new Gtk.Label({css_classes: ['as-preview-value']});
    bar.append(icon);
    bar.append(graph);
    bar.append(value);
    // Neighbors for scale, as they'd sit in a real top bar.
    const others = new Gtk.Box({spacing: 10, margin_start: 14, css_classes: ['as-preview-dim']});
    for (const name of ['network-wireless-symbolic', 'audio-volume-high-symbolic', 'battery-level-90-symbolic'])
        others.append(new Gtk.Image({icon_name: name, pixel_size: 16}));
    bar.append(others);

    // An invisible accent-colored widget tells us the current accent color.
    const accentProbe = new Gtk.Label({css_classes: ['accent']});
    const history = Array.from({length: 20}, (_v, i) => 8 + 6 * Math.sin(i / 2.5));
    let memBytes = 4.6e9;

    const graphColor = () => {
        if (settings.get_boolean('panel-graph-accent'))
            return accentProbe.get_color?.() ?? new Gdk.RGBA({red: 0.21, green: 0.52, blue: 0.89, alpha: 1});
        const rgba = new Gdk.RGBA();
        return rgba.parse(settings.get_string('panel-graph-color')) ? rgba : new Gdk.RGBA({red: 1, green: 1, blue: 1, alpha: 1});
    };

    graph.set_draw_func((_area, cr, w, h) => {
        const c = graphColor();
        const max = Math.max(20, ...history) * 1.1;
        const step = w / (history.length - 1);
        const points = history.map((v, i) => [i * step, h - 1 - v / max * (h - 2)]);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        smoothPath(cr, points, 1, h - 1);
        cr.lineTo(w, h);
        cr.lineTo(0, h);
        cr.closePath();
        const fill = new Cairo.LinearGradient(0, 0, 0, h);
        fill.addColorStopRGBA(0, c.red, c.green, c.blue, 0.38);
        fill.addColorStopRGBA(1, c.red, c.green, c.blue, 0);
        cr.setSource(fill);
        cr.fill();
        smoothPath(cr, points, 1, h - 1);
        cr.setSourceRGBA(c.red, c.green, c.blue, 1);
        cr.setLineWidth(1.2);
        cr.stroke();
        cr.$dispose();
    });

    const memText = () => {
        const binary = settings.get_boolean('binary-units');
        const v = memBytes / (binary ? 1024 ** 3 : 1e9);
        return `${v.toFixed(1)}G${binary ? 'i' : ''}`;
    };
    const cpuText = () => {
        const v = history[history.length - 1];
        return v >= 10 ? `${Math.round(v)}%` : `${v.toFixed(1)}%`;
    };

    const sync = () => {
        const mode = settings.get_string('panel-text');
        const parts = [];
        if (mode === 'cpu' || mode === 'both')
            parts.push(cpuText());
        if (mode === 'memory' || mode === 'both')
            parts.push(memText());
        value.label = parts.join('  ');
        value.visible = parts.length > 0;
        icon.visible = settings.get_boolean('panel-show-icon') || mode === 'none';
        graph.visible = mode !== 'none' && settings.get_boolean('panel-graph');
        graph.content_width = settings.get_int('panel-graph-width');
        graph.queue_draw();
    };
    for (const key of ['panel-text', 'panel-show-icon', 'panel-graph', 'panel-graph-width',
        'panel-graph-accent', 'panel-graph-color', 'binary-units'])
        handlers.push(settings.connect(`changed::${key}`, sync));
    sync();

    timers.push(GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        const last = history[history.length - 1];
        history.push(Math.max(1, Math.min(60, last + (Math.random() - 0.5) * 8)));
        history.shift();
        memBytes = Math.max(3.8e9, Math.min(5.4e9, memBytes + (Math.random() - 0.5) * 1.5e8));
        sync();
        return GLib.SOURCE_CONTINUE;
    }));

    const frame = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        css_classes: ['card'],
    });
    frame.append(new Gtk.Box({height_request: 6}));
    frame.append(bar);
    frame.append(new Gtk.Label({
        label: _('Live preview'),
        css_classes: ['caption', 'dim-label'],
        margin_bottom: 10,
    }));
    frame.append(accentProbe);
    accentProbe.visible = false;
    return frame;
}

/**
 * A combo row for a string-choice key. Gio.Settings.bind() can't map a string to
 * the row's index from GJS, so this syncs both ways and records its settings
 * handler in `handlers` for removal when the window closes.
 */
function comboRow(settings, handlers, key, title, subtitle, choices) {
    const model = new Gtk.StringList();
    for (const [, label] of choices)
        model.append(label);
    const row = new Adw.ComboRow({title, subtitle, model});
    const sync = () => {
        const i = choices.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(0, i);
    };
    sync();
    row.connect('notify::selected', () => settings.set_string(key, choices[row.selected][0]));
    handlers.push(settings.connect(`changed::${key}`, sync));
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** A color button for a string key holding a CSS color. */
function colorRow(settings, handlers, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle});
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });
    const stored = () => {
        const rgba = new Gdk.RGBA();
        return rgba.parse(settings.get_string(key)) ? rgba : null;
    };
    const sync = () => {
        const rgba = stored();
        if (rgba && !rgba.equal(button.rgba))
            button.rgba = rgba;
    };
    sync();
    button.connect('notify::rgba', () => {
        if (!stored()?.equal(button.rgba))
            settings.set_string(key, button.rgba.to_string());
    });
    handlers.push(settings.connect(`changed::${key}`, sync));
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

/** True for keys that may be used without a modifier (F1–F35 and the like). */
function standalone(keyval) {
    return keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;
}

/** A row showing a shortcut that, when activated, captures a new one. */
function shortcutRow(settings, handlers, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    const label = new Gtk.ShortcutLabel({disabled_text: _('Disabled'), valign: Gtk.Align.CENTER});
    const sync = () => {
        label.accelerator = settings.get_strv(key)[0] ?? '';
    };
    sync();
    handlers.push(settings.connect(`changed::${key}`, sync));
    row.add_suffix(label);

    row.connect('activated', () => {
        const status = new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title: _('Press a shortcut'),
            description: _('Esc to cancel, Backspace to turn the shortcut off'),
        });
        const dialog = new Adw.Window({
            modal: true,
            transient_for: row.get_root(),
            default_width: 420,
            default_height: 280,
            content: new Adw.ToolbarView({content: status}),
        });
        dialog.content.add_top_bar(new Adw.HeaderBar({show_title: false}));
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_controller, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (!mods && keyval === Gdk.KEY_Escape) {
                dialog.close();
            } else if (!mods && keyval === Gdk.KEY_BackSpace) {
                settings.set_strv(key, []);
                dialog.close();
            } else if ((mods || standalone(keyval)) && Gtk.accelerator_valid(keyval, mods)) {
                settings.set_strv(key, [Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods)]);
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(keys);
        dialog.present();
    });
    return row;
}

/** An editable list of names for a string-array key. */
function nameListGroup(settings, handlers, key, title, description) {
    const group = new Adw.PreferencesGroup({title, description});
    const entry = new Adw.EntryRow({title: _('Add an app'), show_apply_button: true});
    const add = () => {
        const name = entry.text.trim();
        const names = settings.get_strv(key);
        if (name && !names.some(n => n.toLowerCase() === name.toLowerCase()))
            settings.set_strv(key, [...names, name]);
        entry.text = '';
    };
    entry.connect('apply', add);
    entry.connect('entry-activated', add);
    group.add(entry);

    let rows = [];
    const sync = () => {
        for (const row of rows)
            group.remove(row);
        rows = settings.get_strv(key).map(name => {
            const row = new Adw.ActionRow({title: name});
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Show again'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => settings.set_strv(key, settings.get_strv(key).filter(n => n !== name)));
            row.add_suffix(remove);
            group.add(row);
            return row;
        });
    };
    sync();
    handlers.push(settings.connect(`changed::${key}`, sync));
    return group;
}

export default class AppsightPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        // The preferences run inside the Extensions app, which outlives this window.
        const handlers = [];
        const timers = [];
        const css = new Gtk.CssProvider();
        if (css.load_from_string)
            css.load_from_string(PREVIEW_CSS);
        else
            css.load_from_data(PREVIEW_CSS, -1);
        const display = window.get_display();
        Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        window.connect('close-request', () => {
            for (const id of handlers.splice(0))
                settings.disconnect(id);
            for (const id of timers.splice(0))
                GLib.source_remove(id);
            Gtk.StyleContext.remove_provider_for_display(display, css);
            return false;
        });

        window.set_default_size(620, 780);
        window.search_enabled = true;

        window.add(this._panelPage(settings, handlers, timers));
        window.add(this._menuPage(settings, handlers));
        window.add(this._behaviorPage(settings, handlers));
        window.add(this._aboutPage(settings, window));
    }

    _panelPage(settings, handlers, timers) {
        const page = new Adw.PreferencesPage({title: _('Top bar'), icon_name: 'video-display-symbolic'});

        const preview = new Adw.PreferencesGroup();
        preview.add(topBarPreview(settings, handlers, timers, `${this.path}/icons/appsight-symbolic.svg`));
        page.add(preview);

        const content = new Adw.PreferencesGroup({title: _('Content')});
        content.add(withIcon(comboRow(settings, handlers, 'panel-text', _('Show next to icon'), null, [
            ['none', _('Nothing')],
            ['cpu', _('CPU usage')],
            ['memory', _('Memory used')],
            ['both', _('CPU and memory')],
        ]), 'view-reveal-symbolic'));
        const icon = switchRow(settings, 'panel-show-icon', _('Show icon'),
            _('The icon always shows when there is nothing else in the top bar'));
        const fixed = switchRow(settings, 'panel-fixed-width', _('Steady width'),
            _('Keep the text from shrinking and growing as the numbers change'));
        content.add(withIcon(icon, 'image-x-generic-symbolic'));
        content.add(withIcon(fixed, 'format-justify-left-symbolic'));
        page.add(content);

        const graph = new Adw.PreferencesGroup({title: _('Graph')});
        const showGraph = switchRow(settings, 'panel-graph', _('Live graph'),
            _('A small history graph of the value shown in the top bar'));
        const width = spinRow(settings, 'panel-graph-width', _('Width'), _('Pixels'), 16, 80, 2);
        const accent = switchRow(settings, 'panel-graph-accent', _('Use accent color'),
            _('Follow the accent color picked in the system settings'));
        const color = colorRow(settings, handlers, 'panel-graph-color', _('Graph color'), null);
        const graphIcons = ['power-profile-performance-symbolic', 'zoom-fit-best-symbolic',
            'preferences-color-symbolic', 'color-select-symbolic'];
        [showGraph, width, accent, color].forEach((row, i) => graph.add(withIcon(row, graphIcons[i])));
        page.add(graph);

        const alerts = new Adw.PreferencesGroup({
            title: _('Alerts'),
            description: _('Turn the top bar orange while usage is high. Set to 0 to turn an alert off.'),
        });
        const cpuAlert = spinRow(settings, 'cpu-alert', _('CPU above'), _('Percent of all CPUs'), 0, 100, 5);
        const memAlert = spinRow(settings, 'memory-alert', _('Memory above'), _('Percent of RAM'), 0, 100, 5);
        alerts.add(withIcon(cpuAlert, 'dialog-warning-symbolic'));
        alerts.add(withIcon(memAlert, 'dialog-warning-symbolic'));
        page.add(alerts);

        const placement = new Adw.PreferencesGroup({title: _('Placement')});
        placement.add(withIcon(comboRow(settings, handlers, 'panel-position', _('Position'), null, [
            ['left', _('Left')],
            ['center', _('Center')],
            ['right', _('Right')],
        ]), 'view-dual-symbolic'));
        placement.add(withIcon(spinRow(settings, 'panel-index', _('Order'),
            _('0 puts it first, higher numbers move it right past other icons'), 0, 20, 1),
        'object-flip-horizontal-symbolic'));
        page.add(placement);

        const sync = () => {
            const mode = settings.get_string('panel-text');
            const text = mode !== 'none';
            icon.sensitive = text;
            fixed.sensitive = text;
            showGraph.sensitive = text;
            const graphOn = text && settings.get_boolean('panel-graph');
            width.sensitive = graphOn;
            accent.sensitive = graphOn;
            color.sensitive = graphOn && !settings.get_boolean('panel-graph-accent');
            cpuAlert.sensitive = mode === 'cpu' || mode === 'both';
            memAlert.sensitive = mode === 'memory' || mode === 'both';
        };
        for (const key of ['panel-text', 'panel-graph', 'panel-graph-accent'])
            handlers.push(settings.connect(`changed::${key}`, sync));
        sync();
        return page;
    }

    _menuPage(settings, handlers) {
        const page = new Adw.PreferencesPage({title: _('Menu'), icon_name: 'view-list-symbolic'});

        const opening = new Adw.PreferencesGroup({title: _('Opening')});
        opening.add(withIcon(switchRow(settings, 'open-on-hover', _('Open on hover'),
            _('Show the list when the pointer rests on the icon, without clicking')), 'input-mouse-symbolic'));
        const delay = spinRow(settings, 'hover-delay', _('Hover delay'), _('Milliseconds'), 0, 2000, 50);
        settings.bind('open-on-hover', delay, 'sensitive', Gio.SettingsBindFlags.GET);
        opening.add(withIcon(delay, 'appointment-soon-symbolic'));
        opening.add(withIcon(shortcutRow(settings, handlers, 'toggle-menu', _('Keyboard shortcut'),
            _('Open and close the menu from anywhere')), 'input-keyboard-symbolic'));
        page.add(opening);

        const layout = new Adw.PreferencesGroup({title: _('Layout')});
        layout.add(withIcon(spinRow(settings, 'menu-width', _('Menu width'), _('Pixels'), 440, 800, 20),
            'zoom-fit-best-symbolic'));
        layout.add(withIcon(switchRow(settings, 'show-summary', _('System summary'),
            _('CPU, memory and load cards above the list')), 'view-grid-symbolic'));
        page.add(layout);

        const list = new Adw.PreferencesGroup({title: _('App list')});
        list.add(withIcon(comboRow(settings, handlers, 'sort-key', _('Sort apps by'), null, [
            ['cpu', _('CPU')],
            ['memory', _('Memory')],
            ['name', _('Name')],
        ]), 'view-sort-descending-symbolic'));
        list.add(withIcon(comboRow(settings, handlers, 'list-category', _('Show'),
            _('Also changes when you pick a filter in the menu'), [
                ['all', _('All')],
                ['apps', _('Apps')],
                ['services', _('Services')],
                ['commands', _('Commands')],
            ]), 'view-list-symbolic'));
        list.add(withIcon(switchRow(settings, 'show-system-processes', _('Show system processes'),
            _('Include processes owned by root and other users (they can be viewed but not ended)')),
        'system-run-symbolic'));
        page.add(list);

        const highlight = new Adw.PreferencesGroup({
            title: _('Highlights'),
            description: _('Apps using at least this much are shown in orange'),
        });
        highlight.add(withIcon(spinRow(settings, 'hot-cpu', _('CPU'), _('Percent of all CPUs'), 1, 100, 5),
            'power-profile-performance-symbolic'));
        highlight.add(withIcon(spinRow(settings, 'hot-memory', _('Memory'), _('Percent of RAM'), 1, 100, 5),
            'drive-harddisk-solidstate-symbolic'));
        page.add(highlight);

        page.add(nameListGroup(settings, handlers, 'hidden-apps', _('Hidden apps'),
            _('Leave these out of the list. Use the name shown in the menu, for example “Firefox”.')));
        return page;
    }

    _behaviorPage(settings, handlers) {
        const page = new Adw.PreferencesPage({title: _('Behavior'), icon_name: 'preferences-system-symbolic'});

        const monitoring = new Adw.PreferencesGroup({title: _('Monitoring')});
        monitoring.add(withIcon(spinRow(settings, 'refresh-interval', _('Refresh interval'),
            _('Seconds between updates'), 1, 10, 1), 'media-playlist-repeat-symbolic'));
        page.add(monitoring);

        const units = new Adw.PreferencesGroup({title: _('Units')});
        units.add(withIcon(switchRow(settings, 'cpu-per-core', _('CPU per core'),
            _('One fully busy core reads 100%, so an app can show more than 100%')),
        'power-profile-performance-symbolic'));
        units.add(withIcon(switchRow(settings, 'binary-units', _('Binary sizes'),
            _('Use KiB, MiB and GiB (powers of 1024) instead of kB, MB and GB')),
        'drive-harddisk-solidstate-symbolic'));
        units.add(withIcon(switchRow(settings, 'network-bits', _('Network speed in bits'),
            _('Show Mbit/s like internet plans do, instead of MB/s')), 'network-transmit-receive-symbolic'));
        page.add(units);

        const ending = new Adw.PreferencesGroup({title: _('Ending apps')});
        ending.add(withIcon(switchRow(settings, 'confirm-kill', _('Ask for confirmation'),
            _('Require a second click before ending an app or process')), 'dialog-question-symbolic'));
        ending.add(withIcon(spinRow(settings, 'kill-timeout', _('Grace period'),
            _('Seconds to let an app quit cleanly before it is force killed'), 1, 30, 1), 'alarm-symbolic'));
        page.add(ending);

        const monitor = new Adw.PreferencesGroup({title: _('System monitor button')});
        const command = new Adw.EntryRow({title: _('Command'), show_apply_button: true});
        command.text = settings.get_string('system-monitor-command');
        command.connect('apply', () => settings.set_string('system-monitor-command', command.text.trim()));
        handlers.push(settings.connect('changed::system-monitor-command', () => {
            command.text = settings.get_string('system-monitor-command');
        }));
        monitor.description = _('Leave empty to open GNOME System Monitor or Resources. For example: mission-center');
        monitor.add(withIcon(command, 'system-run-symbolic'));
        page.add(monitor);
        return page;
    }

    _aboutPage(settings, window) {
        const page = new Adw.PreferencesPage({title: _('About'), icon_name: 'help-about-symbolic'});

        // Banner-style header with the icon, name and a short pitch.
        const intro = new Adw.PreferencesGroup();
        const hero = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 18,
            margin_bottom: 12,
            halign: Gtk.Align.CENTER,
        });
        hero.append(new Gtk.Image({
            gicon: Gio.icon_new_for_string(`${this.path}/icons/appsight-symbolic.svg`),
            pixel_size: 96,
            margin_bottom: 6,
            css_classes: ['accent'],
        }));
        hero.append(new Gtk.Label({label: this.metadata.name, css_classes: ['title-1']}));
        hero.append(new Gtk.Label({
            label: _('Every running app, one hover away'),
            css_classes: ['dim-label'],
        }));
        const version = String(this.metadata['version-name'] ?? this.metadata.version ?? '');
        if (version) {
            hero.append(new Gtk.Label({
                label: _('Version %s').replace('%s', version),
                halign: Gtk.Align.CENTER,
                margin_top: 4,
                css_classes: ['as-hero-version', 'accent', 'card'],
            }));
        }
        intro.add(hero);
        page.add(intro);

        const about = new Adw.PreferencesGroup();
        const link = (title, subtitle, iconName, uri) => {
            const row = withIcon(new Adw.ActionRow({title, subtitle, activatable: true}), iconName);
            row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
            row.connect('activated', () => new Gtk.UriLauncher({uri}).launch(window, null, null));
            about.add(row);
        };
        if (this.metadata.url) {
            link(_('Source code'), this.metadata.url, 'text-x-generic-symbolic', this.metadata.url);
            link(_('Report a problem'), _('Open an issue on GitHub'), 'dialog-warning-symbolic',
                `${this.metadata.url}/issues`);
        }
        page.add(about);

        const reset = new Adw.PreferencesGroup();
        const row = withIcon(new Adw.ActionRow({title: _('Reset all settings'), subtitle: _('Go back to the defaults')}),
            'edit-clear-all-symbolic');
        const button = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        button.connect('clicked', () => {
            const saved = settings.settings_schema.list_keys()
                .map(key => [key, settings.get_user_value(key)])
                .filter(([, value]) => value !== null);
            if (saved.length === 0)
                return;
            for (const [key] of saved)
                settings.reset(key);
            const toast = new Adw.Toast({title: _('Settings reset'), button_label: _('Undo'), timeout: 8});
            toast.connect('button-clicked', () => {
                for (const [key, value] of saved)
                    settings.set_value(key, value);
            });
            window.add_toast(toast);
        });
        row.add_suffix(button);
        reset.add(row);
        page.add(reset);
        return page;
    }
}
