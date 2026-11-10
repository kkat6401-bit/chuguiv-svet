// Общая логика: работает и в браузере (сайт), и в GitHub Actions (Node). Все даты — Europe/Kyiv.
export const TZ = 'Europe/Kyiv';
export function kyivParts(d) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, h: +p.hour, m: +p.minute };
}
function offsetMs(d) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).format(d);
  const m = /GMT([+-])(\d\d):(\d\d)/.exec(s);
  return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) * 60000 : 0;
}
export function kyivToDate(date, h, m) {
  const [Y, M, D] = date.split('-').map(Number);
  const g = Date.UTC(Y, M - 1, D, h, m);
  const t = g - offsetMs(new Date(g));
  return new Date(g - offsetMs(new Date(t)));
}
export function addDays(date, n) {
  const [Y, M, D] = date.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D + n)).toISOString().slice(0, 10);
}
export function parseUpdate(text) {
  const m = /^(\d\d)\.(\d\d)\.(\d{4}) (\d\d):(\d\d)$/.exec(String(text || '').trim());
  if (!m) return null;
  return kyivToDate(`${m[3]}-${m[2]}-${m[1]}`, +m[4], +m[5]).toISOString();
}
const VALID = new Set(['yes', 'no', 'maybe', 'first', 'second']);
// 24 часовых значения источника -> 48 получасовых слотов: on / off / maybe. Невалидно -> null.
export function parseDay(g) {
  if (!g || typeof g !== 'object') return null;
  const s = [];
  for (let h = 1; h <= 24; h++) {
    const v = g[h];
    if (!VALID.has(v)) return null;
    const [a, b] = v === 'yes' ? ['on', 'on'] : v === 'no' ? ['off', 'off'] : v === 'maybe' ? ['maybe', 'maybe'] : v === 'first' ? ['off', 'on'] : ['on', 'off'];
    s.push(a, b);
  }
  return s;
}
const t = (i) => { const m = i * 30; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
export function intervals(slots) {
  const r = []; let s = 0;
  for (let i = 1; i <= 48; i++) if (i === 48 || slots[i] !== slots[s]) { r.push({ from: t(s), to: t(i), state: slots[s] }); s = i; }
  return r;
}
export function diffSlots(a, b) {
  const r = []; let s = null;
  for (let i = 0; i <= 48; i++) {
    const k = i < 48 && a[i] !== b[i] ? a[i] + '>' + b[i] : null;
    if (s && k !== s.k) { r.push({ from: t(s.i), to: t(i), before: a[s.i], after: b[s.i] }); s = null; }
    if (k && !s) s = { i, k };
  }
  return r;
}
// Текущее состояние и ближайшее изменение. Неизвестное не достраивается.
export function analyze(days, now = new Date()) {
  const p = kyivParts(now), idx = p.h * 2 + (p.m >= 30 ? 1 : 0), cur = days[p.date]?.slots;
  if (!cur) return { known: false, date: p.date, idx };
  const state = cur[idx], last = addDays(p.date, 1);
  let d = p.date, arr = cur, i = idx + 1;
  for (;;) {
    if (i >= 48) { d = addDays(d, 1); arr = days[d]?.slots; i = 0; if (!arr || d > last) return { known: true, state, date: p.date, idx, next: null }; }
    if (arr[i] !== state) return { known: true, state, date: p.date, idx, next: { at: kyivToDate(d, Math.floor(i / 2), (i % 2) * 30), to: arr[i] } };
    i++;
  }
}

// Оценка достоверности. Наличие сегодняшней даты в данных само по себе актуальность не доказывает.
const RANK = { high: 0, medium: 1, low: 2, none: 3 };
export function assess(sch, now = new Date()) {
  if (!sch || !sch.lastAcceptedAt) return { level: 'none', usable: false, reasons: ['Нет ни одной принятой проверки источника: корректных данных нет.'] };
  const reasons = [], p = kyivParts(now), mins = (iso) => (now - new Date(iso)) / 60000;
  const fmt = (m) => (m < 90 ? `${Math.round(m)} мин` : m < 2880 ? `${Math.round(m / 60)} ч` : `${Math.round(m / 1440)} дн`);
  let level = 'high';
  const bump = (l, text) => { if (RANK[l] > RANK[level]) level = l; reasons.push(text); };
  const byAge = (m, what) => (m > 360 ? bump('none', `${what}: ${fmt(m)} назад, слишком давно.`) : m > 120 ? bump('low', `${what}: ${fmt(m)} назад.`) : m > 45 ? bump('medium', `${what}: ${fmt(m)} назад.`) : 0);
  byAge(mins(sch.lastAcceptedAt), 'Последняя принятая проверка источника');
  const day = sch.days?.[p.date];
  if (!day) bump('none', 'Графика на сегодня нет.');
  else {
    if (day.missingSince) bump('low', 'Источник перестал содержать график на сегодня, показана последняя сохранённая версия.');
    else byAge(mins(day.confirmedAt), 'Сегодняшний график последний раз подтверждён источником');
  }
  for (const s of sch.sources || []) {
    if (s.status === 'stale_source') bump('low', s.message);
    else if (s.status === 'rollback') bump('medium', s.message);
    else if (s.status === 'error') bump('medium', `Последняя попытка получить данные не удалась: ${s.message}`);
    if (s.status === 'ok' && s.sourceToday && s.sourceToday !== p.date) bump(p.h === 0 && p.m < 30 ? 'medium' : 'low', `Источник ещё считает «сегодня» датой ${s.sourceToday}.`);
    if (s.sourceParsedAt && mins(s.sourceParsedAt) > 720) bump('medium', `Файл источника не обновлялся ${fmt(mins(s.sourceParsedAt))}: изменений могло не быть, а парсер мог остановиться.`);
  }
  return { level, usable: level !== 'none', reasons };
}
