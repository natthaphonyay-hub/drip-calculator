// Tests for the calculation engine inside index.html (the part between CALC-START and CALC-END).
// Run: node tests/test-calc.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const code = html.slice(html.indexOf('// CALC-START'), html.indexOf('// CALC-END'));
const api = new Function(`${code}
return { computeDrip, parseDrugSheet, parseNum, fmt, fmtDuration, concText, doseText, ceilSafe, buildNoteText };`)();

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

test('parseDrugSheet reads the sheet layout, skips incomplete rows, sorts by name', () => {
  const csv = [
    '"ชื่อยา","ยาต่อหลอด","หน่วย","ml ต่อหลอด","ชนิดบรรจุ","ผสมยา","ผสมใน ml","สารละลาย","หมายเหตุ"',
    '"Norepinephrine","4","mg","4","amp","8","500","",""',
    '"Heparin","25,000","units","5","Vial","25,000","500","NSS","multi-dose"',
    '"KCl","20","MEQ","10","Amp","","","",""',
    '"Missing number","","mg","","amp","","","",""',
    '"Missing unit","10","","","amp","","","",""',
    '"","","","","","","","",""',
  ].join('\n');
  const { list, skipped } = api.parseDrugSheet(csv);
  assert.equal(skipped, 2);
  assert.deepEqual(list.map(d => d.name), ['Heparin', 'KCl', 'Norepinephrine']);
  assert.deepEqual(list[0], { name: 'Heparin', amount: 25000, unit: 'unit', volume: 5, form: 'vial', mixAmount: 25000, mixVolume: 500, diluent: 'NSS', note: 'multi-dose' });
  assert.equal(list[1].unit, 'mEq');
  assert.equal(list[1].mixAmount, null);
  assert.equal(list[2].form, 'amp');
});

test('parseDrugSheet returns nothing for a login page (sheet not shared)', () => {
  assert.equal(api.parseDrugSheet('<!DOCTYPE html><html>sign in</html>').list.length, 0);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
