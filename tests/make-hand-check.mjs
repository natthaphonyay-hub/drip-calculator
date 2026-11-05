// Writes docs/ตารางตรวจมือ-การคำนวณ.md: every listed drug and preset mix at 10 ml/hr for 24 hr,
// plus worked examples with loading, rate change and dose units, so the numbers can be checked with a calculator.
// usage: node tests/make-hand-check.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const block = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));
const api = new Function(`${block('// DATA-START', '// DATA-END')}\n${block('// CALC-START', '// CALC-END')}
return { computeDrip, fmt, fmtDuration, DRUGS, SOURCES };`)();
const { computeDrip, fmt, fmtDuration, DRUGS } = api;

const rows = [];
for (const d of DRUGS) {
  d.mixes.forEach(m => {
    const und = m.v === 0;
    const p = { pkgAmount: d.amount, pkgUnit: d.unit, pkgVolume: d.volume, diluent: und ? 'none' : (d.diluents || ['NSS'])[0],
      mixAmount: m.a, mixUnit: m.unit === 'cont' ? 'cont' : 'drug', mixVolume: m.v, includeDrugVolume: !!m.addDrugVol,
      rateMode: 'mlhr', rate: 10, hours: 24, multiDose: !!d.multiDose };
    const r = computeDrip(p);
    const mixTxt = und ? `${fmt(r.mixDrug)} ${d.unit} ไม่เจือจาง` : `${fmt(r.mixDrug)} ${d.unit} : ${fmt(m.v)} ml${m.addDrugVol ? ' + ยา' : ''}`;
    const per = d.multiDose ? `${fmt(r.contPerBagExact)} (ใช้ส่วนเหลือต่อ)` : `${fmt(r.contPerBagExact)} เปิด ${r.contPerBag}`;
    rows.push(`| ${d.name} ${fmt(d.amount)} ${d.unit}/${fmt(d.volume)} ml | ${mixTxt} | ${fmt(r.bagVolume)} | ${per} | ${fmt(240 / r.bagVolume)} | ${r.bags} | ${r.totalContainers} ${d.form} |`);
  });
}

const W = [];
const ex = (title, p, steps) => {
  const r = computeDrip(p);
  if (!r.ok) throw new Error(title + ': ' + r.missing);
  W.push(`### ${title}`, '', ...steps(r).map(s => `- ${s}`), `- **ผลในแอป: ${r.totalContainers} ${p.form || 'amp'}**`, '');
};
const NE = { pkgAmount: 4, pkgUnit: 'mg', pkgVolume: 4, diluent: 'D5W', mixAmount: 8, mixUnit: 'drug', mixVolume: 500, rateMode: 'mlhr', rate: 30, hours: 24 };
ex('Norepinephrine 4 mg/4 ml ผสม 8 mg : 500 ml หยด 30 ml/hr 24 ชม. (ตัวอย่างจาก LINE)', NE, r => [
  `ปริมาตร 24 ชม. = 30 x 24 = ${fmt(r.totalVolume)} ml`,
  `จำนวนถุง = ปัดขึ้น(720 / 500) = ปัดขึ้น(1.44) = ${r.bags} ถุง`,
  `amp ต่อถุง = 8 / 4 = ${r.contPerBag} amp`,
  `รวม = ${r.bags} x ${r.contPerBag} = ${r.totalContainers} amp (ยาที่ได้รับจริง 720 x 0.016 = ${fmt(r.drugInfused)} mg)`,
]);
ex('Amiodarone 150 mg/3 ml ตามฉลาก: loading 150 mg ใน D5W 100 ml 10 นาที, แล้ว 900 mg : 500 ml ที่ 1 mg/min 6 ชม., แล้ว 0.5 mg/min',
  { pkgAmount: 150, pkgUnit: 'mg', pkgVolume: 3, diluent: 'D5W', mixAmount: 900, mixUnit: 'drug', mixVolume: 500, rateMode: 'dose', doseValue: 1,
    doseUnit: 'mg/min', step2On: true, step2After: 6, step2Value: 0.5, loadOn: true, loadAmount: 150, loadUnit: 'mg', loadMode: 'separate',
    loadVolume: 100, loadMinutes: 10, hours: 24 }, r => [
  'ความเข้มข้น = 900 / 500 = 1.8 mg/ml',
  `1 mg/min = 60 mg/hr / 1.8 = ${fmt(r.rate)} ml/hr นาน 6 ชม. = 200 ml`,
  `0.5 mg/min = ${fmt(r.rate2)} ml/hr ตั้งแต่ชั่วโมงที่ 6:10 ถึง 24:00 (17 ชม. 50 นาที) = ${fmt(r.totalVolume - 200)} ml`,
  `รวมจากถุง ${fmt(r.totalVolume)} ml ไม่เกิน 500 ml จึงใช้ ${r.bags} ถุง x 6 amp = ${r.containers} amp`,
  `loading 150 mg = ${r.loadContainers} amp, รวม ${r.totalContainers} amp`,
]);
ex('Heparin 25,000 unit/5 ml น้ำหนัก 60 kg: bolus 80 unit/kg แล้ว 18 unit/kg/hr จาก 25,000 unit : 500 ml',
  { pkgAmount: 25000, pkgUnit: 'unit', pkgVolume: 5, diluent: 'NSS', mixAmount: 25000, mixUnit: 'drug', mixVolume: 500, rateMode: 'dose', doseValue: 18,
    doseUnit: 'unit/kg/hr', weight: 60, loadOn: true, loadAmount: 80, loadUnit: 'unit', loadPerKg: true, loadMode: 'separate', loadVolume: 0, loadMinutes: 0, hours: 24, form: 'vial' }, r => [
  'bolus = 80 x 60 = 4,800 unit = 1 vial',
  `18 x 60 = 1,080 unit/hr / 50 unit/ml = ${fmt(r.rate)} ml/hr`,
  `24 ชม. = ${fmt(r.totalVolume)} ml จึงใช้ปัดขึ้น(518.4 / 500) = ${r.bags} ถุง x 1 vial`,
  `รวม ${r.containers} + ${r.loadContainers} = ${r.totalContainers} vial`,
]);
ex('Magnesium sulfate 50% 1 g/2 ml: loading 4 g ใน 20 นาที แล้ว 1 g/hr จาก 4 g : 250 ml',
  { pkgAmount: 1, pkgUnit: 'g', pkgVolume: 2, diluent: 'D5W', mixAmount: 4, mixUnit: 'drug', mixVolume: 250, rateMode: 'dose', doseValue: 1,
    doseUnit: 'g/hr', loadOn: true, loadAmount: 4, loadUnit: 'g', loadMode: 'separate', loadVolume: 100, loadMinutes: 20, hours: 24 }, r => [
  'ความเข้มข้น = 4 g / 250 ml = 16 mg/ml',
  `1 g/hr = ${fmt(r.rate)} ml/hr เริ่มหลัง loading 20 นาที นาน 23 ชม. 40 นาที = ${fmt(r.totalVolume)} ml`,
  `จำนวนถุง = ปัดขึ้น(${fmt(r.totalVolume)} / 250) = ${r.bags} ถุง x 4 amp = ${r.containers} amp`,
  `loading 4 g = ${r.loadContainers} amp, รวม ${r.totalContainers} amp`,
]);
ex('Dexmedetomidine 200 mcg/2 ml น้ำหนัก 60 kg: 200 mcg : 50 ml, loading 1 mcg/kg ใน 10 นาทีจากถุงเดียวกัน แล้ว 0.5 mcg/kg/hr',
  { pkgAmount: 200, pkgUnit: 'mcg', pkgVolume: 2, diluent: 'NSS', mixAmount: 200, mixUnit: 'drug', mixVolume: 50, rateMode: 'dose', doseValue: 0.5,
    doseUnit: 'mcg/kg/hr', weight: 60, loadOn: true, loadAmount: 1, loadUnit: 'mcg', loadPerKg: true, loadMode: 'same', loadMinutes: 10, hours: 24, form: 'vial' }, r => [
  'ความเข้มข้น = 200 / 50 = 4 mcg/ml',
  `loading 60 mcg = ${fmt(r.loading.volume)} ml ใน 10 นาที (${fmt(r.loading.rate)} ml/hr)`,
  `0.5 x 60 = 30 mcg/hr / 4 = ${fmt(r.rate)} ml/hr นาน 23 ชม. 50 นาที = 178.75 ml`,
  `รวม ${Number(r.totalVolume.toFixed(2))} ml จึงใช้ปัดขึ้น(193.75 / 50) = ${r.bags} ถุง x 1 vial = ${r.totalContainers} vial`,
]);
ex('Oxytocin 10 IU/1 ml: 10 IU : 1,000 ml (10 mU/ml) ที่ 2 mU/min',
  { pkgAmount: 10, pkgUnit: 'IU', pkgVolume: 1, diluent: 'NSS', mixAmount: 10, mixUnit: 'drug', mixVolume: 1000, rateMode: 'dose', doseValue: 2, doseUnit: 'mU/min', hours: 24 }, r => [
  `2 mU/min = 120 mU/hr / 10 mU/ml = ${fmt(r.rate)} ml/hr`,
  `24 ชม. = ${fmt(r.totalVolume)} ml ไม่เกิน 1,000 ml = ${r.bags} ถุง x 1 amp`,
]);
ex('Propofol 1% 200 mg/20 ml ไม่เจือจาง น้ำหนัก 70 kg ที่ 50 mcg/kg/min',
  { pkgAmount: 200, pkgUnit: 'mg', pkgVolume: 20, diluent: 'none', mixAmount: 1, mixUnit: 'cont', rateMode: 'dose', doseValue: 50, doseUnit: 'mcg/kg/min', weight: 70, hours: 24 }, r => [
  '50 x 70 x 60 = 210,000 mcg/hr = 210 mg/hr / 10 mg/ml = 21 ml/hr',
  `24 ชม. = ${fmt(r.totalVolume)} ml จึงใช้ปัดขึ้น(504 / 20) = ${r.bags} ไซริงจ์ x 1 amp`,
]);
ex('Vasopressin 20 unit/1 ml: 20 unit : 100 ml (0.2 unit/ml) ที่ 0.03 unit/min',
  { pkgAmount: 20, pkgUnit: 'unit', pkgVolume: 1, diluent: 'NSS', mixAmount: 20, mixUnit: 'drug', mixVolume: 100, rateMode: 'dose', doseValue: 0.03, doseUnit: 'unit/min', hours: 24, form: 'vial' }, r => [
  `0.03 x 60 = 1.8 unit/hr / 0.2 = ${fmt(r.rate)} ml/hr`,
  `24 ชม. = ${fmt(r.totalVolume)} ml จึงใช้ปัดขึ้น(216 / 100) = ${r.bags} ถุง x 1 vial`,
]);
ex('KCl 20 mEq/10 ml: 40 mEq ใน NSS 1,000 ml นับยารวม (1,020 ml) ที่ 85 ml/hr',
  { pkgAmount: 20, pkgUnit: 'mEq', pkgVolume: 10, diluent: 'NSS', mixAmount: 40, mixUnit: 'drug', mixVolume: 1000, includeDrugVolume: true, rateMode: 'mlhr', rate: 85, hours: 24, form: 'vial' }, r => [
  `ปริมาตรถุง = 1,000 + 20 = ${fmt(r.bagVolume)} ml`,
  `24 ชม. = 85 x 24 = ${fmt(r.totalVolume)} ml = 2 ถุงพอดี (หมดพอดีตอนครบ 24 ชม. จึงไม่ต้องเปิดถุงที่ 3)`,
  `รวม ${r.bags} x 2 = ${r.totalContainers} vial`,
]);

const out = [
  '# ตารางตรวจมือ: การคำนวณของ Drip Calculator',
  '',
  'สร้างจากตัวแอปด้วย `node tests/make-hand-check.mjs` ทุกตัวเลขในหน้านี้ตรวจซ้ำได้ด้วยเครื่องคิดเลข',
  'และชุดทดสอบเทียบกับตัวคำนวณอีกตัวที่เขียนแยก (`tests/reference.py`) แล้ว',
  '',
  '## ส่วนที่ 1: ยาทุกตัว ทุกสูตรผสม ที่ 10 ml/hr นาน 24 ชม.',
  '',
  'วิธีคิด: ปริมาตร 24 ชม. = 10 x 24 = 240 ml, จำนวนถุง = ปัดขึ้น(240 / ปริมาตรถุง),',
  'หลอดต่อถุง = ปัดขึ้น(ยาต่อถุง / ยาต่อหลอด) เพราะหลอดที่เปิดแล้วใช้ต่อไม่ได้, รวม = ถุง x หลอดต่อถุง',
  '(ยกเว้นยาที่ติ๊ก multi-dose ไว้ ใช้ยาส่วนเหลือต่อได้ รวม = ปัดขึ้น(ถุง x ยาต่อถุง / ยาต่อหลอด))',
  '',
  '| ยา (ขนาดบรรจุ) | สูตรผสม | ปริมาตรถุง (ml) | หลอดต่อถุง | 240 / ปริมาตรถุง | ถุง | รวม |',
  '|---|---|---|---|---|---|---|',
  ...rows,
  '',
  '## ส่วนที่ 2: ตัวอย่างที่มี loading การเปลี่ยนอัตรา และการสั่งเป็นขนาดยา',
  '',
  ...W,
  'ค่าตั้งต้นของยาแต่ละตัวมาจากเอกสารที่ระบุในแอป ก่อนใช้จริงให้ตรวจกับแนวทาง HAD ของโรงพยาบาล',
  '',
];
mkdirSync(join(here, '..', 'docs'), { recursive: true });
writeFileSync(join(here, '..', 'docs', 'ตารางตรวจมือ-การคำนวณ.md'), out.join('\n'));
console.log('wrote docs/ตารางตรวจมือ-การคำนวณ.md', rows.length, 'mix rows,', W.filter(l => l.startsWith('### ')).length, 'worked examples');
