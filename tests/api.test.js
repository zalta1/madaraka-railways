// API tests – run only against a local in-memory instance of this clone.
process.env.MOCK_PAY_DELAY_MS = '0';
const test = require('node:test'); const assert = require('node:assert');
const db = require('../src/db'); const { build, today, addDays } = require('../src/app');
let base, server;
const call = async (method, path, body, token) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || ''; return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text(), headers: r.headers };
};
const D5 = addDays(today(), 5), D6 = addDays(today(), 6);
const adult = (n, id, seat) => ({ ptype: 'adult', full_name: n, id_no: id, gender: 'F', nationality: 'Kenya', seat });
async function book(opts = {}) {
  const tk = (await call('POST', '/api/rest/seat-locks/token', {})).body.data.token;
  const legs = opts.legs || [{ trip_id: 1, date: D5, from: 2, to: 3, class: 'economy', passengers: [adult('Wanjiru Kamau', 'A' + Math.floor(Math.random() * 1e8))] }];
  const r = await call('POST', '/api/rest/booking-management/create', { token: tk, phone: opts.phone || '0712345678', legs });
  return r;
}
async function pay(group, phone = '0712345678') {
  const s = await call('POST', '/api/rest/booking-info/payment/stk-push', { group_ref: group, phone });
  return call('GET', '/api/rest/booking-info/payment/status?checkout_id=' + s.body.data.checkout_id);
}
test.before(async () => { await db.open('memory'); server = build().listen(0); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => server.close());

test('config and stations', async () => {
  const c = await call('GET', '/console/api/rest/booking-info/config'); assert.equal(c.body.data.max_booking_days, 60);
  const s = await call('GET', '/console/api/rest/booking-info/stations'); assert.equal(s.body.data.length, 13);
  assert.ok(s.headers.get('x-demo-notice').includes('not affiliated'));
});
test('search returns trains and fares; validation errors are Laravel-shaped', async () => {
  const r = await call('POST', '/api/rest/trips/search', { from: 2, to: 3, date: D5 });
  const e2 = r.body.data.find((t) => t.train_no === 'E2'); assert.equal(e2.departure, '15:00');
  assert.equal(e2.classes.find((c) => c.class === 'economy').fares.adult, 1500); assert.equal(e2.classes.find((c) => c.class === 'first').fares.child, 2250);
  assert.ok(e2.classes.find((c) => c.class === 'premium'));
  const bad = await call('POST', '/api/rest/trips/search', { date: D5 }); assert.equal(bad.status, 422); assert.ok(bad.body.errors.from && bad.body.errors.to);
  const far = await call('POST', '/api/rest/trips/search', { from: 2, to: 3, date: addDays(today(), 61) }); assert.equal(far.status, 422);
  const back = await call('POST', '/api/rest/trips/search', { from: 3, to: 2, date: D5 }); assert.ok(back.body.data.every((t) => t.train_no !== 'E2'));
});
test('partial journey priced by distance; intercounty serves Voi→Mombasa', async () => {
  const r = await call('POST', '/api/rest/trips/search', { from: 4, to: 3, date: D5, class: 'economy' });
  const ic = r.body.data.find((t) => t.train_no === 'IC1'); assert.equal(ic.classes[0].fares.adult, 470);
});
test('premium round trip totals KSh 20,000 per adult', async () => {
  const r = await call('POST', '/api/rest/trips/search-return', { from: 2, to: 3, date: D5, return_date: D6, class: 'premium' });
  const a = r.body.data.outbound[0].classes[0].fares.adult, b = r.body.data.return[0].classes[0].fares.adult; assert.equal(a + b, 20000);
});
test('seat locking prevents double booking', async () => {
  const t1 = (await call('POST', '/api/rest/seat-locks/token', {})).body.data.token, t2 = (await call('POST', '/api/rest/seat-locks/token', {})).body.data.token;
  const s = { trip_id: 1, date: D5, seat: 'E1-1A', class: 'economy' };
  assert.equal((await call('POST', '/api/rest/seat-locks/lock', { ...s, token: t1 })).status, 200);
  assert.equal((await call('POST', '/api/rest/seat-locks/lock', { ...s, token: t2 })).status, 409);
  const st = await call('GET', `/api/rest/seat-locks/status?trip_id=1&date=${D5}&class=economy&token=${t2}`); assert.equal(st.body.data.seats.find((x) => x.seat === 'E1-1A').state, 'locked');
  const b = await call('POST', '/api/rest/booking-management/create', { token: t2, phone: '0712345678', legs: [{ trip_id: 1, date: D5, from: 2, to: 3, class: 'economy', passengers: [adult('Other Person', 'ZZ9988776', 'E1-1A')] }] });
  assert.equal(b.status, 409);
  const ok = await call('POST', '/api/rest/booking-management/create', { token: t1, phone: '0712345678', legs: [{ trip_id: 1, date: D5, from: 2, to: 3, class: 'economy', passengers: [adult('Lock Owner', 'LK1234567', 'E1-1A')] }] });
  assert.equal(ok.status, 200); assert.equal(ok.body.data.bookings[0].passengers[0].seat, 'E1-1A');
  assert.equal((await call('POST', '/api/rest/seat-locks/lock', { ...s, token: t2 })).status, 409, 'pending booking still holds seat');
});
test('booking rules: adult required, unique ID per train, phone format, infant gets no seat', async () => {
  const leg = (p) => [{ trip_id: 1, date: D5, from: 2, to: 3, class: 'economy', passengers: p }];
  assert.equal((await book({ legs: leg([{ ptype: 'child', full_name: 'Kid One', gender: 'M' }]) })).status, 422);
  assert.equal((await book({ legs: leg([adult('Same Id', 'DUP12345'), adult('Same Id2', 'dup12345')]) })).status, 422);
  assert.equal((await book({ phone: '12345', legs: leg([adult('Bad Phone', 'PH1234567')]) })).status, 422);
  const r = await book({ legs: leg([adult('Mum Achieng', 'MUM123456'), { ptype: 'infant', full_name: 'Baby Achieng', gender: 'F' }, { ptype: 'child', full_name: 'Kid Achieng', gender: 'M' }]) });
  assert.equal(r.status, 200); const p = r.body.data.bookings[0].passengers; assert.equal(p[1].seat, null); assert.equal(r.body.data.amount, 1500 + 0 + 750);
  await pay(r.body.data.group_ref);
  assert.equal((await book({ legs: leg([adult('Mum Again', 'MUM123456')]) })).status, 422, 'same ID on same train rejected');
});
test('mock payment confirms booking; card data is refused; 000 phone fails', async () => {
  const r = await book(); const g = r.body.data.group_ref;
  const card = await call('POST', '/api/rest/booking-info/payment/card/session', { group_ref: g, card_number: '4111111111111111' }); assert.equal(card.status, 400);
  const p = await pay(g); assert.equal(p.body.data.status, 'success');
  assert.equal((await call('POST', '/api/rest/booking-info/payment/stk-push', { group_ref: g, phone: '0712345678' })).status, 409, 'cannot pay twice');
  const r2 = await book(); const f = await pay(r2.body.data.group_ref, '0712345000'); assert.equal(f.body.data.status, 'failed');
  const v = await call('GET', `/api/rest/booking-info/booking/${g}?phone=0712345678`); assert.equal(v.body.data[0].status, 'confirmed');
  assert.equal((await call('GET', `/api/rest/booking-info/booking/${g}?phone=0799999999`)).status, 403);
});
test('equity, kcb and card mock flows work', async () => {
  for (const [path, st] of [['card/session', 'card/status'], ['equity/session', 'equity/status'], ['buni/stk-push', 'buni/status']]) {
    const g = (await book()).body.data.group_ref; const s = await call('POST', '/api/rest/booking-info/payment/' + path, { group_ref: g, phone: '0712345678' });
    assert.equal(s.status, 200, path); const p = await call('GET', `/api/rest/booking-info/payment/${st}?checkout_id=${s.body.data.checkout_id}`); assert.equal(p.body.data.status, 'success');
  }
});
test('round trip creates two linked bookings', async () => {
  const r = await book({ legs: [{ trip_id: 1, date: D5, from: 2, to: 3, class: 'first', passengers: [adult('Round Tripper', 'RT1234567')] }, { trip_id: 3, date: D6, from: 3, to: 2, class: 'first', passengers: [adult('Round Tripper', 'RT1234567')] }] });
  assert.equal(r.status, 200); assert.equal(r.body.data.bookings.length, 2); assert.equal(r.body.data.bookings[1].leg, 'return');
  await pay(r.body.data.group_ref); const v = await call('GET', `/api/rest/booking-info/booking/${r.body.data.group_ref}?phone=0712345678`); assert.ok(v.body.data.every((b) => b.status === 'confirmed'));
});
test('manage booking: OTP, reschedule once with fee, cancel with 30% refund', async () => {
  const r = await book(); const g = r.body.data.group_ref; await pay(g);
  assert.equal((await call('POST', '/api/rest/booking-management/auth/request-otp', { ref: g, phone: '0700000001' })).status, 404);
  const o = await call('POST', '/api/rest/booking-management/auth/request-otp', { ref: g, phone: '0712345678' });
  assert.equal((await call('POST', '/api/rest/booking-management/auth/verify-otp', { ref: g, phone: '0712345678', otp: '000000' })).status, 422);
  const v = await call('POST', '/api/rest/booking-management/auth/verify-otp', { ref: g, phone: '0712345678', otp: o.body.data.demo_code }); const tk = v.body.data.token;
  const qt = await call('POST', '/api/rest/booking-management/change-date/quote', { new_date: D6 }, tk); assert.equal(qt.body.data.fee, 150);
  const ch = await call('POST', '/api/rest/booking-management/change-date/request', { new_date: D6 }, tk); assert.equal(ch.body.data.travel_date, D6);
  assert.equal((await call('POST', '/api/rest/booking-management/change-date/request', { new_date: D5 }, tk)).status, 409, 'only once');
  const cx = await call('POST', '/api/rest/booking-management/cancel', {}, tk); assert.equal(cx.body.data.refund.amount, 1050); assert.equal(cx.body.data.refund.fee, 450);
  assert.equal((await call('POST', '/api/rest/booking-management/cancel', {}, tk)).status, 409);
});
test('cancel blocked within 48 hours', async () => {
  const d = addDays(today(), 1); const r = await book({ legs: [{ trip_id: 1, date: d, from: 2, to: 3, class: 'economy', passengers: [adult('Late Canceller', 'LC1234567')] }] });
  await pay(r.body.data.group_ref); const o = await call('POST', '/api/rest/booking-management/auth/request-otp', { ref: r.body.data.group_ref, phone: '0712345678' });
  const tk = (await call('POST', '/api/rest/booking-management/auth/verify-otp', { ref: r.body.data.group_ref, phone: '0712345678', otp: o.body.data.demo_code })).body.data.token;
  assert.equal((await call('POST', '/api/rest/booking-management/cancel', {}, tk)).status, 409);
});
test('phone OTP login, profile, bookings, refresh', async () => {
  const o = await call('POST', '/api/rest/auth/otp/request', { phone: '+254712345678' });
  const v = await call('POST', '/api/rest/auth/otp/verify', { phone: '0712345678', otp: o.body.data.demo_code }); const at = v.body.data.access_token;
  assert.equal((await call('POST', '/api/rest/auth/otp/verify', { phone: '0712345678', otp: o.body.data.demo_code })).status, 422, 'OTP is single-use');
  assert.ok((await call('GET', '/api/rest/bookings', null, at)).body.data.length > 3);
  assert.equal((await call('GET', '/api/rest/profile')).status, 401);
  const rf = await call('POST', '/api/rest/auth/refresh', { refresh_token: v.body.data.refresh_token }); assert.ok(rf.body.data.access_token);
});
test('tickets: QR PNG and PDF, phone-protected', async () => {
  const g = (await book()).body.data.group_ref; assert.equal((await call('GET', `/tickets/${g}.pdf?phone=0712345678`)).status, 409, 'unpaid'); await pay(g);
  const pdf = await fetch(`${base}/tickets/${g}.pdf?phone=0712345678`); assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.ok((await pdf.arrayBuffer()).byteLength > 1000);
  assert.equal((await fetch(`${base}/tickets/${g}/qr.png?phone=0712345678`)).headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/tickets/${g}.pdf?phone=0711111111`)).status, 403);
});
test('admin: auth, edit fare, trips, refunds workflow, reports', async () => {
  assert.equal((await call('GET', '/api/admin/reports')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { username: 'admin', password: 'x' })).status, 401);
  const tk = (await call('POST', '/api/admin/login', { username: 'admin', password: 'madaraka-demo' })).body.data.token;
  const rep = await call('GET', '/api/admin/reports', null, tk); assert.ok(rep.body.data.totals.revenue > 0);
  const fares = (await call('GET', '/api/admin/fares', null, tk)).body.data; const se = fares.find((f) => f.service === 'suswa' && f.class === 'economy');
  assert.equal((await call('PUT', '/api/admin/fares/' + se.id, { adult: -5 }, tk)).status, 422);
  await call('PUT', '/api/admin/fares/' + se.id, { adult: 350 }, tk);
  assert.equal((await call('POST', '/api/admin/trips', { route_id: 1, train_no: 'X', dep_time: '25:00', arr_time: '10:00', days: '0', classes: 'economy' }, tk)).status, 422);
  const nt = await call('POST', '/api/admin/trips', { route_id: 5, train_no: 'S9', dep_time: '07:00', arr_time: '09:20', days: '0123456', classes: 'economy' }, tk); assert.equal(nt.status, 200);
  const s = await call('POST', '/api/rest/trips/search', { from: 2, to: 15, date: D5 }); const s9 = s.body.data.find((x) => x.train_no === 'S9'); assert.equal(s9.classes[0].fares.adult, 350);
  const rf = (await call('GET', '/api/admin/refunds', null, tk)).body.data[0];
  assert.equal((await call('POST', `/api/admin/refunds/${rf.id}/pay`, {}, tk)).status, 409, 'must approve before paying');
  assert.equal((await call('POST', `/api/admin/refunds/${rf.id}/approve`, {}, tk)).status, 200);
  assert.equal((await call('POST', `/api/admin/refunds/${rf.id}/pay`, {}, tk)).status, 200);
});
test('classic compatibility: fetch.php and validate.php', async () => {
  const t = await call('GET', '/fetch.php?type=terminals&schedule_type=express'); assert.match(t.body, /Nairobi Terminus/); assert.doesNotMatch(t.body, /Kibwezi/);
  const d = await call('GET', '/fetch.php?type=destinations&schedule_type=express&terminal_id=2'); assert.match(d.body, /Mombasa/); assert.doesNotMatch(d.body, /Nairobi/);
  const v = await call('POST', '/validate.php', { fullnames: ['Ab'], ids: ['1'], pay_mobile: '0712345678' }); assert.equal(v.body.info, 'invalid');
  const ok = await call('POST', '/validate.php', { fullnames: ['Ann Wairimu'], ids: ['12345678'], pay_mobile: '0712345678' }); assert.equal(ok.body.info, 'valid');
});
test('admin seat availability: only enabled seats are auto-assigned; graceful message when full', async () => {
  const tk = (await call('POST', '/api/admin/login', { username: 'admin', password: 'madaraka-demo' })).body.data.token;
  assert.equal((await call('GET', '/api/admin/seat-availability?trip_id=2&class=premium')).status, 401);
  const m = (await call('GET', `/api/admin/seat-availability?trip_id=2&class=premium&date=${D5}`, null, tk)).body.data;
  assert.equal(m.seats.length, 18); assert.equal(m.enabled_count, 18);
  assert.equal((await call('PUT', '/api/admin/seat-availability', { trip_id: 2, class: 'premium', seats: ['X9-9Z'], enabled: false }, tk)).status, 422);
  assert.equal((await call('PUT', '/api/admin/seat-availability', { trip_id: 5, class: 'premium', seats: ['P1-1A'], enabled: false }, tk)).status, 422, 'IC1 has no premium');
  const keep = ['P1-3B', 'P1-4C'];
  const r = await call('PUT', '/api/admin/seat-availability', { trip_id: 2, class: 'premium', seats: m.seats.map((s) => s.seat).filter((s) => !keep.includes(s)), enabled: false }, tk);
  assert.equal(r.body.data.enabled_count, 2);
  const s = await call('POST', '/api/rest/trips/search', { from: 2, to: 3, date: D5, class: 'premium' });
  assert.equal(s.body.data.find((x) => x.train_no === 'E4').classes[0].seats_available, 2);
  const leg = (n) => [{ trip_id: 2, date: D5, from: 2, to: 3, class: 'premium', passengers: Array.from({ length: n }, (_, i) => adult('Prem Guest ' + i, 'PG' + i + Math.floor(Math.random() * 1e7))) }];
  const big = await book({ legs: leg(3) }); assert.equal(big.status, 409); assert.match(big.body.message, /only 2 seat\(s\) are left/);
  const ok = await book({ legs: leg(2) }); assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data.bookings[0].passengers.map((p) => p.seat).sort(), keep);
  const full = await book({ legs: leg(1) }); assert.equal(full.status, 409); assert.match(full.body.message, /fully booked on train E4/);
  const tk2 = (await call('POST', '/api/rest/seat-locks/token', {})).body.data.token;
  assert.equal((await call('POST', '/api/rest/seat-locks/lock', { trip_id: 2, date: D6, seat: 'P1-1A', class: 'premium', token: tk2 })).status, 422, 'closed seat cannot be locked');
  await call('PUT', '/api/admin/seat-availability', { trip_id: 2, class: 'premium', seats: m.seats.map((x) => x.seat), enabled: true }, tk);
  assert.equal((await call('GET', `/api/admin/seat-availability?trip_id=2&class=premium`, null, tk)).body.data.enabled_count, 18);
});
test('booking without seats auto-assigns distinct seats', async () => {
  const r = await book({ legs: [{ trip_id: 1, date: D6, from: 2, to: 3, class: 'economy', passengers: [adult('Auto One', 'AU1234567'), adult('Auto Two', 'AU7654321'), { ptype: 'child', full_name: 'Auto Kid', gender: 'M' }] }] });
  const seats = r.body.data.bookings[0].passengers.map((p) => p.seat); assert.equal(new Set(seats).size, 3); assert.ok(seats.every(Boolean));
});
