// Dev helper: run the sampling pipeline outside GNOME Shell (it has no UI dependencies).
//   gjs -m tools/sample.js [filter]
import GLib from 'gi://GLib';
import {Monitor} from '../lib/monitor.js';
import {estimateStorage} from '../lib/storage.js';
import * as Fmt from '../lib/format.js';

const filter = ARGV[0] ?? null;
const loop = new GLib.MainLoop(null, false);
const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const full = {cpu: true, mem: true, full: true};

(async () => {
    const monitor = new Monitor();
    await monitor.sampleSystem(full, null);
    let t = Date.now();
    await monitor.sampleGroups(false, null);
    console.log(`first scan ${Date.now() - t} ms`);
    await wait(1000);
    const sys = await monitor.sampleSystem(full, null);
    t = Date.now();
    const groups = [...(await monitor.sampleGroups(false, null)).values()].sort((a, b) => b.mem - a.mem);
    const procs = groups.reduce((n, g) => n + g.procs.length, 0);
    console.log(`second scan ${Date.now() - t} ms, ${procs} procs, cpu ${Fmt.percent(sys.cpu)}, mem ${Fmt.bytes(sys.memUsed)}/${Fmt.bytes(sys.memTotal)}`);
    for (const g of groups.slice(0, 40))
        console.log(`${g.kind.padEnd(8)} ${g.key.slice(0, 50).padEnd(50)} n=${String(g.procs.length).padStart(3)} cpu=${Fmt.percent(g.cpu).padStart(6)} mem=${Fmt.bytes(g.mem).padStart(9)}${g.protected ? ' [protected]' : ''}`);
    console.log(`${groups.length} groups`);

    const target = groups.find(g => filter && g.key.includes(filter));
    if (target) {
        await monitor.sampleDetail(target, null);
        await wait(1500);
        const again = (await monitor.sampleGroups(false, null)).get(target.key) ?? target;
        const d = await monitor.sampleDetail(again, null);
        console.log(JSON.stringify(d, null, 1));
        t = Date.now();
        const st = await estimateStorage(target, target.name);
        console.log(`storage (${Date.now() - t} ms)`, JSON.stringify(st, null, 1));
    }
    loop.quit();
})().catch(e => { logError(e); loop.quit(); });
loop.run();
