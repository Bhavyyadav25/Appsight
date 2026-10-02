// SPDX-License-Identifier: GPL-3.0-or-later
// Display strings shared by the views.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

/** "App", "Background", "Service", etc. for a group. */
export function kindLabel(group) {
    if (group.foreign)
        return _('System');
    switch (group.kind) {
    case 'app':
        return group.windowed ? _('App') : _('Background');
    case 'service':
        return _('Service');
    case 'system':
        return _('System');
    default:
        return _('Command');
    }
}
