# RamosMAX Web

The Next.js + Supabase migration of the RamosMAX Automotive Care Management System.

> **The Flutter/Firebase application at the repository root is the reference
> implementation.** It stays intact and authoritative until this web system has
> verified feature parity. Do not delete it, do not modify the production
> Firebase project, and do not migrate production data.

Migration plan: [`../migration/RAMOSMAX_WEB_MIGRATION_PLAN.md`](../migration/RAMOSMAX_WEB_MIGRATION_PLAN.md)
Reference version: Phase 9, commit `113219d`.

## Status — Phase A (foundation) complete

| Phase | Scope                                               | State       |
| ----- | --------------------------------------------------- | ----------- |
| A     | Scaffold, access model, shell, DataView, tokens, CI | **done**    |
| B     | Auth, users, roles, permissions                     | not started |
| C–I   | Business modules                                    | not started |
| J     | Hardening and parity suite                          | not started |
| K     | Data migration and cutover                          | not started |

## Commands

```bash
npm run dev              # development server
npm run verify           # lint, typecheck, unit tests, SQL grammar
npm run verify:all       # the above plus a database rebuild and the DB suite
npm run db:reset         # rebuild the development database from nothing
npm run test:db          # schema, RLS, permission parity, auth functions
npm run gen:permissions  # regenerate the catalogue from the reference implementation
npm run check:sql        # parse migrations with the real PostgreSQL grammar
npm run test             # unit and component tests
```

Browser verification (needs a built app running on port 3100 and the
development database):

```bash
npm run build && npx next start -p 3100 &
CHROMIUM_PATH=/path/to/chromium node scripts/check-responsive.mjs
CHROMIUM_PATH=/path/to/chromium node scripts/check-auth-e2e.mjs

# Needs a FRESH database, because RamosMAX never deletes what it creates:
npm run db:reset
CHROMIUM_PATH=/path/to/chromium node scripts/check-operations-e2e.mjs
```

## The worker / customer-phone boundary

A Worker holds `vehicles.view` and `services.view` but not `customers.view`.
They must be able to look up a number plate and see whose car it is, and must
never reach that customer's phone number. Three independent layers hold that
line:

1. **`public.vehicles` has no phone column at all** — there is nothing to leak.
2. **`public.customers`, which does hold phones, grants a Worker no row.**
3. **`public.vehicle_directory`** — the view plate search reads — names an
   explicit column list, so a column added to `vehicles` later cannot widen it
   by accident.

`src/test/db/operations-rls.test.ts` proves all three, including direct
attempts to join or name a customer id.

## Architecture rules

These are not stylistic preferences. They preserve financial controls that the
reference implementation enforces today.

1. **The client never computes a number that matters.** No total, balance,
   payroll figure, ownership percentage or expected-cash amount is calculated
   in the browser or in Next.js. The server calculates; the client displays.
2. **No client writes a business table.** `authenticated` holds `SELECT` only.
   Every mutation goes through a `SECURITY DEFINER` function, which is the
   equivalent of `allow write: if false` plus a callable Cloud Function.
3. **Permission checks in TypeScript decide what is SHOWN, never what is
   allowed.** RLS and the database functions are the security boundary.
4. **Money movements are never queued offline.** Reads may come from cache;
   mutations require a confirmed server response. See `src/lib/online.ts` —
   do not add Background Sync or optimistic writes to anything behind it.
5. **A lost answer is never reported as a failure.** It "may already have been
   saved". Retry with the same `requestId`.
6. **Nothing is deleted.** Deactivate, cancel or reverse.
7. **The permission catalogue is generated**, never hand-edited. CI fails if
   the committed copy drifts from the reference implementation.

## Layout

```
scripts/
  generate-permission-catalogue.mjs   reference implementation -> TS + SQL
  check-sql.mjs                       parses migrations with the PostgreSQL grammar
  check-responsive.mjs                breakpoint / a11y / overflow checks
supabase/local/
  00_platform_bootstrap.sql           LOCAL ONLY: emulates the Supabase platform
supabase/migrations/
  0001_app_schema.sql                 app schema, access tables, default deny
  0002_permission_catalogue.sql       GENERATED seed
  0003_access_helpers.sql             is_active(), has_permission(), RLS
  0004_auth_functions.sql             throttle, password policy, sign-in decision
  0005_user_admin.sql                 roles, permissions, temporary grants
  0006_operations_schema.sql          customers, vehicles, services, jobs, orders
  0007_operations_functions.sql       plates, customer/vehicle/service rules
  0008_jobs_functions.sql             intake, assignment, the status machine
  0009_operations_rls.sql             RLS, the vehicle directory, plate search
supabase/seed/
  dev_accounts.sql                    DEVELOPMENT ONLY: six fake test accounts
  dev_operations.sql                  DEVELOPMENT ONLY: catalogue and test vehicles
src/
  app/(auth)/login                    sign-in
  app/(app)                           authenticated shell
  components/shell                    responsive navigation
  components/data/data-view.tsx       table on desktop, cards on phone
  lib/permissions                     effective-permission resolution
  lib/auth                            phone + password policy ports
  lib/online.ts                       the offline financial control
  lib/server/                         db seam, auth provider, session, service
  proxy.ts                            route protection (Next 16 renamed this
                                      from middleware.ts)
  test/db/                            tests against a real PostgreSQL database
```

## The development database

Every migration is applied to, and tested against, a **real PostgreSQL server**.
No Supabase project exists yet (creating one needs the account owner), so
development uses a local database plus `supabase/local/00_platform_bootstrap.sql`,
which reproduces the parts of Supabase the application depends on: the
`anon` / `authenticated` / `service_role` roles, the PostgREST
`SET ROLE` request model, the `auth` schema and `auth.uid()`, and pgcrypto for
bcrypt password hashing — the same scheme GoTrue uses.

```bash
sudo apt-get install -y postgresql postgresql-contrib   # once
npm run db:reset                                        # rebuild from nothing
npm run test:db                                         # schema, RLS, permissions, auth
```

`supabase/local/` is **never** applied to a Supabase project; Supabase provides
all of it already.

### When a Supabase development project exists

```bash
supabase link --project-ref <DEVELOPMENT_PROJECT_REF>   # never production
supabase db push                                        # applies supabase/migrations only
cp .env.example .env.local                              # URL + anon + service-role key
```

Setting `NEXT_PUBLIC_SUPABASE_URL` switches the backend from the local
PostgreSQL connection to Supabase. The business rules do not change: both
paths call the same `app.*` functions with the same arguments.

## Authentication

People sign in with a **phone number and a password**; no email is ever typed.
The credential lives in Supabase Auth against a random hidden identity on the
reserved `.invalid` domain, exactly as the reference implementation does.

Everything that is a business rule — phone normalisation, the
five-per-fifteen-minutes throttle, the uniform credential failure message, the
account decision, the password policy, the forced change, the audit trail — is
decided by `app.*` database functions and is shared by both backends. The only
thing that differs is the credential store itself (`src/lib/server/auth-provider.ts`).

The session is an httpOnly, SameSite=Lax cookie. It is not readable from
JavaScript, and nothing sensitive is handed to client-side code.

### Development accounts

`supabase/seed/dev_accounts.sql` creates six obviously fake accounts, one per
role, with the shared password `DevP@ssw0rd!`:

| Role          | Phone      |
| ------------- | ---------- |
| Administrator | 0772000001 |
| Manager       | 0772000002 |
| Cashier       | 0772000003 |
| Worker        | 0772000004 |
| Shareholder   | 0772000005 |
| Auditor       | 0772000006 |

They are development-only and must never be applied to a production project.
