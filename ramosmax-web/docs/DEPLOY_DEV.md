# Deploying the development system

Getting from "the migrations are applied" to "I can sign in and test".

This is a **development** deployment against a **development** Supabase
project. It is not production, it does not touch Firebase, and nothing here
migrates any data.

---

## 1. What the application needs, and why

Two things are decided separately, and it is worth knowing which is which
before setting anything.

**Where the data is read.** `DATABASE_URL`, a PostgreSQL connection to the
Supabase project. Every read the application makes is SQL — the joins,
aggregates and window functions that the reports, the ledger and the ownership
history are built from — so it speaks to PostgreSQL rather than to PostgREST.
That changes nothing about who may see what: each request opens a transaction,
takes the `authenticated` role and sets the same `request.jwt.claims` PostgREST
would, so RLS decides what comes back exactly as it would for a direct client
query, and the connection has no more authority than the person using it. The
transaction is also what makes the pooler safe — `SET LOCAL` ends with it, so a
connection handed to the next request carries nothing over.

**Where passwords live.** `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. With these
set, credentials are Supabase Auth's. Sign-in is unchanged from the reference:
a phone number, throttled; resolved to a hidden identity on the reserved
`.invalid` domain that nobody types or sees; the password checked against that
identity; and then the PROFILE decides whether the person may in.

The service-role key reaches only the credential store. It is never given to a
browser: the modules that hold it import `server-only`, so a build that tried
to ship one would fail rather than succeed quietly.

## 2. What is still required after migrations 0001–0055

| | Required now | Why |
|---|---|---|
| `DATABASE_URL` | **Yes** | Nothing reads or writes without it |
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | No credential store without it |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Yes** | Used to verify a password |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Creating identities, setting passwords, ending sessions |
| `SESSION_SECRET` | **Yes** | Signs the session cookie; a production build with a Supabase project refuses to start without one |
| The first administrator | **Yes** | Nobody can sign in otherwise |
| Storage buckets | Created by `0054` | Only needed when evidence upload is built |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Later | Without them the in-app inbox works and notices wait |
| `NOTIFICATION_CRON_SECRET` + a scheduler | Later | Without it notices are written but not delivered or pushed |
| Edge Functions | Never | There are none, and none is planned |
| `pg_cron` | Later | The sweeps are reachable over HTTP; nothing needs the database to schedule itself |

Run this to see where a project actually stands. It is read-only and prints no
secret:

```bash
node scripts/check-deployment-ready.mjs
```

## 3. The first administrator

`app.create_user` requires `users.create`, which only an administrator holds,
so on a new project that door cannot be the first one used. `0055` adds the one
other door, `app.bootstrap_first_admin`, and it can be used exactly once: it
refuses the moment any administrator exists, deactivated or not, and it is not
callable by a browser at all.

It is not a bypass. It writes the same row `app.create_user` writes — active,
password set, `must_change_password` true — and the same audit entry, marked
`bootstrap` so the trail shows this was the installation rather than an
ordinary creation.

```bash
cd ramosmax-web
export NEXT_PUBLIC_SUPABASE_URL='https://<ref>.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='...'          # from your own notes, not from here
export SUPABASE_DB_URL='postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres'

node scripts/bootstrap-admin.mjs "0772123456" "Their Full Name" RMX-STF-0001
```

It prints the phone number and a generated password **once**. The password is
not stored anywhere it can be read again. Signing in with it lands on the
change-password screen, which is the only thing that account can do until the
password is replaced — exactly as for anyone created later from User
management.

If the password is lost before it is used: delete that user under
Authentication → Users, delete the matching row in `public.users`, and run the
script again.

## 4. Storage

Three buckets, all **private**, created by migration `0054`:
`finance_uploads`, `payroll_uploads`, `staff`.

They grant nothing to `anon` or `authenticated`, and that is deliberate. In the
reference a storage rule can read the caller's profile, because the caller
holds a Firebase identity. Here a person holds a RamosMAX session cookie and no
Supabase token of their own, so `auth.uid()` is null for anything a browser
sends straight to Storage — a policy written in terms of it would either deny
everyone or, written carelessly, allow everyone. So the only way in is the
application server, which checks the permission first and then records the path
through `app.attach_evidence`, the function that enforces the path shape and
that evidence is never replaced and never removed.

That is stricter than the reference, not weaker. No screen offers an upload
yet; when one does, it will go through the server.

## 5. Vercel

The repository root is the Flutter reference. **The Next.js application is in
`ramosmax-web/`**, and Vercel has to be told so — this is the one setting that
will otherwise waste an afternoon.

Deploy the branch as a **Preview**, not as Production: leave the production
branch as `main` and push `claude/gifted-cerf-mfgdcx`. Vercel builds it and
gives it its own URL. Set the environment variables for the **Preview**
environment, or the build will have none of them.

Nothing in the build touches the database: every page is rendered per request,
so a build succeeds before the first administrator exists.

## 6. Checking it worked

1. Open the Preview URL. The sign-in page loads.
2. Sign in with the phone number and the generated password.
3. You land on the change-password screen. Nothing else is reachable until you
   change it.
4. Change it. You land on the dashboard with every Administrator menu.
5. Go to User management and create a second person — that is the ordinary
   door, and it working is the proof the bootstrap was only ever a first step.

If the sign-in page loads but signing in fails with a message about the
connection, `DATABASE_URL` is wrong or not the pooled string. If it fails with
"Incorrect phone number or password", the credential and the profile have got
out of step — run `node scripts/check-deployment-ready.mjs`, which says which.

## 7. What this does not do

Hosted certification — `scripts/check-supabase.mjs`, the ten platform checks
and the local-versus-hosted schema comparison — is untouched and still to be
run before anything is called production-ready. It needs a seeded project, so
it belongs after testing rather than before it. `docs/GO_LIVE.md` is the gate,
and `docs/CUTOVER.md` is the migration plan, prepared and not executed.
