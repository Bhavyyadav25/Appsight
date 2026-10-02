// SPDX-License-Identifier: GPL-3.0-or-later
// Turns settings into the plain option objects the views and formatters take,
// so none of them reads Gio.Settings itself.

import GLib from 'gi://GLib';

/** Keys that change how numbers are formatted. */
export const UNIT_KEYS = ['binary-units', 'network-bits', 'cpu-per-core'];

/** Keys that change the top bar button. */
export const PANEL_KEYS = [
    'panel-show-icon', 'panel-graph', 'panel-fixed-width', 'panel-graph-width',
    'panel-graph-accent', 'panel-graph-color', 'cpu-alert', 'memory-alert',
];

/** Keys that change the app list (and the menu around it). */
export const LIST_KEYS = ['menu-width', 'show-summary', 'hot-cpu', 'hot-memory', 'hidden-apps'];

/** For format.js configure(). */
export function unitOptions(settings) {
    return {
        binary: settings.get_boolean('binary-units'),
        bits: settings.get_boolean('network-bits'),
        perCore: settings.get_boolean('cpu-per-core'),
        ncpu: GLib.get_num_processors(),
    };
}

/** For PanelStatus.setOptions(). */
export function panelOptions(settings) {
    return {
        showIcon: settings.get_boolean('panel-show-icon'),
        graph: settings.get_boolean('panel-graph'),
        fixedWidth: settings.get_boolean('panel-fixed-width'),
        graphWidth: settings.get_int('panel-graph-width'),
        graphColor: settings.get_boolean('panel-graph-accent') ? null : settings.get_string('panel-graph-color'),
        cpuAlert: settings.get_int('cpu-alert'),
        memAlert: settings.get_int('memory-alert'),
    };
}

/** For ListView.setOptions(). */
export function listOptions(settings) {
    return {
        showSummary: settings.get_boolean('show-summary'),
        hotCpu: settings.get_int('hot-cpu'),
        hotMem: settings.get_int('hot-memory'),
        hidden: settings.get_strv('hidden-apps'),
    };
}
