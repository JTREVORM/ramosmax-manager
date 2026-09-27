#!/usr/bin/env node
/**
 * HOSTED SUPABASE VERIFICATION.
 *
 * Everything else in this repository is proved against a local PostgreSQL
 * database that emulates the Supabase platform. This script is the only thing
 * that proves the PLATFORM: PostgREST, GoTrue, @supabase/ssr, the pooler and
 * the scheduler.
 *
 * Until it has run against a real development project and passed, nothing here
 * may be called production-ready.
 *
 * Usage (see docs/SUPABASE_SETUP.md):
 *   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_DB_URL=... \
 *     node scripts/check-supabase.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.SUPABASE_DB_URL;
const POOLED_URL = process.env.SUPABASE_POOLED_URL;
const TEST_PHONE = process.env.SUPABASE_TEST_PHONE ?? '0772000001';
const TEST_PASSWORD = process.env.SUPABASE_TEST_PASSWORD ?? 'DevP@ssw0rd!';

if (!URL_ || !ANON || !SERVICE) {
  console.error(
    '\n  Hosted Supabase verification has not been run.\n\n' +
    '  It needs a DEVELOPMENT Supabase project. Set:\n' +
    '    NEXT_PUBLIC_SUPABASE_URL\n' +
    '    NEXT_PUBLIC_SUPABASE_ANON_KEY\n' +
    '    SUPABASE_SERVICE_ROLE_KEY\n' +
    '    SUPABASE_DB_URL           (for the schema comparison)\n' +
    '    SUPABASE_POOLED_URL       (optional: port 6543, to test the pooler)\n\n' +
    '  See docs/SUPABASE_SETUP.md for exactly what to create and where each\n' +
    '  value is found. Your Supabase account password is never needed.\n',
  );
  process.exit(2);
}

let failures = 0;
const check = (passed, message, detail) => {
  if (passed) console.log(`    ok    ${message}`);
  else {
    failures += 1;
    console.error(`    FAIL  ${message}${detail ? `\n          ${detail}` : ''}`);
  }
};

const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
const service = createClient(URL_, SERVICE, { auth: { persistSession: false } });

const connect = async (url) => {
  const client = new pg.Client({
    connectionString: url,
    ssl: /supabase\.(co|com)/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  return client;
};

// ---------------------------------------------------------------------------
console.log('\n  1. the schema is the one in this repository');
{
  if (!DB_URL) {
    check(false, 'SUPABASE_DB_URL is set', 'Needed to compare the schema.');
  } else {
    const remote = await connect(DB_URL);
    const local = await connect(
      process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev');
    try {
      const files = readdirSync(join(root, 'supabase/migrations'))
        .filter((f) => f.endsWith('.sql')).sort();
      const { rows: applied } = await remote.query(
        `select filename from app.schema_migrations order by filename`);
      check(applied.length === files.length,
        `every migration is applied (${applied.length} of ${files.length})`,
        applied.length === files.length ? undefined
          : `missing: ${files.filter((f) => !applied.some((a) => a.filename === f)).join(', ')}`);

      const shape = async (client, sql) => (await client.query(sql)).rows.map((r) => Object.values(r).join('.'));
      const TABLES = `select table_name from information_schema.tables
                       where table_schema = 'public' and table_type = 'BASE TABLE'
                       order by table_name`;
      const FUNCTIONS = `select p.proname, pg_get_function_identity_arguments(p.oid)
                           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'app' order by 1, 2`;
      const POLICIES = `select schemaname, tablename, policyname from pg_policies
                         where schemaname = 'public' order by 1, 2, 3`;

      for (const [label, sql] of [['tables', TABLES], ['functions', FUNCTIONS],
        ['policies', POLICIES]]) {
        const [a, b] = [await shape(remote, sql), await shape(local, sql)];
        const missing = b.filter((x) => !a.includes(x));
        const extra = a.filter((x) => !b.includes(x));
        check(missing.length === 0 && extra.length === 0,
          `${label} match the local database (${b.length})`,
          [missing.length ? `missing there: ${missing.slice(0, 5).join(', ')}` : '',
            extra.length ? `only there: ${extra.slice(0, 5).join(', ')}` : ''].filter(Boolean).join('; '));
      }

      const { rows: rls } = await remote.query(`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
      check(rls.length === 0, 'row level security is enabled on every public table',
        rls.map((r) => r.relname).join(', '));
    } finally {
      await remote.end();
      await local.end();
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n  2. PostgREST exposes the allow-list, and only the allow-list');
{
  // The whole browser-callable surface, taken from the migrations themselves.
  const granted = new Set();
  for (const file of readdirSync(join(root, 'supabase/migrations')).sort()) {
    const sql = readFileSync(join(root, 'supabase/migrations', file), 'utf8');
    for (const block of sql.split(/grant execute on function/i).slice(1)) {
      const list = block.split(/to\s+authenticated\s*;/i)[0];
      for (const match of list.matchAll(/app\.([a-z_0-9]+)\s*\(/g)) granted.add(match[1]);
    }
  }
  check(granted.size > 100, `${granted.size} functions are on the allow-list`);

  // A function that is NOT on it must be refused by PostgREST, whatever the
  // caller knows its name to be.
  const { error: hidden } = await service.schema('app').rpc('notify', {
    p_recipient: '00000000-0000-4000-8000-000000000001', p_type: 'attendance_review',
  });
  check(Boolean(hidden), 'a function that is not allow-listed is refused by PostgREST',
    hidden ? undefined : 'app.notify answered a PostgREST call');

  // A read-only one that IS on it must work, by name, with named arguments.
  const { data: policy, error: policyError } = await service.schema('app').rpc(
    'after_hours_policy');
  check(!policyError && policy, 'an allow-listed function answers a named-argument call',
    policyError?.message);
}

// ---------------------------------------------------------------------------
console.log('\n  3. anon reads nothing');
{
  const tables = ['users', 'customers', 'invoices', 'payments', 'financial_accounts',
    'shareholders', 'cash_handovers', 'notifications', 'push_subscriptions'];
  for (const table of tables) {
    const { data, error } = await anon.from(table).select('*').limit(1);
    check((data ?? []).length === 0, `anon reads nothing from ${table}`,
      error ? undefined : `returned ${(data ?? []).length} row(s)`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n  4. GoTrue signs somebody in, and RLS applies to their token');
{
  // RamosMAX signs in by phone number; the identity GoTrue holds is the
  // generated .invalid address, which app.sign_in_identity_for_phone resolves.
  const { data: identity, error: identityError } = await service.schema('app')
    .rpc('sign_in_identity_for_phone', { p_phone: TEST_PHONE });
  check(!identityError && identity, `the sign-in identity for ${TEST_PHONE} resolves`,
    identityError?.message ?? 'no identity — has the development seed been applied?');

  if (identity) {
    const { data: session, error: signInError } = await anon.auth.signInWithPassword({
      email: identity, password: TEST_PASSWORD,
    });
    check(!signInError && session?.session?.access_token, 'GoTrue issues a session',
      signInError?.message);

    if (session?.session?.access_token) {
      const token = session.session.access_token;
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      check(Boolean(claims.sub), 'the token carries the sub the RLS policies read');

      const asUser = createClient(URL_, ANON, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      });

      const { data: mine } = await asUser.from('users').select('id, full_name').limit(50);
      check((mine ?? []).length > 0, 'a signed-in user reads what their policies allow');

      // A money column must arrive as a NUMBER over PostgREST, not a string.
      const { data: accounts } = await asUser.from('financial_accounts')
        .select('code, balance_ugx').limit(1);
      if ((accounts ?? []).length > 0) {
        check(typeof accounts[0].balance_ugx === 'number',
          'a bigint money column arrives as a JSON number',
          `got ${typeof accounts[0].balance_ugx}`);
      } else {
        check(false, 'a bigint money column arrives as a JSON number',
          'no account was readable to check');
      }

      // And the tables that are closed stay closed for a real user token.
      const { data: subs } = await asUser.from('push_subscriptions').select('*').limit(1);
      check((subs ?? []).length === 0, 'the closed tables stay closed to a user token');

      await anon.auth.signOut();
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n  5. the pooler does not break the functions');
{
  if (!POOLED_URL) {
    check(false, 'SUPABASE_POOLED_URL is set (port 6543, transaction mode)',
      'Skipped: set it to prove the application works through PgBouncer.');
  } else {
    const pooled = await connect(POOLED_URL);
    try {
      // SECURITY DEFINER functions and the request.jwt.claims the policies read
      // must survive transaction-mode pooling, where a connection is shared.
      await pooled.query('begin');
      await pooled.query(
        `select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: '00000000-0000-4000-8000-000000000001', role: 'authenticated' })]);
      await pooled.query('set local role authenticated');
      const { rows } = await pooled.query(`select app.has_permission('finance.view') as ok`);
      await pooled.query('commit');
      check(rows[0].ok === true, 'a permission check works through the pooler');

      // And the claim must NOT survive into the next transaction.
      const { rows: after } = await pooled.query(
        `select current_setting('request.jwt.claims', true) as claims`);
      check(!after[0].claims, 'the claims do not leak into the next transaction on that connection');
    } finally {
      await pooled.end();
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n  6. the scheduled work can be reached');
{
  const { error: sweepError } = await service.schema('app').rpc('sweep_after_hours');
  check(!sweepError, 'the after-hours sweep can be run by the service role', sweepError?.message);

  const { error: deliverError } = await service.schema('app').rpc('deliver_events', {
    p_limit: 1,
  });
  check(Boolean(deliverError),
    'the delivery function is NOT reachable through PostgREST',
    deliverError ? undefined : 'app.deliver_events answered a PostgREST call');

  const { rows: cron } = DB_URL
    ? await (async () => {
        const client = await connect(DB_URL);
        try {
          return await client.query(
            `select extname from pg_extension where extname = 'pg_cron'`);
        } finally {
          await client.end();
        }
      })()
    : { rows: [] };
  console.log(
    cron.length > 0
      ? '    note  pg_cron is installed; the sweeps can be scheduled in the database'
      : '    note  pg_cron is not installed; schedule the sweeps externally '
        + '(POST /api/notifications/deliver)',
  );
}

console.log(
  failures === 0
    ? '\nHosted Supabase verification PASSED. The platform integration is proved.'
    : `\n${failures} hosted Supabase check(s) failed. The platform integration is NOT proved.`,
);
process.exit(failures === 0 ? 0 : 1);
