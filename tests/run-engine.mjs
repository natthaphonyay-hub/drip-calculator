// Runs the engine inside index.html on a list of scenarios (JSON file) and prints the results as JSON.
// usage: node tests/run-engine.mjs <scenarios.json> | --drugs | --limits-data | --limits <scenarios.json>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const block = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));
const api = new Function(`${block('// DATA-START', '// DATA-END')}\n${block('// CALC-START', '// CALC-END')}
return { computeDrip, buildNoteText, checkLimits, DRUGS, LIMITS, LIMITS_NOTE };`)();

const arg = process.argv[2];
if (arg === '--drugs') {
  process.stdout.write(JSON.stringify(api.DRUGS));
} else if (arg === '--limits-data') {
  process.stdout.write(JSON.stringify({ LIMITS: api.LIMITS, LIMITS_NOTE: api.LIMITS_NOTE }));
} else if (arg === '--limits') { // scenarios carry drugId; prints the warnings the app would show
  const out = JSON.parse(readFileSync(process.argv[3], 'utf8')).map(p => {
    const r = api.computeDrip(p);
    if (!r.ok) return { ok: false };
    return { ok: true, first24: r.drugFirst24, warnings: api.checkLimits(api.LIMITS[p.drugId], p, r)
      .map(a => ({ id: a.id, seg: a.seg, side: a.side, level: a.level, value: a.value })) };
  });
  process.stdout.write(JSON.stringify(out));
} else {
  const SAFE = /^[\t\n\x20-\x7E฀-๿]*$/;
  const start = new Date(2026, 10, 5, 20, 0);
  const out = JSON.parse(readFileSync(arg, 'utf8')).map(p => {
    const r = api.computeDrip(p);
    if (!r.ok) return { ok: false, missing: r.missing };
    const note = api.buildNoteText(p, r, { name: 'Drug', form: 'amp', diluent: p.diluent === 'none' ? '' : p.diluent, start, orderUnit: p.doseUnit });
    return {
      ok: true, bags: r.bags, containers: r.containers, loadContainers: r.loadContainers, totalContainers: r.totalContainers,
      totalVolume: r.totalVolume, leftoverEnd: r.leftoverEnd, bagVolume: r.bagVolume, rate: r.rate, rate2: r.rate2,
      ends: r.schedule.map(b => b.endsBy), noteSafe: SAFE.test(note), noteHasNaN: /NaN|undefined|Infinity|null/.test(note),
    };
  });
  process.stdout.write(JSON.stringify(out));
}
