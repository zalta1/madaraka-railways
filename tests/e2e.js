// Browser end-to-end run against the LOCAL clone only (default http://localhost:4300). Saves screenshots.
const { chromium } = require('playwright-core');
const BASE = process.env.BASE || 'http://localhost:4300';
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(BASE)) throw new Error('E2E must target the local clone only');
const out = (n) => `${__dirname}/../screenshots/${n}.png`;
const assert = (c, m) => { if (!c) throw new Error('E2E assert: ' + m); };
const d = (n) => new Date(Date.now() + 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(BASE); await page.waitForSelector('#searchForm'); await page.screenshot({ path: out('01-home') });
  // validation
  await page.click('#searchForm button[type=submit]'); assert(await page.locator('.err').count() >= 2, 'empty search shows errors'); await page.screenshot({ path: out('02-home-validation') });
  // round trip search Nairobi -> Mombasa
  await page.check('input[value=round]'); await page.selectOption('#from', '2'); await page.selectOption('#to', '3');
  await page.fill('#date', d(5)); await page.fill('#return_date', d(7)); await page.fill('#p_adult', '2'); await page.fill('#p_child', '1');
  await page.click('#searchForm button[type=submit]'); await page.waitForSelector('.kbox'); await page.screenshot({ path: out('03-results'), fullPage: true });
  await page.locator('[data-leg=outbound] .kbox').filter({ hasText: /First Class/ }).first().click();
  await page.locator('[data-leg=return] .kbox').filter({ hasText: /First Class/ }).first().click();
  await page.click('#next'); await page.waitForURL(/\/booking\/passengers/); await page.waitForSelector('#paxForm');
  assert(await page.locator('.seat').count() === 0, 'no customer seat map'); assert((await page.textContent('#autoNote')).includes('automatically'), 'auto-seat note');
  await page.fill('#n0', 'Amina Odhiambo'); await page.fill('#i0', '30111222'); await page.selectOption('#g0', 'F');
  await page.fill('#n1', 'Brian Otieno'); await page.fill('#i1', '30111223'); await page.selectOption('#g1', 'M');
  await page.fill('#n2', 'Zawadi Otieno'); await page.selectOption('#g2', 'F'); await page.fill('#phone', '0712345678');
  await page.screenshot({ path: out('04-passengers-auto-seats'), fullPage: true });
  await page.click('#toPay'); await page.waitForURL(/\/booking\/pay/); assert(/Seats assigned: F\d-\d+[A-C], F/.test(await page.textContent('aside')), 'seats auto-assigned'); await page.screenshot({ path: out('05-payment') });
  await page.click('#payForm button'); await page.waitForSelector('#modal:not(.hidden)'); await page.screenshot({ path: out('06-mpesa-prompt') });
  await page.waitForURL(/\/booking\/done/, { timeout: 20000 }); await page.waitForSelector('.ticket img'); await page.waitForTimeout(500);
  await page.screenshot({ path: out('07-confirmation-qr'), fullPage: true });
  const ref = (await page.locator('.ticket b').first().textContent()).split(':')[1].trim();
  const pdf = await page.request.get(`${BASE}/tickets/${ref}.pdf?phone=0712345678`); assert(pdf.headers()['content-type'] === 'application/pdf', 'pdf');
  require('fs').writeFileSync(`${__dirname}/../screenshots/sample-ticket.pdf`, await pdf.body());
  // manage booking: reschedule outbound then cancel
  await page.goto(BASE + '/booking/manage'); await page.fill('#mref', ref); await page.fill('#mph', '0712345678'); await page.click('#mf button');
  const code = (await page.locator('.otp b').textContent()).trim(); await page.fill('#otp', code); await page.screenshot({ path: out('08-manage-otp') });
  await page.click('#of button'); await page.waitForSelector('#cx'); page.on('dialog', (dlg) => dlg.accept());
  await page.fill('#nd', d(6)); await page.click('#rs'); await page.waitForTimeout(1200); assert((await page.textContent('#app')).includes(d(6)), 'rescheduled');
  await page.screenshot({ path: out('09-manage-rescheduled') });
  await page.click('#cx'); await page.waitForTimeout(1200); assert((await page.textContent('.badge')).includes('cancelled'), 'cancelled'); await page.screenshot({ path: out('10-manage-cancelled') });
  // login with phone OTP
  await page.goto(BASE + '/login'); await page.fill('#lph', '0712345678'); await page.click('#lf button'); const lc = (await page.locator('.otp b').textContent()).trim();
  await page.fill('#lotp', lc); await page.click('#lv button'); await page.waitForURL(/\/account/); await page.waitForSelector('table'); await page.screenshot({ path: out('11-account'), fullPage: true });
  // Swahili + dark mode
  await page.goto(BASE); await page.click('#langBtn'); await page.click('#themeBtn'); await page.waitForTimeout(300);
  assert((await page.textContent('#searchForm')).includes('Tafuta treni'), 'swahili'); await page.screenshot({ path: out('12-home-swahili-dark') });
  await page.click('#langBtn'); await page.click('#themeBtn');
  for (const p of ['stations', 'fares', 'faq', 'about', 'contact']) { await page.goto(BASE + '/' + p); await page.waitForTimeout(500); await page.screenshot({ path: out('13-' + p), fullPage: true }); }
  // admin
  await page.goto(BASE + '/admin'); await page.fill('#au', 'admin'); await page.fill('#ap', 'madaraka-demo'); await page.click('#al button'); await page.waitForSelector('.stat');
  await page.screenshot({ path: out('14-admin-reports'), fullPage: true });
  for (const tab of ['bookings', 'refunds', 'timetables', 'fares', 'seats']) { await page.click(`[data-t=${tab}]`); await page.waitForTimeout(700); if (tab === 'seats') {
      await page.selectOption('#st', '1'); await page.waitForTimeout(500); await page.selectOption('#sc', 'premium'); await page.waitForTimeout(500);
      await page.click('[data-coff="1"]'); await page.waitForTimeout(600); assert((await page.textContent('#socc')).includes('0 of 18'), 'coach closed');
      await page.click('[data-s="P1-2B"]'); await page.click('[data-s="P1-3B"]'); await page.click('#sOpen'); await page.waitForTimeout(600);
      assert((await page.textContent('#socc')).includes('2 of 18'), 'two seats reopened'); await page.click('[data-s="P1-4A"]'); await page.waitForTimeout(200); } await page.screenshot({ path: out('15-admin-' + tab), fullPage: true }); }
  // customer search now sees only 2 premium seats on E2; 3 passengers cannot pick premium there
  const resp = await page.request.post(`${BASE}/console/api/rest/trips/search`, { data: { from: 2, to: 3, date: d(1), class: 'premium' } });
  assert((await resp.json()).data.find((x) => x.train_no === 'E2').classes[0].seats_available === 2, 'search honours admin seat selection');
  const tok = await page.evaluate(() => sessionStorage.getItem('admin_token'));
  const all = (await (await page.request.get(`${BASE}/console/api/admin/seat-availability?trip_id=1&class=premium`, { headers: { authorization: 'Bearer ' + tok } })).json()).data.seats.map((x) => x.seat);
  await page.request.put(`${BASE}/console/api/admin/seat-availability`, { headers: { authorization: 'Bearer ' + tok }, data: { trip_id: 1, class: 'premium', seats: all, enabled: true } });
  // mobile
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true }); await m.goto(BASE); await m.waitForSelector('#searchForm'); await m.screenshot({ path: out('16-home-mobile'), fullPage: true });
  await browser.close();
  if (errors.length) { console.error('Browser errors:', errors); process.exit(1); }
  console.log('E2E OK, ref', ref);
})().catch((e) => { console.error(e); process.exit(1); });
