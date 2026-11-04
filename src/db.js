// Database layer. Uses PGlite (real PostgreSQL compiled to WASM, runs in-process) so no
// external server is required. Set DATABASE_URL to use a real Postgres via `pg` instead.
const path = require('path');
let db;
async function open(dir) {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = { query: (q, p) => pool.query(q, p), exec: (q) => pool.query(q) };
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const pg = dir === 'memory' ? new PGlite() : new PGlite(dir || path.join(__dirname, '..', 'data', 'pg'));
    await pg.waitReady;
    db = { query: (q, p) => pg.query(q, p), exec: (q) => pg.exec(q) };
  }
  await migrate();
  return db;
}
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stations(id INT PRIMARY KEY, name TEXT NOT NULL, code TEXT, county TEXT, lat NUMERIC, lng NUMERIC, facilities TEXT DEFAULT '', blurb TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS routes(id SERIAL PRIMARY KEY, code TEXT UNIQUE, name TEXT, service TEXT, stops JSONB NOT NULL, distance_km INT, duration TEXT, active BOOLEAN DEFAULT true);
CREATE TABLE IF NOT EXISTS trips(id SERIAL PRIMARY KEY, route_id INT REFERENCES routes(id), train_no TEXT, dep_time TEXT, arr_time TEXT, days TEXT DEFAULT '0123456', classes TEXT DEFAULT 'economy,first', active BOOLEAN DEFAULT true);
CREATE TABLE IF NOT EXISTS fares(id SERIAL PRIMARY KEY, service TEXT, class TEXT, adult NUMERIC, return_adult NUMERIC, UNIQUE(service,class));
CREATE TABLE IF NOT EXISTS seat_layouts(class TEXT PRIMARY KEY, coaches INT, rows INT, cols INT, letters TEXT);
CREATE TABLE IF NOT EXISTS users(phone TEXT PRIMARY KEY, name TEXT, email TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS otps(id SERIAL PRIMARY KEY, phone TEXT, purpose TEXT, ref TEXT, code TEXT, expires_at TIMESTAMPTZ, used BOOLEAN DEFAULT false);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, phone TEXT, kind TEXT, ref TEXT, expires_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS seat_locks(trip_id INT, travel_date DATE, seat TEXT, class TEXT, token TEXT, expires_at TIMESTAMPTZ, PRIMARY KEY(trip_id,travel_date,seat));
CREATE TABLE IF NOT EXISTS bookings(id SERIAL PRIMARY KEY, ref TEXT UNIQUE, group_ref TEXT, leg TEXT DEFAULT 'outbound', phone TEXT, trip_id INT REFERENCES trips(id), travel_date DATE, from_id INT, to_id INT, class TEXT, status TEXT DEFAULT 'pending', total NUMERIC, pay_method TEXT, paid_at TIMESTAMPTZ, reschedules INT DEFAULT 0, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS passengers(id SERIAL PRIMARY KEY, booking_id INT REFERENCES bookings(id), full_name TEXT, id_no TEXT, gender TEXT, nationality TEXT, ptype TEXT, seat TEXT, fare NUMERIC, status TEXT DEFAULT 'active');
CREATE TABLE IF NOT EXISTS payments(id SERIAL PRIMARY KEY, checkout_id TEXT UNIQUE, group_ref TEXT, method TEXT, phone TEXT, amount NUMERIC, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS refunds(id SERIAL PRIMARY KEY, booking_id INT REFERENCES bookings(id), amount NUMERIC, fee NUMERIC, reason TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS messages(id SERIAL PRIMARY KEY, name TEXT, email TEXT, mobile TEXT, category TEXT, body TEXT, created_at TIMESTAMPTZ DEFAULT now());
`;

async function migrate() {
  await db.exec(SCHEMA);
  const c = await one('SELECT count(*)::int n FROM stations');
  if (c.n) return;
  const st = [
    [2,'Nairobi Terminus','NBI','Nairobi',-1.3543,36.8990,'Parking,Waiting lounge,Food court,Accessible ramps'],
    [11,'Athi River','ATR','Machakos',-1.4560,36.9780,'Parking,Waiting lounge'],
    [10,'Emali','EML','Makueni',-2.0780,37.4740,'Waiting lounge'],
    [9,'Kibwezi','KBZ','Makueni',-2.4140,37.9650,'Waiting lounge'],
    [5,'Mtito Andei','MTA','Makueni',-2.6900,38.1670,'Waiting lounge,Kiosk'],
    [4,'Voi','VOI','Taita Taveta',-3.3960,38.5560,'Parking,Waiting lounge,Kiosk'],
    [7,'Miasenyi','MSY','Taita Taveta',-3.6400,38.9200,'Waiting lounge'],
    [6,'Mariakani','MRK','Kilifi',-3.8620,39.4730,'Waiting lounge'],
    [3,'Mombasa Terminus','MSA','Mombasa',-4.0300,39.5940,'Parking,Waiting lounge,Food court,Accessible ramps'],
    [12,'Ongata Rongai','ORG','Kajiado',-1.3960,36.7600,'Waiting lounge'],
    [13,'Ngong','NGG','Kajiado',-1.3620,36.6560,'Waiting lounge'],
    [14,'Maai Mahiu','MMH','Nakuru',-1.0120,36.5900,'Waiting lounge'],
    [15,'Suswa','SSW','Narok',-1.1500,36.3500,'Waiting lounge'],
  ];
  for (const s of st) await db.query('INSERT INTO stations(id,name,code,county,lat,lng,facilities) VALUES($1,$2,$3,$4,$5,$6,$7)', s);
  const ic = [[2,0],[11,30],[10,125],[9,200],[5,245],[4,330],[7,380],[6,440],[3,480]];
  const rev = (a) => { const t = a[a.length-1][1]; return a.slice().reverse().map(([i,k]) => [i, t-k]); };
  const ex = [[2,0],[4,330],[3,480]];
  const sw = [[2,0],[12,25],[13,40],[14,90],[15,120]];
  const routes = [
    ['NBI_MSA_EXPRESS','Nairobi – Mombasa Express','express',ex,480,'5h 30m'],
    ['MSA_NBI_EXPRESS','Mombasa – Nairobi Express','express',rev(ex),480,'5h 30m'],
    ['NBI_MSA_INTERCOUNTY','Nairobi – Mombasa Inter-County','intercounty',ic,480,'6h 45m'],
    ['MSA_NBI_INTERCOUNTY','Mombasa – Nairobi Inter-County','intercounty',rev(ic),480,'6h 45m'],
    ['NBI_SUSWA','Nairobi – Suswa Leisure','suswa',sw,120,'2h 20m'],
    ['SUSWA_NBI','Suswa – Nairobi Leisure','suswa',rev(sw),120,'2h 20m'],
  ];
  for (const r of routes) await db.query('INSERT INTO routes(code,name,service,stops,distance_km,duration) VALUES($1,$2,$3,$4,$5,$6)', [r[0],r[1],r[2],JSON.stringify(r[3].map(([id,km])=>({id,km}))),r[4],r[5]]);
  const trips = [
    [1,'E2','15:00','20:30','0123456','economy,first,premium'],[1,'E4','22:00','03:30','0123456','economy,first,premium'],
    [2,'E1','15:00','20:30','0123456','economy,first,premium'],[2,'E3','22:00','03:30','0123456','economy,first,premium'],
    [3,'IC1','08:00','14:45','0123456','economy,first'],[4,'IC2','08:00','14:45','0123456','economy,first'],
    [5,'S1','08:50','11:10','056','economy,first'],[6,'S2','16:05','18:25','056','economy,first'],
  ];
  for (const t of trips) await db.query('INSERT INTO trips(route_id,train_no,dep_time,arr_time,days,classes) VALUES($1,$2,$3,$4,$5,$6)', t);
  const fares = [['express','economy',1500,null],['express','first',4500,null],['express','premium',12000,20000],
    ['intercounty','economy',1500,null],['intercounty','first',4500,null],['suswa','economy',300,null],['suswa','first',800,null]];
  for (const f of fares) await db.query('INSERT INTO fares(service,class,adult,return_adult) VALUES($1,$2,$3,$4)', f);
  for (const l of [['economy',4,10,4,'ABCD'],['first',2,8,3,'ABC'],['premium',1,6,3,'ABC']])
    await db.query('INSERT INTO seat_layouts VALUES($1,$2,$3,$4,$5)', l);
}
module.exports = { open, q, one, get db() { return db; } };
