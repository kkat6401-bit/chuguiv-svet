// Запуск: node tests/run-tests.mjs  (нужен Node 20+; на сайте и в Actions не используется)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../js/core.js';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0, bad = 0;
const t = (n, f) => { try { f(); ok++; console.log('ok   ' + n); } catch (e) { bad++; console.log('FAIL ' + n + '\n     ' + e.message); } };
const H = (o = {}) => Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), o[i + 1] || 'yes']));
const REAL_PAT = { 8: 'no', 9: 'no', 10: 'first', 17: 'second', 18: 'no', 19: 'no', 20: 'no' }; // GPV4.1 из реального файла от 07.10.2026
const file = (days, update, today, parsed = '2026-10-07T21:01:49.465Z') => ({ lastUpdated: parsed, fact: { data: days, update, today } });
const REAL = file({ 1791406800: { 'GPV4.1': H(REAL_PAT), 'GPV1.1': H() } }, '08.10.2026 00:01', 1791406800);
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oe-'));
function run(dir, src, now, extra = {}) {
  const sf = path.join(dir, 'src.json');
  if (src === null) fs.rmSync(sf, { force: true }); else fs.writeFileSync(sf, typeof src === 'string' ? src : JSON.stringify(src));
  const env = { ...process.env, DATA_DIR: path.join(dir, 'd'), NOW_ISO: now, ...extra }; if (!extra.NO_SF) env.SOURCE_FILE = sf; else delete env.SOURCE_FILE;
  const r = spawnSync('node', [path.join(ROOT, 'scripts/update.mjs')], { env, encoding: 'utf8' });
  const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'd', f), 'utf8')); } catch { return null; } };
  return { code: r.status, sch: rd('schedule.json'), hist: rd('history.json'), out: r.stdout + r.stderr };
}
const offs = (iv) => iv.filter((x) => x.state === 'off').map((x) => `${x.from}-${x.to}`).join(',');

t('1. реальный срез: GPV4.1, timestamp, fact.update -> интервалы', () => {
  const d = mk(), r = run(d, REAL, '2026-10-08T09:00:00Z');
  assert.equal(r.sch.sources[0].status, 'ok'); assert.deepEqual(Object.keys(r.sch.days), ['2026-10-08']);
  assert.equal(offs(r.sch.days['2026-10-08'].intervals), '07:00-09:30,16:30-20:00');
  assert.equal(r.sch.days['2026-10-08'].scheduleUpdatedAt, '2026-10-07T21:01:00.000Z'); assert.equal(r.sch.sources[0].sourceToday, '2026-10-08');
});
t('2. часовой пояс: летнее/зимнее время и границы суток', () => {
  assert.equal(C.kyivToDate('2026-03-29', 0, 0).toISOString(), '2026-03-28T22:00:00.000Z');
  assert.equal(C.kyivToDate('2026-03-30', 0, 0).toISOString(), '2026-03-29T21:00:00.000Z'); // 23-часовые сутки
  assert.equal(C.kyivToDate('2026-10-25', 0, 0).toISOString(), '2026-10-24T21:00:00.000Z');
  assert.equal(C.kyivToDate('2026-10-26', 0, 0).toISOString(), '2026-10-25T22:00:00.000Z'); // 25-часовые сутки
  assert.equal(C.parseUpdate('15.12.2026 10:00'), '2026-12-15T08:00:00.000Z'); assert.equal(C.parseUpdate('2026-12-15'), null);
  assert.equal(C.kyivParts(new Date('2026-12-31T22:30:00Z')).date, '2027-01-01'); assert.equal(C.addDays('2026-02-28', 1), '2026-03-01');
});
t('3. значения yes/no/maybe/first/second и защита от неизвестных', () => {
  const s = C.parseDay(H({ 1: 'no', 2: 'maybe', 3: 'first', 4: 'second' }));
  assert.deepEqual(s.slice(0, 8), ['off', 'off', 'maybe', 'maybe', 'off', 'on', 'on', 'off']); assert.equal(s.length, 48);
  assert.equal(C.parseDay(H({ 5: 'нет' })), null); assert.equal(C.parseDay({ 1: 'yes' }), null); assert.equal(C.parseDay(null), null);
});
t('4. analyze: переходы, полночь, нет завтра', () => {
  const days = { '2026-11-10': { slots: C.parseDay(H({ 24: 'no' })) }, '2026-11-11': { slots: C.parseDay(H({ 1: 'no', 2: 'second' })) } };
  const at = (d, h, m) => C.analyze(days, C.kyivToDate(d, h, m));
  let r = at('2026-11-10', 12, 0); assert.equal(r.state, 'on'); assert.equal(C.kyivParts(r.next.at).h, 23); assert.equal(r.next.to, 'off');
  r = at('2026-11-10', 23, 45); assert.equal(r.state, 'off'); assert.equal(r.next.to, 'on'); assert.equal(C.kyivParts(r.next.at).date, '2026-11-11'); assert.equal(C.kyivParts(r.next.at).h, 1); // 23:45 off, 00:00-01:00 off, включение в 01:00
  r = at('2026-11-11', 1, 45); assert.equal(r.state, 'off'); assert.equal(r.next.to, 'on'); assert.equal(C.kyivParts(r.next.at).h, 2);
  r = at('2026-11-12', 10, 0); assert.equal(r.known, false);
  const one = { '2026-11-10': days['2026-11-10'] }; r = C.analyze(one, C.kyivToDate('2026-11-10', 23, 10)); assert.equal(r.next, null); // конец суток, завтра неизвестно
  assert.equal(C.analyze({ '2026-11-10': { slots: C.parseDay(H()) } }, C.kyivToDate('2026-11-10', 0, 0)).next, null);
});
t('5. достоверность assess()', () => {
  const now = new Date('2026-11-10T09:00:00Z'), ago = (m) => new Date(now - m * 60000).toISOString();
  const S = (m, o = {}) => ({ lastAcceptedAt: ago(m), days: { '2026-11-10': { confirmedAt: ago(m), ...o.day } }, sources: [{ status: 'ok', sourceToday: '2026-11-10', sourceParsedAt: ago(m), ...o.src }] });
  const lv = (s) => C.assess(s, now).level;
  assert.equal(lv(S(10)), 'high'); assert.equal(lv(S(60)), 'medium'); assert.equal(lv(S(200)), 'low'); assert.equal(lv(S(400)), 'none');
  assert.equal(lv(S(10, { src: { sourceToday: '2026-11-09' } })), 'low'); assert.equal(lv(S(10, { day: { missingSince: ago(5) } })), 'low');
  assert.equal(lv(S(10, { src: { sourceParsedAt: ago(800) } })), 'medium'); assert.equal(lv(S(10, { src: { status: 'stale_source', message: 'x' } })), 'low');
  assert.equal(lv({ lastAcceptedAt: ago(5), days: {}, sources: [] }), 'none'); assert.equal(lv(null), 'none');
});
t('6. устаревший источник (реальный срез, сегодня 10.11.2026) не даёт «актуальных» данных', () => {
  const r = run(mk(), REAL, '2026-11-10T07:00:00Z');
  assert.equal(r.sch.sources[0].status, 'stale_source'); assert.deepEqual(r.sch.days, {}); assert.equal(r.sch.lastAcceptedAt, null);
  assert.equal(C.assess(r.sch, new Date('2026-11-10T07:00:00Z')).usable, false);
});
t('7. откат к старой версии игнорируется', () => {
  const d = mk(), n = '2026-10-08T09:00:00Z', P = H({ 5: 'no' });
  run(d, file({ 1791406800: { 'GPV4.1': P } }, '08.10.2026 10:00', 1791406800), n);
  const r = run(d, file({ 1791406800: { 'GPV4.1': H({ 6: 'no' }) } }, '08.10.2026 09:00', 1791406800), '2026-10-08T09:10:00Z');
  assert.equal(r.sch.sources[0].status, 'rollback'); assert.equal(offs(r.sch.days['2026-10-08'].intervals), '04:00-05:00'); assert.equal(r.hist.entries.length, 1);
  assert.equal(r.sch.sources[0].lastAcceptedAt, new Date(n).toISOString());
});
t('8. история: без дублей, несколько отдельных изменений, пропавшая дата', () => {
  const d = mk(), k = 1791406800, k2 = k + 86400, N = (m) => `2026-10-08T${m}:00Z`;
  const f = (p, u, days = { [k]: p }) => file(days, u, k);
  let r = run(d, f({ 'GPV4.1': H({ 5: 'no' }) }, '08.10.2026 10:00'), N('08:00')); assert.equal(r.hist.entries.length, 1);
  r = run(d, f({ 'GPV4.1': H({ 5: 'no' }) }, '08.10.2026 10:00'), N('08:10')); assert.equal(r.hist.entries.length, 1, 'повтор не должен давать записей');
  r = run(d, f({ 'GPV4.1': H({ 5: 'no', 9: 'maybe', 10: 'maybe', 20: 'no' }) }, '08.10.2026 12:00'), N('09:10'));
  assert.equal(r.hist.entries.length, 2); const e = r.hist.entries[0]; assert.equal(e.type, 'changed'); assert.equal(e.diff.length, 2);
  assert.deepEqual(e.diff[0], { from: '08:00', to: '10:00', before: 'on', after: 'maybe' }); assert.deepEqual(e.diff[1], { from: '19:00', to: '20:00', before: 'on', after: 'off' });
  r = run(d, f({ 'GPV4.1': H({ 5: 'no', 9: 'maybe', 10: 'maybe', 20: 'no' }) }, '08.10.2026 12:00', { [k2]: { 'GPV4.1': H() } }), N('09:30'));
  assert.equal(r.hist.entries.filter((x) => x.type === 'missing').length, 1); assert.ok(r.sch.days['2026-10-08'].missingSince); assert.equal(r.sch.days['2026-10-08'].slots.length, 48);
  r = run(d, f(0, '08.10.2026 12:00', { [k2]: { 'GPV4.1': H() } }), N('09:40')); assert.equal(r.hist.entries.filter((x) => x.type === 'missing').length, 1, 'пропажа не должна дублироваться');
});
t('9. ошибки не уничтожают последний корректный график', () => {
  const d = mk(), n = '2026-10-08T09:00:00Z'; let r = run(d, REAL, n); const sl = (x) => JSON.stringify(Object.values(x.days).map((v) => v.slots)), before = sl(r.sch), acc = r.sch.lastAcceptedAt;
  for (const bad of ['', '{"fact":{"data":{}}', '{}', '[]', JSON.stringify(file({ 1791406800: { 'GPV4.1': H({ 3: 'zzz' }) } }, '08.10.2026 12:00', 1791406800)), JSON.stringify(file({ 1791406800: { 'GPV4.1': H() } }, 'вчера', 1791406800)), JSON.stringify(file({ 1791406800: { 'GPV4.1': H() } }, '01.01.2030 10:00', 1791406800)), null]) {
    r = run(d, bad, '2026-10-08T09:20:00Z'); assert.equal(r.code, 0); assert.equal(sl(r.sch), before, 'график изменился на: ' + String(bad).slice(0, 40)); assert.equal(r.sch.lastAcceptedAt, acc);
    assert.ok(['error', 'stale_source'].includes(r.sch.sources[0].status));
  }
  r = run(d, null, '2026-10-08T09:30:00Z', { NO_SF: '1' }); assert.equal(sl(r.sch), before); // реальная сетевая попытка: в песочнице без сети — ошибка
  assert.ok(['ok', 'error', 'stale_source'].includes(r.sch.sources[0].status));
});
t('10. повреждённый schedule.json: остановка без перезаписи', () => {
  const d = mk(); run(d, REAL, '2026-10-08T09:00:00Z'); const p = path.join(d, 'd/schedule.json'); fs.writeFileSync(p, '{"days":');
  const r = run(d, REAL, '2026-10-08T09:10:00Z'); assert.equal(r.code, 1); assert.equal(fs.readFileSync(p, 'utf8'), '{"days":');
});
t('11. файлы сайта: пути и синтаксис', () => {
  const h = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'); assert.match(h, /href="css\/style\.css"/); assert.match(h, /src="js\/app\.js"/);
  for (const f of ['css/style.css', 'js/app.js', 'js/core.js', 'data/schedule.json', 'data/history.json', 'package.json']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/schedule.json'), 'utf8')).generatedAt, null); // стартовые данные пустые, не фиктивные
});
console.log(`\nпройдено: ${ok}, провалено: ${bad}`); process.exit(bad ? 1 : 0);
