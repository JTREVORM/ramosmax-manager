# RamosMAX Web — final phase report

Shareholders, after-hours, reports, hosted Supabase and production readiness.
Written after the last verification run, against the branch
`claude/gifted-cerf-mfgdcx`.

---

## 1. What this phase delivered

Three workstreams, done in order, each finished before the next began.

**Workstream 1 — Shareholders, shares, ownership and dividends.** Shareholder
profiles with `RMX-SHR` references; configurable share classes that keep a
historical snapshot on every transaction; an immutable `RMX-SHR-TXN` ownership
ledger with second-person approval; contributions posted to the Phase E ledger
as share capital; ownership derived from the ledger on any date, never stored
as a mutable balance; the full dividend lifecycle with frozen allocations,
whole-shilling server arithmetic, atomic distribution and non-destructive
reversal; and the two privacy rules that matter — a shareholder never receives
the register, and a manager's aggregate totals never become identities.

**Workstream 2 — After-hours, temporary authorisation and cash handovers.**
Temporary authorisations from a fixed allow-list that can never carry
administrative or financial permissions; expiry by direct time comparison, so
a window closes whether or not anything is running; sessions that tag the
ordinary job, invoice and payment flows rather than duplicating them; a cash
custody sub-ledger that is not revenue and posts nothing on handover; a
server-calculated, frozen expected figure; manager counting with separation of
duties; the discrepancy lifecycle; and a shortage that reports a loss incident
and deducts nothing.

**Workstream 3 — Reports, notifications, administration and readiness.** Ten
server-calculated report domains with EAT periods, bounded record lists, a
`truncated` flag and CSV export; permission-filtered reporting with no second
query that could disagree; a notification catalogue whose text can never name
anybody or state an amount, with de-duplication and always-on critical
categories; an in-app inbox and Web Push; the three administration screens the
navigation had been advertising with nothing behind them; evidence
attachments; and the four documents this phase was asked for.

## 2. Acceptance gate — exact counts

Every number below is from the final run, on a fresh database.

| Check | Pass | Fail | Skipped |
|---|---|---|---|
| Unit tests (`npm run verify`) | 85 | 0 | 0 |
| Database tests (`npm run test:db`) | 1,647 | 0 | 0 |
| …run a second time on the used database | 1,647 | 0 | 0 |
| …and a third | 1,647 | 0 | 0 |
| Migration parsing (`check-sql.mjs`) | 53 | 0 | 0 |
| End-to-end, eight scripts | 526 | 0 | 0 |
| Responsive, four breakpoints | 803 | 0 | 0 |
| Accessibility (axe-core, WCAG 2.1 A/AA) | 121 | 0 | 0 |
| Performance and build quality | 22 | 0 | 0 |
| ESLint | 0 errors, 0 warnings | | |
| TypeScript | 0 errors | | |
| `next build` | 0 errors | | |
| **Hosted Supabase verification** | **NOT RUN** | | **10 checks** |

**3,204 automated checks pass. None is skipped, and no test in this
repository is marked `skip`, `todo` or `only`** — `grep` for them returns
nothing.

The only checks that did not run are the ten in `scripts/check-supabase.mjs`.
They did not run because no hosted Supabase project exists, and they cannot be
made to run without one. That is §5 below.

Two harnesses, two databases: the end-to-end scripts deliberately put the
seeded accounts into states the unit-level tests assert they are not in, so
each harness starts from `npm run db:reset`. Running one on the other's
database produces hundreds of failures that mean nothing. This is written down
in `AGENTS.md` rather than left to be rediscovered.

## 3. What was found by testing, not by reading

- **Two real concurrency holes.** Two simultaneous share transfers both
  succeeded; two simultaneous after-hours authorisations both succeeded, and
  revoking one would have left the other's grants standing. Both are fixed by
  ordered row locks, and both now have a test that fails without the fix.
- **A whole feature missing.** Comparing the reference's `storage.rules`
  against the port turned up evidence — deposit slips, receipts, sick notes,
  photographs of a loss, profile photos — with nothing ported. The database
  half is now done; the bucket is §5.
- **Three screens the navigation advertised and nothing served.** `/users`,
  `/settings` and `/audit` were 404s. The accessibility script had been
  reporting them clean, because a 404 has no violations; it now fails a screen
  that does not exist.
- **Four reference callables with no equivalent**, found by walking all 127 one
  at a time: `updateUserProfile`, `changeUserPhone`, `linkStaff`,
  `updateServiceIntake`.
- **A function that became browser-callable by accident.** PostgreSQL grants
  EXECUTE to `PUBLIC` on every new function; the exposure test refuses anything
  not on the written allow-list, and caught it.

## 4. The safety boundaries

Each one was a constraint on the work, and each held.

| Boundary | Status |
|---|---|
| Firebase production untouched | Never contacted. No credential for it exists in this container. |
| Production data unmodified, not migrated | Nothing read, nothing copied. |
| Web app not deployed publicly | It has only ever run on `127.0.0.1:3100`. |
| Phase 9 Flutter reference unmodified | Against `origin/main`, this branch touches exactly two files outside `ramosmax-web/`: the new `.github/workflows/web-ci.yml` and `migration/RAMOSMAX_WEB_MIGRATION_PLAN.md`. No Dart file, no Cloud Function, no rules file. |
| Financial history never deleted | Append-only, guarded by triggers, corrected only by reversal. |
| Ownership history never deleted | Same; ownership is derived from it. |
| RLS never weakened | Enabled and forced on all 62 tables; `authenticated` holds no write grant. |
| Phase 9 permissions never weakened | 127 keys × 6 roles compared against the reference key by key. |
| Service-role credentials never exposed | `serviceDb()` only, server-side only. |
| Shareholder register never exposed | A shareholder gets `my_shareholding` and nothing else. |
| Salaries never exposed | Own pay only; totals without identities for a manager. |
| Share capital never revenue | Its own category; tested against the revenue total. |
| Cash custody never revenue | A handover posts nothing to the ledger at all. |
| Salary never deducted automatically | A shortage reports an incident; recovery is separate and approved. |
| Financial mutations never queued offline | Refused outright, and a lost answer is never called a failure. |
| No business rule invented | Every rule traced to the reference; six deliberate differences listed in `docs/PARITY.md` §11. |
| No feature silently omitted | The evidence gap was found and reported rather than passed over. |
| No production-readiness claim from the local bootstrap | Stated in four documents, including this one. |

## 5. The hosted Supabase boundary — what I need from you

**I have stopped here, and this is the only thing blocking the rest.**

Everything above was proved against PostgreSQL 16 with the Supabase platform
objects emulated locally. That proves the business rules. It does not prove
PostgREST, GoTrue, `@supabase/ssr`, PgBouncer, the scheduler or Storage.

**What you need to create:** one **development** Supabase project — not
production, and not sharing a database with anything real.
`docs/SUPABASE_SETUP.md` §1 has the steps, including which region.

**What you need to give me**, from Project Settings → API:

1. `NEXT_PUBLIC_SUPABASE_URL` — the project URL.
2. `NEXT_PUBLIC_SUPABASE_ANON_KEY` — the anon key (public by design).
3. `SUPABASE_SERVICE_ROLE_KEY` — the service-role key (secret).
4. `SUPABASE_DB_URL` — the direct connection string, for the schema
   comparison.
5. `SUPABASE_POOLED_URL` — optional, port 6543, to test the pooler.

**What you also need to create**, once the project exists: three private
storage buckets — `finance_uploads`, `payroll_uploads` and `staff` — with the
paths and rules in `docs/SUPABASE_SETUP.md` §4. None may allow update or
delete to anybody.

**I will not ask you for your Supabase account password**, your production
project's keys, or any production data.

Once those values exist, `node scripts/apply-migrations.mjs` and
`node scripts/check-supabase.mjs` run the ten remaining checks without further
input.

## 6. Known differences and open items

Six deliberate differences from the reference, each with its reason, are in
`docs/PARITY.md` §11. The two worth repeating here:

- **A truncated report still adds up.** The reference caps both the list and
  the totals; here only the list is capped and the totals are aggregated over
  the whole period in the database. A capped total is a wrong total.
- **Evidence is attached after the upload, not passed to the function that
  creates the record.** A failed upload then cannot take the record down with
  it. The path shape, the permission and "never replaced, never removed" are
  unchanged.

Open, and waiting on §5:

1. The ten hosted-Supabase checks.
2. The storage buckets, and the upload control on each form that takes
   evidence. No screen offers an upload today, because there is nowhere to put
   the file.

One cosmetic item: `npm run format:check` reports style differences in 146
files. Prettier is not part of `npm run verify` and never has been in this
repository, so the code has been written to ESLint's rules rather than
Prettier's. Running `npm run format` would fix it and touch every file; I have
not done that unasked at the end of a phase.

## 7. Where the work is

Branch `claude/gifted-cerf-mfgdcx`, pushed. **Not merged to `main`. No
production deployment. No Firebase cutover.**

`docs/CUTOVER.md` is the migration plan, prepared and not executed.
`docs/GO_LIVE.md` is the checklist that gates it, with nothing ticked.

**I am stopping here and waiting for your approval** before any production
migration, any merge to `main`, any Vercel production deployment or any
Firebase cutover.
