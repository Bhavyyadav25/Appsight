// SPDX-License-Identifier: GPL-3.0-or-later
// What sits in the top bar: the icon, an optional live graph and a value.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Fmt from './format.js';
import {Sparkline, bandScale, setText} from './widgets.js';

const PANEL_HISTORY = 20;
const ALERT_COLOR = '#e66100';

export const PanelStatus = GObject.registerClass(
class PanelStatus extends St.BoxLayout {
    _init(iconPath) {
        super._init({style_class: 'panel-status-menu-box'});
        this._mode = null;
        this._alert = false;
        this._minWidth = 0;
        this._shapes = new Set();
        this._options = {
            showIcon: true, graph: true, fixedWidth: true, graphWidth: 26,
            graphColor: null, cpuAlert: 0, memAlert: 0,
        };

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        // The slot hides the graph when there's no value to graph; the setting
        // controls the graph itself.
        this._graph = new Sparkline({
            style_class: 'as-panel-graph',
            capacity: PANEL_HISTORY,
            x_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._graphSlot = new St.Bin({child: this._graph, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._graphSlot);

        this._label = new St.Label({style_class: 'as-panel-label', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);
    }

    /**
     * @param {object} options
     * @param {boolean} options.showIcon
     * @param {boolean} options.graph
     * @param {boolean} options.fixedWidth  never let the text shrink, so the panel doesn't jitter
     * @param {number} options.graphWidth  pixels
     * @param {string|null} options.graphColor  CSS color, or null for the accent color
     * @param {number} options.cpuAlert  percent, 0 for off
     * @param {number} options.memAlert  percent of RAM, 0 for off
     */
    setOptions(options) {
        this._options = options;
        this._graph.visible = options.graph;
        this._resetWidth();
        this._styleGraph();
        this._syncIcon();
    }

    _resetWidth() {
        this._minWidth = 0;
        this._shapes = new Set();
        this._label.clutter_text.min_width_set = false;
    }

    _styleGraph() {
        const {graphWidth, graphColor} = this._options;
        const color = this._alert ? ALERT_COLOR : graphColor;
        this._graph.set_style(`width: ${graphWidth}px;${color ? ` color: ${color};` : ''}`);
    }

    _syncIcon() {
        // Without the icon there has to be something else to click on.
        this._icon.visible = this._options.showIcon || this._mode === 'none' || !this._mode;
    }

    /**
     * @param {string} mode 'none' | 'cpu' | 'memory' | 'both'
     * @param {object|null} sys latest system sample
     * @param {number[]} cpuHistory
     * @param {number[]} memHistory percent of RAM
     */
    update(mode, sys, cpuHistory, memHistory) {
        this._graphSlot.visible = mode !== 'none';
        if (mode !== this._mode) {
            this._mode = mode;
            this._resetWidth();
            if (mode === 'memory')
                this._graph.add_style_class_name('as-panel-graph-mem');
            else
                this._graph.remove_style_class_name('as-panel-graph-mem');
            this._syncIcon();
        }
        if (mode !== 'none') {
            // Repainting a hidden actor is a no-op, so this is cheap with the graph off.
            const recent = (mode === 'memory' ? memHistory : cpuHistory).slice(-PANEL_HISTORY);
            if (mode === 'memory')
                this._graph.setData([recent], ...bandScale(recent));
            else
                this._graph.setData([recent], Math.max(20, ...recent) * 1.1);
        }

        let text = '';
        let alert = false;
        if (sys && mode !== 'none') {
            const {cpuAlert, memAlert} = this._options;
            const memShare = sys.memTotal ? sys.memUsed / sys.memTotal * 100 : 0;
            const parts = [];
            if (mode === 'cpu' || mode === 'both') {
                parts.push(Fmt.percent(sys.cpu));
                alert ||= cpuAlert > 0 && sys.cpu >= cpuAlert;
            }
            if (mode === 'memory' || mode === 'both') {
                parts.push(Fmt.shortBytes(sys.memUsed));
                alert ||= memAlert > 0 && memShare >= memAlert;
            }
            text = parts.join('  ');
        }
        if (alert !== this._alert) {
            this._alert = alert;
            this._label[alert ? 'add_style_class_name' : 'remove_style_class_name']('as-panel-alert');
            this._styleGraph();
            this._shapes.clear(); // the alert style is bold, so wider
        }
        setText(this._label, text);
        this._label.visible = text !== '';

        // Digits are tabular, so the width only depends on where the digits are
        // ("0.0%", "00%"...). A measurement costs a text layout, so each shape is
        // measured once.
        const shape = text.replace(/\d/g, '0');
        if (this._options.fixedWidth && text && !this._shapes.has(shape)) {
            // Grow to the widest text seen so far, never shrink back.
            this._shapes.add(shape);
            const inner = this._label.clutter_text;
            const [, natural] = inner.get_preferred_width(-1);
            if (natural > this._minWidth) {
                this._minWidth = natural;
                inner.min_width = Math.ceil(natural);
            }
        }
    }
});
