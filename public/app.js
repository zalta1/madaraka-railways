/* Madaraka Railways demo front end – vanilla JS SPA */
const $ = (s, el = document) => el.querySelector(s); const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const S = { get(k, d) { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { sessionStorage.setItem(k, JSON.stringify(v)); } };
let lang = localStorage.getItem('lang') || 'en';
const t = (k) => (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ksh = (n) => 'KSh ' + Number(n || 0).toLocaleString('en-KE');
const app = $('#app');
let STATIONS = [];
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }; const tok = opts.token || (opts.auth && localStorage.getItem('access_token'));
  if (tok) headers.Authorization = 'Bearer ' + tok;
  const r = await fetch('/console/api' + path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message || 'Request failed'); e.errors = j.errors || {}; e.status = r.status; throw e; }
  return j.data;
}
function toast(m) { const el = $('#toast'); el.textContent = m; el.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (el.style.display = 'none'), 3500); }
function modal(html) { const m = $('#modal'); m.innerHTML = `<div class="card">${html}</div>`; m.classList.remove('hidden'); return m; }
function closeModal() { $('#modal').classList.add('hidden'); }
const stName = (id) => (STATIONS.find((s) => s.id === Number(id)) || {}).name || id;
const todayStr = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
function applyI18n() { $$('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n))); $('#langBtn').textContent = lang === 'en' ? 'SW' : 'EN'; document.documentElement.lang = lang; }
function applyTheme() { document.documentElement.dataset.theme = localStorage.getItem('theme') || 'light'; $('#themeBtn').textContent = localStorage.getItem('theme') === 'dark' ? '☀️' : '🌙'; }
$('#langBtn').onclick = () => { lang = lang === 'en' ? 'sw' : 'en'; localStorage.setItem('lang', lang); applyI18n(); route(); };
$('#themeBtn').onclick = () => { localStorage.setItem('theme', localStorage.getItem('theme') === 'dark' ? 'light' : 'dark'); applyTheme(); };
function go(p) { history.pushState({}, '', p); route(); window.scrollTo(0, 0); }
document.addEventListener('click', (e) => { const a = e.target.closest('a[data-link]'); if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute('href')); } });
window.addEventListener('popstate', route);
function showErrors(form, err) {
  $$('.err', form).forEach((x) => x.remove());
  let shown = false;
  for (const [k, msgs] of Object.entries(err.errors || {})) { const el = form.querySelector(`[name="${k}"]`); if (el) { el.insertAdjacentHTML('afterend', `<div class="err">${esc(msgs[0])}</div>`); shown = true; } }
  if (!shown) form.insertAdjacentHTML('beforeend', `<div class="err">${esc(err.message)}</div>`);
}

// ---------------- Home ----------------
function stationOptions(sel, filterIds) { return `<option value="">${lang === 'sw' ? 'Chagua...' : 'Select...'}</option>` + STATIONS.filter((s) => !filterIds || filterIds.includes(s.id)).map((s) => `<option value="${s.id}" ${Number(sel) === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join(''); }
function home() {
  const s = S.get('search', { trip: 'oneway', service: '', from: '', to: '', date: addDays(todayStr(), 1), return_date: '', klass: '', adult: 1, teenager: 0, child: 0, infant: 0 });
  app.innerHTML = `<section class="hero"><h1>${t('hero_t')}</h1><p><b>${t('hero_s')}</b></p><p>${t('hero_x')}</p></section>
  <section class="booker"><div class="tabs" role="tablist"><button class="${s.klass !== 'premium' ? 'on' : ''}" data-tab="std">🚆 ${t('economy')} / ${t('first')}</button><button class="${s.klass === 'premium' ? 'on' : ''}" data-tab="premium">★ ${t('premium')}</button></div>
  <form class="card" id="searchForm" style="margin-top:0;border-top-left-radius:0" novalidate>
   <div class="radio"><label><input type="radio" name="trip" value="oneway" ${s.trip !== 'round' ? 'checked' : ''}> ${t('oneway')}</label><label><input type="radio" name="trip" value="round" ${s.trip === 'round' ? 'checked' : ''}> ${t('round')}</label></div>
   <div class="grid"><div><label for="service">${t('service')}</label><select id="service" name="service"><option value="">${t('any')}</option>${['express', 'intercounty', 'suswa'].map((v) => `<option value="${v}" ${s.service === v ? 'selected' : ''}>${t(v)}</option>`).join('')}</select></div>
    <div><label for="from">${t('from')}</label><select id="from" name="from"></select></div>
    <div class="rel"><button type="button" class="btn ghost swap" id="swap" title="Swap" aria-label="Swap from and to">⇄</button><label for="to">${t('to')}</label><select id="to" name="to"></select></div>
    <div><label for="date">${t('date')}</label><input type="date" id="date" name="date" min="${todayStr()}" max="${addDays(todayStr(), 60)}" value="${s.date}"></div>
    <div id="retWrap" ${s.trip === 'round' ? '' : 'hidden'}><label for="return_date">${t('ret')}</label><input type="date" id="return_date" name="return_date" min="${todayStr()}" max="${addDays(todayStr(), 60)}" value="${s.return_date}"></div></div>
   <div class="grid" style="margin-top:12px">${['adult', 'teenager', 'child', 'infant'].map((p, i) => `<div><label for="p_${p}">${t(['adults', 'teens', 'children', 'infants'][i])}</label><input type="number" min="0" max="9" id="p_${p}" name="${p}" value="${s[p]}"></div>`).join('')}
    <div><button class="btn alt wide" type="submit">${t('search')}</button></div></div><input type="hidden" name="klass" value="${s.klass === 'premium' ? 'premium' : ''}"></form></section>
  <section class="tiles" style="margin-top:20px">
   <div class="tile"><h3>🕒 ${t('nav_fares')}</h3><p class="muted">${lang === 'sw' ? 'Ratiba na nauli za kila njia.' : 'Timetables and prices for every line.'}</p><a href="/fares" data-link>→</a></div>
   <div class="tile"><h3>📍 ${t('nav_stations')}</h3><p class="muted">${lang === 'sw' ? 'Vituo 13 kutoka Nairobi hadi Mombasa na Suswa.' : '13 stops from Nairobi to the coast and out to Suswa.'}</p><a href="/stations" data-link>→</a></div>
   <div class="tile"><h3>🔁 ${t('nav_manage')}</h3><p class="muted">${lang === 'sw' ? 'Ghairi au badilisha tarehe kwa msimbo wa simu.' : 'Cancel or move your trip with a code sent to your phone.'}</p><a href="/booking/manage" data-link>→</a></div>
   <div class="tile"><h3>🧳 ${lang === 'sw' ? 'Kabla ya kusafiri' : 'Before you travel'}</h3><p class="muted">${lang === 'sw' ? 'Fika saa moja mapema ukiwa na kitambulisho.' : 'Arrive an hour early with your ID. Up to 30 kg luggage.'}</p><a href="/faq" data-link>→</a></div></section>`;
  const f = $('#searchForm');
  const fill = () => {
    const svc = f.service.value; const fromSel = f.from.value || s.from;
    const ids = (sv) => STATIONS.filter((x) => !sv || x.services.includes(sv)).map((x) => x.id);
    f.from.innerHTML = stationOptions(fromSel, ids(f.klass.value === 'premium' ? 'express' : svc));
    const reach = REACH[f.from.value] || [];
    f.to.innerHTML = stationOptions(f.to.value || s.to, reach.filter((id) => ids(f.klass.value === 'premium' ? 'express' : svc).includes(id)));
  };
  fill(); f.service.onchange = fill; f.from.onchange = () => { f.to.value = ''; fill(); };
  $('#swap').onclick = () => { const a = f.from.value, b = f.to.value; s.from = b; s.to = a; f.from.value = ''; f.to.value = ''; f.from.innerHTML = stationOptions(b); f.from.value = b; fill(); f.to.value = a; };
  $$('[name=trip]', f).forEach((r) => (r.onchange = () => ($('#retWrap').hidden = f.trip.value !== 'round')));
  $$('.tabs button').forEach((b) => (b.onclick = () => { $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b)); f.klass.value = b.dataset.tab === 'premium' ? 'premium' : ''; f.service.disabled = !!f.klass.value; if (f.klass.value) f.service.value = 'express'; fill(); }));
  if (f.klass.value) f.service.disabled = true;
  f.onsubmit = (e) => {
    e.preventDefault(); $$('.err', f).forEach((x) => x.remove());
    const v = { trip: f.trip.value, service: f.service.value, from: f.from.value, to: f.to.value, date: f.date.value, return_date: f.return_date.value, klass: f.klass.value };
    for (const p of ['adult', 'teenager', 'child', 'infant']) v[p] = Math.max(0, Math.min(9, parseInt(f[p].value, 10) || 0));
    const errs = {};
    if (!v.from) errs.from = ['Choose where you start.']; if (!v.to) errs.to = ['Choose your destination.'];
    if (!v.date) errs.date = ['Pick a date.']; else if (v.date < todayStr() || v.date > addDays(todayStr(), 60)) errs.date = ['Dates must be within the next 60 days.'];
    if (v.trip === 'round') { if (!v.return_date) errs.return_date = ['Pick a return date.']; else if (v.return_date < v.date) errs.return_date = ['Return cannot be before departure.']; else if (v.return_date > addDays(todayStr(), 60)) errs.return_date = ['Dates must be within the next 60 days.']; }
    const n = v.adult + v.teenager + v.child + v.infant;
    if (v.adult < 1) errs.adult = ['At least one adult must travel.']; else if (n > 9) errs.adult = ['Up to 9 passengers per booking.']; else if (v.infant > v.adult) errs.infant = ['One infant per adult.'];
    if (Object.keys(errs).length) return showErrors(f, { errors: errs });
    S.set('search', v); S.set('sel', {}); go('/booking');
  };
}
let REACH = {};

// ---------------- Results ----------------
async function results() {
  const s = S.get('search'); if (!s) return go('/');
  app.innerHTML = `<div class="card row" style="justify-content:space-between;flex-wrap:wrap"><div><b>${esc(stName(s.from))} → ${esc(stName(s.to))}</b> · ${s.date}${s.trip === 'round' ? ' ⇄ ' + s.return_date : ''} · ${s.adult + s.teenager + s.child + s.infant} pax</div><a href="/" data-link class="btn ghost">${t('modify')}</a></div><div id="res">Loading…</div>`;
  try {
    const body = { from: s.from, to: s.to, date: s.date, class: s.klass || undefined, return_date: s.trip === 'round' ? s.return_date : undefined };
    let out, ret = null;
    if (s.trip === 'round') { const r = await api('/rest/trips/search-return', { body }); out = r.outbound; ret = r.return; } else out = await api('/rest/trips/search', { body });
    if (s.service) { out = out.filter((x) => x.service === s.service); if (ret) ret = ret.filter((x) => x.service === s.service); }
    const sel = S.get('sel', {});
    const legHtml = (list, leg) => `<h2>${t(leg)} · ${esc(stName(leg === 'outbound' ? s.from : s.to))} → ${esc(stName(leg === 'outbound' ? s.to : s.from))}</h2>` + (list.length ? list.map((tr) => `
      <div class="card trip" data-leg="${leg}"><div><h3>Train ${esc(tr.train_no)} <span class="badge">${t(tr.service)}</span></h3><p style="font-size:22px;margin:8px 0"><b>${tr.departure}</b> → <b>${tr.arrival}</b>${tr.arrives_next_day ? ' <small>+1</small>' : ''}</p>
      <p class="muted">${esc(tr.route_name)} · ${tr.distance_km} km</p>${tr.bookable ? '' : '<p class="err">Booking closed for this departure</p>'}</div>
      <div class="klass">${tr.classes.map((c) => { const on = sel[leg] && sel[leg].trip_id === tr.trip_id && sel[leg].class === c.class; const dis = !tr.bookable || c.seats_available < s.adult + s.teenager + s.child;
        return `<button class="kbox ${on ? 'on' : ''}" ${dis ? 'disabled' : ''} data-trip='${esc(JSON.stringify({ trip_id: tr.trip_id, train_no: tr.train_no, class: c.class, fares: c.fares, departure: tr.departure, arrival: tr.arrival, date: tr.date, from: tr.from, to: tr.to, service: tr.service }))}'>
        <small>${t(c.class)}</small><b>${ksh(c.fares.adult)}</b><small class="muted">${t('per_adult')} · child ${ksh(c.fares.child)}</small><br><small>${c.seats_available} ${t('seats_left')}</small></button>`; }).join('')}</div></div>`).join('') : `<div class="card">${t('no_trains')}</div>`);
    const total = () => { let n = 0; for (const l of ['outbound', 'return']) if (sel[l]) for (const p of ['adult', 'teenager', 'child', 'infant']) n += s[p] * sel[l].fares[p]; return n; };
    $('#res').innerHTML = legHtml(out, 'outbound') + (ret ? legHtml(ret, 'return') : '') + `<div class="card row" style="justify-content:space-between;position:sticky;bottom:40px"><div>${t('total')}: <b id="tot">${ksh(total())}</b></div><button class="btn alt" id="next">${t('continue')}</button></div>`;
    $$('.kbox').forEach((b) => (b.onclick = () => { const leg = b.closest('[data-leg]').dataset.leg; sel[leg] = JSON.parse(b.dataset.trip); S.set('sel', sel);
      $$(`[data-leg="${leg}"] .kbox`).forEach((x) => x.classList.toggle('on', x === b)); $('#tot').textContent = ksh(total()); }));
    $('#next').onclick = () => { if (!sel.outbound || (s.trip === 'round' && !sel.return)) return toast(lang === 'sw' ? 'Chagua treni na daraja kwanza.' : 'Choose a train and class for each leg first.'); go('/booking/passengers'); };
  } catch (e) { $('#res').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// ---------------- Passengers (seats are auto-assigned by the server) ----------------
async function passengersPage() {
  const s = S.get('search'), sel = S.get('sel', {}); if (!s || !sel.outbound) return go('/');
  const legs = ['outbound', ...(s.trip === 'round' ? ['return'] : [])];

  const ptypes = [...Array(s.adult).fill('adult'), ...Array(s.teenager).fill('teenager'), ...Array(s.child).fill('child'), ...Array(s.infant).fill('infant')];
  const saved = S.get('pax', []);
  app.innerHTML = `<div class="split"><div>
   <h2>${t('passengers')}</h2><p class="muted" id="autoNote">${t('auto_seats')}</p><form id="paxForm" novalidate>${ptypes.map((p, i) => `<div class="card"><b>#${i + 1} · ${p}</b><div class="grid" style="margin-top:8px">
     <div><label for="n${i}">${t('full_name')}</label><input id="n${i}" name="legs.0.passengers.${i}.full_name" value="${esc(saved[i]?.full_name || '')}" autocomplete="name"></div>
     ${['adult', 'teenager'].includes(p) ? `<div><label for="i${i}">${t('id_no')}</label><input id="i${i}" name="legs.0.passengers.${i}.id_no" value="${esc(saved[i]?.id_no || '')}"></div>` : ''}
     <div><label for="g${i}">${t('gender')}</label><select id="g${i}" name="legs.0.passengers.${i}.gender"><option value="">–</option><option ${saved[i]?.gender === 'M' ? 'selected' : ''} value="M">M</option><option ${saved[i]?.gender === 'F' ? 'selected' : ''} value="F">F</option></select></div>
     <div><label for="c${i}">${t('nationality')}</label><select id="c${i}" name="legs.0.passengers.${i}.nationality">${['Kenya', 'Uganda', 'Tanzania', 'Rwanda', 'Burundi', 'South Sudan', 'Other'].map((c) => `<option ${saved[i]?.nationality === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div></div>`).join('')}
     <div class="card"><label for="phone">${t('pay_phone')}</label><input id="phone" name="phone" inputmode="tel" placeholder="07XX XXX XXX" value="${esc(S.get('phone', ''))}"></div></form></div>
   <aside class="card sum"><h3>${t('summary')}</h3>${legs.map((l) => `<p><b>${t(l)}</b>: Train ${esc(sel[l].train_no)} · ${t(sel[l].class)}<br>${esc(stName(sel[l].from))} → ${esc(stName(sel[l].to))}<br>${sel[l].date} · ${sel[l].departure}<br>${t('seats_auto_short')}</p>`).join('')}
   <p>${t('total')}: <b>${ksh(legs.reduce((a, l) => a + ptypes.reduce((b, p) => b + sel[l].fares[p], 0), 0))}</b></p><button class="btn alt wide" id="toPay">${t('continue')} → ${t('pay')}</button>
   <p><a href="/booking" data-link>← ${t('back')}</a></p></aside></div>`;
  $('#toPay').onclick = async () => {
    const f = $('#paxForm'); $$('.err', f).forEach((x) => x.remove());
    const pax = ptypes.map((p, i) => ({ ptype: p, full_name: f[`legs.0.passengers.${i}.full_name`].value, id_no: f[`legs.0.passengers.${i}.id_no`]?.value, gender: f[`legs.0.passengers.${i}.gender`].value, nationality: f[`legs.0.passengers.${i}.nationality`].value }));
    S.set('pax', pax); S.set('phone', f.phone.value);
    const body = { phone: f.phone.value, legs: legs.map((l) => ({ trip_id: sel[l].trip_id, date: sel[l].date, from: sel[l].from, to: sel[l].to, class: sel[l].class, passengers: pax })) };
    const btn = $('#toPay'); btn.disabled = true;
    try { const r = await api('/rest/booking-management/create', { body }); S.set('order', r); go('/booking/pay'); }
    catch (e) { const errs = {}; for (const [k, v] of Object.entries(e.errors)) errs[k.replace(/^legs\.1\./, 'legs.0.')] = v; showErrors(f, { ...e, errors: errs }); if (e.status === 409) { $('#autoNote').innerHTML = `<span class="err">${esc(e.message)}</span> <a href="/booking" data-link>${t('back')}</a>`; toast(e.message); } }
    finally { btn.disabled = false; }
  };
}

// ---------------- Pay ----------------
function payPage() {
  const o = S.get('order'); if (!o) return go('/');
  app.innerHTML = `<div class="split"><div class="card"><h2>${t('pay')}</h2><p class="otp">🧪 ${lang === 'sw' ? 'Malipo ya majaribio tu – hakuna pesa halisi.' : 'Mock payments only – no real money moves and no card numbers or PINs are ever requested.'}</p>
   <div class="paym">${[['mpesa', 'M-Pesa'], ['card', 'Card'], ['equity', 'Equity Bank'], ['kcb', 'KCB Buni']].map(([k, n], i) => `<button class="kbox ${i ? '' : 'on'}" data-m="${k}"><b style="font-size:16px">${n}</b><small class="muted">mock</small></button>`).join('')}</div>
   <form id="payForm" style="margin-top:14px" novalidate><div id="payFields"></div><button class="btn alt wide" style="margin-top:12px">${t('pay_now')} ${ksh(o.amount)}</button></form>
   <p class="muted">${lang === 'sw' ? 'Muda wa kulipa: dakika 30.' : 'Seats are held for 30 minutes while you pay.'} Tip: a phone ending in 000 simulates a failed payment.</p></div>
   <aside class="card"><h3>${t('ref')}: ${esc(o.group_ref)}</h3>${o.bookings.map((b) => `<p><b>${t(b.leg)}</b> ${esc(b.from.name)} → ${esc(b.to.name)}<br>${b.travel_date} · Train ${esc(b.train_no)} · ${t(b.class)}<br>${t('seats_assigned')}: ${b.passengers.map((p) => p.seat || 'lap').join(', ')}</p>`).join('')}<p>${t('total')}: <b>${ksh(o.amount)}</b></p></aside></div>`;
  let method = 'mpesa';
  const fields = () => { $('#payFields').innerHTML = method === 'mpesa' || method === 'kcb' ? `<label for="payphone">${t('phone')}</label><input id="payphone" name="phone" value="${esc(S.get('phone', ''))}" inputmode="tel">` : `<p class="muted">${method === 'card' ? 'You will see a simulated hosted card page. This demo has no card-number fields at all.' : 'You will be shown a simulated Equity checkout.'}</p>`; };
  fields(); $$('[data-m]').forEach((b) => (b.onclick = () => { method = b.dataset.m; $$('[data-m]').forEach((x) => x.classList.toggle('on', x === b)); fields(); }));
  $('#payForm').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; $$('.err', f).forEach((x) => x.remove());
    const path = { mpesa: '/rest/booking-info/payment/stk-push', kcb: '/rest/booking-info/payment/buni/stk-push', card: '/rest/booking-info/payment/card/session', equity: '/rest/booking-info/payment/equity/session' }[method];
    const st = { mpesa: 'status', kcb: 'buni/status', card: 'card/status', equity: 'equity/status' }[method];
    try {
      const r = await api(path, { body: { group_ref: o.group_ref, phone: f.phone?.value } });
      modal(`<h3>${method === 'mpesa' || method === 'kcb' ? '📱 Check your phone (simulated)' : '💳 Simulated checkout'}</h3><p>${esc(r.prompt)}</p><p class="muted" id="pst">Waiting for confirmation…</p>`);
      for (let i = 0; i < 30; i++) { await new Promise((z) => setTimeout(z, 1000)); const p = await api(`/rest/booking-info/payment/${st}?checkout_id=${r.checkout_id}`);
        if (p.status === 'success') { closeModal(); S.set('done', { group_ref: o.group_ref, phone: S.get('phone') }); S.set('order', null); return go('/booking/done'); }
        if (p.status === 'failed') { $('#pst').innerHTML = '<span class="err">Payment failed (simulated). Close and try again.</span> <button class="btn ghost" onclick="closeModal()">Close</button>'; return; } }
    } catch (err) { showErrors(f, err); }
  };
}
async function donePage() {
  const d = S.get('done'); if (!d) return go('/');
  const list = await api(`/rest/booking-info/booking/${d.group_ref}?phone=${encodeURIComponent(d.phone)}`);
  const ph = encodeURIComponent(d.phone);
  app.innerHTML = `<div class="card"><h2 class="okc">✅ ${t('done')}</h2><p>${lang === 'sw' ? 'Onyesha msimbo huu kituoni pamoja na kitambulisho.' : 'Show this code at the station with your ID. A copy was “sent” to your phone (demo).'}</p>
   ${list.map((b) => `<div class="ticket"><img src="/tickets/${b.ref}/qr.png?phone=${ph}" alt="QR code for ${b.ref}"><div><b>${t('ref')}: ${esc(b.ref)}</b> <span class="badge ${b.status}">${b.status}</span><br>${esc(b.from.name)} → ${esc(b.to.name)}<br>${b.travel_date} · ${b.departure}–${b.arrival} · Train ${esc(b.train_no)} · ${t(b.class)}<br>${b.passengers.map((p) => `${esc(p.full_name)} (${p.seat || 'lap'})`).join(', ')}<br>${ksh(b.total)}</div></div>`).join('')}
   <a class="btn" href="/tickets/${d.group_ref}.pdf?phone=${ph}" target="_blank">${t('download_pdf')}</a> <a class="btn ghost" href="/" data-link>${t('nav_book')}</a></div>`;
}

// ---------------- Manage booking ----------------
function managePage() {
  app.innerHTML = `<div class="card" style="max-width:520px"><h2>${t('nav_manage')}</h2><form id="mf" novalidate><label for="mref">${t('ref')}</label><input id="mref" name="ref" placeholder="MRXXXXXX"><br><br><label for="mph">${t('phone')}</label><input id="mph" name="phone" inputmode="tel"><br><br><button class="btn">${t('send_code')}</button></form><div id="mout"></div></div>`;
  $('#mf').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; $$('.err', f).forEach((x) => x.remove());
    try { const r = await api('/rest/booking-management/auth/request-otp', { body: { ref: f.ref.value, phone: f.phone.value } });
      $('#mout').innerHTML = `<form id="of" novalidate><p class="otp">Demo SMS code: <b>${r.demo_code}</b></p><label for="otp">Code</label><input id="otp" name="otp" inputmode="numeric" maxlength="6"><br><br><button class="btn">${t('verify')}</button></form>`;
      $('#of').onsubmit = async (ev) => { ev.preventDefault(); try { const v = await api('/rest/booking-management/auth/verify-otp', { body: { ref: f.ref.value, phone: f.phone.value, otp: ev.target.otp.value } }); S.set('mtok', v.token); S.set('mphone', f.phone.value); manageDetail(); } catch (err) { showErrors(ev.target, err); } };
    } catch (err) { showErrors(f, err); }
  };
}
async function manageDetail() {
  const tok = S.get('mtok'); let b;
  try { b = await api('/rest/booking-management/details', { token: tok }); } catch { return managePage(); }
  const p = b.policy; const ph = encodeURIComponent(S.get('mphone'));
  app.innerHTML = `<div class="card"><h2>${t('ref')}: ${esc(b.ref)} <span class="badge ${b.status}">${b.status}</span></h2><p>${esc(b.from.name)} → ${esc(b.to.name)} · ${b.travel_date} · ${b.departure} · Train ${esc(b.train_no)} · ${t(b.class)} · ${ksh(b.total)}</p>
   <table><tr><th>Name</th><th>Type</th><th>Seat</th><th>Status</th><th></th></tr>${b.passengers.map((x) => `<tr><td>${esc(x.full_name)}</td><td>${x.type}</td><td>${x.seat || 'lap'}</td><td>${x.status}</td><td>${x.status === 'active' && p.can_cancel ? `<button class="btn ghost" data-rm="${x.id}">Remove</button>` : ''}</td></tr>`).join('')}</table>
   <p class="muted">${p.hours_to_departure} h to departure. Cancel fee ${p.cancel_fee_pct}% · date-change fee ${p.reschedule_fee_pct}% (once, ≥48 h ahead).</p>
   <div class="row" style="flex-wrap:wrap"><button class="btn danger" id="cx" ${p.can_cancel ? '' : 'disabled'}>${t('cancel_booking')}</button>
   <input type="date" id="nd" style="max-width:180px" min="${todayStr()}" max="${addDays(todayStr(), 60)}"><button class="btn" id="rs" ${p.can_reschedule ? '' : 'disabled'}>${t('reschedule')}</button>
   ${b.status === 'confirmed' ? `<a class="btn ghost" target="_blank" href="/tickets/${b.ref}.pdf?phone=${ph}">${t('download_pdf')}</a>` : ''}</div><div id="mmsg"></div></div>`;
  $('#cx').onclick = async () => { if (!confirm('Cancel this booking? A 30% fee applies.')) return; try { const r = await api('/rest/booking-management/cancel', { token: tok, body: {} }); toast(`Cancelled. Refund of ${ksh(r.refund.amount)} requested.`); manageDetail(); } catch (e) { $('#mmsg').innerHTML = `<p class="err">${esc(e.message)}</p>`; } };
  $('#rs').onclick = async () => { const nd = $('#nd').value; try { const qt = await api('/rest/booking-management/change-date/quote', { token: tok, body: { new_date: nd } });
    if (!confirm(`Move to ${nd}? Fee ${ksh(qt.fee)} (mock payment).`)) return; await api('/rest/booking-management/change-date/request', { token: tok, body: { new_date: nd } }); toast('Date changed.'); manageDetail(); } catch (e) { $('#mmsg').innerHTML = `<p class="err">${esc(e.message)}</p>`; } };
  $$('[data-rm]').forEach((x) => (x.onclick = async () => { try { await api('/rest/booking-management/passengers/cancel', { token: tok, body: { passenger_id: x.dataset.rm } }); manageDetail(); } catch (e) { $('#mmsg').innerHTML = `<p class="err">${esc(e.message)}</p>`; } }));
}

// ---------------- Login / account ----------------
function loginPage() {
  app.innerHTML = `<div class="card" style="max-width:440px;margin:30px auto"><h2>${t('signin')}</h2><form id="lf" novalidate><label for="lph">${t('phone')}</label><input id="lph" name="phone" inputmode="tel" placeholder="07XX XXX XXX"><br><br><button class="btn wide">${t('send_code')}</button></form><div id="lo"></div></div>`;
  $('#lf').onsubmit = async (e) => { e.preventDefault(); const f = e.target; $$('.err', f).forEach((x) => x.remove());
    try { const r = await api('/rest/auth/otp/request', { body: { phone: f.phone.value } });
      $('#lo').innerHTML = `<form id="lv" novalidate><p class="otp">Demo SMS code: <b>${r.demo_code}</b></p><label for="lotp">Code</label><input id="lotp" name="otp" inputmode="numeric" maxlength="6"><br><br><button class="btn alt wide">${t('verify')}</button></form>`;
      $('#lv').onsubmit = async (ev) => { ev.preventDefault(); try { const v = await api('/rest/auth/otp/verify', { body: { phone: f.phone.value, otp: ev.target.otp.value } });
        localStorage.setItem('access_token', v.access_token); localStorage.setItem('refresh_token', v.refresh_token); S.set('phone', f.phone.value); acct(); go('/account'); } catch (err) { showErrors(ev.target, err); } };
    } catch (err) { showErrors(f, err); } };
}
async function authed(path) {
  try { return await api(path, { auth: true }); } catch (e) {
    if (e.status !== 401) throw e; const rt = localStorage.getItem('refresh_token'); if (!rt) throw e;
    const r = await api('/rest/auth/refresh', { body: { refresh_token: rt } }); localStorage.setItem('access_token', r.access_token); return api(path, { auth: true });
  }
}
async function accountPage() {
  let prof, bks, tx; try { [prof, bks, tx] = await Promise.all([authed('/rest/profile'), authed('/rest/bookings'), authed('/rest/transactions')]); } catch { localStorage.removeItem('access_token'); acct(); return go('/login'); }
  app.innerHTML = `<div class="card"><h2>${t('account')}</h2><form id="pf" class="grid" novalidate><div><label>${t('phone')}</label><input value="${esc(prof.phone)}" disabled></div><div><label for="pn">Name</label><input id="pn" name="name" value="${esc(prof.name || '')}"></div><div><label for="pe">Email</label><input id="pe" name="email" value="${esc(prof.email || '')}"></div><div><button class="btn">Save</button> <button type="button" class="btn ghost" id="lgo">Sign out</button></div></form></div>
   <div class="card"><h3>My bookings</h3><table><tr><th>Ref</th><th>Trip</th><th>Date</th><th>Class</th><th>Total</th><th>Status</th><th></th></tr>${bks.map((b) => `<tr><td>${esc(b.ref)}</td><td>${esc(b.from.name)} → ${esc(b.to.name)}</td><td>${b.travel_date} ${b.departure}</td><td>${t(b.class)}</td><td>${ksh(b.total)}</td><td><span class="badge ${b.status}">${b.status}</span></td><td>${b.status === 'confirmed' ? `<a target="_blank" href="/tickets/${b.ref}.pdf?phone=${b.phone}">PDF</a>` : ''}</td></tr>`).join('') || '<tr><td colspan=7 class="muted">No bookings yet</td></tr>'}</table></div>
   <div class="card"><h3>Transactions</h3><table><tr><th>ID</th><th>Method</th><th>Amount</th><th>Status</th><th>When</th></tr>${tx.map((x) => `<tr><td>${esc(x.checkout_id)}</td><td>${x.method}</td><td>${ksh(x.amount)}</td><td>${x.status}</td><td>${new Date(x.created_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })} EAT</td></tr>`).join('') || '<tr><td colspan=5 class="muted">None</td></tr>'}</table></div>`;
  $('#pf').onsubmit = async (e) => { e.preventDefault(); try { await api('/rest/profile', { method: 'PUT', auth: true, body: { name: e.target.name.value, email: e.target.email.value } }); toast('Saved'); } catch (err) { showErrors(e.target, err); } };
  $('#lgo').onclick = async () => { try { await api('/rest/logout', { auth: true, body: {} }); } catch {} localStorage.removeItem('access_token'); localStorage.removeItem('refresh_token'); acct(); go('/'); };
}
function acct() { const a = $('#acctBtn'); const on = !!localStorage.getItem('access_token'); a.setAttribute('href', on ? '/account' : '/login'); a.dataset.i18n = on ? 'account' : 'signin'; a.textContent = t(a.dataset.i18n); }

// ---------------- Info pages ----------------
async function stationsPage() {
  app.innerHTML = `<h1>${t('nav_stations')}</h1><div class="tiles">${STATIONS.map((s) => `<div class="tile"><h3>${esc(s.name)}</h3><p class="muted">${esc(s.city)} County · ${s.code}</p><p>${s.services.map((x) => `<span class="badge">${t(x)}</span>`).join(' ')}</p><p><small>${s.facilities.map(esc).join(' · ')}</small></p></div>`).join('')}</div>`;
}
async function faresPage() {
  const fc = await api('/rest/booking-info/fare-charts'); const tt = await api('/rest/booking-info/next-trips?from=2&to=3').catch(() => []);
  app.innerHTML = `<h1>${t('nav_fares')}</h1><div class="card"><table><tr><th>Route</th><th>Stops</th><th>Distance / time</th><th>Fares (adult · child)</th></tr>${fc.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${r.stoppages.map(stName).map(esc).join(' → ')}</td><td>${r.distance} · ${r.time}</td><td>${r.fares.map((f) => `${t(f.class)}: ${ksh(f.adult)} · ${ksh(f.child)}${f.return_adult ? ` (return ${ksh(f.return_adult)})` : ''}`).join('<br>')}</td></tr>`).join('')}</table>
  <p class="muted">Under-3s travel free. Partial journeys are priced by distance. Sample data for a demo.</p></div>
  <div class="card"><h3>Timetable</h3><table><tr><th>Train</th><th>Service</th><th>Departs</th><th>Arrives</th><th>Days</th></tr>
  ${[['IC1 / IC2', 'intercounty', '08:00', '14:45', 'Daily'], ['E1 / E2', 'express', '15:00', '20:30', 'Daily'], ['E3 / E4', 'express', '22:00', '03:30 (+1)', 'Daily'], ['S1', 'suswa', '08:50 Nairobi', '11:10 Suswa', 'Fri–Sun'], ['S2', 'suswa', '16:05 Suswa', '18:25 Nairobi', 'Fri–Sun']].map((r) => `<tr><td>${r[0]}</td><td>${t(r[1])}</td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td></tr>`).join('')}</table></div>`;
}
async function faqPage() { const f = await api('/rest/booking-info/faqs'); app.innerHTML = `<h1>FAQ</h1>${f.map((x) => `<details class="card"><summary><b>${esc(lang === 'sw' ? x.q_sw : x.q)}</b></summary><p>${esc(lang === 'sw' ? x.a_sw : x.a)}</p></details>`).join('')}`; }
function aboutPage() {
  app.innerHTML = `<h1>${t('nav_about')}</h1><div class="split"><div class="card"><p>${lang === 'sw' ? 'Madaraka Railways ni mradi wa maonyesho unaoonyesha jinsi kukata tiketi za treni kunavyoweza kuwa rahisi: tafuta, chagua kiti, lipa kwa simu, na upate tiketi ya QR.' : 'Madaraka Railways is a showcase concept that shows how simple rail ticketing can be: search, pick a seat, pay from your phone and get a QR ticket in under two minutes.'}</p>
  <p>${lang === 'sw' ? 'Huduma tatu: Express, Kati ya kaunti na treni ya burudani ya Suswa.' : 'It models three services – the fast Express, the all-stops Inter-County train and the weekend leisure run to Suswa – in Economy, First Class and Premium.'}</p><p class="muted">This is a demo with sample data. It is not affiliated with, endorsed by or connected to Kenya Railways Corporation.</p></div><img src="/img/coach.svg" alt="Illustration of a coach interior" style="width:100%;border-radius:16px"></div>`;
}
function contactPage() {
  app.innerHTML = `<h1>Contact</h1><form class="card" id="cf" style="max-width:640px" novalidate><div class="grid"><div><label for="cn">Name</label><input id="cn" name="name"></div><div><label for="ce">Email</label><input id="ce" name="email"></div><div><label for="cm">Mobile</label><input id="cm" name="mobile"></div><div><label for="cc">Category</label><select id="cc" name="category">${['Cancellation', 'Refund', 'Enquiry', 'Suggestion', 'Complaint', 'Other'].map((c) => `<option>${c}</option>`).join('')}</select></div></div><br><label for="cb">Message</label><textarea id="cb" name="message" rows="5"></textarea><br><br><button class="btn">Send</button></form>`;
  $('#cf').onsubmit = async (e) => { e.preventDefault(); const f = e.target; $$('.err', f).forEach((x) => x.remove()); try { await api('/rest/contact', { body: Object.fromEntries(new FormData(f)) }); f.reset(); toast('Thanks – message received (demo).'); } catch (err) { showErrors(f, err); } };
}

const ROUTES = { '/': home, '/booking': results, '/booking/oneway': results, '/booking/passengers': passengersPage, '/booking/seats': passengersPage, '/booking/pay': payPage, '/booking/done': donePage, '/booking/manage': managePage,
  '/stations': stationsPage, '/fares': faresPage, '/faq': faqPage, '/about': aboutPage, '/contact': contactPage, '/login': loginPage, '/otp': loginPage, '/account': accountPage, '/account/bookings': accountPage, '/account/profile': accountPage, '/account/transactions': accountPage, '/admin': () => window.adminPage(app) };
async function route() {
  const p = location.pathname.replace(/\/$/, '') || '/';
  $$('nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === p));
  const fn = ROUTES[p]; if (!fn) { app.innerHTML = '<div class="card"><h2>Page not found</h2><a href="/" data-link>Home</a></div>'; return; }
  try { await fn(); } catch (e) { app.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
(async () => {
  applyTheme(); applyI18n(); acct();
  STATIONS = await api('/rest/booking-info/stations');
  const fc = await api('/rest/booking-info/fare-charts');
  for (const r of fc) r.stoppages.forEach((a, i) => { REACH[a] = REACH[a] || []; r.stoppages.slice(i + 1).forEach((b) => { if (!REACH[a].includes(b)) REACH[a].push(b); }); });
  route();
})();
