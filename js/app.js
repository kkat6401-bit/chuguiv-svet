import { analyze, assess, intervals, kyivParts, addDays } from './core.js';

const $ = (id) => document.getElementById(id);
const TZ = 'Europe/Kyiv';
const hm = (d) => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d);
const dm = (d) => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(d);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (iso) => {
  if (!iso) return 'нет данных';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  return m < 1 ? 'только что' : m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.floor(m / 60)} ч ${m % 60} мин назад` : `${Math.floor(m / 1440)} дн назад`;
};
const dur = (ms) => { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? `${h} ч ${m % 60} мин` : `${m} мин`; };
const NAME = { on: 'есть свет', off: 'нет света', maybe: 'возможно отключение' };

let schedule = null, history = { entries: [] }, loadError = '', day = 'today';

function dataUrls(file) {
  const u = [], h = location.hostname, seg = location.pathname.split('/')[1];
  if (h.endsWith('.github.io') && seg) u.push(`https://raw.githubusercontent.com/${h.split('.')[0]}/${seg}/main/data/${file}`);
  u.push(`data/${file}`);
  return u;
}
async function getJson(file, rank, valid) {
  const rs = await Promise.allSettled(dataUrls(file).map(async (u) => { const r = await fetch(u + '?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); if (!valid(j)) throw new Error('неверный формат'); return j; }));
  const ok = rs.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (!ok.length) throw new Error(rs[0].reason?.message || 'нет ответа');
  return ok.sort((x, y) => rank(y).localeCompare(rank(x)))[0];
}
async function load() {
  try { schedule = await getJson('schedule.json', (j) => j.generatedAt || '', (j) => j && typeof j.days === 'object' && Array.isArray(j.sources)); loadError = ''; } catch (e) { loadError = 'Не удалось загрузить данные сайта: ' + e.message; }
  try { history = await getJson('history.json', (j) => j.entries[0]?.detectedAt || '', (j) => j && Array.isArray(j.entries)); } catch { /* история необязательна для показа графика */ }
  render();
}

const LV = { high: ['ok', 'достоверность высокая'], medium: ['warn', 'достоверность средняя'], low: ['bad', 'достоверность низкая'], none: ['bad', 'данные недостоверны'] };
function render() {
  const now = new Date(), p = kyivParts(now);
  $('clock').textContent = hm(now);
  const days = schedule?.days || {}, src = schedule?.sources || [], A = assess(schedule, now);
  const notes = [];
  if (loadError) notes.push(['bad', loadError + (schedule ? ' Показаны ранее загруженные данные.' : '')]);
  if (schedule && !schedule.lastAcceptedAt && !src.length) notes.push(['bad', 'Данных ещё нет: ни одной проверки источника не было. Запустите проверку вручную в GitHub (Actions → Run workflow).']);
  for (const r of A.reasons) notes.push([A.level === 'none' || A.level === 'low' ? 'bad' : '', r]);
  for (const s of src) if (s.status === 'ok' && s.message) notes.push(['', s.message]);
  if (src.length && src.every((s) => s.independent === false)) notes.push(['', 'Подключён один источник, сверка с независимым невозможна. Расхождения не проверяются.']);
  $('notices').innerHTML = notes.map(([c, t]) => `<div class="notice ${c}">${esc(t)}</div>`).join('');

  const a = analyze(days, now), ok = a.known && A.usable;
  let cls = 'unk', big = 'Статус неизвестен', next = a.known ? 'Данные слишком устарели. Последний сохранённый график показан ниже, но не как текущий.' : 'Графика на сегодня нет. Неизвестное не достраивается.';
  if (ok) {
    cls = a.state; big = a.state === 'on' ? 'Свет есть по графику' : a.state === 'off' ? 'Света нет по графику' : 'Возможно отключение';
    if (a.next) {
      const when = kyivParts(a.next.at).date === p.date ? '' : ' (завтра)', left = ` · через ${dur(a.next.at - now)}`;
      next = a.state === 'on' ? (a.next.to === 'off' ? `Отключение в ${hm(a.next.at)}${when}${left}` : `Возможное отключение с ${hm(a.next.at)}${when}${left}`)
        : a.next.to === 'on' ? `Включение в ${hm(a.next.at)}${when}${left}` : `Статус изменится в ${hm(a.next.at)}${when}: ${NAME[a.next.to]}${left}`;
    } else next = a.state === 'on' ? 'Отключений в известном графике дальше нет. Графика на завтра может не быть.' : 'Дальше график не опубликован, время включения неизвестно.';
  }
  const [bc, bt] = LV[A.level], st = $('status'); st.className = 'card status ' + (ok && A.level !== 'low' ? cls : ok ? 'stale' : 'unk');
  const upd = days[p.date]?.scheduleUpdatedAt;
  st.innerHTML = `<p class="big">${big}</p><p class="next">${esc(next)}</p>
    <p class="meta"><span class="badge ${bc}">${bt}</span>очередь 4.1 · график на ${p.date.split('-').reverse().join('.')}${upd ? ' · график обновлён ' + dm(new Date(upd)) : ''}<br>Последняя принятая проверка: ${ago(schedule?.lastAcceptedAt)}</p>`;

  // Шкала
  const date = day === 'today' ? p.date : addDays(p.date, 1), rec = days[date];
  $('tabToday').classList.toggle('on', day === 'today'); $('tabTomorrow').classList.toggle('on', day !== 'today');
  const slots = rec?.slots;
  $('dayinfo').textContent = rec ? `График на ${date.split('-').reverse().join('.')} · обновлён ${dm(new Date(rec.scheduleUpdatedAt))}${A.usable ? '' : ' · последний сохранённый, УСТАРЕЛ'}` : `График на ${date.split('-').reverse().join('.')} не получен. Всё время неизвестно.`;
  $('timeline').innerHTML = Array.from({ length: 48 }, (_, i) => `<i class="${slots ? slots[i] : 'unk'}"></i>`).join('') + (day === 'today' ? `<span class="now" style="left:${((p.h * 60 + p.m) / 1440) * 100}%" title="сейчас ${hm(now)}"></span>` : '');
  const nowMin = p.h * 60 + p.m;
  $('intervals').innerHTML = slots ? intervals(slots).map((iv) => {
    const [fh, fm] = iv.from.split(':').map(Number), [th, tm] = iv.to.split(':').map(Number);
    const cur = day === 'today' && nowMin >= fh * 60 + fm && nowMin < th * 60 + tm;
    return `<li class="${cur ? 'cur' : ''}"><span>${iv.from}–${iv.to}${cur ? ' · сейчас' : ''}</span><span class="s ${iv.state}">${NAME[iv.state]}</span></li>`;
  }).join('') : '';

  // История
  $('history').innerHTML = (history.entries.length ? history.entries.slice(0, 40).map((e) => {
    const ivs = (l) => l.filter((x) => x.state !== 'on').map((x) => `${x.from}–${x.to}`).join(', ') || 'без отключений';
    const body = e.type === 'changed'
      ? `<p>Изменения: ${e.diff.map((d) => `${d.from}–${d.to}: ${NAME[d.before]} → ${NAME[d.after]}`).join('; ')}</p><p class="muted">Было: ${ivs(e.before)}<br>Стало: ${ivs(e.after)}</p>`
      : e.type === 'missing' ? `<p>Источник перестал содержать график на эту дату. Показана сохранённая версия. Отключения в ней: ${ivs(e.before)}</p>`
      : `<p>Опубликован график. Отключения: ${ivs(e.after)}</p>`;
    return `<div class="h"><div class="t">Обнаружено ${dm(new Date(e.detectedAt))}${e.checkedBefore ? ' (предыдущая принятая проверка: ' + dm(new Date(e.checkedBefore)) + ')' : ''} · график на ${e.date.split('-').reverse().join('.')}</div>${body}</div>`;
  }).join('') : '<p class="muted">Изменений пока не зафиксировано.</p>') + '<p class="muted">История ведётся только с момента первого запуска проверок. Изменения между проверками (раз в 10+ минут) или во время сбоев Actions не фиксируются.</p>';

  // Источники
  $('sources').innerHTML = (src.length ? src.map((s) => `<div class="src"><b>${esc(s.name)}</b>
    <p>Статус: ${{ ok: 'подключён', stale_source: 'доступен, но данные не актуальны', error: 'ошибка получения', rollback: 'вернул более старую версию' }[s.status] || s.status}</p>
    <p>Последнее принятое получение: ${s.lastAcceptedAt ? dm(new Date(s.lastAcceptedAt)) : 'нет'}</p>
    <p>Последнее успешное получение (файл прочитан): ${s.lastSuccessAt ? dm(new Date(s.lastSuccessAt)) : 'нет'}</p>
    <p>Последняя попытка: ${s.lastAttemptAt ? dm(new Date(s.lastAttemptAt)) : 'нет'}</p>
    <p>Время обновления графика в источнике: ${s.scheduleUpdatedAt ? dm(new Date(s.scheduleUpdatedAt)) : 'нет'}</p>
    <p>Независимость: нет, это копия сайта Харьковобленерго</p></div>`).join('') : '<p class="muted">Проверок ещё не было.</p>')
    + '<div class="src"><p>Не подключены: outage-data-ua, bezsvitla.com.ua, alerts.energy. Структура доступна не везде, и все они берут данные у того же Харьковобленерго.</p></div>';
}

$('tabToday').onclick = () => { day = 'today'; render(); };
$('tabTomorrow').onclick = () => { day = 'tomorrow'; render(); };
load(); setInterval(render, 30000); setInterval(load, 120000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
