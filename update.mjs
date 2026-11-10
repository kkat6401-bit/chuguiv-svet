// Запускается GitHub Actions. Получает данные, проверяет, сравнивает, пишет data/*.json.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as C from '../js/core.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const QUEUE = 'GPV4.1';
// Другие очереди/города позже: расширить QUEUE до списка, а days — до вложенного объекта.
const SOURCES = [{
  id: 'oe-outage-data', name: 'OE_OUTAGE_DATA (данные Харьковобленерго)',
  url: 'https://raw.githubusercontent.com/yaroslav2901/OE_OUTAGE_DATA/main/data/Kharkivoblenerho.json',
  independent: false,
}];

const load = async (f, fb) => {
  let t; try { t = await readFile(path.join(DATA, f), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fb; throw e; }
  try { return JSON.parse(t); } catch { console.error(`${f} повреждён: остановка, ничего не перезаписано`); process.exit(1); }
};
const save = async (f, o) => { const p = path.join(DATA, f); await writeFile(p + '.tmp', JSON.stringify(o, null, 1)); await rename(p + '.tmp', p); };

async function getText(src) {
  if (process.env.SOURCE_FILE) return readFile(process.env.SOURCE_FILE, 'utf8');
  let err;
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(src.url + '?t=' + Date.now(), { signal: AbortSignal.timeout(20000), headers: { 'cache-control': 'no-cache' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) { err = e; await new Promise((r) => setTimeout(r, 2000 * a)); }
  }
  throw err;
}

function parseSource(text, now) {
  if (!text || !text.trim()) throw new Error('пустой ответ');
  let j; try { j = JSON.parse(text); } catch { throw new Error('повреждённый JSON'); }
  const fact = j?.fact;
  if (!fact || typeof fact.data !== 'object' || !fact.data) throw new Error('нет блока fact.data');
  const parsedAt = j.lastUpdated && !isNaN(new Date(j.lastUpdated)) ? new Date(j.lastUpdated).toISOString() : null;
  const updatedAt = C.parseUpdate(fact.update);
  if (!updatedAt) throw new Error('нет или неверное время обновления графика (fact.update)');
  if (new Date(updatedAt) - now > 10 * 60000) throw new Error('время обновления графика в будущем');
  const srcToday = Number.isFinite(Number(fact.today)) && fact.today ? C.kyivParts(new Date(Number(fact.today) * 1000)).date : null;
  const days = {}, warnings = [];
  for (const [k, v] of Object.entries(fact.data)) {
    const ts = Number(k), p = C.kyivParts(new Date(ts * 1000));
    if (!Number.isFinite(ts) || p.h !== 0 || p.m !== 0) { warnings.push(`ключ ${k}: не полночь Europe/Kyiv`); continue; }
    if (!v || !v[QUEUE]) { warnings.push(`${p.date}: нет очереди ${QUEUE}`); continue; }
    const slots = C.parseDay(v[QUEUE]);
    if (!slots) { warnings.push(`${p.date}: повреждён график ${QUEUE}`); continue; }
    days[p.date] = slots;
  }
  return { days, parsedAt, updatedAt, srcToday, warnings };
}

await mkdir(DATA, { recursive: true });
const now = process.env.NOW_ISO ? new Date(process.env.NOW_ISO) : new Date(), nowIso = now.toISOString();
const today = C.kyivParts(now).date, minD = C.addDays(today, -1), maxD = C.addDays(today, 2);
const prev = await load('schedule.json', { days: {}, sources: [] });
const hist = await load('history.json', { schema: 1, entries: [] });
const out = { ...prev, schema: 1, queue: '4.1', locality: 'Чугуев', tz: C.TZ, generatedAt: nowIso, days: { ...prev.days } };
for (const d of Object.keys(out.days)) if (d < minD) delete out.days[d];
const newEntries = [], same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

out.sources = [];
for (const src of SOURCES) {
  const old = (prev.sources || []).find((s) => s.id === src.id) || {};
  const st = { id: src.id, name: src.name, url: src.url, independent: src.independent, lastAttemptAt: nowIso, lastSuccessAt: old.lastSuccessAt || null, lastAcceptedAt: old.lastAcceptedAt || null, sourceParsedAt: old.sourceParsedAt || null, sourceToday: old.sourceToday || null, scheduleUpdatedAt: old.scheduleUpdatedAt || null, newestDate: old.newestDate || null, status: 'error', message: '' };
  const backup = structuredClone(out.days), n0 = newEntries.length; // ошибка не должна испортить последний корректный график
  try {
    const r = parseSource(await getText(src), now);
    const dates = Object.keys(r.days).sort();
    st.lastSuccessAt = nowIso; st.sourceParsedAt = r.parsedAt; st.sourceToday = r.srcToday; st.newestDate = dates.at(-1) || null;
    if (old.scheduleUpdatedAt && r.updatedAt < old.scheduleUpdatedAt) {
      st.status = 'rollback'; st.message = 'Источник вернул более старую версию графика, она проигнорирована. Показана последняя принятая.';
    } else {
      st.scheduleUpdatedAt = r.updatedAt;
      let accepted = 0;
      for (const d of dates) {
        if (d < minD || d > maxD) continue;
        const slots = r.days[d], was = out.days[d]; accepted++;
        const entry = { detectedAt: nowIso, checkedBefore: old.lastAcceptedAt || null, date: d, scheduleUpdatedAt: r.updatedAt };
        if (!was) newEntries.push({ ...entry, type: 'added', after: C.intervals(slots) });
        else if (!same(was.slots, slots)) newEntries.push({ ...entry, type: 'changed', before: C.intervals(was.slots), after: C.intervals(slots), diff: C.diffSlots(was.slots, slots) });
        out.days[d] = { slots, intervals: C.intervals(slots), scheduleUpdatedAt: was && same(was.slots, slots) ? was.scheduleUpdatedAt : r.updatedAt, firstSeenAt: was?.firstSeenAt || nowIso, confirmedAt: nowIso };
      }
      for (const [d, was] of Object.entries(out.days)) // дата пропала из источника
        if (d >= today && d <= maxD && !r.days[d] && !was.missingSince) { was.missingSince = nowIso; newEntries.push({ detectedAt: nowIso, checkedBefore: old.lastAcceptedAt || null, date: d, type: 'missing', scheduleUpdatedAt: r.updatedAt, before: was.intervals }); }
      if (accepted === 0) { st.status = 'stale_source'; st.message = `В источнике нет графика на ${today} и ближайшие дни (самый новый день: ${st.newestDate || 'нет'}).`; }
      else { st.status = 'ok'; st.lastAcceptedAt = nowIso; st.message = r.warnings.join('; '); }
    }
  } catch (e) { out.days = backup; newEntries.length = n0; st.status = 'error'; st.message = String(e.message || e); }
  out.sources.push(st);
}
const mx = (k) => out.sources.map((s) => s[k]).filter(Boolean).sort().at(-1) || prev[k] || null;
out.lastSuccessAt = mx('lastSuccessAt'); out.lastAcceptedAt = mx('lastAcceptedAt');

for (const d of Object.values(out.days)) if (!Array.isArray(d.slots) || d.slots.length !== 48 || d.slots.some((x) => !['on', 'off', 'maybe'].includes(x))) { console.error('Проверка не пройдена, ничего не записано'); process.exit(1); }
await save('schedule.json', out);
if (newEntries.length) { hist.entries = [...newEntries.reverse(), ...hist.entries].slice(0, 300); await save('history.json', hist); }
console.log(out.sources.map((s) => `${s.id}: ${s.status} ${s.message}`).join('\n'), `\nновых записей истории: ${newEntries.length}`);
