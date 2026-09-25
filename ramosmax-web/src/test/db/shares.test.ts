import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, makeUser, SEED } from './harness';
import {
  allowUnpaid, autoPost, holdingOf, issue, openDay, ownAccount, requestId, requireApproval,
  shareClass, shareholder, shareholderRow, testClassCode, ugx,
} from './ownership-helpers';
import { ledgerDisagreements } from './finance-helpers';

afterAll(closePool);

/**
 * THE IMMUTABLE OWNERSHIP LEDGER.
 *
 * Ownership is not a number somebody edits. Every change is an entry with
 * signed lines, and a holding is the sum of them. Nothing is corrected by
 * overwriting: a mistake is adjusted or reversed, and both stay in the record.
 */

/**
 * Its own share class and its own people.
 *
 * The committing suites leave holders and a class behind, so a suite that
 * asserts totals works inside a class of its own.
 */
async function scene(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) {
  const classId = await shareClass(db, testClassCode(), 100_000);
  await requireApproval(db);
  const account = await ownAccount(db, 500_000_000);
  const john = await shareholder(db, 'John Owner', '0772600001');
  const mary = await shareholder(db, 'Mary Owner', '0772600002');
  const day = await openDay(db);
  return { account, john, mary, classId, day };
}

describe('shares: issuing', () => {
  it('computes the commitment from the class, never from the browser', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      const result = await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      expect(result.committed_ugx).toBe(10_000_000);
      expect(result.paid_ugx).toBe(10_000_000);
      expect(result.outstanding_ugx).toBe(0);
      expect(ugx((await holdingOf(db, john, classId))!.shares)).toBe(100);
    });
  });

  it('refuses a payment that does not match the commitment the server worked out', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      // The browser offers less than the shares are worth. The default policy
      // says shares are paid in full when issued.
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select * from app.issue_shares($1, '${classId}', 100, $2, null, 'account', 1, $3)`,
        [john, requestId('short'), account])).toMatch(/does not allow shares to be part-paid/i);
      // And more than they are worth is refused outright.
      expect(await db.expectError(
        `select * from app.issue_shares($1, '${classId}', 100, $2, null, 'account', 99000000, $3)`,
        [john, requestId('over'), account])).toMatch(/cannot be more than the UGX/i);
    });
  });

  it('posts ONE share-capital entry: owners’ money, never revenue', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      const { rows: before } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [account]);
      await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });

      const { rows } = await db.query<{ n: string; is_revenue: boolean; amount_ugx: string }>(
        `select count(*)::text as n, bool_and(is_revenue) as is_revenue, min(amount_ugx) as amount_ugx
           from public.financial_transactions
          where entry_type = 'share_capital_contribution' and destination_account_id = $1`,
        [account]);
      expect(Number(rows[0].n)).toBe(1);
      expect(rows[0].is_revenue).toBe(false);
      expect(ugx(rows[0].amount_ugx)).toBe(10_000_000);

      const { rows: after } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [account]);
      expect(ugx(after[0].balance_ugx) - ugx(before[0].balance_ugx)).toBe(10_000_000);
      expect(await ledgerDisagreements(db)).toEqual([]);

      const { rows: today } = await db.query<{ share_capital_ugx: string; payments_in_ugx: string }>(
        `select share_capital_ugx, payments_in_ugx from public.finance_daily_summaries
          where business_day = app.eat_day()`);
      expect(ugx(today[0].share_capital_ugx)).toBeGreaterThanOrEqual(10_000_000);
      // Share capital never lands in takings. The committing suites may have
      // left customer payments behind, so this compares the DAY's own numbers:
      // the share capital is recorded, and not as a payment in.
      const { rows: mine } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions
          where entry_type = 'customer_payment' and destination_account_id = $1`, [account]);
      expect(Number(mine[0].n), 'share capital is not takings').toBe(0);
    });
  });

  it('records money paid before RamosMAX without touching any balance', async () => {
    await asAdminDb(async (db) => {
      const { john, classId } = await scene(db);
      await autoPost(db);
      const { rows: before } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions`);
      await becomeClient(db, SEED.admin);
      await db.query(
        `select * from app.issue_shares($1, '${classId}', 100, $2, null, 'prior_record', 10000000,
                                        null, null, null, null, 'Paid at incorporation')`,
        [john, requestId('prior')]);
      await becomeOwner(db);
      const { rows: after } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions`);
      expect(Number(after[0].n)).toBe(Number(before[0].n));
      expect(ugx((await shareholderRow(db, john)).paid_ugx)).toBe(10_000_000);
    });
  });

  it('refuses an inactive class and an inactive shareholder', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      await becomeClient(db, SEED.admin);
      await db.query(`select app.update_share_class('${classId}', null, null, null, false, 'Retired')`);
      expect(await db.expectError(
        `select * from app.issue_shares($1, '${classId}', 10, $2, null, 'account', 1000000, $3)`,
        [john, requestId('inactive-class'), account])).toMatch(/share class is inactive/i);

      await db.query(`select app.update_share_class('${classId}', null, null, null, true, 'Back')`);
      await db.query(`select app.set_shareholder_status($1, 'suspended', 'Under review')`, [john]);
      expect(await db.expectError(
        `select * from app.issue_shares($1, '${classId}', 10, $2, null, 'account', 1000000, $3)`,
        [john, requestId('inactive-sh'), account])).toMatch(/cannot receive new shares/i);
    });
  });

  it('issues once for a repeated request id', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      const key = requestId('issue-retry');
      await becomeClient(db, SEED.admin);
      const first = await db.query<{ transaction_id: string }>(
        `select * from app.issue_shares($1, '${classId}', 100, $2, null, 'account', 10000000, $3)`,
        [john, key, account]);
      const again = await db.query<{ transaction_id: string }>(
        `select * from app.issue_shares($1, '${classId}', 100, $2, null, 'account', 10000000, $3)`,
        [john, key, account]);
      await becomeOwner(db);
      expect(again.rows[0].transaction_id).toBe(first.rows[0].transaction_id);
      expect(ugx((await holdingOf(db, john, classId))!.shares)).toBe(100);
    });
  });

  it('keeps the value per share it used, so a later price change moves nothing', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      const result = await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      await becomeClient(db, SEED.admin);
      await db.query(
        `select app.update_share_class('${classId}', null, null, 250000, null, 'Revaluation')`);
      await becomeOwner(db);

      const { rows } = await db.query<{ value_per_share_ugx: string; committed_ugx: string }>(
        `select value_per_share_ugx, committed_ugx from public.share_transactions where id = $1`,
        [result.transaction_id]);
      expect(ugx(rows[0].value_per_share_ugx)).toBe(100_000);
      expect(ugx(rows[0].committed_ugx)).toBe(10_000_000);
      expect(ugx((await shareholderRow(db, john)).committed_ugx)).toBe(10_000_000);
    });
  });
});

describe('shares: second-person approval', () => {
  it('waits for another person by default', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      const result = await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      expect(result.status).toBe('pending_approval');
      expect(await holdingOf(db, john, classId)).toBeNull();
      expect(ugx((await shareholderRow(db, john)).total_shares)).toBe(0);
    });
  });

  it('changes nothing financial until it is approved', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      const { rows: before } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [account]);
      await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      const { rows: after } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [account]);
      expect(after[0].balance_ugx).toBe(before[0].balance_ugx);
      const { rows: entries } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions
          where entry_type = 'share_capital_contribution' and destination_account_id = $1`,
        [account]);
      expect(Number(entries[0].n)).toBe(0);
    });
  });

  it('posts everything on approval, in one act', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      const approver = await makeUser(db, { role: 'manager', permissions: ['shares.approve'] });
      const result = await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });

      await becomeClient(db, approver);
      expect((await db.query<{ decide_share_transaction: string }>(
        `select app.decide_share_transaction($1, 'approve')`, [result.transaction_id]))
        .rows[0].decide_share_transaction).toBe('posted');
      await becomeOwner(db);

      expect(ugx((await holdingOf(db, john, classId))!.shares)).toBe(100);
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions
          where entry_type = 'share_capital_contribution' and destination_account_id = $1`,
        [account]);
      expect(Number(rows[0].n)).toBe(1);
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('refuses the requester’s own approval', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      const requester = await makeUser(db, {
        role: 'manager', permissions: ['shares.issue', 'shares.approve', 'shares.view'],
      });
      const result = await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000, by: requester,
      });
      await becomeClient(db, requester);
      expect(await db.expectError(
        `select app.decide_share_transaction($1, 'approve')`, [result.transaction_id]))
        .toMatch(/Another person must approve/i);
    });
  });

  it('refuses an approval on the approver’s own shareholding', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      const uid = await makeUser(db, { role: 'manager', permissions: ['shares.approve'] });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_shareholder_account($1, $2)`, [john, uid]);
      await becomeOwner(db);
      const result = await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      await becomeClient(db, uid);
      expect(await db.expectError(
        `select app.decide_share_transaction($1, 'approve')`, [result.transaction_id]))
        .toMatch(/your own shareholding/i);
    });
  });

  it('refuses an unauthorized approval, and a second one', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      const result = await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      await becomeClient(db, SEED.manager);
      expect(await db.denied(
        `select app.decide_share_transaction($1, 'approve')`, [result.transaction_id])).toBe(true);
      await becomeClient(db, SEED.admin);
      await db.query(`select app.decide_share_transaction($1, 'approve')`, [result.transaction_id]);
      expect(await db.expectError(
        `select app.decide_share_transaction($1, 'approve')`, [result.transaction_id]))
        .toMatch(/already been decided/i);
    });
  });

  it('rejects with a reason, and changes no ownership', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      const result = await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.decide_share_transaction($1, 'reject')`, [result.transaction_id]))
        .toMatch(/reason/i);
      await db.query(`select app.decide_share_transaction($1, 'reject', 'Not agreed')`,
        [result.transaction_id]);
      await becomeOwner(db);
      const { rows } = await db.query<{ status: string; applied: boolean }>(
        `select status, applied from public.share_transactions where id = $1`,
        [result.transaction_id]);
      expect(rows[0]).toEqual({ status: 'rejected', applied: false });
      expect(await holdingOf(db, john, classId)).toBeNull();
    });
  });

  it('cannot reopen a rejected entry, even below the function', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      const result = await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.decide_share_transaction($1, 'reject', 'Not agreed')`,
        [result.transaction_id]);
      await becomeOwner(db);
      expect(await db.expectError(
        `update public.share_transactions set status = 'posted', applied = true where id = $1`,
        [result.transaction_id])).toMatch(/rejected share transaction cannot be reopened/i);
    });
  });

  it('re-validates at approval: two pending transfers cannot take more than is owned', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, classId } = await scene(db);
      await autoPost(db);
      await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      // Back to requiring approval, then raise two transfers of 60 each.
      await becomeClient(db, SEED.admin);
      await db.query(
        `select app.update_shareholding_policy('share', '{"requireApproval":true}'::jsonb, 'Back on')`);
      const a = await db.query<{ transaction_id: string }>(
        `select * from app.transfer_shares($1, $2, '${classId}', 60, 'Sale one', $3)`,
        [john, mary, requestId('t1')]);
      const b = await db.query<{ transaction_id: string }>(
        `select * from app.transfer_shares($1, $2, '${classId}', 60, 'Sale two', $3)`,
        [john, mary, requestId('t2')]);

      await db.query(`select app.decide_share_transaction($1, 'approve')`,
        [a.rows[0].transaction_id]);
      expect(await db.expectError(`select app.decide_share_transaction($1, 'approve')`,
        [b.rows[0].transaction_id]), 'the second is re-validated and refused')
        .toMatch(/would not have held enough shares|holds only/i);
      await becomeOwner(db);
      expect(ugx((await holdingOf(db, john, classId))!.shares)).toBe(40);
      expect(ugx((await holdingOf(db, mary, classId))!.shares)).toBe(60);
    });
  });
});

describe('shares: transfers and adjustments', () => {
  it('moves shares without creating any', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, classId } = await scene(db);
      await autoPost(db);
      await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.transfer_shares($1, $2, '${classId}', 40, 'Private sale', $3)`,
        [john, mary, requestId('transfer')]);
      await becomeOwner(db);

      expect(ugx((await holdingOf(db, john, classId))!.shares)).toBe(60);
      expect(ugx((await holdingOf(db, mary, classId))!.shares)).toBe(40);
      const { rows } = await db.query<{ issued_shares: string }>(
        `select issued_shares from public.share_classes where id = '${classId}'`);
      expect(ugx(rows[0].issued_shares), 'the total is unchanged').toBe(100);
    });
  });

  it('refuses a transfer of more shares than are held', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, classId } = await scene(db);
      await autoPost(db);
      await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select * from app.transfer_shares($1, $2, '${classId}', 150, 'Too many', $3)`,
        [john, mary, requestId('over-transfer')])).toMatch(/holds only 100/i);
    });
  });

  it('refuses a transfer while the commitment is unpaid', async () => {
    await asAdminDb(async (db) => {
      const { john, mary, classId } = await scene(db);
      await autoPost(db);
      await allowUnpaid(db);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.issue_shares($1, '${classId}', 100, $2, null, 'none')`,
        [john, requestId('unpaid')]);
      expect(await db.expectError(
        `select * from app.transfer_shares($1, $2, '${classId}', 10, 'Sale', $3)`,
        [john, mary, requestId('unpaid-transfer')])).toMatch(/unpaid .* commitment/i);
    });
  });

  /**
   * A BACKDATED ENTRY CANNOT CREATE AN IMPOSSIBLE HISTORY. Shares cannot be
   * transferred before they existed, however the dates are arranged.
   */
  it('refuses a transfer dated before the shares were issued', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, classId } = await scene(db);
      await autoPost(db);
      const { rows: days } = await db.query<{ recent: string; older: string }>(
        `select (app.eat_day() - 5)::text as recent, (app.eat_day() - 20)::text as older`);
      await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000,
        effective: days[0].recent,
      });
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select * from app.transfer_shares($1, $2, '${classId}', 50, 'Backdated', $3, $4::date)`,
        [john, mary, requestId('backdated'), days[0].older]))
        .toMatch(/would not have held enough shares on that date|holds only 0/i);
    });
  });

  it('adjusts with a reason, and keeps the earlier entries as they were', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      const issued = await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000,
      });
      await becomeClient(db, SEED.admin);
      await db.query(
        `select * from app.adjust_shares($1, '${classId}', -10, 'Counted wrongly at allotment', $2)`,
        [john, requestId('adjust')]);
      await becomeOwner(db);

      expect(ugx((await holdingOf(db, john, classId))!.shares)).toBe(90);
      const { rows } = await db.query<{ shares: string; status: string }>(
        `select shares, status from public.share_transactions where id = $1`,
        [issued.transaction_id]);
      expect(ugx(rows[0].shares), 'the original entry is untouched').toBe(100);
      expect(rows[0].status).toBe('posted');
      const { rows: all } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.share_transactions where class_id = $1`, [classId]);
      expect(Number(all[0].n), 'a correction is a NEW entry').toBe(2);
    });
  });

  it('refuses an adjustment that would take more shares than are held', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select * from app.adjust_shares($1, '${classId}', -200, 'Too many', $2)`,
        [john, requestId('over-adjust')])).toMatch(/would not have held enough shares/i);
    });
  });

  it('never lets the ownership lines of an applied entry change', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      const issued = await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      expect(await db.expectError(
        `update public.share_transactions set lines = '[]'::jsonb where id = $1`,
        [issued.transaction_id])).toMatch(/ownership lines of an applied share transaction/i);
      expect(await db.expectError(
        `update public.share_transactions set shares = 1 where id = $1`, [issued.transaction_id]))
        .toMatch(/keeps its number, type, class, size and effective date/i);
      expect(await db.expectError(
        `delete from public.share_transactions where id = $1`, [issued.transaction_id]))
        .toMatch(/never deletes/i);
    });
  });
});

describe('shares: money afterwards, and reversals', () => {
  it('records a later payment against an issue, up to what is outstanding', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      await allowUnpaid(db);
      await becomeClient(db, SEED.admin);
      const issued = await db.query<{ transaction_id: string }>(
        `select * from app.issue_shares($1, '${classId}', 100, $2, null, 'none')`,
        [john, requestId('unpaid2')]);
      const { rows } = await db.query<{ outstanding_ugx: string }>(
        `select * from app.record_share_contribution($1, 4000000, $2, 'account', $3)`,
        [issued.rows[0].transaction_id, requestId('pay1'), account]);
      expect(ugx(rows[0].outstanding_ugx)).toBe(6_000_000);
      expect(await db.expectError(
        `select * from app.record_share_contribution($1, 99000000, $2, 'account', $3)`,
        [issued.rows[0].transaction_id, requestId('pay2'), account]))
        .toMatch(/cannot be more than the UGX 6,000,000 outstanding/i);
      await becomeOwner(db);
      expect(ugx((await shareholderRow(db, john)).paid_ugx)).toBe(4_000_000);
      expect(ugx((await shareholderRow(db, john)).outstanding_ugx)).toBe(6_000_000);
    });
  });

  it('reverses a contribution: the money leaves, the commitment is owed again', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      const { rows: before } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [account]);
      await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      const { rows: c } = await db.query<{ id: string }>(
        `select id from public.share_contributions where shareholder_id = $1 and class_id = $2`,
        [john, classId]);

      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_share_contribution($1, 'Bounced')`, [c[0].id]);
      await becomeOwner(db);

      const { rows: after } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [account]);
      expect(after[0].balance_ugx).toBe(before[0].balance_ugx);
      expect(ugx((await shareholderRow(db, john)).paid_ugx)).toBe(0);
      expect(ugx((await shareholderRow(db, john)).outstanding_ugx)).toBe(10_000_000);
      const { rows: kept } = await db.query<{ status: string }>(
        `select status from public.share_contributions where id = $1`, [c[0].id]);
      expect(kept[0].status, 'the contribution is kept, marked reversed').toBe('reversed');
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('reverses an issue and its contributions in one act', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      const { rows: before } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [account]);
      const issued = await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });

      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{ transaction_number: string; contributions_reversed: number }>(
        `select * from app.reverse_share_transaction($1, 'Allotment cancelled', $2)`,
        [issued.transaction_id, requestId('rev')]);
      await becomeOwner(db);

      expect(Number(rows[0].contributions_reversed)).toBe(1);
      expect(ugx((await holdingOf(db, john, classId))!.shares)).toBe(0);
      const { rows: after } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [account]);
      expect(after[0].balance_ugx).toBe(before[0].balance_ugx);

      const { rows: original } = await db.query<{ status: string; reversed_by_number: string }>(
        `select status, reversed_by_number from public.share_transactions where id = $1`,
        [issued.transaction_id]);
      expect(original[0].status, 'the original stays, marked reversed').toBe('reversed');
      expect(original[0].reversed_by_number).toBe(rows[0].transaction_number);
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('refuses to reverse shares that have been transferred on', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, classId } = await scene(db);
      await autoPost(db);
      const issued = await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.transfer_shares($1, $2, '${classId}', 100, 'Sold on', $3)`,
        [john, mary, requestId('sold-on')]);
      expect(await db.expectError(
        `select * from app.reverse_share_transaction($1, 'Too late', $2)`,
        [issued.transaction_id, requestId('rev2')])).toMatch(/no longer held/i);
    });
  });

  it('refuses a reversal of a reversal, and a second reversal', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      const issued = await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{ transaction_id: string }>(
        `select * from app.reverse_share_transaction($1, 'Cancelled', $2)`,
        [issued.transaction_id, requestId('rev3')]);
      expect(await db.expectError(
        `select * from app.reverse_share_transaction($1, 'Again', $2)`,
        [issued.transaction_id, requestId('rev4')])).toMatch(/already been reversed/i);
      expect(await db.expectError(
        `select * from app.reverse_share_transaction($1, 'Mirror', $2)`,
        [rows[0].transaction_id, requestId('rev5')])).toMatch(/cannot itself be reversed/i);
    });
  });

  /** Phase E's guard, extended: owners' money goes back through its own door. */
  it('refuses a generic finance reversal of share capital', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await autoPost(db);
      await issue(db, { shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      const { rows } = await db.query<{ id: string }>(
        `select id from public.financial_transactions
          where entry_type = 'share_capital_contribution' and destination_account_id = $1`,
        [account]);
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select * from app.reverse_financial_transaction($1, 'Wrong door')`, [rows[0].id]))
        .toMatch(/share contribution from its share transaction/i);
    });
  });
});
