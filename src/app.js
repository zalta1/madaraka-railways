const express = require('express');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { q, one } = require('./db');

const PHONE_RE = /^(?:254|\+254|0)(7|1)[0-9]{8}$/;
const CONFIG = { max_booking_days: 60, booking_cutoff_minutes: 10, payment_window_seconds: 1800, cancellation_cutoff_hours: 48,
  date_change_notice_hours: 48, max_passengers_per_booking: 9, cancel_fee_pct: 30, reschedule_fee_pct: 10, seat_lock_seconds: 600 };
const PTYPES = [ { id: 1, type: 'adult', name: 'Adult', note: '18+ years', min_age: 18, factor: 1 },
  { id: 5, type: 'teenager', name: 'Teen', note: '12–17 years', min_age: 12, max_age: 17, factor: 1 },
  { id: 2, type: 'child', name: 'Child', note: '3–11 years', min_age: 3, max_age: 11, factor: 0.5 },
  { id: 3, type: 'infant', name: 'Infant', note: '0–2 years (on lap, no seat)', min_age: 0, max_age: 2, factor: 0 } ];
const factor = (t) => (PTYPES.find((p) => p.type === t) || {}).factor;

const ok = (res, data, message = 'OK') => res.json({ status: 'success', message, data });
class VErr extends Error { constructor(errors, status = 422) { super(Object.values(errors).flat()[0]); this.errors = errors; this.status = status; } }
const fail = (field, msg, status = 422) => { throw new VErr({ [field]: [msg] }, status); };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const token = () => crypto.randomBytes(18).toString('hex');
const ref = () => 'MR' + Array.from(crypto.randomBytes(6)).map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const normPhone = (p) => { p = String(p || '').replace(/\s/g, ''); if (!PHONE_RE.test(p)) return null; return '254' + p.slice(-9); };

// Dates in Africa/Nairobi (UTC+3, no DST)
const EAT = 3 * 3600e3;
const today = () => new Date(Date.now() + EAT).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const depInstant = (date, hhmm) => new Date(`${date}T${hhmm}:00+03:00`);
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const fmtDate = (d) => (d instanceof Date ? new Date(d.getTime() + EAT).toISOString().slice(0, 10) : String(d).slice(0, 10));

async function tripInfo(trip, fromId, toId) {
  const route = trip.route || (await one('SELECT * FROM routes WHERE id=$1', [trip.route_id]));
  const stops = route.stops; const fi = stops.findIndex((s) => s.id === fromId); const ti = stops.findIndex((s) => s.id === toId);
  if (fi < 0 || ti < 0 || fi >= ti) return null;
  const total = stops[stops.length - 1].km; const dur = (toMin(trip.arr_time) - toMin(trip.dep_time) + 1440) % 1440;
  const offFrom = Math.round((dur * stops[fi].km) / total), offTo = Math.round((dur * stops[ti].km) / total);
  return { route, km: stops[ti].km - stops[fi].km, total, dep: fromMin(toMin(trip.dep_time) + offFrom), arr: fromMin(toMin(trip.dep_time) + offTo),
    depDayOffset: Math.floor((toMin(trip.dep_time) + offFrom) / 1440), arrDayOffset: Math.floor((toMin(trip.dep_time) + offTo) / 1440) };
}
async function farePrice(service, cls, km, total, ptype, roundTrip) {
  const f = await one('SELECT * FROM fares WHERE service=$1 AND class=$2', [service, cls]);
  if (!f) return null;
  let base = Number(f.adult);
  if (roundTrip && f.return_adult) base = Number(f.return_adult) / 2;
  if (km < total) base = Math.max(100, Math.round((base * km) / total / 10) * 10);
  return Math.round(base * factor(ptype));
}
async function layoutSeats(cls) {
  const l = await one('SELECT * FROM seat_layouts WHERE class=$1', [cls]); if (!l) return [];
  const out = []; const p = cls[0].toUpperCase();
  for (let c = 1; c <= l.coaches; c++) for (let r = 1; r <= l.rows; r++) for (const L of l.letters.slice(0, l.cols)) out.push(`${p}${c}-${r}${L}`);
  return out;
}
async function enabledSeats(tripId, cls) {
  const off = new Set((await q('SELECT seat FROM seat_disabled WHERE trip_id=$1 AND class=$2', [tripId, cls])).map((r) => r.seat));
  return (await layoutSeats(cls)).filter((s) => !off.has(s));
}
async function takenSeats(tripId, date, exceptToken) {
  await q('DELETE FROM seat_locks WHERE expires_at < now()');
  await q("UPDATE bookings SET status='expired' WHERE status='pending' AND expires_at < now()");
  const booked = await q(`SELECT p.seat FROM passengers p JOIN bookings b ON b.id=p.booking_id WHERE b.trip_id=$1 AND b.travel_date=$2
     AND b.status IN ('pending','confirmed') AND p.status='active' AND p.seat IS NOT NULL`, [tripId, date]);
  const locked = await q('SELECT seat, token FROM seat_locks WHERE trip_id=$1 AND travel_date=$2', [tripId, date]);
  return { booked: new Set(booked.map((r) => r.seat)), locked: new Set(locked.filter((l) => l.token !== exceptToken).map((l) => l.seat)),
    mine: new Set(locked.filter((l) => exceptToken && l.token === exceptToken).map((l) => l.seat)) };
}
const runsOn = (trip, date) => trip.days.includes(String(new Date(date + 'T12:00:00Z').getUTCDay()));
function checkDate(date, field = 'date') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail(field, 'Please choose a valid travel date (YYYY-MM-DD).');
  if (date < today()) fail(field, 'The travel date cannot be in the past.');
  if (date > addDays(today(), CONFIG.max_booking_days)) fail(field, `Bookings open only ${CONFIG.max_booking_days} days ahead.`);
}

async function searchTrips({ from, to, date, cls, roundTrip }) {
  const errors = {};
  if (!from) errors.from = ['The from field is required.'];
  if (!to) errors.to = ['The to field is required.'];
  if (from && to && Number(from) === Number(to)) errors.to = ['Origin and destination must differ.'];
  if (Object.keys(errors).length) throw new VErr(errors);
  checkDate(date);
  from = Number(from); to = Number(to);
  const trips = await q('SELECT t.*, row_to_json(r) AS route FROM trips t JOIN routes r ON r.id=t.route_id WHERE t.active AND r.active ORDER BY t.dep_time');
  const out = [];
  for (const t of trips) {
    if (!runsOn(t, date)) continue;
    const info = await tripInfo(t, from, to); if (!info) continue;
    const depAt = depInstant(addDays(date, info.depDayOffset), info.dep);
    const bookable = depAt.getTime() - Date.now() > CONFIG.booking_cutoff_minutes * 60e3;
    const taken = await takenSeats(t.id, date);
    const classes = [];
    for (const c of t.classes.split(',')) {
      if (cls && cls !== c) continue;
      const seats = await enabledSeats(t.id, c);
      const fares = {}; for (const p of PTYPES) fares[p.type] = await farePrice(t.route.service, c, info.km, info.total, p.type, roundTrip);
      classes.push({ class: c, fares, seats_total: (await layoutSeats(c)).length, seats_enabled: seats.length, seats_available: seats.filter((s) => !taken.booked.has(s) && !taken.locked.has(s)).length });
    }
    if (!classes.length) continue;
    out.push({ trip_id: t.id, train_no: t.train_no, service: t.route.service, route_name: t.route.name, from, to, date, departure: info.dep, arrival: info.arr,
      arrives_next_day: info.arrDayOffset > info.depDayOffset, distance_km: info.km, bookable, classes });
  }
  return out;
}

async function auth(req, kind) {
  const h = req.get('authorization') || ''; const t = h.replace(/^Bearer\s+/i, '');
  if (!t) return null;
  const s = await one('SELECT * FROM sessions WHERE token=$1 AND expires_at > now()', [t]);
  if (!s || (kind && s.kind !== kind)) return null; return s;
}
const need = (kind) => wrap(async (req, res, next) => { const s = await auth(req, kind); if (!s) return res.status(401).json({ message: 'Unauthenticated.' }); req.session = s; next(); });

async function bookingView(b) {
  const trip = await one('SELECT * FROM trips WHERE id=$1', [b.trip_id]);
  const info = await tripInfo(trip, b.from_id, b.to_id);
  const pax = await q('SELECT * FROM passengers WHERE booking_id=$1 ORDER BY id', [b.id]);
  const st = await q('SELECT id,name FROM stations WHERE id = ANY($1)', [[b.from_id, b.to_id]]);
  const name = (id) => (st.find((s) => s.id === id) || {}).name;
  const date = fmtDate(b.travel_date);
  return { id: b.id, ref: b.ref, group_ref: b.group_ref, leg: b.leg, phone: b.phone, status: b.status, class: b.class, total: Number(b.total), pay_method: b.pay_method,
    reschedules: b.reschedules, travel_date: date, train_no: trip.train_no, trip_id: trip.id, service: info.route.service, route_name: info.route.name,
    from: { id: b.from_id, name: name(b.from_id) }, to: { id: b.to_id, name: name(b.to_id) }, departure: info.dep, arrival: info.arr,
    departs_at: depInstant(addDays(date, info.depDayOffset), info.dep).toISOString(), expires_at: b.expires_at, created_at: b.created_at,
    passengers: pax.map((p) => ({ id: p.id, full_name: p.full_name, id_no: p.id_no, gender: p.gender, nationality: p.nationality, type: p.ptype, seat: p.seat, fare: Number(p.fare), status: p.status })) };
}
const hoursToDep = (v) => (Date.parse(v.departs_at) - Date.now()) / 3600e3;

async function confirmGroup(groupRef, method) {
  await q("UPDATE bookings SET status='confirmed', pay_method=$2, paid_at=now() WHERE group_ref=$1 AND status='pending'", [groupRef, method]);
}

function build() {
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { res.set('X-Demo-Notice', 'Demo project - not affiliated with Kenya Railways'); next(); });
  const api = express.Router();
  const R = '/console/api';

  // ---------- booking info ----------
  api.get('/rest/booking-info/config', (req, res) => ok(res, { ...CONFIG, min_booking_date: today(), max_booking_date: addDays(today(), CONFIG.max_booking_days) }, 'Booking configuration retrieved successfully'));
  api.get('/rest/booking-info/maintenance', (req, res) => ok(res, { maintenance: false }));
  api.get('/rest/booking-info/stations', wrap(async (req, res) => {
    const st = await q('SELECT * FROM stations ORDER BY id');
    const routes = await q('SELECT * FROM routes WHERE active');
    ok(res, st.map((s) => ({ id: s.id, name: s.name, display_name: s.name, code: s.code, city: s.county, latitude: String(s.lat), longitude: String(s.lng),
      facilities: s.facilities ? s.facilities.split(',') : [], services: [...new Set(routes.filter((r) => r.stops.some((x) => x.id === s.id)).map((r) => r.service))] })));
  }));
  api.get('/rest/booking-info/station-facilities', wrap(async (req, res) => ok(res, (await q('SELECT id,name,facilities FROM stations ORDER BY id')).map((s) => ({ ...s, facilities: s.facilities.split(',') })))));
  api.get('/rest/booking-info/passenger-types', (req, res) => ok(res, PTYPES));
  api.get('/rest/booking-info/pwd-types', (req, res) => ok(res, [{ id: 1, name: 'Wheelchair user' }, { id: 2, name: 'Visual impairment' }, { id: 3, name: 'Hearing impairment' }]));
  api.get('/rest/booking-info/nationalities', (req, res) => ok(res, ['Kenya', 'Uganda', 'Tanzania', 'Rwanda', 'Burundi', 'South Sudan', 'DR Congo', 'Somalia', 'Ethiopia', 'Other']));
  api.get('/rest/booking-info/payment-methods', (req, res) => ok(res, [
    { alias: 'mpesa', name: 'M-Pesa (mock)', currencies: ['KES'], convenience_fee: 0 }, { alias: 'card', name: 'Card (mock checkout)', presentation: 'mock', convenience_fee: 0 },
    { alias: 'equity', name: 'Equity Bank (mock)', convenience_fee: 0 }, { alias: 'kcb', name: 'KCB Buni (mock)', convenience_fee: 0 } ]));
  api.get('/rest/booking-info/fare-charts', wrap(async (req, res) => {
    const routes = await q('SELECT * FROM routes WHERE active ORDER BY id'); const fares = await q('SELECT * FROM fares');
    ok(res, routes.map((r) => ({ route_id: r.id, code: r.code, name: r.name, service: r.service, distance: r.distance_km + ' km', time: r.duration, stoppages: r.stops.map((s) => s.id),
      fares: fares.filter((f) => f.service === r.service).map((f) => ({ class: f.class, adult: Number(f.adult), child: Number(f.adult) * 0.5, infant: 0, return_adult: f.return_adult && Number(f.return_adult) })) })));
  }));
  api.get('/rest/booking-info/ticket-prices', wrap(async (req, res) => {
    const r = await one('SELECT * FROM routes WHERE id=$1', [Number(req.query.vehicle_route_id) || 0]); if (!r) fail('vehicle_route_id', 'Unknown route.', 404);
    const fares = await q('SELECT * FROM fares WHERE service=$1', [r.service]);
    ok(res, fares.map((f) => ({ id: f.id, class: f.class, vehicle_route_id: r.id, price: Number(f.adult).toFixed(2), band_factors: { 2: 0.5, 3: 0, 5: 1 }, route: { id: r.id, code: r.code, name: r.name, stoppages: r.stops.map((s) => String(s.id)), distance: r.distance_km + ' km', time: r.duration } })));
  }));
  api.get('/rest/booking-info/fare-calculator', wrap(async (req, res) => {
    const trips = await searchTrips({ from: req.query.from, to: req.query.to, date: req.query.date || addDays(today(), 1), cls: req.query.class });
    ok(res, trips.map((t) => ({ train_no: t.train_no, classes: t.classes.map((c) => ({ class: c.class, fares: c.fares })) })));
  }));
  api.post('/rest/booking-info/payment-preview', wrap(async (req, res) => {
    const b = await q('SELECT total FROM bookings WHERE group_ref=$1', [req.body.group_ref]); if (!b.length) fail('group_ref', 'Booking not found.', 404);
    const amount = b.reduce((s, x) => s + Number(x.total), 0); ok(res, { amount, convenience_fee: 0, total: amount, currency: 'KES' });
  }));
  api.get('/rest/booking-info/next-trips', wrap(async (req, res) => ok(res, (await searchTrips({ from: req.query.from, to: req.query.to, date: today() })).filter((t) => t.bookable))));
  api.get('/rest/booking-info/search-trips', wrap(async (req, res) => ok(res, await searchTrips({ ...req.query, cls: req.query.class }))));
  api.get('/rest/booking-info/faqs', (req, res) => ok(res, require('./content').faqs));
  api.get('/rest/booking-info/news', (req, res) => ok(res, require('./content').news));
  api.get('/rest/booking-info/gallery', (req, res) => ok(res, require('./content').gallery));
  api.get('/get-countries', (req, res) => ok(res, ['Kenya', 'Uganda', 'Tanzania', 'Rwanda', 'Burundi', 'South Sudan', 'Other']));

  // ---------- trips ----------
  api.post('/rest/trips/search', wrap(async (req, res) => ok(res, await searchTrips({ ...req.body, cls: req.body.class, roundTrip: !!req.body.return_date }))));
  api.post('/rest/trips/search-return', wrap(async (req, res) => {
    const b = req.body; if (!b.return_date) fail('return_date', 'The return date is required.'); if (b.return_date < b.date) fail('return_date', 'Return must be on or after the departure date.');
    ok(res, { outbound: await searchTrips({ from: b.from, to: b.to, date: b.date, cls: b.class, roundTrip: true }), return: await searchTrips({ from: b.to, to: b.from, date: b.return_date, cls: b.class, roundTrip: true }) });
  }));

  // ---------- seat locks ----------
  api.post('/rest/seat-locks/token', (req, res) => ok(res, { token: token(), ttl_seconds: CONFIG.seat_lock_seconds }));
  api.post('/rest/seat-locks/auth', (req, res) => ok(res, { token: token(), ttl_seconds: CONFIG.seat_lock_seconds }));
  api.get('/rest/seat-locks/status', wrap(async (req, res) => {
    const { trip_id, date, class: cls, token: tk } = req.query; const seats = await layoutSeats(cls || 'economy');
    const t = await takenSeats(Number(trip_id), date, tk); const l = await one('SELECT * FROM seat_layouts WHERE class=$1', [cls || 'economy']);
    ok(res, { layout: l, seats: seats.map((s) => ({ seat: s, state: t.booked.has(s) ? 'booked' : t.locked.has(s) ? 'locked' : t.mine.has(s) ? 'mine' : 'free' })) });
  }));
  api.post('/rest/seat-locks/lock', wrap(async (req, res) => {
    const { trip_id, date, seat, class: cls, token: tk } = req.body; if (!tk) fail('token', 'Seat-lock token is required.');
    if (!(await enabledSeats(Number(trip_id), cls)).includes(seat)) fail('seat', 'That seat is not open for booking.');
    const t = await takenSeats(Number(trip_id), date, tk); if (t.booked.has(seat) || t.locked.has(seat)) fail('seat', 'Sorry, that seat was just taken.', 409);
    const exp = new Date(Date.now() + CONFIG.seat_lock_seconds * 1000);
    await q('INSERT INTO seat_locks VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (trip_id,travel_date,seat) DO UPDATE SET expires_at=$6 WHERE seat_locks.token=$5', [Number(trip_id), date, seat, cls, tk, exp]);
    const mine = await one('SELECT token FROM seat_locks WHERE trip_id=$1 AND travel_date=$2 AND seat=$3', [Number(trip_id), date, seat]);
    if (!mine || mine.token !== tk) fail('seat', 'Sorry, that seat was just taken.', 409);
    ok(res, { seat, expires_at: exp }, 'Seat locked');
  }));
  api.post('/rest/seat-locks/release', wrap(async (req, res) => { await q('DELETE FROM seat_locks WHERE token=$1 AND trip_id=$2 AND travel_date=$3 AND seat=$4', [req.body.token, Number(req.body.trip_id), req.body.date, req.body.seat]); ok(res, null, 'Released'); }));
  api.post('/rest/seat-locks/release-all', wrap(async (req, res) => { await q('DELETE FROM seat_locks WHERE token=$1', [req.body.token]); ok(res, null, 'Released'); }));

  // ---------- booking create ----------
  api.post('/rest/booking-management/create', wrap(async (req, res) => {
    const { legs, token: tk } = req.body; const phone = normPhone(req.body.phone);
    if (!phone) fail('phone', 'Enter a valid Safaricom/Airtel number, e.g. 0712345678.');
    if (!Array.isArray(legs) || !legs.length || legs.length > 2) fail('legs', 'Choose an outbound (and optional return) trip.');
    const roundTrip = legs.length === 2; const group = ref(); const created = [];
    const plan = [];
    for (const [li, leg] of legs.entries()) {
      const trip = await one('SELECT t.*, row_to_json(r) AS route FROM trips t JOIN routes r ON r.id=t.route_id WHERE t.id=$1 AND t.active', [Number(leg.trip_id)]);
      if (!trip) fail(`legs.${li}.trip_id`, 'That train is not available.');
      checkDate(leg.date, `legs.${li}.date`);
      if (!runsOn(trip, leg.date)) fail(`legs.${li}.date`, 'This train does not run on the chosen day.');
      if (!trip.classes.split(',').includes(leg.class)) fail(`legs.${li}.class`, 'This class is not offered on that train.');
      const info = await tripInfo(trip, Number(leg.from), Number(leg.to)); if (!info) fail(`legs.${li}.to`, 'This train does not serve that journey.');
      if (depInstant(addDays(leg.date, info.depDayOffset), info.dep) - Date.now() < CONFIG.booking_cutoff_minutes * 60e3) fail(`legs.${li}.trip_id`, 'Booking for this departure has closed.');
      const pax = leg.passengers || [];
      if (!pax.length || pax.length > CONFIG.max_passengers_per_booking) fail(`legs.${li}.passengers`, `A booking can hold 1 to ${CONFIG.max_passengers_per_booking} passengers.`);
      if (!pax.some((p) => p.ptype === 'adult')) fail(`legs.${li}.passengers`, 'At least one adult must travel.');
      const infants = pax.filter((p) => p.ptype === 'infant').length; if (infants > pax.filter((p) => p.ptype === 'adult').length) fail(`legs.${li}.passengers`, 'Each infant must travel with an adult.');
      const t = await takenSeats(trip.id, leg.date, tk); const free = (await enabledSeats(trip.id, leg.class)).filter((s) => !t.booked.has(s) && !t.locked.has(s));
      const seated = pax.filter((p) => p.ptype !== 'infant').length;
      if (free.length + [...t.mine].length < seated) fail(`legs.${li}.class`, free.length + t.mine.size === 0
        ? `Sorry, ${leg.class === 'first' ? 'First Class' : leg.class[0].toUpperCase() + leg.class.slice(1)} is fully booked on train ${trip.train_no} for ${leg.date}. Please try another class or date.`
        : `Sorry, only ${free.length + t.mine.size} seat(s) are left in ${leg.class} on train ${trip.train_no} for ${leg.date}, but you need ${seated}. Please try fewer passengers, another class or another date.`, 409);
      const ids = new Set(); const used = new Set();
      for (const [pi, p] of pax.entries()) {
        const f = `legs.${li}.passengers.${pi}`;
        if (!factor(p.ptype) && p.ptype !== 'infant') fail(`${f}.ptype`, 'Unknown passenger type.');
        if (!p.full_name || String(p.full_name).trim().length < 3) fail(`${f}.full_name`, 'Enter the passenger\'s full name.');
        if (!['M', 'F'].includes(p.gender)) fail(`${f}.gender`, 'Select gender.');
        if (['adult', 'teenager'].includes(p.ptype)) {
          const idn = String(p.id_no || '').toUpperCase();
          if (!/^[A-Z0-9]{7,14}$/.test(idn)) fail(`${f}.id_no`, 'ID/passport must be 7–14 letters or digits.');
          if (ids.has(idn)) fail(`${f}.id_no`, 'Each adult ID can appear only once per booking.'); ids.add(idn);
          const dup = await one(`SELECT 1 FROM passengers p JOIN bookings b ON b.id=p.booking_id WHERE b.trip_id=$1 AND b.travel_date=$2 AND b.status IN ('pending','confirmed') AND p.status='active' AND upper(p.id_no)=$3`, [trip.id, leg.date, idn]);
          if (dup) fail(`${f}.id_no`, 'This ID already holds a ticket on this train.');
          p.id_no = idn;
        }
        if (p.ptype === 'infant') { p.seat = null; continue; }
        if (p.seat) {
          if (used.has(p.seat)) fail(`${f}.seat`, 'Two passengers cannot share a seat.');
          if (!free.includes(p.seat) && !(t.mine.has(p.seat) && (await enabledSeats(trip.id, leg.class)).includes(p.seat))) fail(`${f}.seat`, `Seat ${p.seat} is no longer available.`, 409);
        } else {
          p.seat = free.find((s) => !used.has(s) && !t.mine.has(s)); if (!p.seat) fail(`${f}.seat`, 'Not enough seats left in this class.', 409);
        }
        used.add(p.seat);
      }
      const prices = []; for (const p of pax) prices.push(await farePrice(trip.route.service, leg.class, info.km, info.total, p.ptype, roundTrip));
      plan.push({ trip, leg, pax, prices });
    }
    for (const [li, { trip, leg, pax, prices }] of plan.entries()) {
      const r = li === 0 ? group : ref(); const total = prices.reduce((a, b) => a + b, 0);
      const b = await one(`INSERT INTO bookings(ref,group_ref,leg,phone,trip_id,travel_date,from_id,to_id,class,total,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + interval '${CONFIG.payment_window_seconds} seconds') RETURNING *`,
        [r, group, li ? 'return' : 'outbound', phone, trip.id, leg.date, Number(leg.from), Number(leg.to), leg.class, total]);
      for (const [pi, p] of pax.entries()) await q('INSERT INTO passengers(booking_id,full_name,id_no,gender,nationality,ptype,seat,fare) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [b.id, String(p.full_name).trim(), p.id_no || null, p.gender, p.nationality || 'Kenya', p.ptype, p.seat, prices[pi]]);
      created.push(await bookingView(b));
    }
    if (tk) await q('DELETE FROM seat_locks WHERE token=$1', [tk]);
    await q('INSERT INTO users(phone) VALUES($1) ON CONFLICT DO NOTHING', [phone]);
    ok(res, { group_ref: group, amount: created.reduce((s, b) => s + b.total, 0), bookings: created, payment_window_seconds: CONFIG.payment_window_seconds }, 'Booking created, awaiting payment');
  }));

  // ---------- mock payments ----------
  const startPay = (method) => wrap(async (req, res) => {
    const g = req.body.group_ref; const bk = await q("SELECT * FROM bookings WHERE group_ref=$1", [g]);
    if (!bk.length) fail('group_ref', 'Booking not found.', 404);
    if (bk.some((b) => b.status !== 'pending')) fail('group_ref', bk[0].status === 'confirmed' ? 'This booking is already paid.' : 'This booking has expired. Please search again.', 409);
    if (bk.some((b) => new Date(b.expires_at) < new Date())) fail('group_ref', 'The payment window has closed.', 409);
    let phone = null;
    if (method === 'mpesa' || method === 'kcb') { phone = normPhone(req.body.phone); if (!phone) fail('phone', 'Enter a valid phone number for the payment prompt.'); }
    // Mock only: no card number / PIN fields are accepted or stored.
    for (const k of ['card_number', 'pan', 'cvv', 'cvc', 'pin', 'expiry']) if (k in req.body) fail(k, 'This demo never accepts card numbers or PINs.', 400);
    const cid = (method === 'mpesa' ? 'ws_CO_' : method.toUpperCase() + '_') + token().slice(0, 16);
    const amount = bk.reduce((s, b) => s + Number(b.total), 0);
    await q('INSERT INTO payments(checkout_id,group_ref,method,phone,amount) VALUES($1,$2,$3,$4,$5)', [cid, g, method, phone, amount]);
    ok(res, { checkout_id: cid, amount, method, mock: true, prompt: method === 'mpesa' || method === 'kcb' ? `A simulated payment prompt for KSh ${amount} was "sent" to ${phone}. Nothing is actually charged.` : 'Simulated hosted checkout – no card details are collected.' }, 'Payment initiated (demo)');
  });
  const payStatus = wrap(async (req, res) => {
    const p = await one('SELECT * FROM payments WHERE checkout_id=$1', [req.query.checkout_id || req.body.checkout_id]); if (!p) fail('checkout_id', 'Unknown payment.', 404);
    if (p.status === 'pending' && Date.now() - new Date(p.created_at).getTime() > Number(process.env.MOCK_PAY_DELAY_MS ?? 2500)) {
      const failNow = p.phone && p.phone.endsWith('000');
      const still = await q("SELECT 1 FROM bookings WHERE group_ref=$1 AND status='pending' AND expires_at > now()", [p.group_ref]);
      const st = failNow || !still.length ? 'failed' : 'success';
      await q('UPDATE payments SET status=$2 WHERE id=$1', [p.id, st]); p.status = st;
      if (st === 'success') await confirmGroup(p.group_ref, p.method);
    }
    ok(res, { checkout_id: p.checkout_id, status: p.status, group_ref: p.group_ref, method: p.method, amount: Number(p.amount) });
  });
  api.post('/rest/booking-info/payment/stk-push', startPay('mpesa')); api.get('/rest/booking-info/payment/status', payStatus);
  api.post('/rest/booking-info/payment/buni/stk-push', startPay('kcb')); api.get('/rest/booking-info/payment/buni/status', payStatus);
  api.post('/rest/booking-info/payment/card/session', startPay('card')); api.get('/rest/booking-info/payment/card/status', payStatus);
  api.post('/rest/booking-info/payment/equity/session', startPay('equity')); api.get('/rest/booking-info/payment/equity/status', payStatus);
  api.get('/rest/booking-info/booking/:group', wrap(async (req, res) => {
    const bk = await q('SELECT * FROM bookings WHERE group_ref=$1 ORDER BY id', [req.params.group]); if (!bk.length) fail('ref', 'Not found', 404);
    if (normPhone(req.query.phone) !== bk[0].phone) fail('phone', 'Phone number does not match this booking.', 403);
    ok(res, await Promise.all(bk.map(bookingView)));
  }));
  api.post('/rest/booking-management/abandon', wrap(async (req, res) => { await q("UPDATE bookings SET status='abandoned' WHERE group_ref=$1 AND status='pending'", [req.body.group_ref]); ok(res, null, 'Abandoned'); }));

  // ---------- phone OTP auth ----------
  async function issueOtp(phone, purpose, r) {
    const code = String(crypto.randomInt(100000, 999999));
    await q("INSERT INTO otps(phone,purpose,ref,code,expires_at) VALUES($1,$2,$3,$4, now() + interval '5 minutes')", [phone, purpose, r || null, code]);
    return code;
  }
  async function useOtp(phone, purpose, code, r) {
    const o = await one('SELECT * FROM otps WHERE phone=$1 AND purpose=$2 AND coalesce(ref,\'\')=coalesce($4,\'\') AND code=$3 AND NOT used AND expires_at > now() ORDER BY id DESC LIMIT 1', [phone, purpose, String(code || ''), r || null]);
    if (!o) fail('otp', 'That code is wrong or has expired.');
    await q('UPDATE otps SET used=true WHERE id=$1', [o.id]);
  }
  api.post('/rest/auth/otp/request', wrap(async (req, res) => {
    const phone = normPhone(req.body.phone); if (!phone) fail('phone', 'Enter a valid phone number.');
    const code = await issueOtp(phone, 'login'); ok(res, { phone, demo_code: code, expires_in: 300 }, 'Demo: the code is shown on screen instead of being sent by SMS');
  }));
  api.post('/rest/auth/otp/verify', wrap(async (req, res) => {
    const phone = normPhone(req.body.phone); if (!phone) fail('phone', 'Enter a valid phone number.');
    await useOtp(phone, 'login', req.body.otp);
    await q('INSERT INTO users(phone) VALUES($1) ON CONFLICT DO NOTHING', [phone]);
    const t = token(), rt = token();
    await q("INSERT INTO sessions VALUES($1,$2,'user',null, now() + interval '1 hour')", [t, phone]);
    await q("INSERT INTO sessions VALUES($1,$2,'refresh',null, now() + interval '30 days')", [rt, phone]);
    ok(res, { access_token: t, refresh_token: rt, user: await one('SELECT * FROM users WHERE phone=$1', [phone]) });
  }));
  api.post('/rest/auth/refresh', wrap(async (req, res) => {
    const s = await one("SELECT * FROM sessions WHERE token=$1 AND kind='refresh' AND expires_at > now()", [req.body.refresh_token]); if (!s) fail('refresh_token', 'Session expired, please sign in again.', 401);
    const t = token(); await q("INSERT INTO sessions VALUES($1,$2,'user',null, now() + interval '1 hour')", [t, s.phone]); ok(res, { access_token: t });
  }));
  api.post('/rest/logout', need('user'), wrap(async (req, res) => { await q('DELETE FROM sessions WHERE phone=$1 AND kind IN (\'user\',\'refresh\')', [req.session.phone]); ok(res, null, 'Signed out'); }));
  api.get('/rest/profile', need('user'), wrap(async (req, res) => ok(res, await one('SELECT * FROM users WHERE phone=$1', [req.session.phone]))));
  api.put('/rest/profile', need('user'), wrap(async (req, res) => {
    if (req.body.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(req.body.email)) fail('email', 'Enter a valid email.');
    ok(res, await one('UPDATE users SET name=$2, email=$3 WHERE phone=$1 RETURNING *', [req.session.phone, req.body.name || null, req.body.email || null]), 'Profile saved');
  }));
  api.get('/rest/bookings', need('user'), wrap(async (req, res) => ok(res, await Promise.all((await q("SELECT * FROM bookings WHERE phone=$1 AND status NOT IN ('abandoned') ORDER BY id DESC", [req.session.phone])).map(bookingView)))));
  api.get('/rest/transactions', need('user'), wrap(async (req, res) => ok(res, await q('SELECT p.checkout_id,p.group_ref,p.method,p.amount::float,p.status,p.created_at FROM payments p WHERE p.group_ref IN (SELECT group_ref FROM bookings WHERE phone=$1) ORDER BY p.id DESC', [req.session.phone]))));
  api.get('/rest/booking-details/people', need('user'), wrap(async (req, res) => ok(res, await q('SELECT DISTINCT ON (upper(full_name)) full_name,id_no,gender,nationality,ptype FROM passengers p JOIN bookings b ON b.id=p.booking_id WHERE b.phone=$1', [req.session.phone]))));
  api.get('/rest/booking-details', need('user'), wrap(async (req, res) => ok(res, await q('SELECT DISTINCT ON (upper(full_name)) full_name,id_no,gender,nationality,ptype FROM passengers p JOIN bookings b ON b.id=p.booking_id WHERE b.phone=$1', [req.session.phone]))));

  // ---------- manage booking ----------
  const mgr = wrap(async (req, res, next) => {
    const s = await auth(req, 'manage'); if (!s) return res.status(401).json({ message: 'Please verify with the code sent to your phone first.' });
    const b = await one('SELECT * FROM bookings WHERE ref=$1', [s.ref]); req.booking = b; req.view = await bookingView(b); next();
  });
  api.post('/rest/booking-management/auth/request-otp', wrap(async (req, res) => {
    const r = String(req.body.ref || '').trim().toUpperCase(); const phone = normPhone(req.body.phone);
    const b = await one('SELECT * FROM bookings WHERE ref=$1', [r]);
    if (!b || !phone || b.phone !== phone) fail('ref', 'No booking matches that reference and phone number.', 404);
    ok(res, { demo_code: await issueOtp(phone, 'manage', r), expires_in: 300 }, 'Demo: the code is shown on screen instead of being sent by SMS');
  }));
  api.post('/rest/booking-management/auth/verify-otp', wrap(async (req, res) => {
    const r = String(req.body.ref || '').trim().toUpperCase(); const phone = normPhone(req.body.phone); if (!phone) fail('phone', 'Enter a valid phone number.');
    await useOtp(phone, 'manage', req.body.otp, r); const t = token();
    await q("INSERT INTO sessions VALUES($1,$2,'manage',$3, now() + interval '20 minutes')", [t, phone, r]); ok(res, { token: t });
  }));
  api.get('/rest/booking-management/details', mgr, (req, res) => ok(res, { ...req.view, policy: policyFor(req.view) }));
  function policyFor(v) {
    const h = hoursToDep(v); const active = v.status === 'confirmed';
    return { can_cancel: active && h >= CONFIG.cancellation_cutoff_hours, can_reschedule: active && h >= CONFIG.date_change_notice_hours && v.reschedules < 1,
      cancel_fee_pct: CONFIG.cancel_fee_pct, reschedule_fee_pct: CONFIG.reschedule_fee_pct, hours_to_departure: Math.round(h) };
  }
  api.post('/rest/booking-management/cancel', mgr, wrap(async (req, res) => {
    const v = req.view; const pol = policyFor(v);
    if (v.status !== 'confirmed') fail('ref', 'Only paid bookings can be cancelled.', 409);
    if (!pol.can_cancel) fail('ref', `Cancellations close ${CONFIG.cancellation_cutoff_hours} hours before departure.`, 409);
    const paid = v.passengers.filter((p) => p.status === 'active').reduce((s, p) => s + p.fare, 0);
    const fee = Math.round(paid * CONFIG.cancel_fee_pct / 100);
    await q("UPDATE bookings SET status='cancelled' WHERE id=$1", [v.id]); await q("UPDATE passengers SET status='cancelled' WHERE booking_id=$1", [v.id]);
    const rf = await one('INSERT INTO refunds(booking_id,amount,fee,reason) VALUES($1,$2,$3,$4) RETURNING *', [v.id, paid - fee, fee, req.body.reason || 'Customer cancellation']);
    ok(res, { refund: { ...rf, amount: Number(rf.amount), fee: Number(rf.fee) } }, 'Booking cancelled. A refund request was created.');
  }));
  api.post('/rest/booking-management/passengers/cancel', mgr, wrap(async (req, res) => {
    const v = req.view; if (!policyFor(v).can_cancel) fail('ref', 'This booking can no longer be changed online.', 409);
    const p = v.passengers.find((x) => x.id === Number(req.body.passenger_id) && x.status === 'active'); if (!p) fail('passenger_id', 'Passenger not found.', 404);
    const active = v.passengers.filter((x) => x.status === 'active');
    if (p.type === 'adult' && !active.some((x) => x.id !== p.id && x.type === 'adult') && active.length > 1) fail('passenger_id', 'Children and infants cannot travel without an adult.');
    const fee = Math.round(p.fare * CONFIG.cancel_fee_pct / 100);
    await q("UPDATE passengers SET status='cancelled' WHERE id=$1", [p.id]); await q('UPDATE bookings SET total=total-$2 WHERE id=$1', [v.id, p.fare]);
    if (active.length === 1) await q("UPDATE bookings SET status='cancelled' WHERE id=$1", [v.id]);
    await q('INSERT INTO refunds(booking_id,amount,fee,reason) VALUES($1,$2,$3,$4)', [v.id, p.fare - fee, fee, 'Passenger removed: ' + p.full_name]);
    ok(res, await bookingView(await one('SELECT * FROM bookings WHERE id=$1', [v.id])), 'Passenger removed');
  }));
  async function dateQuote(v, newDate) {
    checkDate(newDate, 'new_date'); const pol = policyFor(v);
    if (!pol.can_reschedule) fail('new_date', v.reschedules ? 'A booking can only be rescheduled once.' : `Date changes close ${CONFIG.date_change_notice_hours} hours before departure.`, 409);
    if (newDate === v.travel_date) fail('new_date', 'Pick a different date.');
    const trip = await one('SELECT * FROM trips WHERE id=$1', [v.trip_id]); if (!runsOn(trip, newDate)) fail('new_date', 'This train does not run on that day.');
    const t = await takenSeats(trip.id, newDate); const free = (await enabledSeats(trip.id, v.class)).filter((s) => !t.booked.has(s) && !t.locked.has(s));
    const need = v.passengers.filter((p) => p.status === 'active' && p.seat); if (free.length < need.length) fail('new_date', 'Not enough seats on that date.', 409);
    const fee = Math.round(v.total * CONFIG.reschedule_fee_pct / 100);
    const assign = {}; const pool = free.slice(); for (const p of need) { const s = pool.includes(p.seat) ? p.seat : pool[0]; assign[p.id] = s; pool.splice(pool.indexOf(s), 1); }
    return { new_date: newDate, fee, currency: 'KES', seats: assign };
  }
  api.post('/rest/booking-management/change-date/quote', mgr, wrap(async (req, res) => ok(res, await dateQuote(req.view, req.body.new_date))));
  api.post('/rest/booking-management/change-date', mgr, wrap(async (req, res) => ok(res, await dateQuote(req.view, req.body.new_date))));
  api.post('/rest/booking-management/change-date/request', mgr, wrap(async (req, res) => {
    const qt = await dateQuote(req.view, req.body.new_date);
    // Mock: the reschedule fee is treated as paid instantly via the selected method.
    await q('UPDATE bookings SET travel_date=$2, reschedules=reschedules+1 WHERE id=$1', [req.view.id, qt.new_date]);
    for (const [pid, seat] of Object.entries(qt.seats)) await q('UPDATE passengers SET seat=$2 WHERE id=$1', [Number(pid), seat]);
    await q('INSERT INTO payments(checkout_id,group_ref,method,amount,status) VALUES($1,$2,$3,$4,\'success\')', ['RSCH_' + token().slice(0, 12), req.view.group_ref, req.body.method || 'mpesa', qt.fee]);
    ok(res, await bookingView(await one('SELECT * FROM bookings WHERE id=$1', [req.view.id])), 'Travel date changed');
  }));
  api.get('/rest/booking-management/passengers', mgr, (req, res) => ok(res, req.view.passengers));
  api.get('/rest/booking-management/booked-seats', mgr, wrap(async (req, res) => ok(res, [...(await takenSeats(req.view.trip_id, req.view.travel_date)).booked])));
  api.get('/rest/booking-management/available-seats', mgr, wrap(async (req, res) => { const t = await takenSeats(req.view.trip_id, req.view.travel_date); ok(res, (await enabledSeats(req.view.trip_id, req.query.class || req.view.class)).filter((s) => !t.booked.has(s) && !t.locked.has(s))); }));
  api.post('/rest/booking-management/change-seat', mgr, wrap(async (req, res) => {
    const v = req.view; if (v.status !== 'confirmed') fail('ref', 'Only paid bookings can change seats.', 409);
    const p = v.passengers.find((x) => x.id === Number(req.body.passenger_id) && x.status === 'active' && x.seat); if (!p) fail('passenger_id', 'Passenger not found.', 404);
    const t = await takenSeats(v.trip_id, v.travel_date); const seats = await enabledSeats(v.trip_id, v.class);
    if (!seats.includes(req.body.seat) || t.booked.has(req.body.seat) || t.locked.has(req.body.seat)) fail('seat', 'That seat is not available.', 409);
    await q('UPDATE passengers SET seat=$2 WHERE id=$1', [p.id, req.body.seat]); ok(res, await bookingView(req.booking), 'Seat changed');
  }));
  api.post('/rest/booking-management/refund', mgr, wrap(async (req, res) => ok(res, await q('SELECT * FROM refunds WHERE booking_id=$1', [req.view.id]))));
  api.get('/rest/booking-management/refund', mgr, wrap(async (req, res) => ok(res, await q('SELECT * FROM refunds WHERE booking_id=$1', [req.view.id]))));

  api.get('/rest/refreshment-orders/menu', (req, res) => ok(res, require('./content').menu));
  api.post('/rest/refreshment-orders/place-order', wrap(async (req, res) => { if (!req.body.ref) fail('ref', 'Booking reference required.'); ok(res, { order_no: 'RF' + token().slice(0, 6).toUpperCase(), mock: true }, 'Order noted (demo)'); }));
  api.post('/rest/contact', wrap(async (req, res) => {
    const b = req.body; const e = {};
    if (!b.name) e.name = ['Your name is required.']; if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email || '')) e.email = ['Enter a valid email.']; if (!b.message || b.message.length < 5) e.message = ['Please write a message.'];
    if (Object.keys(e).length) throw new VErr(e);
    await q('INSERT INTO messages(name,email,mobile,category,body) VALUES($1,$2,$3,$4,$5)', [b.name, b.email, b.mobile, b.category, b.message]); ok(res, null, 'Thanks – your message was received (demo).');
  }));

  // ---------- admin ----------
  const ADMIN_USER = process.env.ADMIN_USER || 'admin', ADMIN_PASS = process.env.ADMIN_PASS || 'madaraka-demo';
  api.post('/admin/login', wrap(async (req, res) => {
    if (req.body.username !== ADMIN_USER || req.body.password !== ADMIN_PASS) fail('username', 'These credentials do not match our records.', 401);
    const t = token(); await q("INSERT INTO sessions VALUES($1,'admin','admin',null, now() + interval '8 hours')", [t]); ok(res, { token: t });
  }));
  const A = need('admin');
  api.get('/admin/stations', A, wrap(async (req, res) => ok(res, await q('SELECT * FROM stations ORDER BY id'))));
  api.get('/admin/routes', A, wrap(async (req, res) => ok(res, await q('SELECT * FROM routes ORDER BY id'))));
  api.put('/admin/routes/:id', A, wrap(async (req, res) => {
    const b = req.body; if (!b.name) fail('name', 'Name is required.');
    ok(res, await one('UPDATE routes SET name=$2, duration=$3, active=$4 WHERE id=$1 RETURNING *', [Number(req.params.id), b.name, b.duration, b.active !== false]), 'Route saved');
  }));
  api.get('/admin/trips', A, wrap(async (req, res) => ok(res, await q('SELECT t.*, r.name route_name FROM trips t JOIN routes r ON r.id=t.route_id ORDER BY t.id'))));
  const tripCheck = (b) => {
    if (!b.train_no) fail('train_no', 'Train number is required.');
    for (const k of ['dep_time', 'arr_time']) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b[k] || '')) fail(k, 'Use HH:MM (24h).');
    if (!/^[0-6]{1,7}$/.test(b.days || '')) fail('days', 'Days must be digits 0 (Sun) to 6 (Sat).');
    const cl = String(b.classes || '').split(',').filter(Boolean); if (!cl.length || cl.some((c) => !['economy', 'first', 'premium'].includes(c))) fail('classes', 'Classes: economy, first, premium.');
  };
  api.post('/admin/trips', A, wrap(async (req, res) => { const b = req.body; tripCheck(b);
    ok(res, await one('INSERT INTO trips(route_id,train_no,dep_time,arr_time,days,classes,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [Number(b.route_id), b.train_no, b.dep_time, b.arr_time, b.days, b.classes, b.active !== false]), 'Trip added'); }));
  api.put('/admin/trips/:id', A, wrap(async (req, res) => { const b = req.body; tripCheck(b);
    ok(res, await one('UPDATE trips SET train_no=$2, dep_time=$3, arr_time=$4, days=$5, classes=$6, active=$7 WHERE id=$1 RETURNING *', [Number(req.params.id), b.train_no, b.dep_time, b.arr_time, b.days, b.classes, b.active !== false]), 'Trip saved'); }));
  api.delete('/admin/trips/:id', A, wrap(async (req, res) => { await q('UPDATE trips SET active=false WHERE id=$1', [Number(req.params.id)]); ok(res, null, 'Trip deactivated'); }));
  api.get('/admin/fares', A, wrap(async (req, res) => ok(res, await q('SELECT id,service,class,adult::float,return_adult::float FROM fares ORDER BY service,class'))));
  api.put('/admin/fares/:id', A, wrap(async (req, res) => { const a = Number(req.body.adult); if (!(a >= 0) || a > 1e6) fail('adult', 'Enter a valid fare.');
    ok(res, await one('UPDATE fares SET adult=$2, return_adult=$3 WHERE id=$1 RETURNING *', [Number(req.params.id), a, req.body.return_adult ? Number(req.body.return_adult) : null]), 'Fare saved'); }));
  api.get('/admin/seat-layouts', A, wrap(async (req, res) => ok(res, await q('SELECT * FROM seat_layouts'))));
  api.put('/admin/seat-layouts/:cls', A, wrap(async (req, res) => { const b = req.body; for (const k of ['coaches', 'rows', 'cols']) if (!(Number(b[k]) >= 1 && Number(b[k]) <= 40)) fail(k, 'Must be 1–40.');
    if (Number(b.cols) > 6) fail('cols', 'At most 6 seats per row.');
    ok(res, await one('UPDATE seat_layouts SET coaches=$2, rows=$3, cols=$4 WHERE class=$1 RETURNING *', [req.params.cls, Number(b.coaches), Number(b.rows), Number(b.cols)]), 'Layout saved'); }));
  api.get('/admin/seat-map', A, wrap(async (req, res) => {
    const { trip_id, date, class: cls } = req.query; const t = await takenSeats(Number(trip_id), date);
    ok(res, (await layoutSeats(cls)).map((s) => ({ seat: s, state: t.booked.has(s) ? 'booked' : t.locked.has(s) ? 'locked' : 'free' })));
  }));
  api.get('/admin/seat-availability', A, wrap(async (req, res) => {
    const tripId = Number(req.query.trip_id), cls = req.query.class || 'economy';
    const trip = await one('SELECT * FROM trips WHERE id=$1', [tripId]); if (!trip) fail('trip_id', 'Unknown train.', 404);
    if (!trip.classes.split(',').includes(cls)) fail('class', `Train ${trip.train_no} has no ${cls} class.`);
    const en = new Set(await enabledSeats(tripId, cls)); const t = req.query.date ? await takenSeats(tripId, req.query.date) : { booked: new Set() };
    const l = await one('SELECT * FROM seat_layouts WHERE class=$1', [cls]);
    ok(res, { train_no: trip.train_no, class: cls, layout: l, enabled_count: en.size, seats: (await layoutSeats(cls)).map((s) => ({ seat: s, coach: Number(s.split('-')[0].slice(1)), enabled: en.has(s), booked: t.booked.has(s) })) });
  }));
  api.put('/admin/seat-availability', A, wrap(async (req, res) => {
    const { trip_id, class: cls, seats, enabled } = req.body; const tripId = Number(trip_id);
    const trip = await one('SELECT * FROM trips WHERE id=$1', [tripId]); if (!trip) fail('trip_id', 'Unknown train.', 404);
    if (!trip.classes.split(',').includes(cls)) fail('class', `Train ${trip.train_no} has no ${cls} class.`);
    if (!Array.isArray(seats) || !seats.length) fail('seats', 'Choose at least one seat.');
    if (typeof enabled !== 'boolean') fail('enabled', 'enabled must be true or false.');
    const all = new Set(await layoutSeats(cls)); const bad = seats.find((s) => !all.has(s)); if (bad) fail('seats', `Seat ${bad} is not in the ${cls} layout.`);
    for (const s of seats) {
      if (enabled) await q('DELETE FROM seat_disabled WHERE trip_id=$1 AND class=$2 AND seat=$3', [tripId, cls, s]);
      else await q('INSERT INTO seat_disabled VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [tripId, cls, s]);
    }
    ok(res, { enabled_count: (await enabledSeats(tripId, cls)).length }, `${seats.length} seat(s) ${enabled ? 'opened' : 'closed'} for booking`);
  }));
  api.get('/admin/bookings', A, wrap(async (req, res) => {
    const s = `%${(req.query.q || '').toUpperCase()}%`;
    const rows = await q(`SELECT * FROM bookings WHERE (ref LIKE $1 OR phone LIKE $1) AND ($2='' OR status=$2) ORDER BY id DESC LIMIT 200`, [s, req.query.status || '']);
    ok(res, await Promise.all(rows.map(bookingView)));
  }));
  api.post('/admin/bookings/:ref/cancel', A, wrap(async (req, res) => {
    const b = await one('SELECT * FROM bookings WHERE ref=$1', [req.params.ref]); if (!b) fail('ref', 'Not found', 404);
    if (b.status !== 'confirmed' && b.status !== 'pending') fail('ref', 'Booking is not active.', 409);
    await q("UPDATE bookings SET status='cancelled' WHERE id=$1", [b.id]); await q("UPDATE passengers SET status='cancelled' WHERE booking_id=$1", [b.id]);
    if (b.status === 'confirmed') await q('INSERT INTO refunds(booking_id,amount,fee,reason) VALUES($1,$2,0,$3)', [b.id, b.total, 'Cancelled by back office']);
    ok(res, null, 'Booking cancelled');
  }));
  api.get('/admin/refunds', A, wrap(async (req, res) => ok(res, await q('SELECT r.*, r.amount::float amount, r.fee::float fee, b.ref, b.phone FROM refunds r JOIN bookings b ON b.id=r.booking_id ORDER BY r.id DESC'))));
  api.post('/admin/refunds/:id/:action', A, wrap(async (req, res) => {
    const st = { approve: 'approved', reject: 'rejected', pay: 'paid' }[req.params.action]; if (!st) fail('action', 'Unknown action.');
    const r = await one('SELECT * FROM refunds WHERE id=$1', [Number(req.params.id)]); if (!r) fail('id', 'Not found', 404);
    const allowed = { pending: ['approved', 'rejected'], approved: ['paid'] }; if (!(allowed[r.status] || []).includes(st)) fail('action', `Cannot ${req.params.action} a ${r.status} refund.`, 409);
    ok(res, await one('UPDATE refunds SET status=$2 WHERE id=$1 RETURNING *', [r.id, st]), 'Refund ' + st);
  }));
  api.get('/admin/messages', A, wrap(async (req, res) => ok(res, await q('SELECT * FROM messages ORDER BY id DESC'))));
  api.get('/admin/reports', A, wrap(async (req, res) => {
    const from = req.query.from || addDays(today(), -30), to = req.query.to || addDays(today(), 60);
    const W = "status='confirmed' AND travel_date BETWEEN $1 AND $2";
    const totals = await one(`SELECT count(*)::int bookings, coalesce(sum(total),0)::float revenue, (SELECT count(*)::int FROM passengers p JOIN bookings b ON b.id=p.booking_id WHERE b.${W} AND p.status='active') passengers FROM bookings WHERE ${W}`, [from, to]);
    const byClass = await q(`SELECT class, count(*)::int bookings, sum(total)::float revenue FROM bookings WHERE ${W} GROUP BY class ORDER BY class`, [from, to]);
    const byRoute = await q(`SELECT r.name, count(*)::int bookings, sum(b.total)::float revenue FROM bookings b JOIN trips t ON t.id=b.trip_id JOIN routes r ON r.id=t.route_id WHERE b.${W} GROUP BY r.name ORDER BY revenue DESC`, [from, to]);
    const byDay = await q(`SELECT to_char(travel_date,'YYYY-MM-DD') AS "day", count(*)::int bookings, sum(total)::float revenue FROM bookings WHERE ${W} GROUP BY 1 ORDER BY 1`, [from, to]);
    const byMethod = await q(`SELECT pay_method method, count(*)::int n, sum(total)::float revenue FROM bookings WHERE ${W} GROUP BY 1`, [from, to]);
    const refunds = await one("SELECT count(*)::int n, coalesce(sum(amount),0)::float amount, coalesce(sum(fee),0)::float fees FROM refunds", []);
    ok(res, { from, to, totals, byClass, byRoute, byDay, byMethod, refunds });
  }));

  app.use(R, api);
  app.use('/api', api); // short alias

  // ---------- classic compatibility endpoints ----------
  const SCHED = { express: 'express', inter_county: 'intercounty', phase2: 'suswa' };
  app.get('/fetch.php', wrap(async (req, res) => {
    const svc = SCHED[req.query.schedule_type]; const routes = await q('SELECT * FROM routes WHERE active AND service=$1', [svc || '']);
    const st = await q('SELECT id,name FROM stations ORDER BY name'); const tid = Number(req.query.terminal_id);
    let ids = new Set();
    for (const r of routes) r.stops.forEach((s, i) => { if (req.query.type === 'terminals') { if (i < r.stops.length - 1) ids.add(s.id); } else { const fi = r.stops.findIndex((x) => x.id === tid); if (!tid ? i > 0 : fi >= 0 && i > fi) ids.add(s.id); } });
    const esc = (s) => s.replace(/[&<>'"]/g, (c) => `&#${c.charCodeAt(0)};`);
    res.type('html').send("<option value=''>Select...</option>" + st.filter((s) => ids.has(s.id)).map((s) => `<option value='${s.id}'>${esc(s.name)}</option>`).join(''));
  }));
  app.post('/validate.php', (req, res) => {
    const b = req.body; const names = [].concat(b['fullnames[]'] || b.fullnames || []); const ids = [].concat(b['ids[]'] || b.ids || []);
    if (!names.length || names.some((n) => !n || n.trim().length < 3)) return res.json({ info: 'invalid', message: 'Please fill in every passenger name.' });
    if (ids.some((i) => !/^[A-Za-z0-9]{7,14}$/.test(i))) return res.json({ info: 'invalid', message: 'ID/passport numbers must be 7–14 letters or digits.' });
    if (new Set(ids.map((i) => i.toUpperCase())).size !== ids.length) return res.json({ info: 'invalid', message: 'Each ID can only be used once.' });
    if (!normPhone(b.pay_mobile)) return res.json({ info: 'invalid', message: 'Enter a valid M-Pesa number.' });
    res.json({ info: 'valid', message: 'OK' });
  });

  // ---------- tickets ----------
  async function ticketGroup(req) {
    const bk = await q('SELECT * FROM bookings WHERE group_ref=$1 OR ref=$1 ORDER BY id', [req.params.ref]); if (!bk.length) fail('ref', 'Ticket not found', 404);
    if (normPhone(req.query.phone) !== bk[0].phone) fail('phone', 'Phone number does not match this booking.', 403);
    if (bk.some((b) => b.status !== 'confirmed' && b.status !== 'cancelled')) fail('ref', 'Ticket available after payment.', 409);
    return Promise.all(bk.map(bookingView));
  }
  const qrText = (v) => `MADARAKA-RAILWAYS-DEMO|${v.ref}|${v.train_no}|${v.travel_date}|${v.from.name}>${v.to.name}|${v.class}|${v.passengers.filter((p) => p.status === 'active').map((p) => p.seat || 'LAP').join(',')}`;
  app.get('/tickets/:ref/qr.png', wrap(async (req, res) => { const [v] = await ticketGroup(req); res.type('png').send(await QRCode.toBuffer(qrText(v), { width: 320, margin: 1 })); }));
  app.get('/tickets/:ref.pdf', wrap(async (req, res) => {
    const views = await ticketGroup(req); const doc = new PDFDocument({ size: 'A5', margin: 36 });
    res.type('pdf').set('Content-Disposition', `inline; filename="ticket-${req.params.ref}.pdf"`); doc.pipe(res);
    for (const [i, v] of views.entries()) {
      if (i) doc.addPage();
      doc.rect(0, 0, doc.page.width, 64).fill('#0E5E6F'); doc.fillColor('#fff').fontSize(18).text('Madaraka Railways', 36, 18); doc.fontSize(9).text('E-ticket  ·  DEMO – not valid for travel  ·  not affiliated with Kenya Railways', 36, 42);
      doc.fillColor('#111').moveDown(2).fontSize(12);
      doc.text(`Ref: ${v.ref}   (${v.leg})   Status: ${v.status.toUpperCase()}`, 36, 84);
      doc.fontSize(16).text(`${v.from.name}  →  ${v.to.name}`, { continued: false }); doc.fontSize(11)
        .text(`Train ${v.train_no} · ${v.route_name}`).text(`Date ${v.travel_date} · Departs ${v.departure} · Arrives ${v.arrival}`).text(`Class: ${v.class.toUpperCase()}   Total: KSh ${v.total.toLocaleString()}`).moveDown();
      doc.fontSize(11).text('Passengers', { underline: true });
      for (const p of v.passengers) doc.text(`${p.full_name}  (${p.type})  seat ${p.seat || 'lap'}  ${p.status === 'active' ? '' : '[' + p.status + ']'}`);
      const qr = await QRCode.toBuffer(qrText(v), { width: 220, margin: 1 }); doc.image(qr, doc.page.width - 36 - 130, 84, { width: 130 });
      doc.fontSize(8).fillColor('#555').text('Arrive at least 1 hour before departure with your ID. Demo project, not affiliated with Kenya Railways.', 36, doc.page.height - 60);
    }
    doc.end();
  }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
  app.get(/^\/(?!console|api|tickets).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  app.use((req, res) => res.status(404).json({ message: 'Not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof VErr) return res.status(err.status).json({ message: err.message + (Object.keys(err.errors).length > 1 ? ` (and ${Object.keys(err.errors).length - 1} more error)` : ''), errors: err.errors });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Malformed JSON.' });
    console.error(err); res.status(500).json({ message: 'Server error.' });
  });
  return app;
}
module.exports = { build, today, addDays, CONFIG };
