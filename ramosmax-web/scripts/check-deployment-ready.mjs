#!/usr/bin/env node
/**
 * IS THIS PROJECT READY TO DEPLOY AGAINST?
 *
 * Read-only. It changes nothing, and it prints no secret — only whether each
 * value is present and whether the thing it unlocks actually works.
 *
 * It answers the question "what is still required?" for a FIRST DEVELOPMENT
 * DEPLOYMENT, and it is deliberately narrower than
 * `scripts/check-supabase.mjs`, which is the full certification gate and needs
 * a seeded project. This one runs against an empty one.
 *
 * Usage (values from your own shell or .env.local — never committed):
 *   DATABASE_URL='postgresql://postgres.<ref>:...@...pooler.supabase.com:6543/postgres' \
 *   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/check-deployment-ready.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DB = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;

let failures = 0;
let advisories = 0;
const check = (passed, message, detail) => {
  if (passed) console.log(`    ok      ${message}`);
  else {
    failures += 1;
    console.error(`    MISSING ${message}${detail ? `\n            ${detail}` : ''}`);
  }
};
const note = (message) => {
  advisories += 1;
  console.log(`    later   ${message}`);
};

// ---------------------------------------------------------------------------
console.log('\n  1. the values a deployment needs');
check(Boolean(DB), 'DATABASE_URL',
  'Supabase → Connect → Transaction pooler. Port 6543, not the direct 5432 string.');
check(Boolean(URL_), 'NEXT_PUBLIC_SUPABASE_URL', 'Supabase → Project Settings → API → Project URL.');
check(Boolean(ANON), 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'Same page → anon public key.');
check(Boolean(SERVICE), 'SUPABASE_SERVICE_ROLE_KEY', 'Same page → service_role key. SECRET.');
check(Boolean(SESSION_SECRET), 'SESSION_SECRET',
  'Any long random string: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');

if (DB && /:6543\//.test(DB)) {
  console.log('    ok      DATABASE_URL uses the pooler (6543)');
} else if (DB) {
  note('DATABASE_URL is not the pooled (6543) string — a serverless deployment will exhaust the direct endpoint');
}
if (DB && /^postgres(ql)?:\/\/postgres:/.test(DB) && !/pooler/.test(DB)) {
  note('DATABASE_URL looks like the DIRECT connection string');
}

if (!DB) {
  console.error('\n  Without DATABASE_URL nothing further can be checked.\n');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: DB,
  ssl: /supabase\.(co|com)/.test(DB) ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

try {
  // -------------------------------------------------------------------------
  console.log('\n  2. the schema');
  const expected = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));
  const { rows: record } = await client.query(
    `select to_regclass('app.schema_migrations') is not null as present`);
  if (!record[0].present) {
    // `npm run db:reset` builds a local database without keeping a record;
    // only `apply-migrations.mjs` writes one, and only it needs to.
    note('no migration record on this database — it was not built by scripts/apply-migrations.mjs');
  } else {
    const { rows: applied } = await client.query(
      `select filename from app.schema_migrations order by filename`);
    const missing = expected.filter((f) => !applied.some((r) => r.filename === f));
    check(missing.length === 0,
      `all ${expected.length} migrations applied (${applied.length} on record)`,
      missing.length > 0
        ? `Run: node scripts/apply-migrations.mjs\n            Missing: ${missing.join(', ')}`
        : undefined);
  }

  const { rows: counts } = await client.query(`
    select (select count(*) from pg_tables where schemaname = 'public') as tables,
           (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r'
               and (not c.relrowsecurity or not c.relforcerowsecurity)) as unprotected,
           (select count(*) from information_schema.role_table_grants
             where grantee = 'authenticated' and table_schema = 'public'
               and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')) as writes,
           (select count(*) from information_schema.role_table_grants
             where grantee = 'anon' and table_schema in ('public','app')) as anon_grants,
           (select count(*) from app.permissions) as permissions`);
  const c = counts[0];
  check(Number(c.unprotected) === 0,
    `RLS enabled and forced on every one of the ${c.tables} tables`,
    `${c.unprotected} table(s) are not protected`);
  check(Number(c.writes) === 0, 'a signed-in session holds no write grant on any table',
    `${c.writes} write grant(s) found`);
  check(Number(c.anon_grants) === 0, 'anon holds nothing', `${c.anon_grants} grant(s) found`);
  check(Number(c.permissions) === 127, `all 127 permissions are in the catalogue (${c.permissions})`);

  // -------------------------------------------------------------------------
  console.log('\n  3. the mechanism every page read depends on');
  // Reading as the caller: take the `authenticated` role, set the same claims
  // PostgREST would, and confirm RLS is then in charge — and that nothing
  // carries into the next transaction on a shared connection.
  await client.query('begin');
  await client.query(`select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: '00000000-0000-0000-0000-000000000000', role: 'authenticated' })]);
  await client.query('set local role authenticated');
  const { rows: asUser } = await client.query(
    `select current_user as role, app.has_permission('finance.view') as permitted`);
  await client.query('commit');
  check(asUser[0].role === 'authenticated', 'the connection can drop to the authenticated role');
  check(asUser[0].permitted === false,
    'and an unknown caller is refused (RLS and the permission checks are live)');

  const { rows: leaked } = await client.query(
    `select current_user as role, current_setting('request.jwt.claims', true) as claims`);
  check(!leaked[0].claims && leaked[0].role !== 'authenticated',
    'nothing carries into the next transaction on that connection');

  // -------------------------------------------------------------------------
  console.log('\n  4. sign-in');
  // Resolving a phone number to its hidden identity reads auth.users from a
  // SECURITY DEFINER function. If this connection cannot see that table, no
  // password can ever be checked.
  let authReadable = true;
  try {
    await client.query(`select app.sign_in_identity_for_phone('0772000000')`);
  } catch (e) {
    authReadable = false;
    check(false, 'the hidden sign-in identity can be resolved', e.message);
  }
  if (authReadable) check(true, 'the hidden sign-in identity can be resolved (auth.users is readable)');

  const { rows: admins } = await client.query(
    `select count(*)::int as n from public.users where role = 'admin'`);
  const { rows: people } = await client.query(`select count(*)::int as n from public.users`);
  if (Number(admins[0].n) > 0) {
    check(true, `an administrator exists (${admins[0].n} of ${people[0].n} account(s))`);
  } else {
    check(false, 'a first administrator exists',
      'Run: NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_DB_URL=... \\\n' +
      '              node scripts/bootstrap-admin.mjs "0772123456" "Their Name"');
  }

  // -------------------------------------------------------------------------
  console.log('\n  5. storage');
  const { rows: storage } = await client.query(
    `select exists (select 1 from information_schema.schemata
                     where schema_name = 'storage') as present`);
  if (!storage[0].present) {
    note('no storage schema on this database — evidence uploads are a later feature');
  } else {
    const { rows: buckets } = await client.query(
      `select id, public from storage.buckets
        where id in ('finance_uploads', 'payroll_uploads', 'staff') order by id`);
    for (const wanted of ['finance_uploads', 'payroll_uploads', 'staff']) {
      const found = buckets.find((b) => b.id === wanted);
      if (!found) {
        note(`bucket "${wanted}" does not exist — evidence uploads are a later feature; ` +
             'node scripts/apply-migrations.mjs creates it');
      } else {
        check(found.public === false, `bucket "${wanted}" exists and is private`,
          'IT IS PUBLIC. Make it private: Storage → the bucket → Settings → Public off.');
      }
    }
    const { rows: policies } = await client.query(
      `select count(*)::int as n from pg_policies
        where schemaname = 'storage' and tablename = 'objects'`);
    if (Number(policies[0].n) > 0) {
      note(`${policies[0].n} policy/policies exist on storage.objects — ` +
           'these buckets are meant to answer the service role only; check nothing grants anon or authenticated');
    } else {
      check(true, 'no policy grants a browser direct access to any bucket');
    }
  }

  // -------------------------------------------------------------------------
  console.log('\n  6. the credential store');
  if (!URL_ || !SERVICE) {
    check(false, 'Supabase Auth can be reached', 'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  } else {
    const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
    const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
    check(!error, 'Supabase Auth answers the service-role key', error?.message);
  }
  if (URL_ && ANON) {
    const browser = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error } = await browser.auth.signInWithPassword({
      email: 'nobody@users.ramosmax.invalid', password: 'not-a-password',
    });
    check(Boolean(error), 'and refuses a credential that does not exist',
      error ? undefined : 'it accepted one, which cannot be right');
  }

  // -------------------------------------------------------------------------
  console.log('\n  7. optional, and safe to add later');
  if (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    console.log('    ok      Web Push is configured');
  } else {
    note('no VAPID keys — the in-app inbox works and notices wait to be read; no push is sent');
  }
  if (process.env.NOTIFICATION_CRON_SECRET) {
    console.log('    ok      notification delivery is configured');
  } else {
    note('no NOTIFICATION_CRON_SECRET — /api/notifications/deliver answers 503 until a scheduler exists');
  }
} finally {
  await client.end();
}

console.log(
  failures === 0
    ? `\n  Ready to deploy.${advisories > 0 ? ` ${advisories} thing(s) noted for later.` : ''}\n`
    : `\n  ${failures} thing(s) still required before this project can be deployed against.\n`,
);
process.exit(failures === 0 ? 0 : 1);
