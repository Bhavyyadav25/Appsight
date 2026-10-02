// SPDX-License-Identifier: GPL-3.0-or-later

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

/** Vertical St.BoxLayout that works on GNOME 45-49 (`vertical` was deprecated in 48). */
export function vbox(params = {}) {
    const box = new St.BoxLayout(params);
    if (box.orientation !== undefined)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

export function setScrollChild(scrollView, child) {
    if (scrollView.add_actor)
        scrollView.add_actor(child); // GNOME 45
    else
        scrollView.set_child(child);
}

// Icons that some themes lack (Adwaita among them), with one that every theme has.
const FALLBACK_ICONS = {
    'speedometer-symbolic': 'power-profile-performance-symbolic',
    'emblem-system-symbolic': 'preferences-system-symbolic',
    'utilities-system-monitor-symbolic': 'org.gnome.SystemMonitor-symbolic',
};

/** An St.Icon that falls back to a common icon when the theme lacks `iconName`. */
export function icon(iconName, styleClass, params = {}) {
    return new St.Icon({
        icon_name: iconName,
        fallback_icon_name: FALLBACK_ICONS[iconName] ?? null,
        style_class: styleClass,
        ...params,
    });
}

export function label(text, styleClass, params = {}) {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...params});
}

/**
 * Set a label's text only if it changed. A non-editable ClutterText resets its
 * buffer (and queues a relayout) on every assignment, even of the same string.
 */
export function setText(actor, text) {
    if (actor.text !== text)
        actor.text = text;
}

function rgba(color, alpha = 1) {
    return [color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255 * alpha];
}

/**
 * Trace `points` as a smooth curve (Catmull-Rom as cubic Béziers). Control
 * points are clamped to [top, bottom] so the curve never overshoots the graph.
 */
function smoothPath(cr, points, top, bottom) {
    const clamp = y => Math.max(top, Math.min(bottom, y));
    cr.moveTo(...points[0]);
    for (let i = 0; i < points.length - 1; i++) {
        const [x0, y0] = points[Math.max(0, i - 1)];
        const [x1, y1] = points[i];
        const [x2, y2] = points[i + 1];
        const [x3, y3] = points[Math.min(points.length - 1, i + 2)];
        cr.curveTo(
            x1 + (x2 - x0) / 6, clamp(y1 + (y2 - y0) / 6),
            x2 - (x3 - x1) / 6, clamp(y2 - (y3 - y1) / 6),
            x2, y2);
    }
}

/**
 * A small live area chart: a smooth line over a fill that fades out towards the
 * bottom. Colors come from the stylesheet: `color` for the first series and
 * `-as-secondary-color` for the second, so they follow the light or dark style.
 * Only repaints when new data arrives.
 */
export const Sparkline = GObject.registerClass(
class Sparkline extends St.DrawingArea {
    /**
     * @param {object} params
     * @param {number} [params.capacity] samples that fill the width
     * @param {boolean} [params.dot] mark the latest value of the first series
     */
    _init({capacity = 60, dot = false, ...params} = {}) {
        super._init({style_class: 'as-spark', x_expand: true, ...params});
        this._capacity = capacity;
        this._dot = dot;
        this._series = [];
        this._min = 0;
        this._max = 1;
    }

    /**
     * @param {number[][]} series values, oldest first
     * @param {number} max value at the top edge
     * @param {number} [min] value at the bottom edge
     */
    setData(series, max, min = 0) {
        this._series = series;
        this._min = min;
        this._max = max > min ? max : min + 1;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const node = this.get_theme_node();
        const colors = [node.get_foreground_color()];
        const [hasSecondary, secondary] = node.lookup_color('-as-secondary-color', false);
        colors.push(hasSecondary ? secondary : colors[0]);

        // Until the history is full, stretch it over the whole width.
        const longest = Math.max(0, ...this._series.map(v => v.length));
        const step = w / Math.max(1, Math.min(this._capacity, longest) - 1);
        const lineWidth = Math.max(1, Math.min(2, h / 12));
        const dotRadius = this._dot ? Math.min(3, h / 8) : 0;
        const pad = Math.max(lineWidth, dotRadius + lineWidth / 2);
        const range = this._max - this._min;
        const y = v => h - pad - Math.max(0, Math.min(1, (v - this._min) / range)) * (h - pad * 2);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);

        // Paint the second series first so the main one sits on top.
        const order = this._series.map((values, i) => i).reverse();
        for (const i of order) {
            const values = this._series[i];
            if (values.length < 2)
                continue;
            const color = colors[i] ?? colors[0];
            const x0 = w - (values.length - 1) * step;
            const right = w - (dotRadius ? pad : 0);
            const points = values.map((v, k) => [Math.min(right, x0 + k * step), y(v)]);

            smoothPath(cr, points, pad, h - pad);
            cr.lineTo(points[points.length - 1][0], h);
            cr.lineTo(points[0][0], h);
            cr.closePath();
            const fill = new Cairo.LinearGradient(0, 0, 0, h);
            fill.addColorStopRGBA(0, ...rgba(color, i === 0 ? 0.38 : 0.22));
            fill.addColorStopRGBA(1, ...rgba(color, 0));
            cr.setSource(fill);
            cr.fill();

            smoothPath(cr, points, pad, h - pad);
            cr.setLineWidth(lineWidth);
            cr.setSourceRGBA(...rgba(color));
            cr.stroke();

            if (dotRadius && i === 0) {
                const [lx, ly] = points[points.length - 1];
                cr.arc(lx, ly, dotRadius, 0, 2 * Math.PI);
                cr.fill();
            }
        }
        cr.$dispose();
    }
});

/**
 * A thin horizontal usage bar built from plain actors (no drawing), with a
 * fixed width so updating it never needs a layout pass of its own.
 */
export const Bar = GObject.registerClass(
class Bar extends St.Widget {
    _init({width, styleClass = ''}) {
        super._init({style_class: `as-bar ${styleClass}`, width, y_align: Clutter.ActorAlign.CENTER});
        this._full = width;
        this._fill = new St.Widget({style_class: 'as-bar-fill', width: 0});
        this.add_child(this._fill);
        this._px = 0;
    }

    /** @param {number} fraction 0..1 */
    setFraction(fraction) {
        const px = Math.round(Math.max(0, Math.min(1, fraction || 0)) * this._full);
        if (px !== this._px) {
            this._px = px;
            this._fill.width = px;
        }
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const height = box.get_height();
        this._fill.allocate(new Clutter.ActorBox({x1: 0, y1: 0, x2: this._px, y2: height}));
    }
});

/**
 * Scale for a graph of a slowly changing absolute value (e.g. memory), so small
 * changes stay visible instead of a flat bar near the top.
 */
export function bandScale(values) {
    if (values.length === 0)
        return [1, 0];
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = Math.max(hi - lo, hi * 0.02, 1);
    return [hi + pad, Math.max(0, lo - pad)];
}

/** Switch one of several mutually exclusive style classes on an actor. */
export function setVariant(actor, prefix, value, current) {
    if (value === current)
        return value;
    if (current)
        actor.remove_style_class_name(`${prefix}${current}`);
    if (value)
        actor.add_style_class_name(`${prefix}${value}`);
    return value;
}

/**
 * A button that asks for a second click before emitting `activated`
 * (unless `needsConfirm()` returns false).
 */
export const ConfirmButton = GObject.registerClass({
    Signals: {activated: {}, disarmed: {}},
}, class ConfirmButton extends St.Button {
    _init({text = null, iconName = null, confirmText, styleClass = '', needsConfirm = () => true, accessibleName = null}) {
        super._init({
            style_class: `as-button ${styleClass}`,
            can_focus: true,
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: accessibleName ?? text ?? '',
        });
        this._text = text;
        this._iconName = iconName;
        this._confirmText = confirmText;
        this._needsConfirm = needsConfirm;
        this._armedId = 0;

        const box = new St.BoxLayout({style_class: 'as-button-box', x_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({icon_name: iconName ?? '', style_class: 'as-button-icon', visible: !!iconName});
        this._label = new St.Label({text: text ?? '', y_align: Clutter.ActorAlign.CENTER, visible: !!text});
        box.add_child(this._icon);
        box.add_child(this._label);
        this.set_child(box);

        this.connect('clicked', () => this._onClicked());
        this.connect('destroy', () => this._clearTimer());
    }

    _onClicked() {
        if (this._armedId || !this._needsConfirm()) {
            this._disarm();
            this.emit('activated');
            return;
        }
        this.add_style_class_name('as-armed');
        this._icon.visible = false;
        this._label.text = this._confirmText;
        this._label.visible = true;
        this._armedId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._armedId = 0;
            this._disarm();
            return GLib.SOURCE_REMOVE;
        });
    }

    get armed() {
        return this._armedId !== 0;
    }

    _clearTimer() {
        if (this._armedId) {
            GLib.Source.remove(this._armedId);
            this._armedId = 0;
        }
    }

    _disarm() {
        const wasArmed = this.has_style_class_name('as-armed');
        this._clearTimer();
        this.remove_style_class_name('as-armed');
        this._icon.visible = !!this._iconName;
        this._label.text = this._text ?? '';
        this._label.visible = !!this._text;
        if (wasArmed)
            this.emit('disarmed');
    }

    disarm() {
        this._disarm();
    }
});

/**
 * One end button (or lock icon, for rows that can't be ended) shared by all
 * rows of a list. It only shows on the row under the pointer or with key
 * focus, so instead of every row carrying its own it moves into that row's
 * slot. While armed ("End?") it stays where it was clicked.
 */
export class SharedAction {
    constructor({confirmText, accessibleName, needsConfirm, onActivate}) {
        this._owner = null;
        this._slot = null;
        this._actor = null;
        this._wanted = null;
        this.button = new ConfirmButton({
            iconName: 'window-close-symbolic',
            confirmText,
            styleClass: 'as-row-kill',
            needsConfirm,
            accessibleName,
        });
        this.button.connect('activated', () => {
            if (this._owner)
                onActivate(this._owner);
        });
        this.button.connect('disarmed', () => this._sync());
        this.button.connect('key-focus-out', () => this._sync());
        this.lock = new St.Icon({
            icon_name: 'changes-prevent-symbolic',
            style_class: 'as-row-lock',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    /** `owner` wants (or, with show=false, no longer wants) the action in `slot`. */
    request(owner, slot, killable, show) {
        if (show)
            this._wanted = {owner, slot, killable};
        else if (this._wanted?.owner === owner)
            this._wanted = null;
        this._sync();
    }

    /** Called before an owner's row is destroyed, so the shared actors survive it. */
    release(owner) {
        if (this._wanted?.owner === owner)
            this._wanted = null;
        if (this._owner === owner) {
            this.button.disarm();
            this._place(null);
        }
    }

    _sync() {
        // Keep the button where it is while it's armed ("End?") or focused.
        if ((this.button.armed || this.button.has_key_focus()) && this._wanted?.owner !== this._owner && this._owner)
            return;
        this._place(this._wanted);
    }

    _place(target) {
        const owner = target?.owner ?? null;
        const slot = target?.slot ?? null;
        const actor = target ? target.killable ? this.button : this.lock : null;
        if (owner === this._owner && slot === this._slot && actor === this._actor)
            return;
        if (owner !== this._owner)
            this.button.disarm();
        this._actor?.get_parent()?.remove_child(this._actor);
        this._owner = owner;
        this._slot = slot;
        this._actor = actor;
        if (actor)
            slot.add_child(actor);
    }

    destroy() {
        this._place(null);
        this.button.destroy();
        this.lock.destroy();
    }
}
