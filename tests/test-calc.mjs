// Tests for the calculation engine inside index.html (the part between CALC-START and CALC-END).
// Run: node tests/test-calc.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const block = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));
const code = block('// DATA-START', '// DATA-END') + '\n' + block('// CALC-START', '// CALC-END');
const api = new Function(`${code}
return { computeDrip, parseNum, fmt, fmtDuration, concText, doseText, ceilSafe, buildNoteText,
  convertAmount, doseUnitsFor, familyUnits, dosePerHour, DRUGS, SOURCES, DILUENTS, ALL_DILUENTS,
  checkLimits, rateIn, concIn, LIMITS, LIMITS_NOTE };`)();

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

// The order from the LINE chat: Norepinephrine 4 mg/amp, 8:500, 30 ml/hr, 24 hr.
const NE = { pkgAmount: 4, pkgUnit: 'mg', pkgVolume: 4, mixAmount: 8, mixUnit: 'drug', mixVolume: 500, rateMode: 'mlhr', rate: 30, hours: 24 };
const run = (over = {}) => api.computeDrip({ ...NE, ...over });

test('NE 8:500 at 30 ml/hr for 24 hr = 2 bags x 2 amp = 4 amp', () => {
  const r = run();
  assert.equal(r.ok, true);
  assert.equal(r.bags, 2);
  assert.equal(r.contPerBag, 2);
  assert.equal(r.containers, 4);
  near(r.conc, 0.016);
  near(r.totalVolume, 720);
  near(r.drugInfused, 11.52);
  near(r.drugInfusedCont, 2.88);
  near(r.emptyHours, 500 / 30);
  near(r.leftoverEnd, 280);
  assert.deepEqual(r.schedule.map(b => b.endsBy), ['empty', 'orderEnd']);
  near(r.schedule[1].used, 220);
});

test('NE mixed as "2 amp" equals mixed as "8 mg"', () => {
  const r = run({ mixAmount: 2, mixUnit: 'cont' });
  near(r.mixDrug, 8);
  near(r.drugVolume, 8);
  assert.equal(r.containers, 4);
});

test('Counting the added drug volume makes the bag 508 ml', () => {
  const r = run({ includeDrugVolume: true });
  near(r.bagVolume, 508);
  near(r.conc, 8 / 508);
  assert.equal(r.bags, 2);
  assert.equal(r.containers, 4);
});

test('Drug volume is ignored when the volume per container is unknown', () => {
  const r = run({ includeDrugVolume: true, pkgVolume: null });
  near(r.bagVolume, 500);
  assert.equal(r.drugVolume, null);
});

test('KCl 20 mEq/10 ml, 40 mEq in 1000 ml at 80 ml/hr = 4 amp', () => {
  const r = run({ pkgAmount: 20, pkgUnit: 'mEq', pkgVolume: 10, mixAmount: 40, mixVolume: 1000, rate: 80 });
  near(r.totalVolume, 1920);
  near(r.conc, 0.04);
  assert.equal(r.bags, 2);
  assert.equal(r.containers, 4);
});

test('Half an amp per bag: open 2 per bag, or 3 in all when leftovers can be reused', () => {
  const r = run({ mixAmount: 6, mixVolume: 250, rate: 20 });
  assert.equal(r.bags, 2);
  near(r.contPerBagExact, 1.5);
  assert.equal(r.contPerBag, 2);
  assert.equal(r.containers, 4);
  assert.equal(r.containersIfReuse, 3);
  assert.equal(run({ mixAmount: 6, mixVolume: 250, rate: 20, multiDose: true }).containers, 3);
});

test('A bag that ends exactly at the end of the order counts once', () => {
  const r = run({ rate: 500 / 24 });
  assert.equal(r.bags, 1);
  assert.equal(r.schedule[0].endsBy, 'empty');
  near(r.leftoverEnd, 0);
});

test('Floating-point noise does not add an extra amp (1.1 mg / 0.1 mg = 11)', () => {
  const r = run({ pkgAmount: 0.1, mixAmount: 1.1 });
  assert.equal(r.contPerBag, 11);
});

test('Change the bag every 24 hr: slow rate over 48 hr needs 2 bags', () => {
  const r = run({ rate: 5, hours: 48, maxHang: 24 });
  assert.equal(r.hangLimited, true);
  assert.equal(r.bags, 2);
  near(r.discardPerBag, 380);
  assert.deepEqual(r.schedule.map(b => b.endsBy), ['hang', 'hang']);
  near(r.leftoverEnd, 0);
  assert.equal(run({ rate: 5, hours: 48 }).bags, 1);
});

test('A change time longer than the bag lasts changes nothing', () => {
  const r = run({ maxHang: 24 });
  assert.equal(r.hangLimited, false);
  assert.equal(r.bags, 2);
});

test('Next day: 280 ml left in the hanging bag means 1 new bag = 2 amp', () => {
  const r = run({ carryVolume: 280 });
  near(r.carryHours, 280 / 30);
  assert.equal(r.bags, 1);
  assert.equal(r.containers, 2);
  assert.equal(r.schedule.length, 2);
  assert.equal(r.schedule[0].carry, true);
  assert.equal(r.schedule[0].endsBy, 'empty');
  near(r.schedule[1].used, 440);
  near(r.leftoverEnd, 60);
});

test('A hanging bag that outlasts the order needs nothing new', () => {
  const r = run({ carryVolume: 1000 });
  assert.equal(r.bags, 0);
  assert.equal(r.containers, 0);
  assert.equal(r.schedule[0].endsBy, 'orderEnd');
  near(r.leftoverEnd, 280);
});

test('Dose order 0.1 mcg/kg/min, 60 kg = 22.5 ml/hr', () => {
  const r = run({ rateMode: 'dose', doseValue: 0.1, doseUnit: 'mcg/kg/min', weight: 60 });
  near(r.rate, 22.5);
  near(r.totalVolume, 540);
  assert.equal(r.bags, 2);
  assert.equal(r.containers, 4);
});

test('A per-kg dose without weight asks for the weight', () => {
  const r = run({ rateMode: 'dose', doseValue: 0.1, doseUnit: 'mcg/kg/min' });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('น้ำหนักผู้ป่วย'));
});

test('Heparin 25,000 unit/5 ml, 25,000 unit in 500 ml, 1,000 unit/hr = 20 ml/hr, 1 vial', () => {
  const r = run({ pkgAmount: 25000, pkgUnit: 'unit', pkgVolume: 5, mixAmount: 25000, mixVolume: 500,
    rateMode: 'dose', doseValue: 1000, doseUnit: 'unit/hr' });
  near(r.conc, 50);
  near(r.rate, 20);
  assert.equal(r.bags, 1);
  assert.equal(r.containers, 1);
});

test('Gram drug with a g/hr order: 4 g in 100 ml at 1 g/hr = 6 bags x 4 = 24', () => {
  const r = run({ pkgAmount: 1, pkgUnit: 'g', pkgVolume: 2, mixAmount: 4, mixVolume: 100,
    rateMode: 'dose', doseValue: 1, doseUnit: 'g/hr' });
  near(r.rate, 25);
  assert.equal(r.bags, 6);
  assert.equal(r.containers, 24);
});

test('A dose unit from another family (mg for an mEq drug) is refused', () => {
  const r = run({ pkgUnit: 'mEq', rateMode: 'dose', doseValue: 1, doseUnit: 'mg/hr' });
  assert.equal(r.ok, false);
});

test('Empty inputs list everything still needed', () => {
  const r = api.computeDrip({ rateMode: 'mlhr' });
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 5);
});

test('parseNum reads thousands, decimal commas and stray units', () => {
  assert.equal(api.parseNum('25,000'), 25000);
  assert.equal(api.parseNum('1,500.5'), 1500.5);
  assert.equal(api.parseNum('0,5'), 0.5);
  assert.equal(api.parseNum('2,25'), 2.25);
  assert.equal(api.parseNum('4 mg'), 4);
  assert.equal(api.parseNum(''), null);
  assert.equal(api.parseNum('abc'), null);
});

test('Number and time formatting', () => {
  assert.equal(api.fmt(0.016), '0.016');
  assert.equal(api.fmt(0.13333), '0.133');
  assert.equal(api.fmt(16.6667), '16.67');
  assert.equal(api.fmt(720), '720');
  assert.equal(api.fmt(25000), '25,000');
  assert.equal(api.fmtDuration(500 / 30), '16 ชม. 40 นาที');
  assert.equal(api.fmtDuration(24), '24 ชม.');
  assert.equal(api.fmtDuration(0.5), '30 นาที');
  assert.deepEqual(api.concText(0.016, 'mg'), { v: '16', u: 'mcg/ml' });
  assert.deepEqual(api.concText(0.04, 'mEq'), { v: '0.04', u: 'mEq/ml' });
  assert.equal(api.doseText(0.48, 'mg', 60), '480 mcg/hr (8 mcg/min, 0.133 mcg/kg/min)');
  assert.equal(api.doseText(0.48, 'mg', null), '480 mcg/hr (8 mcg/min)');
  assert.equal(api.doseText(1000, 'unit', null), '1,000 unit/hr');
  assert.equal(api.doseText(1, 'g', null), '1 g/hr (16.67 mg/min)');
  // the per-minute and per-kg figures follow the unit the order is written in
  assert.equal(api.doseText(30, 'mg', null, 'mg/min'), '30 mg/hr (0.5 mg/min)');
  assert.equal(api.doseText(0.48, 'mg', 60, 'mcg/min'), '480 mcg/hr (8 mcg/min, 0.133 mcg/kg/min)');
  assert.equal(api.doseText(3, 'mg', 60, 'mg/kg/hr'), '3 mg/hr (50 mcg/min, 0.05 mg/kg/hr)');
  assert.equal(api.doseText(0.36, 'mg', 60, 'mcg/kg/min'), '360 mcg/hr (6 mcg/min, 0.1 mcg/kg/min)');
});

test('The hanging bag also obeys the bag-change time', () => {
  // 8:500 at 5 ml/hr: a full bag would last 100 hr, the hanging 100 ml lasts 20 hr.
  const slow = { rate: 5, maxHang: 24, carryVolume: 100 };
  const fresh = run(slow);
  assert.equal(fresh.carryHangLimited, false);
  near(fresh.carryHours, 20);
  assert.equal(fresh.bags, 1);
  const old = run({ ...slow, carryHung: 20 }); // already up 20 hr: only 4 hr left
  assert.equal(old.carryHangLimited, true);
  near(old.carryHours, 4);
  assert.equal(old.schedule[0].endsBy, 'hang');
  assert.equal(old.bags, 1);
  assert.equal(old.containers, 2);
  const expired = run({ ...slow, carryHung: 30 }); // past its time: change it now
  near(expired.carryHours, 0);
  assert.equal(expired.bags, 1);
});

test('Hours the last bag has hung at the end of the order', () => {
  near(run().leftoverHung, 24 - 500 / 30);
  near(run({ carryVolume: 1000 }).leftoverHung, 24);
});

const START = new Date(2026, 10, 5, 20, 0); // 5 Nov 2026 (2569) 20:00
const note = (over = {}, o = {}) => {
  const p = { ...NE, ...over };
  return api.buildNoteText(p, api.computeDrip(p), { name: 'Norepinephrine', form: 'amp', diluent: '', start: START, ...o });
};
const SAFE = /^[\t\n\x20-\x7E฀-๿]*$/; // ASCII + Thai only

test('Pharmacist note for the LINE-chat order, line by line', () => {
  assert.equal(note({}, { diluent: 'D5W' }), [
    'Pharmacist note',
    '    - Norepinephrine (4 mg/4 ml) 8 mg in D5W 500 ml IV drip 30 ml/hr',
    '        - ความเข้มข้น 16 mcg/ml, ได้รับยา 480 mcg/hr (8 mcg/min)',
    '        - 1 ถุงหยดได้ 16 ชม. 40 นาที',
    '    - เริ่มให้ยา วันที่ 5 พฤศจิกายน 2569 เวลา 20:00 น.',
    '    - เตรียมยา 24 ชม. 2 ถุง (ถุงละ 2 amp) รวม 4 amp',
    '        - ถุงที่ 1 เริ่ม 5 พ.ย. 20:00 น. หมด 6 พ.ย. 12:40 น.',
    '        - ถุงที่ 2 เริ่ม 6 พ.ย. 12:40 น. หมด 7 พ.ย. 05:20 น.',
    '    - ครบ 24 ชม. (6 พ.ย. 20:00 น.)',
    '        - ได้รับยารวม 11.52 mg (720 ml)',
    '        - ถุงที่ 2 ยังเหลือ 280 ml',
  ].join('\n'));
});

test('Pharmacist note variants stay ASCII + Thai and say the right thing', () => {
  const variants = {
    dose: note({ rateMode: 'dose', doseValue: 0.1, doseUnit: 'mcg/kg/min', weight: 60 }),
    halfAmp: note({ mixAmount: 6, mixVolume: 250, rate: 20 }),
    reuse: note({ mixAmount: 6, mixVolume: 250, rate: 20, multiDose: true }, { form: 'vial' }),
    hang: note({ rate: 5, hours: 48, maxHang: 24 }),
    carry: note({ carryVolume: 280 }),
    covered: note({ carryVolume: 1000 }),
    noStart: note({}, { start: null }),
    kcl: note({ pkgAmount: 20, pkgUnit: 'mEq', pkgVolume: 10, mixAmount: 40, mixVolume: 1000, rate: 80 }, { name: 'KCl', diluent: 'NSS' }),
  };
  for (const [k, text] of Object.entries(variants)) assert.ok(SAFE.test(text), `${k} has a character outside ASCII + Thai`);
  assert.ok(variants.dose.includes('IV drip 0.1 mcg/kg/min (BW 60 kg) = 22.5 ml/hr'));
  assert.ok(variants.dose.includes('0.1 mcg/kg/min)'));
  assert.ok(variants.halfAmp.includes('2 ถุง (ถุงละ 1.5 amp เปิด 2 amp) รวม 4 amp'));
  assert.ok(variants.reuse.includes('2 ถุง (ถุงละ 1.5 vial ใช้ยาส่วนเหลือต่อ) รวม 3 vial'));
  assert.ok(variants.hang.includes('1 ถุงหยดได้ 100 ชม., เปลี่ยนถุงทุก 24 ชม.'));
  assert.ok(variants.hang.includes('ถุงที่ 1 เริ่ม 5 พ.ย. 20:00 น. เปลี่ยน 6 พ.ย. 20:00 น. (เหลือทิ้ง 380 ml)'));
  assert.ok(variants.carry.includes('    - ถุงเดิมเหลือ 280 ml หมด 6 พ.ย. 05:20 น.'));
  assert.ok(variants.carry.includes('    - เตรียมยาเพิ่ม 24 ชม. 1 ถุง (ถุงละ 2 amp) รวม 2 amp'));
  assert.ok(variants.covered.includes('    - ไม่ต้องเตรียมยาเพิ่มใน 24 ชม.'));
  assert.ok(variants.covered.includes('        - ถุงเดิม ยังเหลือ 280 ml'));
  assert.ok(!variants.noStart.includes('เริ่มให้ยา'));
  assert.ok(variants.noStart.includes('ถุงที่ 1 เริ่ม ชม.ที่ 0:00 หมด ชม.ที่ 16:40'));
  assert.ok(variants.kcl.includes('KCl (20 mEq/10 ml) 40 mEq in NSS 1,000 ml IV drip 80 ml/hr'));
  assert.ok(variants.kcl.includes('ได้รับยา 3.2 mEq/hr'));
  assert.ok(variants.kcl.includes('ได้รับยารวม 76.8 mEq (1,920 ml)'));
});

// ---------- v1.1: loading dose, rate change, undiluted syringes, unit families ----------
const AMIO = { pkgAmount: 150, pkgUnit: 'mg', pkgVolume: 3, diluent: 'D5W', mixAmount: 900, mixUnit: 'drug', mixVolume: 500,
  rateMode: 'dose', doseValue: 1, doseUnit: 'mg/min', step2On: true, step2After: 6, step2Value: 0.5,
  loadOn: true, loadAmount: 150, loadUnit: 'mg', loadPerKg: false, loadMode: 'separate', loadVolume: 100, loadMinutes: 10, hours: 24 };

test('Amiodarone label regimen: load 150 mg + 900 mg/500 ml at 1 then 0.5 mg/min = 7 amp', () => {
  const r = api.computeDrip(AMIO);
  assert.equal(r.ok, true);
  near(r.rate, 100 / 3); near(r.rate2, 50 / 3);
  near(r.loading.rate, 600); assert.equal(r.loading.containers, 1);
  near(r.maintStart, 1 / 6); near(r.step2At, 6 + 1 / 6);
  near(r.totalVolume, 200 + (24 - 6 - 1 / 6) * 50 / 3, 1e-6);
  assert.equal(r.bags, 1); assert.equal(r.containers, 6); assert.equal(r.totalContainers, 7);
  near(r.leftoverEnd, 500 - r.totalVolume, 1e-6);
  near(r.drugInfused, 1045, 1e-6);
});

test('Rate change after the order ends changes nothing', () => {
  const a = run(); const b = run({ step2On: true, step2After: 30, step2Value: 5 });
  assert.equal(b.bags, a.bags); near(b.totalVolume, a.totalVolume); assert.equal(b.totalContainers, a.totalContainers);
});

test('Dexmedetomidine loading from the same bag: 1 mcg/kg in 10 min, then 0.5 mcg/kg/hr = 4 vials', () => {
  const p = { pkgAmount: 200, pkgUnit: 'mcg', pkgVolume: 2, diluent: 'NSS', mixAmount: 200, mixUnit: 'drug', mixVolume: 50,
    rateMode: 'dose', doseValue: 0.5, doseUnit: 'mcg/kg/hr', weight: 60,
    loadOn: true, loadAmount: 1, loadUnit: 'mcg', loadPerKg: true, loadMode: 'same', loadMinutes: 10, hours: 24 };
  const r = api.computeDrip(p);
  near(r.loading.volume, 15); near(r.loading.rate, 90); near(r.rate, 7.5);
  near(r.totalVolume, 15 + 7.5 * (24 - 1 / 6));
  assert.equal(r.bags, 4); assert.equal(r.totalContainers, 4); assert.equal(r.loadContainers, 0);
  near(r.leftoverEnd, 200 - r.totalVolume);
  const push = api.computeDrip({ ...p, loadMinutes: 0 });
  near(push.totalVolume, 15 + 7.5 * 24); assert.equal(push.bags, 4); near(push.leftoverEnd, 5);
});

test('Heparin 80 unit/kg bolus + 18 unit/kg/hr from 25,000 unit/500 ml = 3 vials', () => {
  const p = { pkgAmount: 25000, pkgUnit: 'unit', pkgVolume: 5, diluent: 'NSS', mixAmount: 25000, mixUnit: 'drug', mixVolume: 500,
    rateMode: 'dose', doseValue: 18, doseUnit: 'unit/kg/hr', weight: 60,
    loadOn: true, loadAmount: 80, loadUnit: 'unit', loadPerKg: true, loadMode: 'separate', loadVolume: 0, loadMinutes: 0, hours: 24 };
  const r = api.computeDrip(p);
  near(r.rate, 21.6); near(r.loading.drug, 4800); near(r.loading.volume, 0.96); assert.equal(r.loading.rate, null);
  assert.equal(r.bags, 2); assert.equal(r.containers, 2); assert.equal(r.loadContainers, 1); assert.equal(r.totalContainers, 3);
  near(r.maintStart, 0);
  assert.equal(api.computeDrip({ ...p, multiDose: true }).totalContainers, 3);
  assert.equal(api.computeDrip({ ...p, mixVolume: 250, multiDose: true }).totalContainers, 3);
});

test('Shared vial: leftovers of the loading vial fill the bags (multi-dose pooling)', () => {
  // 1,000 unit vial, 100 unit bags, 0.1 unit/kg loading at 60 kg = 6 unit: separate counting = 1 + bags, pooled = ceil(total / 1000)
  const p = { pkgAmount: 1000, pkgUnit: 'unit', pkgVolume: 10, diluent: 'NSS', mixAmount: 100, mixUnit: 'drug', mixVolume: 100,
    rateMode: 'mlhr', rate: 6, loadOn: true, loadAmount: 0.1, loadUnit: 'unit', loadPerKg: true, weight: 60, loadMode: 'separate', loadVolume: 0, loadMinutes: 0, hours: 24 };
  const sep = api.computeDrip(p); const pooled = api.computeDrip({ ...p, multiDose: true });
  assert.equal(sep.bags, 2); assert.equal(sep.totalContainers, 3);
  assert.equal(pooled.totalContainers, 1);
});

test('MgSO4 4 g loading in 20 min, then 1 g/hr from 4 g/250 ml = 28 amp of 1 g/2 ml', () => {
  const r = api.computeDrip({ pkgAmount: 1, pkgUnit: 'g', pkgVolume: 2, diluent: 'D5W', mixAmount: 4, mixUnit: 'drug', mixVolume: 250,
    rateMode: 'dose', doseValue: 1, doseUnit: 'g/hr', loadOn: true, loadAmount: 4, loadUnit: 'g', loadMode: 'separate', loadVolume: 100, loadMinutes: 20, hours: 24 });
  near(r.rate, 62.5); near(r.loading.rate, 300); near(r.maintStart, 1 / 3);
  assert.equal(r.bags, 6); assert.equal(r.containers, 24); assert.equal(r.loadContainers, 4); assert.equal(r.totalContainers, 28);
});

test('Loading longer than the order: no drip starts, only the loading is counted', () => {
  const r = api.computeDrip({ ...AMIO, step2On: false, loadMinutes: 60 * 30 });
  assert.equal(r.bags, 0); assert.equal(r.totalContainers, 1); near(r.totalVolume, 0);
});

test('Propofol 1% undiluted 20 ml syringes at 50 mcg/kg/min, 70 kg = 26 amp', () => {
  const r = api.computeDrip({ pkgAmount: 200, pkgUnit: 'mg', pkgVolume: 20, diluent: 'none', mixAmount: 1, mixUnit: 'cont',
    rateMode: 'dose', doseValue: 50, doseUnit: 'mcg/kg/min', weight: 70, hours: 24 });
  assert.equal(r.undiluted, true); near(r.bagVolume, 20); near(r.conc, 10); near(r.rate, 21);
  assert.equal(r.bags, 26); assert.equal(r.totalContainers, 26);
  const missing = api.computeDrip({ pkgAmount: 200, pkgUnit: 'mg', diluent: 'none', mixAmount: 1, mixUnit: 'cont', rateMode: 'mlhr', rate: 5, hours: 24 });
  assert.equal(missing.ok, false); assert.ok(missing.missing.includes('ปริมาตรต่อหลอด'));
});

test('Oxytocin 10 IU/1000 ml: 2 mU/min = 12 ml/hr; vasopressin 0.03 unit/min from 20 unit/100 ml = 9 ml/hr', () => {
  const o = api.computeDrip({ pkgAmount: 10, pkgUnit: 'IU', pkgVolume: 1, diluent: 'NSS', mixAmount: 10, mixUnit: 'drug', mixVolume: 1000,
    rateMode: 'dose', doseValue: 2, doseUnit: 'mU/min', hours: 24 });
  near(o.rate, 12); assert.equal(o.bags, 1); assert.equal(o.totalContainers, 1);
  assert.deepEqual(api.concText(o.conc, 'IU', 'mU/min'), { v: '10', u: 'mU/ml' });
  assert.equal(api.doseText(o.dosePerHour, 'IU', null, 'mU/min'), '0.12 IU/hr (2 mU/min)');
  const v = api.computeDrip({ pkgAmount: 20, pkgUnit: 'unit', pkgVolume: 1, diluent: 'NSS', mixAmount: 20, mixUnit: 'drug', mixVolume: 100,
    rateMode: 'dose', doseValue: 0.03, doseUnit: 'unit/min', hours: 24 });
  near(v.rate, 9); assert.equal(v.bags, 3); assert.equal(v.totalContainers, 3);
  assert.equal(api.doseText(v.dosePerHour, 'unit', null, 'unit/min'), '1.8 unit/hr (0.03 unit/min)');
});

test('KCl 40 mEq + drug volume = 1,020 ml bag; 85 ml/hr for 24 hr fits exactly 2 bags', () => {
  const r = run({ pkgAmount: 20, pkgUnit: 'mEq', pkgVolume: 10, mixAmount: 40, mixVolume: 1000, includeDrugVolume: true, rate: 85 });
  near(r.bagVolume, 1020); assert.equal(r.bags, 2); assert.equal(r.totalContainers, 4); near(r.leftoverEnd, 0);
});

test('Unit families convert, other families refuse', () => {
  near(api.convertAmount(1, 'g', 'mcg'), 1e6); near(api.convertAmount(2, 'mU', 'IU'), 0.002); near(api.convertAmount(5, 'unit', 'IU'), 5);
  assert.ok(Number.isNaN(api.convertAmount(1, 'mEq', 'mg'))); assert.ok(Number.isNaN(api.convertAmount(1, 'unit', 'mg')));
  assert.ok(api.doseUnitsFor('IU').includes('mU/min')); assert.deepEqual(api.familyUnits('unit'), ['unit', 'mU']);
  near(api.dosePerHour(2, 'mU/min', 'IU', null), 0.12); near(api.dosePerHour(0.1, 'mcg/kg/min', 'mg', 60), 0.36);
});

test('Every listed drug: valid data, known sources, and each preset mix computes', () => {
  const ids = new Set();
  const units = ['mg', 'mcg', 'g', 'mEq', 'mmol', 'unit', 'IU'];
  const srcOk = keys => (keys || []).every(k => k in api.SOURCES);
  for (const d of api.DRUGS) {
    assert.ok(!ids.has(d.id), 'duplicate id ' + d.id); ids.add(d.id);
    assert.ok(d.amount > 0 && d.volume > 0 && units.includes(d.unit) && d.form, d.id + ' package');
    assert.ok(srcOk(d.pkgSrc) && srcOk(d.dilSrc), d.id + ' sources');
    assert.ok(d.diluents === null || d.diluents.every(k => k in api.DILUENTS), d.id + ' diluents');
    assert.ok(api.doseUnitsFor(d.unit).includes(d.orderUnit), d.id + ' order unit');
    for (const n of d.notes || []) assert.ok(srcOk(n.src), d.id + ' note source');
    assert.ok(d.mixes.length, d.id + ' has mixes');
    for (const m of d.mixes) {
      assert.ok(srcOk(m.src) && m.src.length, d.id + ' mix source');
      const und = m.v === 0;
      const p = { pkgAmount: d.amount, pkgUnit: d.unit, pkgVolume: d.volume, diluent: und ? 'none' : (d.diluents || ['NSS'])[0],
        mixAmount: m.a, mixUnit: m.unit === 'cont' ? 'cont' : 'drug', mixVolume: m.v, includeDrugVolume: !!m.addDrugVol,
        rateMode: 'mlhr', rate: 10, hours: 24, multiDose: !!d.multiDose };
      if (d.loading) Object.assign(p, { loadOn: true, loadAmount: d.loading.amount, loadUnit: d.loading.unit, loadPerKg: d.loading.perKg,
        loadMode: d.loading.mode, loadVolume: d.loading.volume, loadMinutes: d.loading.minutes, weight: 60 });
      if (d.regimen) Object.assign(p, { rateMode: 'dose', doseValue: d.regimen.doseValue, doseUnit: d.regimen.doseUnit,
        step2On: true, step2After: d.regimen.step2After, step2Value: d.regimen.step2Value });
      const r = api.computeDrip(p);
      assert.equal(r.ok, true, d.id + ' ' + JSON.stringify(r.missing));
      assert.ok(r.totalContainers >= 1, d.id + ' containers');
      const text = api.buildNoteText(p, r, { name: d.name, form: d.form, diluent: und ? '' : p.diluent, start: START, orderUnit: d.orderUnit });
      assert.ok(SAFE.test(text), d.id + ' note charset');
    }
  }
  assert.equal(api.DRUGS.length, 22);
});

test('Pharmacist note with loading and a rate change (Amiodarone)', () => {
  const r = api.computeDrip(AMIO);
  const text = api.buildNoteText(AMIO, r, { name: 'Amiodarone', form: 'amp', diluent: 'D5W', start: START, orderUnit: 'mg/min' });
  assert.ok(SAFE.test(text));
  assert.equal(text, [
    'Pharmacist note',
    '    - Amiodarone (150 mg/3 ml)',
    '        - Loading 150 mg in D5W 100 ml IV drip 10 นาที (600 ml/hr) ใช้ 1 amp',
    '        - ต่อด้วย 900 mg in D5W 500 ml IV drip 1 mg/min = 33.33 ml/hr',
    '        - หลังเริ่มหยด 6 ชม. เปลี่ยนเป็น 0.5 mg/min = 16.67 ml/hr',
    '        - ความเข้มข้น 1.8 mg/ml, ได้รับยา 60 mg/hr (1 mg/min)',
    '        - 1 ถุงหยดได้ 15 ชม. (อัตราแรก)',
    '    - เริ่มให้ยา วันที่ 5 พฤศจิกายน 2569 เวลา 20:00 น.',
    '    - เตรียมยา 24 ชม. รวม 7 amp (loading 1 amp, หยดต่อเนื่อง 1 ถุง ถุงละ 6 amp)',
    '        - ถุงที่ 1 เริ่ม 5 พ.ย. 20:10 น. หมด 6 พ.ย. 20:10 น.',
    '    - ครบ 24 ชม. (6 พ.ย. 20:00 น.)',
    '        - ได้รับยารวม 1,045 mg (loading 150 mg, หยดต่อเนื่อง 497.2 ml)',
    '        - ถุงที่ 1 ยังเหลือ 2.78 ml',
  ].join('\n'));
});


/* ---------- dose and rate warnings ---------- */
const KINDS = ['dose', 'rate', 'load', 'loadMin', 'conc', 'day', 'hours'];
const drugById = id => api.DRUGS.find(d => d.id === id);
// A plain order for a drug: first preset mix in its first diluent, no loading, 24 hours.
function baseOrder(d, over = {}) {
  const m = d.mixes[0];
  const und = m.v === 0;
  return { pkgAmount: d.amount, pkgUnit: d.unit, pkgVolume: d.volume, diluent: und ? 'none' : (d.diluents || ['NSS'])[0],
    mixAmount: m.a, mixUnit: m.unit === 'cont' ? 'cont' : 'drug', mixVolume: m.v, includeDrugVolume: !!m.addDrugVol,
    rateMode: 'mlhr', rate: 10, hours: 24, multiDose: !!d.multiDose, ...over };
}
const limitsOf = (d, p) => api.checkLimits(api.LIMITS[d.id], p, api.computeDrip(p));
// Package units per hour that give `v` in a rate unit such as mcg/kg/min or unit/24hr.
function perHourFor(v, unit, pkgUnit, w) {
  const parts = unit.split('/');
  let x = api.convertAmount(v, parts[0], pkgUnit);
  if (parts.includes('kg')) x *= w;
  const per = parts[parts.length - 1];
  return per === 'min' ? x * 60 : per === '24hr' ? x / 24 : x;
}
// An order whose value for rule L is exactly `v` (the other numbers stay ordinary).
function orderAt(d, L, v) {
  const w = (L.perKg || L.unit.split('/').includes('kg')) ? 60 : undefined;
  const base = baseOrder(d, { weight: w });
  const r0 = api.computeDrip(base);
  if (L.kind === 'dose' || L.kind === 'rate') return { ...base, rate: perHourFor(v, L.unit, d.unit, w) / r0.conc };
  if (L.kind === 'conc') {
    const [num, per] = L.unit.split('/');
    const perMl = api.convertAmount(v, num, d.unit) / (per === 'L' ? 1000 : 1);
    return { ...base, diluent: 'NSS', mixUnit: 'drug', includeDrugVolume: false, mixVolume: 100, mixAmount: perMl * 100 };
  }
  if (L.kind === 'day') return { ...base, rate: api.convertAmount(v, L.unit, d.unit) / 24 / r0.conc };
  if (L.kind === 'hours') return { ...base, hours: v };
  const load = { loadOn: true, loadMode: 'separate', loadVolume: 100, loadUnit: d.unit, loadPerKg: false, loadAmount: d.amount, loadMinutes: 30 };
  if (L.kind === 'load') return { ...base, ...load, loadUnit: L.unit, loadPerKg: !!L.perKg, loadAmount: v };
  return { ...base, ...load, loadMinutes: v }; // loadMin
}
const hit = (d, L, v) => limitsOf(d, orderAt(d, L, v)).filter(a => a.id === L.id && a.seg !== 'step2');

test('Limits table: known drugs, kinds, units that fit the package, sources, and low < high < max', () => {
  const ids = new Set(api.DRUGS.map(d => d.id));
  for (const [id, rules] of Object.entries(api.LIMITS)) {
    const d = drugById(id);
    assert.ok(d, 'unknown drug ' + id);
    const seen = new Set();
    for (const L of rules) {
      assert.ok(!seen.has(L.id), id + ' duplicate rule ' + L.id); seen.add(L.id);
      assert.ok(KINDS.includes(L.kind), id + ' kind ' + L.kind);
      assert.ok(L.src && L.src.length && L.src.every(k => k in api.SOURCES && !api.SOURCES[k].unverified), id + ' ' + L.id + ' sources');
      const nums = [L.low, L.high, L.max].filter(x => x != null);
      assert.ok(nums.length && nums.every(x => x > 0), id + ' ' + L.id + ' numbers');
      for (let i = 1; i < nums.length; i++) assert.ok(nums[i] > nums[i - 1], id + ' ' + L.id + ' order');
      let probe;
      if (L.kind === 'dose' || L.kind === 'rate') probe = api.rateIn(1, d.unit, L.unit, 60);
      else if (L.kind === 'conc') probe = api.concIn(1, d.unit, L.unit);
      else if (L.kind === 'load' || L.kind === 'day') probe = api.convertAmount(1, d.unit, L.unit);
      else probe = 1;
      assert.ok(Number.isFinite(probe), id + ' ' + L.id + ' unit ' + L.unit + ' does not fit ' + d.unit);
      assert.ok(!(L.noWeight && (L.perKg || L.unit.includes('/kg'))), id + ' ' + L.id + ' noWeight on a per-kg rule');
      assert.ok(!L.perKg || L.kind === 'load', id + ' ' + L.id + ' perKg is for loading only');
      for (const k of ['lowLevel', 'highLevel']) assert.ok(!L[k] || ['info', 'warn'].includes(L[k]), id + ' ' + k);
    }
  }
  for (const id of ids) assert.ok(id in api.LIMITS || id in api.LIMITS_NOTE, id + ' has neither rules nor a note');
  for (const id of Object.keys(api.LIMITS_NOTE)) assert.ok(ids.has(id), 'note for unknown drug ' + id);
});

test('Limits: every threshold is silent exactly at the limit and fires just past it, for every rule of every drug', () => {
  let checked = 0;
  for (const [id, rules] of Object.entries(api.LIMITS)) {
    const d = drugById(id);
    for (const L of rules) {
      const edges = [];
      if (L.max != null) edges.push(['max', L.max, 1.05, 'danger']);
      if (L.high != null) edges.push(['high', L.high, 1.05, L.highLevel || 'warn']);
      if (L.low != null) edges.push(['low', L.low, 0.95, L.lowLevel || 'info']);
      for (const [side, edge, f, level] of edges) {
        // exactly at a limit: that limit stays silent (a lower limit of the same rule may still speak)
        assert.deepEqual(hit(d, L, edge).filter(a => a.side === side), [], `${id} ${L.id} at ${side} ${edge} should be silent`);
        if (side === 'low') assert.deepEqual(hit(d, L, edge), [], `${id} ${L.id} at low ${edge} should be fully silent`);
        const past = hit(d, L, edge * f);
        assert.deepEqual(past.map(a => `${a.side}:${a.level}`), [`${side}:${level}`], `${id} ${L.id} past ${side} ${edge}`);
        checked += 2;
      }
    }
  }
  assert.ok(checked >= 80, 'checked ' + checked);
});

test('Limits: a value that only looks equal is not flagged (dopamine 50.004 mcg/kg/min)', () => {
  const d = drugById('dopa'), L = api.LIMITS.dopa[0];
  assert.deepEqual(hit(d, L, 50.004), []);
  assert.deepEqual(hit(d, L, 50.5).map(a => a.level), ['danger']);
});

test('Limits: per-kg rules need a weight; NE falls back to the 30 mcg/min table and asks for the weight', () => {
  const d = drugById('ne4');
  const p = baseOrder(d, { rateMode: 'dose', doseUnit: 'mcg/min', doseValue: 40 });
  assert.deepEqual(limitsOf(d, p).map(a => `${a.id}:${a.level}`), ['dose:warn', 'weight:info']);
  assert.deepEqual(limitsOf(d, { ...p, weight: 60 }).map(a => a.id), []); // 0.67 mcg/kg/min is inside 0.01 to 1
  assert.deepEqual(limitsOf(d, { ...p, weight: 10 }).map(a => `${a.id}:${a.level}`), ['dose-kg:danger']); // 4 mcg/kg/min
});

test('Limits: the rate change and the loading are checked on their own', () => {
  const d = drugById('amio');
  const p = baseOrder(d, { rateMode: 'dose', doseUnit: 'mg/min', doseValue: 1, step2On: true, step2After: 6, step2Value: 2,
    loadOn: true, loadAmount: 150, loadUnit: 'mg', loadMode: 'separate', loadVolume: 100, loadMinutes: 4 });
  const got = limitsOf(d, p).map(a => `${a.id}:${a.seg}:${a.level}`);
  // 150 mg in 4 min = 37.5 mg/min; 2 mg/min after 6 hr; that plan gives about 2,660 mg in the first 24 hr
  assert.deepEqual(got, ['rate:load:danger', 'dose:step2:warn', 'day:day:warn']);
});

test('Limits: a loading with no time cannot be speed-checked and says so (calcium gluconate)', () => {
  const d = drugById('cagl');
  const p = baseOrder(d, { weight: 60, loadOn: true, loadAmount: 1, loadUnit: 'g', loadMode: 'separate', loadVolume: 0, loadMinutes: 0 });
  const got = limitsOf(d, p).filter(a => a.id === 'rate');
  assert.equal(got.length, 1);
  assert.equal(got[0].value, null);
  assert.equal(got[0].level, 'info');
});

test('Drug over the first 24 hours follows the plan: amiodarone label regimen = 150 + 360 + 535 mg', () => {
  const r = api.computeDrip(AMIO);
  near(r.drugFirst24, 150 + 360 + (24 - 10 / 60 - 6) * 30, 1e-6);
  const same = api.computeDrip({ ...NE, loadOn: true, loadAmount: 1, loadUnit: 'mg', loadMode: 'same', loadMinutes: 0 });
  near(same.drugFirst24, 1 + 0.016 * 30 * 24, 1e-9); // the push from the bag counts once
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
