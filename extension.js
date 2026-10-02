// SPDX-License-Identifier: GPL-3.0-or-later

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Indicator} from './lib/indicator.js';

export default class AppsightExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject(
            'changed::panel-position', () => this._addIndicator(),
            'changed::panel-index', () => this._addIndicator(),
            this);
        this._addIndicator();
        Main.wm.addKeybinding('toggle-menu', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._indicator?.menu.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-menu');
        this._settings.disconnectObject(this);
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    /** The panel has no way to move an indicator, so moving it means adding a new one. */
    _addIndicator() {
        this._indicator?.destroy();
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator,
            this._settings.get_int('panel-index'), this._settings.get_string('panel-position'));
    }
}
