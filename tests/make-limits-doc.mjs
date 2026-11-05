// Writes docs/เกณฑ์เตือนขนาดยา.md from the LIMITS table inside index.html, so the document never drifts from the app.
// usage: node tests/make-limits-doc.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const block = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));
const api = new Function(`${block('// DATA-START', '// DATA-END')}\n${block('// CALC-START', '// CALC-END')}
return { DRUGS, SOURCES, LIMITS, LIMITS_NOTE, fmt };`)();
const { DRUGS, SOURCES, LIMITS, LIMITS_NOTE, fmt } = api;

const KIND = { dose: 'ขนาดยาที่หยด', rate: 'ความเร็วให้ยา (รวม loading)', load: 'ขนาด loading', loadMin: 'เวลาให้ loading',
  conc: 'ความเข้มข้นในถุง', day: 'ยารวม 24 ชม. แรก', hours: 'ระยะเวลาที่สั่ง' };
const LEVEL = { info: 'ฟ้า', warn: 'เหลือง', danger: 'แดง' };
const cell = s => String(s ?? '').replace(/\|/g, '/');
const src = keys => keys.map(k => SOURCES[k].u ? `[${SOURCES[k].t}](${SOURCES[k].u})` : SOURCES[k].t).join(', ');
const unitOf = L => (L.kind === 'load' && L.perKg ? `${L.unit}/kg` : L.unit.replace('/24hr', '/24 ชม.'));

const lines = [
  '# เกณฑ์เตือนขนาดยาและอัตรา (Drip Calculator)',
  '',
  '> ไฟล์นี้สร้างจากตาราง LIMITS ใน index.html ด้วย `node tests/make-limits-doc.mjs` แก้ตัวเลขที่ index.html แล้วสร้างใหม่ ห้ามแก้ไฟล์นี้ตรงๆ',
  '',
  'สีของคำเตือนในแอป:',
  '- **แดง** เกินค่าสูงสุดที่แหล่งอ้างอิงเขียนไว้',
  '- **เหลือง** สูงกว่าช่วงที่แนะนำ หรือผิดเงื่อนไขที่ฉลากกำหนด',
  '- **ฟ้า** ต่ำกว่าช่วงที่แนะนำ ซึ่งอาจพิมพ์ผิด หรือข้อมูลประกอบ',
  '',
  'แอปเทียบตัวเลขตามที่แสดงบนจอ (ทศนิยมแบบเดียวกับหน้าจอ) ค่าที่เท่ากับเกณฑ์พอดีไม่เตือน',
  'เกณฑ์ที่เป็นต่อ kg ใช้เมื่อใส่น้ำหนักผู้ป่วย ถ้าไม่ใส่ แอปจะบอกให้ใส่ และใช้เกณฑ์แบบไม่ต่อ kg แทนเมื่อมี',
  'ขนาดยาที่หยดตรวจทุกช่วงอัตรา (รวมหลังเปลี่ยนอัตรา) แต่ไม่ตรวจช่วง loading ซึ่งมีเกณฑ์ของตัวเอง',
  '',
  '| ยา | ตรวจอะไร | หน่วย | ต่ำกว่า | สูงกว่า | สูงสุด (แดง) | เงื่อนไข | หมายเหตุจากแหล่ง | ที่มา |',
  '|---|---|---|---|---|---|---|---|---|',
];
const seen = new Set();
for (const d of DRUGS) {
  const rules = LIMITS[d.id];
  const name = `${d.name} ${fmt(d.amount)} ${d.unit}/${fmt(d.volume)} ml`;
  if (!rules) continue;
  for (const L of rules) {
    const low = L.low != null ? `${fmt(L.low)} (${LEVEL[L.lowLevel || 'info']})` : '';
    const high = L.high != null ? `${fmt(L.high)} (${LEVEL[L.highLevel || 'warn']})` : '';
    const max = L.max != null ? fmt(L.max) : '';
    const when = [L.ctx, L.noWeight ? 'ใช้เมื่อไม่ได้ใส่น้ำหนัก' : ''].filter(Boolean).join(', ');
    const note = [L.note, L.lowNote].filter(Boolean).join(' / ');
    lines.push(`| ${cell(name)} | ${KIND[L.kind]} | ${cell(unitOf(L))} | ${low} | ${high} | ${max} | ${cell(when)} | ${cell(note)} | ${src(L.src)} |`);
  }
  seen.add(d.id);
}
lines.push('', '## ยาที่ไม่มีเกณฑ์เต็ม', '', '| ยา | เหตุผล (แสดงในแอปด้วย) |', '|---|---|');
for (const d of DRUGS) if (LIMITS_NOTE[d.id]) lines.push(`| ${d.name} ${fmt(d.amount)} ${d.unit}/${fmt(d.volume)} ml | ${LIMITS_NOTE[d.id]} |`);
lines.push('', 'ยาที่กรอกเอง (อื่นๆ) ไม่มีเกณฑ์เตือน', '');
writeFileSync(join(here, '..', 'docs', 'เกณฑ์เตือนขนาดยา.md'), lines.join('\n'));
console.log(`rules: ${Object.values(LIMITS).flat().length} in ${seen.size} drugs; notes: ${Object.keys(LIMITS_NOTE).length}`);
