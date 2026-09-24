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
npm run verify           # everything CI runs
npm run gen:permissions  # regenerate the catalogue from the reference implementation
npm run check:sql        # parse migrations with the real PostgreSQL grammar
npm run test             # unit and component tests
```

Responsive verification (needs a built app running on port 3100):

```bash
npm run build && npx next start -p 3100 &
CHROMIUM_PATH=/path/to/chromium node scripts/check-responsive.mjs
```

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
supabase/migrations/
  0001_app_schema.sql                 app schema, access tables, default deny
  0002_permission_catalogue.sql       GENERATED seed
  0003_access_helpers.sql             is_active(), has_permission(), RLS
src/
  app/(auth)/login                    sign-in
  app/(app)                           authenticated shell
  components/shell                    responsive navigation
  components/data/data-view.tsx       table on desktop, cards on phone
  lib/permissions                     effective-permission resolution
  lib/auth                            phone + password policy ports
  lib/online.ts                       the offline financial control
```

## Setting up a Supabase development project

Migrations are written and parse-checked but **have not been applied to any
database** — no Supabase project exists yet. When one is created:

```bash
supabase link --project-ref <DEVELOPMENT_PROJECT_REF>   # never production
supabase db push
cp .env.example .env.local                               # fill in URL + anon key
```

Apply `0001`, `0002`, `0003` in order. All three are additive: they create and
seed, and drop nothing.
