# Bugs found and fixed (testing against the local clone only)
1. **Admin reports 500** – `day` used as an unquoted column alias broke the Postgres parser. Quoted it. (Found by API test.)
2. **Test bug** – payment test called status on a rejected second payment; rewrote to assert the 409 "already paid".
3. **Stale seat picks across searches** – picks from an earlier search could carry into a new one; now cleared on every new search.
4. **Mobile had no navigation** – nav was hidden under 820 px with no menu, so Manage booking/Stations were unreachable. Now a scrollable nav row.
5. **"Sign in" pill wrapped on mobile** – added nowrap.
6. **Link-buttons underlined** ("Download PDF ticket") – removed underline.
7. **Swap button took a whole grid column** on the search form, pushing "To" away – moved inline next to the To label.
8. **Admin report tables had no headers** – added.
9. **Admin occupancy grid**: seat labels like "E1-10A" overflowed 40 px cells – widened.
Open/known: see "Known limitations" in README (segment-level seat reuse, layout changes vs existing bookings).
10. **Fresh clone could fail on a missing `data/` folder** – db.js now creates `data/pg` recursively and `data/.gitkeep` is committed.
11. **Admin seat-editor filters stretched full width** – train/class/date selectors now sit on one row.
