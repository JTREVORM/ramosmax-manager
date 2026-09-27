# Go-live checklist

Nothing here is ticked. Each box is ticked by the person who did the thing,
not by the person who wants it done.

`docs/CUTOVER.md` does not begin until every box in sections 1 to 6 is ticked.
Section 7 is ticked in the week after.

---

## 1. Verified against a hosted Supabase project

Until this section is complete, **the system is not production-ready and must
not be described as such**. Everything proved so far was proved against a
local PostgreSQL 16 database emulating the Supabase platform.

- [ ] A development Supabase project exists (`docs/SUPABASE_SETUP.md` §1).
- [ ] Every migration applied to it in order, with no manual edits.
- [ ] `node scripts/check-supabase.mjs` passes all ten checks.
- [ ] PostgREST exposes exactly the 184 allow-listed functions and no others.
- [ ] `anon` can read nothing.
- [ ] GoTrue sign-in works and the JWT carries the `sub` the RLS policies read.
- [ ] A session round-trips through `@supabase/ssr` and `proxy.ts`.
- [ ] PgBouncer in transaction mode does not break the `SET LOCAL` pattern the
      policies depend on. **Check this one twice.**
- [ ] `bigint` money arrives as a JSON number, not a string.
- [ ] The scheduler reaches `POST /api/notifications/deliver`.
- [ ] The three storage buckets exist, are private, and refuse update and
      delete to everybody (`docs/SUPABASE_SETUP.md` §4).

## 2. Green here

- [ ] `npm run verify` — unit tests.
- [ ] `npm run db:reset && npm run test:db` — on a fresh database.
- [ ] `npm run test:db` twice more on the used database, proving order
      independence.
- [ ] `node scripts/check-sql.mjs` — every migration parses.
- [ ] Every end-to-end script: auth, operations, billing, finance, workforce,
      ownership, after-hours, reports.
- [ ] `node scripts/check-responsive.mjs` at all four breakpoints.
- [ ] `node scripts/check-accessibility.mjs` — no serious or critical issue.
- [ ] `node scripts/check-performance.mjs`.
- [ ] `npm run build` with no error and no new warning.

## 3. Production project

- [ ] A **separate** production Supabase project, not shared with development.
- [ ] Its database password is in the business's password manager and nowhere
      else.
- [ ] The service-role key exists only in the production environment's
      variables. It is not in the repository, not in a chat message, not in
      a screenshot.
- [ ] Point-in-time recovery is on.
- [ ] A backup has been taken **and restored into a scratch project**, to
      prove the backup is a backup.
- [ ] Row-level security is confirmed enabled and forced on all 62 tables in
      the production project, not only in development.

## 4. The application

- [ ] Deployed to its production URL over HTTPS.
- [ ] Every variable in `.env.example` set, with production values.
- [ ] `NOTIFICATION_CRON_SECRET` set and the scheduler using it.
- [ ] VAPID keys set, or push deliberately left off and the business told so.
- [ ] The PWA installs on an Android phone and the service worker serves the
      shell offline.
- [ ] Opened on a real phone on a Ugandan mobile network, not office Wi-Fi.

## 5. The people

- [ ] Every role has been walked through its own screens by somebody who does
      that job — not by the person who built it.
- [ ] The Administrator knows how to create a person, reset a password and
      turn access off.
- [ ] A manager has counted a handover in the web application at least once.
- [ ] A cashier has taken a payment and issued a receipt at least once.
- [ ] A worker has started and finished a job on their own phone at least
      once.
- [ ] Everybody knows the Flutter app stays on their phone for week one, and
      why.

## 6. The business decisions

These are not technical and are not the developer's to make.

- [ ] The cutover date and window are agreed, in writing.
- [ ] Who approves the reconciliation in `docs/CUTOVER.md` §3 is named.
- [ ] Who decides a rollback is named, and can be reached that evening.
- [ ] Data retention and the handling of personal data are agreed.
- [ ] The accountant has seen how share capital, cash custody and
      distributions are recorded, and accepts them.
- [ ] It is agreed in writing that the Firebase project is **not** deleted at
      cutover.

## 7. The week after

- [ ] §3 of the cutover plan reconciled again, on live data.
- [ ] Every notice category produced at least one real notice, and none of
      them carried a name or an amount.
- [ ] The audit trail has been read once, by somebody other than its author.
- [ ] No financial figure has been corrected by hand in the database. Every
      correction went through a reversal.
- [ ] The business says, in writing, that the Flutter fallback may stand down.

---

## Never, on any checklist

- Deploying with the development Supabase project's keys.
- A service-role key anywhere a browser can reach.
- Weakening an RLS policy to make something work.
- Editing a financial row by hand to make a reconciliation balance.
- Deleting the Flutter application or the Firebase project.
