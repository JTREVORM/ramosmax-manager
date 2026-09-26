# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

# RamosMAX Web

Notes that matter in this repository, beyond the Next.js guidance above:

- The Flutter/Firebase app at the repository root is the **reference
  implementation**. Do not modify it, and do not touch the production Firebase
  project. See `../migration/RAMOSMAX_WEB_MIGRATION_PLAN.md`.
- `src/lib/permissions/catalogue.generated.ts` and
  `supabase/migrations/0002_permission_catalogue.sql` are **generated** from the
  reference implementation by `npm run gen:permissions`. Never edit them by
  hand; CI fails if they drift.
- Next.js 16 renames the `middleware` convention to `proxy` (Node runtime),
  and `cookies()`, `headers()`, `params` and `searchParams` are async-only.
- The architecture rules in `README.md` preserve financial controls. Read them
  before adding a mutation, a cache or an offline behaviour.

## Environment

`.env.example` documents every variable. Three groups matter:

- **Supabase** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`). With no URL set, the app talks to
  `DATABASE_URL` directly and calls the same functions, which is how the
  development database works without a hosted project.
- **Web Push** (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT`). Optional: without them the in-app inbox still works.
- **Notification delivery** (`NOTIFICATION_CRON_SECRET`). Required by
  `POST /api/notifications/deliver`, which a scheduler calls.

The service-role key bypasses RLS. It is used only by `serviceDb()` in
`src/lib/server/db.ts`, for the notification delivery run, and never anywhere
a browser can reach.

## Running the checks

There are two harnesses and **they do not share a database**. Each starts from
`npm run db:reset`.

```bash
npm run verify                       # generate, parse SQL, lint, typecheck, unit tests
npm run db:reset && npm run test:db  # 1,647 database tests
npm run test:db                      # again, twice, to prove order independence
```

Then, separately — a fresh reset, the built application on port 3100, and the
scripts **in this order**, because each needs a slice of the database the one
before it has not used:

```bash
npm run build && npx next start -p 3100
node scripts/check-finance-e2e.mjs      # first: it needs an empty ledger
node scripts/check-auth-e2e.mjs
node scripts/check-operations-e2e.mjs
node scripts/check-billing-e2e.mjs
node scripts/check-workforce-e2e.mjs
node scripts/check-ownership-e2e.mjs
node scripts/check-after-hours-e2e.mjs
node scripts/check-reports-e2e.mjs
node scripts/check-responsive.mjs       # needs the receipt billing created
node scripts/check-accessibility.mjs
node scripts/check-performance.mjs
```

Running `test:db` on a database the end-to-end scripts have used will fail in
the hundreds, and the failures are not real: those scripts deliberately put
the seeded accounts into states the unit-level tests assert they are not in.
Reset first.

`npm run db:reset` fails silently while a server still holds connections. Kill
it first (`fuser -k 3100/tcp`).
