// Drives the real page in headless Chrome the way a person would: search a drug, pick it, tick each diluent,
// pick each preset mix, enter a rate (ml/hr and dose mode), switch on the loading/regimen when the drug has one,
// then reads the number on screen, the form values and the note. Prints JSON for tests/e2e_check.py.
// usage: node tests/e2e-ui.mjs   (needs Google Chrome at the usual macOS path)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(join(here, '..', 'index.html')).href;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'e2e-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

const ws = new WebSocket(await target());
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0; const waiting = new Map(); const errors = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise(res => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

// Runs inside the page.
const DRIVER = String.raw`(() => {
  const $ = s => document.querySelector(s);
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const setVal = (sel, v) => { const el = $(sel); el.value = v; fire(el, 'input'); fire(el, 'change'); };
  const read = () => ({
    params: readParams(), hero: $('#resultMain').hidden ? null : Number($('#heroCount').textContent),
    form: $('#heroForm').textContent, note: currentNote, empty: $('#resultEmpty').hidden ? '' : $('#resultEmpty').textContent,
  });
  const out = [];
  DRUGS.forEach((d, di) => {
    const dils = d.diluents || ['NSS', 'D5W'];
    d.mixes.forEach((m, mi) => {
      dils.forEach(dil => {
        ['mlhr', 'dose', 'special'].forEach(mode => {
          if (mode === 'special' && !d.loading) return;
          document.querySelector('#btnReset').click();
          const search = $('#drugSearch');
          search.focus(); search.value = d.name.slice(0, 4).toLowerCase(); fire(search, 'input');
          const li = [...document.querySelectorAll('#drugList [data-i]')].find(x => comboItems[+x.dataset.i] && comboItems[+x.dataset.i].d === d);
          if (!li) { out.push({ drug: d.id, error: 'not found by search' }); return; }
          li.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          const chip = document.querySelector('[data-dil="' + dil + '"]');
          if (chip) chip.click();
          document.querySelector('[data-mix="' + mi + '"]').click();
          if (mode === 'mlhr') setVal('#rate', '10');
          else {
            document.querySelector('.seg button[data-mode="dose"]').click();
            const p = readParams();
            const drug = p.mixUnit === 'cont' ? p.mixAmount * p.pkgAmount : p.mixAmount;
            const vol = p.diluent === 'none' ? drug / p.pkgAmount * p.pkgVolume : p.mixVolume + (p.includeDrugVolume ? drug / p.pkgAmount * p.pkgVolume : 0);
            const perHr = 10 * drug / vol;                       // what 10 ml/hr delivers, package unit per hour
            const du = $('#doseUnit').value, parts = du.split('/');
            let v = convertAmount(perHr, p.pkgUnit, parts[0]);
            if (parts.includes('kg')) v /= 60;
            if (parts[parts.length - 1] === 'min') v /= 60;
            setVal('#weight', '60');
            setVal('#doseValue', String(Number(v.toPrecision(3))));
            if (mode === 'special') {
              if (d.regimen) $('#btnRegimen').click();
              else { const c = $('#loadOn'); c.checked = true; fire(c, 'change'); }
            }
          }
          const r = read();
          out.push({ drug: d.id, mix: mi, dil, mode, ...r });
        });
      });
    });
  });
  // keyboard path: type, arrow down, Enter
  document.querySelector('#btnReset').click();
  const s = $('#drugSearch'); s.focus(); s.value = 'kcl'; fire(s, 'input');
  s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  out.push({ drug: 'keyboard-kcl', picked: $('#dcName').textContent });
  // "อื่นๆ" path
  document.querySelector('#btnReset').click();
  s.focus(); s.value = 'Ceftriaxone'; fire(s, 'input');
  const other = [...document.querySelectorAll('#drugList [data-i]')].pop();
  other.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  setVal('#pkgAmount', '1'); setVal('#pkgVolume', '10'); setVal('#mixAmount', '2'); setVal('#mixVolume', '100'); setVal('#rate', '10');
  out.push({ drug: 'custom', ...read(), dilChips: document.querySelectorAll('[data-dil]').length });
  return JSON.stringify(out);
})()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
await sleep(2500);
const res = await send('Runtime.evaluate', { expression: DRIVER, returnByValue: true });
if (res.result.exceptionDetails) errors.push('driver: ' + (res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text));
process.stdout.write(JSON.stringify({ errors, cases: res.result.result ? JSON.parse(res.result.result.value || '[]') : [] }));
ws.close(); chrome.kill();
