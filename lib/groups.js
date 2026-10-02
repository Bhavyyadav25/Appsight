// SPDX-License-Identifier: GPL-3.0-or-later
// Turns a flat process list into "apps": one entry per application, however many
// helper processes it spawned. Grouping is based on the systemd unit (cgroup) each
// process lives in, which is how GNOME, Flatpak and Snap launch applications.

const UUID_SUFFIX = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Things that must never be killed from inside the session (on Wayland, killing the
// shell ends the session).
const PROTECTED_UNITS = [
    /^org\.gnome\.Shell@/,
    /^gnome-session/,
    /^org\.gnome\.SessionManager/,
    /^dbus(-broker)?\.service$/,
    /^init\.scope$/,
    /^user@\d+\.service$/,
];
const PROTECTED_EXES = new Set([
    'gnome-shell', 'gnome-session-binary', 'gnome-session-service', 'Xwayland',
    'systemd', 'dbus-daemon', 'dbus-broker', 'dbus-broker-launch',
]);
const INTERPRETERS = /^(python[0-9.]*|node|nodejs|perl|ruby|java|gjs)$/;

export function unescapeUnit(s) {
    return s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function basename(path) {
    return path ? path.slice(path.lastIndexOf('/') + 1) : '';
}

/** The innermost .scope/.service unit of a cgroup path, plus whether it's a system unit. */
export function parseUnit(cgroupPath) {
    const parts = (cgroupPath || '').split('/').filter(Boolean);
    let unit = null;
    for (let i = parts.length - 1; i >= 0; i--) {
        if (/\.(scope|service)$/.test(parts[i])) {
            unit = parts[i];
            break;
        }
    }
    return {unit, system: parts[0] !== 'user.slice'};
}

/**
 * Extract the application id from a systemd unit following the XDG convention:
 *   app[-<launcher>]-<ApplicationID>-<RANDOM>.scope
 *   app[-<launcher>]-<ApplicationID>[@<RANDOM>].service
 *   snap.<name>.<app>[-<uuid>].scope|service
 */
export function appFromUnit(unit) {
    if (!unit)
        return null;

    if (unit.startsWith('snap.')) {
        const body = unit.replace(/\.(scope|service)$/, '').slice(5);
        const [name, app = name] = body.split('.');
        const appName = app.replace(UUID_SUFFIX, '');
        return {
            id: name,
            launcher: 'snap',
            desktopIds: [`${name}_${appName}.desktop`, `${name}.desktop`],
        };
    }

    if (!unit.startsWith('app-'))
        return null;

    let body = unit.slice(4);
    if (body.endsWith('.service')) {
        body = body.slice(0, -8).replace(/@.*$/, '');
    } else if (body.endsWith('.scope')) {
        body = body.slice(0, -6);
        body = UUID_SUFFIX.test(body) ? body.replace(UUID_SUFFIX, '') : body.replace(/-[^-]*$/, '');
    } else {
        return null;
    }

    const segments = body.split('-');
    const launcher = segments.length > 1 ? segments[0] : null;
    const id = unescapeUnit(segments.length > 1 ? segments.slice(1).join('-') : segments[0]);
    if (!id)
        return null;
    return {id, launcher, desktopIds: [`${id}.desktop`]};
}

/** Best human-ish executable name for a process. */
export function executableName(proc) {
    let args = proc.args ?? [];
    // Some programs (Chromium, Electron) rewrite argv into one space-separated string.
    if (args.length === 1 && args[0].includes(' ') && !args[0].startsWith('/'))
        args = args[0].split(' ');
    else if (args.length === 1 && args[0].includes(' --'))
        args = args[0].split(' ');

    let name = basename(args[0]) || proc.comm;
    if (INTERPRETERS.test(name)) {
        const script = args.slice(1).find(a => !a.startsWith('-'));
        if (script && /[./]/.test(script))
            name = basename(script);
    }
    return name.replace(/:$/, '') || proc.comm;
}

/** Decide which group a process belongs to. */
export function classify(proc) {
    const {unit, system} = parseUnit(proc.cgroup);
    const app = appFromUnit(unit);
    if (app) {
        return {
            key: `app:${app.id}`,
            kind: 'app',
            name: app.id,
            appId: app.id,
            launcher: app.launcher,
            desktopIds: app.desktopIds,
            unit,
            dedicatedCgroup: true,
        };
    }

    if (unit?.endsWith('.service') && !/^user@\d+\.service$/.test(unit)) {
        const name = unescapeUnit(unit.replace(/\.service$/, '').replace(/@.*$/, ''));
        return {
            key: `${system ? 'sys' : 'svc'}:${unit.replace(/@.*$/, '')}`,
            kind: system ? 'system' : 'service',
            name,
            unit,
            desktopIds: [],
            dedicatedCgroup: true,
        };
    }

    const exe = executableName(proc);
    return {
        key: `exe:${exe}`,
        kind: system ? 'system' : 'command',
        name: exe,
        exe,
        unit,
        desktopIds: [],
        dedicatedCgroup: false,
    };
}

/**
 * @param {object[]} procs output of ProcReader.sampleProcesses
 * @param {{uid:number, shellPid:number}} ctx
 * @returns {Map<string, object>} key -> group
 */
/**
 * Pick each process's group. The cgroup is the primary signal, corrected with the
 * process tree: Chromium/Electron apps move their main process into a self-created
 * `app-org.chromium.Chromium-*.scope` and their zygotes/renderers can land in other
 * cgroups. Those are folded back into the app that launched them.
 */
function resolveClasses(procs) {
    const byPid = new Map(procs.map(p => [p.pid, p]));
    const base = new Map(procs.map(p => [p.pid, classify(p)]));
    const resolved = new Map();
    const cgroupRedirect = new Map();

    const resolve = (p, depth) => {
        let r = resolved.get(p.pid);
        if (r)
            return r;
        r = base.get(p.pid);
        const parent = byPid.get(p.ppid);
        if (parent && depth < 64) {
            const pg = resolve(parent, depth + 1);
            const launchedOnPurpose = r.kind === 'app' && r.launcher;
            if (pg.key !== r.key && !launchedOnPurpose) {
                if (r.kind === 'app' && pg.kind === 'app') {
                    // Self-created scope inside another app (Chromium does this).
                    cgroupRedirect.set(p.cgroup, pg);
                    r = pg;
                } else if ((pg.kind === 'app' || pg.kind === 'command') &&
                           executableName(p) === executableName(parent)) {
                    // Same binary as its parent: a helper of that app.
                    r = pg;
                }
            }
        }
        resolved.set(p.pid, r);
        return r;
    };

    for (const p of procs)
        resolve(p, 0);
    // Other processes in a redirected scope (e.g. crash handlers) follow it.
    for (const p of procs) {
        if (resolved.get(p.pid) === base.get(p.pid) && cgroupRedirect.has(p.cgroup))
            resolved.set(p.pid, cgroupRedirect.get(p.cgroup));
    }
    return resolved;
}

export function buildGroups(procs, ctx) {
    const groups = new Map();
    const classes = resolveClasses(procs);
    for (const p of procs) {
        const c = classes.get(p.pid);
        let g = groups.get(c.key);
        if (!g) {
            g = {
                ...c,
                procs: [],
                cgroups: new Set(),
                cpu: 0,
                cpuKnown: false,
                mem: 0,
                rss: 0,
                threads: 0,
                foreign: false,
                protected: false,
                startedAt: Infinity,
            };
            groups.set(c.key, g);
        }
        g.procs.push(p);
        if (p.cpu !== null) {
            g.cpu += p.cpu;
            g.cpuKnown = true;
        }
        g.mem += p.priv;
        g.rss += p.rss;
        g.threads += p.threads;
        g.startedAt = Math.min(g.startedAt, p.startedAt);
        if (p.cgroup)
            g.cgroups.add(p.cgroup);
        if (p.uid !== ctx.uid)
            g.foreign = true;
        if (p.pid === ctx.shellPid)
            g.protected = true;
        if (g.exe === undefined && !g.exeHint)
            g.exeHint = executableName(p);
    }

    // Only trust cgroup-wide numbers (page cache, pressure) for cgroups that
    // contain nothing but this group's processes.
    const cgroupOwners = new Map();
    for (const g of groups.values()) {
        for (const p of g.procs) {
            const owners = cgroupOwners.get(p.cgroup) ?? new Set();
            owners.add(g.key);
            cgroupOwners.set(p.cgroup, owners);
        }
    }

    for (const g of groups.values()) {
        g.cgroups = new Set([...g.cgroups].filter(cg => cgroupOwners.get(cg)?.size === 1));
        g.dedicatedCgroup = g.kind !== 'command' && g.cgroups.size > 0;
        if (g.unit && PROTECTED_UNITS.some(re => re.test(g.unit)) && g.kind !== 'app' && g.kind !== 'command')
            g.protected = true;
        if (g.exe && PROTECTED_EXES.has(g.exe))
            g.protected = true;
        g.procs.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || b.priv - a.priv);
    }
    return groups;
}

/** Rough "how heavy is this on the machine" rating. */
export function impact(cpuShare, memShare) {
    if (cpuShare >= 25 || memShare >= 20)
        return 'high';
    if (cpuShare >= 5 || memShare >= 5)
        return 'medium';
    return 'low';
}

const ROLE_NAMES = {
    'renderer': 'renderer',
    'gpu-process': 'GPU',
    'zygote': 'zygote',
    'broker': 'broker',
    'crashpad-handler': 'crash handler',
    'ppapi': 'plugin',
};

/** What a helper process does, from Chromium/Electron style `--type=` flags. */
export function processRole(proc) {
    const cmd = (proc.args ?? []).join(' ');
    const type = cmd.match(/--type=([\w-]+)/)?.[1];
    if (!type)
        return null;
    if (type === 'utility') {
        const sub = cmd.match(/--utility-sub-type=[\w.]*?\.?(\w+?)(?:Service)?(?:\s|$)/)?.[1];
        return sub ? `${sub.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} service` : 'utility';
    }
    if (type === 'renderer' && cmd.includes('--extension-process'))
        return 'extension';
    return ROLE_NAMES[type] ?? type;
}
