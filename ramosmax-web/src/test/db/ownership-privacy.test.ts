import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, makeUser, SEED } from './harness';
import {
  autoPost, issue, openDay, ownAccount, requestId, shareClass, shareholder, testClassCode, ugx,
} from './ownership-helpers';

afterAll(closePool);

/**
 * OWNERSHIP IS PRIVATE, AND THE RULES ARE BELOW THE UI.
 *
 * Every query here is sent directly to the tables as a signed-in session — no
 * route, no screen, no server function. A rule only the interface enforces is
 * not a rule.
 *
 * The two that matter most:
 *   * a SHAREHOLDER may not read the register at all, not even their own row;
 *   * a MANAGER with `shareholders.reports.view` sees TOTALS, never contact
 *     details or identification.
 */

async function scene(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) {
  const classId = await shareClass(db, testClassCode(), 100_000);
  await autoPost(db);
  const account = await ownAccount(db, 500_000_000);
  const john = await shareholder(db, 'John Owner', '0772900001');
  const mary = await shareholder(db, 'Mary Owner', '0772900002');
  const day = await openDay(db);
  await issue(db, { shareholder: john, classId, shares: 60, account, amount: 6_000_000, effective: day });
  await issue(db, { shareholder: mary, classId, shares: 40, account, amount: 4_000_000, effective: day });

  // John signs in and is linked to his own record.
  const johnUid = await makeUser(db, { role: 'shareholder' });
  await becomeClient(db, SEED.admin);
  await db.query(`select app.link_shareholder_account($1, $2)`, [john, johnUid]);
  await becomeOwner(db);
  return { account, john, mary, johnUid, classId, day };
}

const OWNERSHIP_TABLES = [
  'shareholders', 'share_classes', 'shareholdings', 'share_transactions',
  'share_contributions', 'dividends', 'dividend_allocations',
];

describe('privacy: a shareholder', () => {
  it('reads NOTHING from any ownership table — not even their own row', async () => {
    await asAdminDb(async (db) => {
      const { johnUid } = await scene(db);
      await becomeClient(db, johnUid);
      for (const table of OWNERSHIP_TABLES) {
        const { rows } = await db.query<{ n: string }>(
          `select count(*)::text as n from public.${table}`);
        expect(Number(rows[0].n), table).toBe(0);
      }
      // Nor through the register views.
      for (const view of ['share_register', 'share_register_totals']) {
        const { rows } = await db.query<Record<string, string>>(`select * from public.${view}`);
        if (view === 'share_register') expect(rows).toHaveLength(0);
        else expect(Number(rows[0].total_shares ?? 0)).toBe(0);
      }
    });
  });

  it('gets their OWN record from the self-service function, and only that', async () => {
    await asAdminDb(async (db) => {
      const { johnUid } = await scene(db);
      await becomeClient(db, johnUid);
      const { rows } = await db.query<{ my_shareholding: Record<string, unknown> }>(
        `select app.my_shareholding() as my_shareholding`);
      const mine = rows[0].my_shareholding;
      expect(mine.linked).toBe(true);
      const profile = mine.shareholder as Record<string, unknown>;
      expect(profile.fullName).toBe('John Owner');
      expect(ugx(profile.totalShares)).toBe(60);
      // The percentage is across every class, so it depends on what else the
      // register holds; what matters here is that it is THEIR figure.
      expect(ugx(profile.ownershipPercent)).toBeGreaterThan(0);
      // Their own holdings and contributions, and nobody else's.
      expect((mine.holdings as unknown[]).length).toBe(1);
      expect((mine.contributions as unknown[]).length).toBe(1);
      expect(JSON.stringify(mine)).not.toContain('Mary Owner');
    });
  });

  it('never learns the other party to their own transfer', async () => {
    await asAdminDb(async (db) => {
      const { john, mary, johnUid, classId } = await scene(db);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.transfer_shares($1, $2, '${classId}', 10, 'Sale', $3)`,
        [john, mary, requestId('sale')]);
      await becomeClient(db, johnUid);
      const { rows } = await db.query<{ my_shareholding: Record<string, unknown> }>(
        `select app.my_shareholding() as my_shareholding`);
      const transactions = rows[0].my_shareholding.transactions as Array<Record<string, unknown>>;
      const transfer = transactions.find((t) => t.type === 'shares_transferred')!;
      expect(transfer.deltaShares).toBe(-10);
      expect(JSON.stringify(transactions)).not.toContain('Mary Owner');
    });
  });

  it('is told nothing when their sign-in is not linked', async () => {
    await asAdminDb(async (db) => {
      await scene(db);
      const stranger = await makeUser(db, { role: 'shareholder' });
      await becomeClient(db, stranger);
      const { rows } = await db.query<{ my_shareholding: Record<string, unknown> }>(
        `select app.my_shareholding() as my_shareholding`);
      expect(rows[0].my_shareholding).toEqual({ linked: false });
    });
  });

  it('sees only approved or paid dividends of their own', async () => {
    await asAdminDb(async (db) => {
      const { john, johnUid, account, classId, day } = await scene(db);
      const { rows: record } = await db.query<{ d: string }>(`select $1::text as d`, [day]);
      await becomeClient(db, SEED.admin);
      const { rows: dividend } = await db.query<{ dividend_id: string }>(
        `select * from app.create_dividend('FY2026', $1::date, $2, 'pool', 1000000,
                                           null, null, null, $3)`,
        [record[0].d, requestId('div'), classId]);
      await db.query(`select * from app.calculate_dividend($1)`, [dividend[0].dividend_id]);
      await becomeClient(db, johnUid);

      // Calculated but not declared: invisible.
      let { rows } = await db.query<{ my_shareholding: Record<string, unknown> }>(
        `select app.my_shareholding() as my_shareholding`);
      expect((rows[0].my_shareholding.dividends as unknown[]).length).toBe(0);

      await becomeClient(db, SEED.admin);
      await db.query(`select app.update_dividend_status($1, 'declare')`, [dividend[0].dividend_id]);
      await db.query(`select app.update_dividend_status($1, 'approve')`, [dividend[0].dividend_id]);
      await becomeClient(db, johnUid);
      ({ rows } = await db.query<{ my_shareholding: Record<string, unknown> }>(
        `select app.my_shareholding() as my_shareholding`));
      const dividends = rows[0].my_shareholding.dividends as Array<Record<string, unknown>>;
      expect(dividends).toHaveLength(1);
      expect(ugx(dividends[0].netUgx)).toBe(600_000);
      expect(john).toBeTruthy();
      expect(account).toBeTruthy();
    });
  });

  it('cannot call any ownership command', async () => {
    await asAdminDb(async (db) => {
      const { john, johnUid, account, classId } = await scene(db);
      await becomeClient(db, johnUid);
      for (const [sql, params] of [
        [`select * from app.issue_shares($1, '${classId}', 1, $2, null, 'account', 100000, $3)`,
         [john, requestId('x'), account]],
        [`select * from app.transfer_shares($1, $1, '${classId}', 1, 'Mine', $2)`, [john, requestId('y')]],
        [`select * from app.ownership_as_of(app.eat_day())`, []],
        [`select * from app.create_shareholder('Me', $1)`, [requestId('z')]],
      ] as Array<[string, unknown[]]>) {
        expect(await db.denied(sql, params), sql.slice(0, 40)).toBe(true);
      }
    });
  });
});

describe('privacy: a manager with workforce and shareholder reporting', () => {
  const reporter = (db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) =>
    makeUser(db, {
      role: 'manager',
      permissions: ['shareholders.reports.view'],
      deniedPermissions: ['shareholders.view', 'shares.view', 'dividends.view'],
    });

  it('sees register totals and the ownership distribution', async () => {
    await asAdminDb(async (db) => {
      await scene(db);
      const uid = await reporter(db);
      await becomeClient(db, uid);
      const { rows } = await db.query<Record<string, string>>(
        `select * from public.share_register_totals`);
      expect(ugx(rows[0].total_shares)).toBeGreaterThanOrEqual(100);
      expect(Number(rows[0].holder_count)).toBeGreaterThanOrEqual(2);
      const { rows: holders } = await db.query<Record<string, string>>(
        `select * from public.share_register where shareholder_name in ('John Owner', 'Mary Owner')
          order by total_shares desc`);
      expect(holders.map((h) => h.shareholder_name)).toEqual(['John Owner', 'Mary Owner']);
      expect(holders.map((h) => ugx(h.total_shares))).toEqual([60, 40]);
    });
  });

  it('gets NO contact detail or identification from the register', async () => {
    await asAdminDb(async (db) => {
      await scene(db);
      const uid = await reporter(db);
      await becomeClient(db, uid);
      const { rows } = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'share_register'`);
      const columns = rows.map((r) => r.column_name);
      for (const hidden of ['phone_number', 'email', 'address', 'id_type', 'id_number', 'notes',
                            'linked_uid']) {
        expect(columns, hidden).not.toContain(hidden);
      }
      // And the base table stays closed to them.
      const { rows: base } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.shareholders`);
      expect(Number(base[0].n)).toBe(0);
    });
  });

  it('cannot reach identity by a join, a view or an RPC', async () => {
    await asAdminDb(async (db) => {
      const { john, classId } = await scene(db);
      const uid = await reporter(db);
      await becomeClient(db, uid);
      // A join to the base table returns nothing, because RLS is per table.
      const { rows: joined } = await db.query(`
        select r.shareholder_name, s.phone_number
          from public.share_register r join public.shareholders s on s.id = r.shareholder_id`);
      expect(joined).toHaveLength(0);
      // The ledger, holdings, contributions and allocations are all closed.
      for (const table of ['shareholdings', 'share_transactions', 'share_contributions',
                           'dividend_allocations']) {
        const { rows } = await db.query<{ n: string }>(
          `select count(*)::text as n from public.${table}`);
        expect(Number(rows[0].n), table).toBe(0);
      }
      // And the self-service function returns nothing, because they are not a
      // linked shareholder.
      expect(await db.denied(`select app.my_shareholding()`)).toBe(true);
      expect(await db.denied(`select * from app.ownership_as_of(app.eat_day())`)).toBe(false);
      const { rows: asOf } = await db.query<{ shareholder_name: string }>(
        `select * from app.ownership_as_of(app.eat_day(), $1)`, [classId]);
      // Ownership-as-of is register data: names, shares, percentages, no contacts.
      expect(asOf.map((r) => r.shareholder_name).sort()).toEqual(['John Owner', 'Mary Owner']);
      expect(john).toBeTruthy();
    });
  });

  it('sees dividend headers but no individual allocation', async () => {
    await asAdminDb(async (db) => {
      const { classId, day } = await scene(db);
      const { rows: record } = await db.query<{ d: string }>(`select $1::text as d`, [day]);
      await becomeClient(db, SEED.admin);
      const { rows: dividend } = await db.query<{ dividend_id: string }>(
        `select * from app.create_dividend('FY2026', $1::date, $2, 'pool', 1000000,
                                           null, null, null, $3)`,
        [record[0].d, requestId('div2'), classId]);
      await db.query(`select * from app.calculate_dividend($1)`, [dividend[0].dividend_id]);
      await becomeOwner(db);

      const uid = await reporter(db);
      await becomeClient(db, uid);
      const { rows: headers } = await db.query<{ allocated_ugx: string }>(
        `select allocated_ugx from public.dividends where class_id = $1`, [classId]);
      expect(headers).toHaveLength(1);
      expect(ugx(headers[0].allocated_ugx)).toBe(1_000_000);
      const { rows: allocations } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.dividend_allocations`);
      expect(Number(allocations[0].n), 'no individual allocation').toBe(0);
    });
  });
});

describe('privacy: everyone else', () => {
  it('gives a cashier and a worker nothing at all', async () => {
    await asAdminDb(async (db) => {
      await scene(db);
      for (const uid of [SEED.cashier, SEED.worker]) {
        await becomeClient(db, uid);
        for (const table of [...OWNERSHIP_TABLES, 'share_register']) {
          const { rows } = await db.query<{ n: string }>(
            `select count(*)::text as n from public.${table}`);
          expect(Number(rows[0].n), `${uid} ${table}`).toBe(0);
        }
      }
    });
  });

  it('gives an auditor the whole record, read-only', async () => {
    await asAdminDb(async (db) => {
      const { john, classId } = await scene(db);
      await becomeClient(db, SEED.auditor);
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.shareholders
          where full_name in ('John Owner', 'Mary Owner')`);
      expect(Number(rows[0].n)).toBe(2);
      const { rows: ledger } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.share_transactions where class_id = $1`, [classId]);
      expect(Number(ledger[0].n)).toBe(2);
      expect(await db.denied(
        `update public.shareholders set full_name = 'Changed' where id = $1`, [john])).toBe(true);
      expect(await db.denied(
        `select app.set_shareholder_status($1, 'inactive', 'Because')`, [john])).toBe(true);
    });
  });

  it('refuses every direct ownership write, even from a signed-in Administrator', async () => {
    await asAdminDb(async (db) => {
      const { john, classId } = await scene(db);
      await becomeClient(db, SEED.admin);
      for (const statement of [
        `update public.shareholders set total_shares = 9999 where id = $1`,
        `update public.shareholdings set shares = 9999 where shareholder_id = $1`,
        `insert into public.share_transactions
           (transaction_number, type, class_id, class_code, shares, lines, shareholder_ids,
            effective_date)
         values ('X', 'shares_issued', '${classId}', 'ORDINARY', 1, '[]'::jsonb, array[$1::uuid],
                 app.eat_day())`,
        `update public.share_classes set value_per_share_ugx = 1 where id = '${classId}'`,
        `update public.dividend_allocations set net_ugx = 1`,
        `insert into public.share_contributions
           (contribution_number, shareholder_id, class_id, share_transaction_id, amount_ugx,
            source, payment_date)
         values ('X', $1, '${classId}', gen_random_uuid(), 1, 'prior_record', app.eat_day())`,
      ]) {
        expect(await db.denied(statement, [john]), statement.slice(0, 40)).toBe(true);
      }
    });
  });

  it('never puts an amount or a contact detail in an ownership event', async () => {
    await asAdminDb(async (db) => {
      const { john, account, classId, day } = await scene(db);
      // Put a request in front of an approver and declare a dividend, so there
      // are events of both kinds to inspect.
      await becomeClient(db, SEED.admin);
      await db.query(
        `select app.update_shareholding_policy('share', '{"requireApproval":true}'::jsonb, 'Back on')`);
      await db.query(
        `select * from app.issue_shares($1, '${classId}', 10, $2, null, 'account', 1000000, $3)`,
        [john, requestId('event'), account]);
      const { rows: dividend } = await db.query<{ dividend_id: string }>(
        `select * from app.create_dividend('FY2026', $2::date, $1, 'pool', 1000000,
                                           null, null, null, $3)`,
        [requestId('event-div'), day, classId]);
      await db.query(`select * from app.calculate_dividend($1)`, [dividend[0].dividend_id]);
      await db.query(`select app.update_dividend_status($1, 'declare')`, [dividend[0].dividend_id]);
      await becomeOwner(db);

      const { rows } = await db.query<{ type: string; payload: Record<string, unknown> }>(
        `select type, payload from public.ownership_events`);
      expect(rows.length).toBeGreaterThan(0);
      const IDENTIFIERS = new Set([
        'transactionNumber', 'dividendNumber', 'allocationNumber',
      ]);
      for (const row of rows) {
        for (const [key, value] of Object.entries(row.payload ?? {})) {
          expect(IDENTIFIERS, `${row.type}.${key}`).toContain(key);
          expect(String(value)).toMatch(/^RMX-/);
        }
      }
    });
  });
});
