# Hosted Supabase — what has to exist, and how it is verified

RamosMAX Web runs against a real Supabase project in production. Everything
in this repository has so far been proved against a **local PostgreSQL 16
database** that emulates the Supabase platform (`supabase/local/00_platform_bootstrap.sql`
creates the `auth`, `app` and role scaffolding that Supabase provides).

That is a strong proof of the **business rules** — 1,608 database tests, every
permission, every financial invariant, every privacy boundary. It is **not** a
proof of the **platform integration**: PostgREST's argument handling, GoTrue's
sessions, `@supabase/ssr` cookies, PgBouncer's statement behaviour and the
scheduler have never run here, because no hosted project has been available.

This document says exactly what to create, what to hand over, and what will
then be checked automatically.

---

## 1. What you need to create

A **development** Supabase project. Not production, and not one that shares a
database with anything real.

1. Sign in at <https://supabase.com/dashboard> and create a new project.
   - **Name:** anything, e.g. `ramosmax-dev`.
   - **Region:** the closest to Uganda that Supabase offers — at the time of
     writing that is `eu-central-1` (Frankfurt) or `eu-west-2` (London).
     Latency from Kampala matters more than anything else on this list.
   - **Database password:** choose one, store it in your own password manager.
     **Do not send it to me and do not put it in this repository.** Nothing in
     the verification needs it.
2. Wait for the project to finish provisioning.

## 2. What to hand over

From **Project Settings → API**:

| What | Where it goes | Secret? |
|---|---|---|
| Project URL (`https://<ref>.supabase.co`) | `NEXT_PUBLIC_SUPABASE_URL` | No — it is in every page |
| `anon` / publishable key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | No — bounded by RLS |
| `service_role` / secret key | `SUPABASE_SERVICE_ROLE_KEY` | **Yes.** Bypasses RLS entirely |

From **Project Settings → Database → Connection string → URI** (session mode,
port 5432), the connection string for applying migrations. It contains the
database password, so treat it as a secret.

Put them in `ramosmax-web/.env.local`, which is gitignored:

```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SUPABASE_DB_URL=postgres://postgres:<password>@db.<ref>.supabase.co:5432/postgres
```

**The service-role key must never be prefixed `NEXT_PUBLIC_`** and must never
be imported by a Client Component. `scripts/check-performance.mjs` fails the
build if it ever appears in a browser chunk.

## 3. What happens next, in order

```bash
cd ramosmax-web

# 1. Apply every migration to the hosted project, in order.
node scripts/apply-migrations.mjs            # uses SUPABASE_DB_URL

# 2. Verify the platform integration.
node scripts/check-supabase.mjs              # uses the three NEXT_PUBLIC/service vars
```

`scripts/check-supabase.mjs` is the gate. It checks, against the real project:

| # | What it proves |
|---|---|
| 1 | Every migration applied, and the schema matches the local one table for table, function for function |
| 2 | PostgREST can call each allow-listed RPC **by name with named arguments**, which is how the application calls them in production |
| 3 | PostgREST **refuses** every function that is not allow-listed |
| 4 | The `anon` role can read nothing at all |
| 5 | GoTrue sign-in works, and the JWT it issues carries the `sub` the RLS policies read |
| 6 | RLS applies to a PostgREST query made with a user's token, exactly as it does locally |
| 7 | `@supabase/ssr` cookie handling round-trips a session through a Server Component |
| 8 | A `bigint` money column arrives as a JSON number, not a string, over PostgREST |
| 9 | Connection pooling (PgBouncer, transaction mode, port 6543) does not break the `SECURITY DEFINER` functions or the `request.jwt.claims` the policies depend on |
| 10 | `pg_cron` (or an external scheduler) can reach the sweeps and the notification delivery endpoint |

Until that script has been run against a real project and passed, **no part of
this system may be described as production-ready**, and the final report says
so in those words.

## 4. What I will NOT ask you for

- Your Supabase account password.
- Your production project's keys.
- Any production data, or a copy of it.

Verification needs a **development** project and nothing else.
