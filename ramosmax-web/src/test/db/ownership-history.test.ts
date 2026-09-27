import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, SEED } from './harness';
import {
  autoPost, issue, ownAccount, requestId, shareClass, shareholder, ugx,
} from './ownership-helpers';

afterAll(closePool);

/**
 * OWNERSHIP IS DERIVED, AND HISTORY IS RECONSTRUCTABLE.
 *
 * Every figure — a holding, a percentage, a class total, the register — is the
 * sum of the ledger's applied lines. Nothing is a stored running total that
 * could quietly disagree with the entries, and an entry made today can never
 * change what the answer was last month.
 */

async function scene(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) {
  // Its own class, so the committing suites' holders never enter these sums.
  const classId = await shareClass(db, `HIST${Math.floor(Math.random() * 900000) + 100000}`, 100_000);
  await autoPost(db);
  const account = await ownAccount(db, 500_000_000);
  const john = await shareholder(db, 'John Owner', '0772700001');
  const mary = await shareholder(db, 'Mary Owner', '0772700002');
  const peter = await shareholder(db, 'Peter Owner', '0772700003');
  // After whatever record date is already locked.
  const { rows } = await db.query<{ d30: string; d20: string; d10: string; today: string }>(`
    with base as (select greatest(coalesce(app.locked_record_date() + 1, app.eat_day() - 30),
                                  app.eat_day() - 30) as d)
    select d::text as d30, (d + 10)::text as d20, (d + 20)::text as d10,
           app.eat_day()::text as today from base`);
  return { account, john, mary, peter, classId, days: rows[0] };
}

const asOf = async (
  db: Parameters<Parameters<typeof asAdminDb>[0]>[0],
  date: string,
  classId: string,
) => {
  await becomeClient(db, SEED.admin);
  const { rows } = await db.query<{ shareholder_name: string; shares: string; ownership_percent: string }>(
    `select * from app.ownership_as_of($1::date, $2)`, [date, classId]);
  await becomeOwner(db);
  return rows.map((r) => ({
    name: r.shareholder_name, shares: ugx(r.shares), percent: Number(r.ownership_percent),
  }));
};

describe('ownership percentages', () => {
  /** The reference's worked example: 100 / 50 / 50 → 50% / 25% / 25%. */
  it('divides to four decimal places', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, peter, classId, days } = await scene(db);
      for (const [id, shares] of [[john, 100], [mary, 50], [peter, 50]] as Array<[string, number]>) {
        await issue(db, {
          shareholder: id, classId, shares, account, amount: shares * 100_000,
          effective: days.d30,
        });
      }
      expect((await asOf(db, days.today, classId)).map((r) => r.percent)).toEqual([50, 25, 25]);
    });
  });

  it('rounds a third to four places, and says so', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, peter, classId, days } = await scene(db);
      for (const id of [john, mary, peter]) {
        await issue(db, {
          shareholder: id, classId, shares: 1, account, amount: 100_000, effective: days.d30,
        });
      }
      // 33.3333 three times adds up to 99.9999, and that is the honest answer.
      expect((await asOf(db, days.today, classId)).map((r) => r.percent))
        .toEqual([33.3333, 33.3333, 33.3333]);
    });
  });
});

describe('ownership on a date', () => {
  it('is the sum of the entries effective on or before that day', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, classId, days } = await scene(db);
      await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000, effective: days.d30,
      });
      await issue(db, {
        shareholder: mary, classId, shares: 100, account, amount: 10_000_000, effective: days.d10,
      });

      expect(await asOf(db, days.d20, classId)).toEqual([{ name: 'John Owner', shares: 100, percent: 100 }]);
      const today = await asOf(db, days.today, classId);
      expect(today.map((r) => r.shares)).toEqual([100, 100]);
      expect(today.every((r) => r.percent === 50)).toBe(true);
    });
  });

  /**
   * THE POINT OF AN IMMUTABLE LEDGER. A transfer agreed in November cannot
   * change who owned what in October.
   */
  it('does not change when a later transaction is added', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, classId, days } = await scene(db);
      await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000, effective: days.d30,
      });
      const before = await asOf(db, days.d20, classId);

      await becomeClient(db, SEED.admin);
      await db.query(
        `select * from app.transfer_shares($1, $2, $5, 60, 'Sold later', $3, $4::date)`,
        [john, mary, requestId('later'), days.d10, classId]);
      await becomeOwner(db);

      expect(await asOf(db, days.d20, classId), 'the answer for that day is unchanged').toEqual(before);
      expect(await asOf(db, days.today, classId)).toEqual([
        { name: 'Mary Owner', shares: 60, percent: 60 },
        { name: 'John Owner', shares: 40, percent: 40 },
      ]);
    });
  });

  it('counts a reversal from the day it was made, not the original day', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId, days } = await scene(db);
      const issued = await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000, effective: days.d30,
      });
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_share_transaction($1, 'Cancelled', $2)`,
        [issued.transaction_id, requestId('rev')]);
      await becomeOwner(db);

      expect(await asOf(db, days.d20, classId), 'they DID own them then').toEqual([
        { name: 'John Owner', shares: 100, percent: 100 },
      ]);
      expect(await asOf(db, days.today, classId), 'and do not now').toEqual([]);
    });
  });

  it('never counts a pending or rejected entry', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId, days } = await scene(db);
      await becomeClient(db, SEED.admin);
      await db.query(
        `select app.update_shareholding_policy('share', '{"requireApproval":true}'::jsonb, 'Back on')`);
      const { rows } = await db.query<{ transaction_id: string }>(
        `select * from app.issue_shares($1, $4, 100, $2, null, 'account', 10000000, $3)`,
        [john, requestId('pending'), account, classId]);
      await becomeOwner(db);
      expect(await asOf(db, days.today, classId)).toEqual([]);

      await becomeClient(db, SEED.admin);
      await db.query(`select app.decide_share_transaction($1, 'reject', 'Not agreed')`,
        [rows[0].transaction_id]);
      await becomeOwner(db);
      expect(await asOf(db, days.today, classId)).toEqual([]);
    });
  });

  it('refuses a future date', async () => {
    await asAdminDb(async (db) => {
      await scene(db);
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select * from app.ownership_as_of(app.eat_day() + 1)`)).toBeTruthy();
    });
  });
});

describe('the derived figures cannot drift from the ledger', () => {
  it('matches every holding, shareholder total and class total to the entries', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, peter, classId, days } = await scene(db);
      await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000, effective: days.d30 });
      await issue(db, { shareholder: mary, classId, shares: 40, account, amount: 4_000_000, effective: days.d20 });
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.transfer_shares($1, $2, $5, 30, 'Sale', $3, $4::date)`,
        [john, peter, requestId('t'), days.d10, classId]);
      await db.query(`select * from app.adjust_shares($1, $3, -5, 'Counted wrongly', $2)`,
        [mary, requestId('a'), classId]);
      await becomeOwner(db);

      // Holdings must equal the ledger, shareholder totals must equal the
      // holdings, and class totals must equal both.
      const { rows: drift } = await db.query(`
        select h.shareholder_id, h.shares, coalesce(l.shares, 0) as ledger
          from public.shareholdings h
          left join (select (line ->> 'shareholderId')::uuid as shareholder_id,
                            sum((line ->> 'deltaShares')::bigint) as shares
                       from public.share_transactions t, jsonb_array_elements(t.lines) line
                      where t.applied group by 1) l on l.shareholder_id = h.shareholder_id
         where h.shares <> coalesce(l.shares, 0)`);
      expect(drift, 'holdings disagree with the ledger').toEqual([]);

      const { rows: totals } = await db.query(`
        select s.id from public.shareholders s
          left join (select shareholder_id, sum(shares) as shares from public.shareholdings group by 1) h
            on h.shareholder_id = s.id
         where s.total_shares <> coalesce(h.shares, 0)`);
      expect(totals, 'shareholder totals disagree with the holdings').toEqual([]);

      const { rows: classes } = await db.query(`
        select k.id from public.share_classes k
          left join (select class_id, sum(shares) as shares from public.shareholdings group by 1) h
            on h.class_id = k.id
         where k.issued_shares <> coalesce(h.shares, 0)`);
      expect(classes, 'class totals disagree with the holdings').toEqual([]);

      const { rows: klass } = await db.query<{ issued_shares: string }>(
        `select issued_shares from public.share_classes where id = $1`, [classId]);
      expect(ugx(klass[0].issued_shares)).toBe(135);
    });
  });

  it('keeps the money derived too: paid is the sum of the posted contributions', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId, days } = await scene(db);
      await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000, effective: days.d30,
      });
      const { rows } = await db.query(`
        select h.shareholder_id from public.shareholdings h
          left join (select shareholder_id, sum(amount_ugx) as paid
                       from public.share_contributions where status = 'posted' group by 1) c
            on c.shareholder_id = h.shareholder_id
         where h.paid_ugx <> coalesce(c.paid, 0)`);
      expect(rows).toEqual([]);
    });
  });
});
