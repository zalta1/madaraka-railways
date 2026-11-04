# Madaraka Railways (demo)

> **Demo project, not affiliated with Kenya Railways.** Showcase for a Ministry of Transport challenge. Payments are simulated; sample data only.

Fresh implementation inspired by the *flow* of a public rail-ticketing site (spec: `/workspace/krc-map/SPEC.md`). All code is new and all copy is paraphrased. The brand, logo (`public/img/logo.svg`) and teal/amber palette are deliberately different from the official site.

## Run
```bash
npm install
npm start                 # http://localhost:4300  (PORT to change)
npm test                  # 15 API tests, in-memory DB
npm start & npm run e2e   # browser E2E (needs /usr/bin/google-chrome), writes screenshots/
```
Back office: http://localhost:4300/admin – `admin` / `madaraka-demo` (override with ADMIN_USER / ADMIN_PASS).
Env: `MOCK_PAY_DELAY_MS` (default 2500) – how long the fake payment takes to "complete". Phone numbers ending in `000` simulate a failed payment.

## Database
PostgreSQL via **PGlite** (real Postgres compiled to WASM, runs in-process; data in `data/pg`). No Postgres server was available on the box, so no SQLite fallback was needed. To use a real server: `npm i pg` and set `DATABASE_URL=postgres://...`. Delete `data/pg` to reseed.

## Images
`public/img/hero.svg`, `coach.svg` and `logo.svg` are original illustrations made for this demo (no third-party photos). Swap in your own photos by replacing those files (or pointing `.hero` in `public/styles.css` at a JPG).

## Features
- Search one-way / round trip, Economy, First, Premium (Premium = Express trains; round trip KSh 20,000), passenger types (adult, teen, child 50%, infant free/no seat), partial journeys priced by distance.
- 13 stations, 6 routes (Express, Inter-County, Suswa leisure), 8 trains with spec timetables.
- Seat map per coach with server-side seat locks (10 min), live "held by someone else" state, 409 on conflicts.
- Booking rules: 60-day window, 10-min cutoff, ≤9 passengers, ≥1 adult, one infant per adult, ID 7–14 alphanumerics unique per train/date, Safaricom-style phone regex, 30-min payment window.
- Mock payments: M-Pesa STK, KCB Buni, card session, Equity session. No card number, CVV or PIN fields exist; the API rejects them.
- Confirmation with QR codes and PDF e-tickets (`/tickets/:ref.pdf?phone=`), marked "DEMO – not valid for travel".
- Manage booking with SMS-style OTP (code shown on screen): cancel (≥48 h, 30% fee → refund request), remove one passenger, change date once (≥48 h, 10% fee), change seat (API).
- Phone-OTP login, profile, my bookings, transactions, token refresh.
- English / Kiswahili toggle, dark mode, responsive layout, persistent demo banner + footer.
- Back office: reports (revenue/class/route/method/day, refunds), bookings search + cancel, refund approve/reject/mark paid, routes, timetables (add/edit/deactivate), fares, seat layouts + occupancy view, contact messages.

## API (mirrors the spec's paths; base `/console/api`, alias `/api`)
`rest/booking-info/{config,maintenance,stations,station-facilities,passenger-types,pwd-types,nationalities,payment-methods,fare-charts,ticket-prices,fare-calculator,payment-preview,next-trips,search-trips,faqs,news,gallery}`,
`rest/trips/{search,search-return}`, `rest/seat-locks/{token,auth,status,lock,release,release-all}`,
`rest/booking-management/{create,abandon,auth/request-otp,auth/verify-otp,details,cancel,passengers,passengers/cancel,change-date,change-date/quote,change-date/request,booked-seats,available-seats,change-seat,refund}`,
`rest/booking-info/payment/{stk-push,status}`, `payment/buni/{stk-push,status}`, `payment/card/{session,status}`, `payment/equity/{session,status}`,
`rest/auth/otp/{request,verify}`, `rest/auth/refresh`, `rest/logout`, `rest/profile`, `rest/bookings`, `rest/transactions`, `rest/booking-details[/people]`, `get-countries`,
`rest/refreshment-orders/{menu,place-order}`, `rest/contact`, `admin/*`. Classic compatibility: `GET /fetch.php`, `POST /validate.php`. Errors use Laravel shape `{message, errors:{field:[...]}}`.

## Known limitations
- Seats are held for the whole train run, not per segment (a Nairobi–Voi seat is not resold Voi–Mombasa).
- Intermediate stop times are interpolated by distance; intercounty arrival time (14:45) and Suswa fares are invented (spec didn't give them).
- Changing a seat layout in the back office doesn't migrate seats already booked outside the new layout.
- No real SMS, email, waiting list, bulk/corporate booking UI, or refreshment ordering UI (APIs stubbed).

See `BUGS.md` for bugs found during testing.
