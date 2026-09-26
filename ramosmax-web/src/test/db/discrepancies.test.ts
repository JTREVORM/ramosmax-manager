import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool } from './harness';
import { balanceOf, fund, ledgerDisagreements } from './finance-helpers';
import {
  authorize, becomeClient, becomeOwner, closeSession, eligibleWorker, makeUser, openSession,
  requestId, SEED, sessionRow, supervisor,
} from './after-hours-helpers';

afterAll(closePool);

type Db = Parameters<Parameters<typeof asAdminDb>[0]>[0];

/** A closed session whose count came up `differenceUgx` against the float. */
async function discrepancyFor(db: Db, differenceUgx: number, floatUgx = 80_000) {
  const staff = await eligibleWorker(db);
  const boss = await supervisor(db);
  const counter = await makeUser(db, {
    role: 'manager',
    permissions: ['cash_handover.approve', 'after_hours.discrepancy.review', 'after_hours.view'],
  });
  await authorize(db, { staff, by: boss, floatUgx });
  const session = await openSession(db, staff);
  const closed = await closeSession(db, session.session_id, staff);

  await becomeClient(db, counter);
  const { rows } = await db.query<{ discrepancy_id: string }>(
    `select * from app.receive_cash_handover($1, $2, $3, 'Counted in front of the worker')`,
    [closed.handover_id, floatUgx + differenceUgx, requestId('receive')]);
  await becomeOwner(db);
  return {
    staff, boss, counter,
    session: session.session_id,
    handover: closed.handover_id!,
    discrepancy: rows[0].discrepancy_id,
  };
}

describe('cash discrepancies: the lifecycle', () => {
  it('goes open → under review → resolved', async () => {
    await asAdminDb(async (db) => {
      const { counter, discrepancy, handover, session } = await discrepancyFor(db, -5_000);
      const { rows: opened } = await db.query<{ status: string }>(
        `select status from public.cash_discrepancies where id = $1`, [discrepancy]);
      expect(opened[0].status).toBe('open');

      await becomeClient(db, counter);
      await db.query(`select app.review_cash_discrepancy($1, 'Asked the worker what happened')`,
        [discrepancy]);
      const { rows: reviewed } = await db.query<{ status: string }>(
        `select status from public.cash_discrepancies where id = $1`, [discrepancy]);
      expect(reviewed[0].status).toBe('under_review');

      await db.query(
        `select * from app.resolve_cash_discrepancy($1, 'resolved', 'Change given to a customer', $2)`,
        [discrepancy, requestId('resolve')]);
      await becomeOwner(db);

      const { rows: resolved } = await db.query<{ status: string; outcome: string }>(
        `select status, outcome from public.cash_discrepancies where id = $1`, [discrepancy]);
      expect(resolved[0].status).toBe('resolved');
      expect(resolved[0].outcome).toBe('resolved');
      const { rows: h } = await db.query<{ status: string }>(
        `select status from public.cash_handovers where id = $1`, [handover]);
      expect(h[0].status).toBe('reconciled');
      expect((await sessionRow(db, session)).status).toBe('reconciled');
    });
  });

  it('may be waived without a review', async () => {
    await asAdminDb(async (db) => {
      const { counter, discrepancy } = await discrepancyFor(db, 2_000);
      await becomeClient(db, counter);
      await db.query(
        `select * from app.resolve_cash_discrepancy($1, 'waived', 'Rounding on the night', $2)`,
        [discrepancy, requestId('waive')]);
      await becomeOwner(db);
      const { rows } = await db.query<{ status: string }>(
        `select status from public.cash_discrepancies where id = $1`, [discrepancy]);
      expect(rows[0].status).toBe('waived');
    });
  });

  it('cannot be closed twice', async () => {
    await asAdminDb(async (db) => {
      const { counter, discrepancy } = await discrepancyFor(db, -5_000);
      await becomeClient(db, counter);
      await db.query(
        `select * from app.resolve_cash_discrepancy($1, 'resolved', 'Explained', $2)`,
        [discrepancy, requestId('resolve')]);
      expect(await db.expectError(
        `select * from app.resolve_cash_discrepancy($1, 'waived', 'Again', $2)`,
        [discrepancy, requestId('again')])).toMatch(/already been closed/i);
      await becomeOwner(db);
    });
  });

  it('nobody reviews or resolves a discrepancy about their own handover', async () => {
    await asAdminDb(async (db) => {
      const staff = await makeUser(db, {
        role: 'worker',
        permissions: ['after_hours.request', 'after_hours.discrepancy.review'],
      });
      const boss = await supervisor(db);
      const counter = await makeUser(db, {
        role: 'manager', permissions: ['cash_handover.approve'],
      });
      await authorize(db, { staff, by: boss, floatUgx: 50_000 });
      const session = await openSession(db, staff);
      const closed = await closeSession(db, session.session_id, staff);
      await becomeClient(db, counter);
      const { rows } = await db.query<{ discrepancy_id: string }>(
        `select * from app.receive_cash_handover($1, 45000, $2, 'Short')`,
        [closed.handover_id, requestId('receive')]);

      await becomeClient(db, staff);
      expect(await db.expectError(`select app.review_cash_discrepancy($1, 'It was fine')`,
        [rows[0].discrepancy_id])).toMatch(/your own handover/i);
      expect(await db.expectError(
        `select * from app.resolve_cash_discrepancy($1, 'waived', 'It was fine', $2)`,
        [rows[0].discrepancy_id, requestId('self')])).toMatch(/your own handover/i);
      await becomeOwner(db);
    });
  });

  it('the figures it was opened about never change', async () => {
    await asAdminDb(async (db) => {
      const { discrepancy } = await discrepancyFor(db, -5_000);
      expect(await db.expectError(
        `update public.cash_discrepancies set difference_ugx = -1 where id = $1`, [discrepancy]))
        .toMatch(/cannot be changed|difference/i);
      expect(await db.expectError(
        `update public.cash_discrepancies set actual_amount_ugx = 1 where id = $1`, [discrepancy]))
        .toMatch(/cannot be changed|difference/i);
    });
  });

  it('is idempotent', async () => {
    await asAdminDb(async (db) => {
      const { counter, discrepancy } = await discrepancyFor(db, -5_000);
      const id = requestId('idem-resolve');
      await becomeClient(db, counter);
      await db.query(
        `select * from app.resolve_cash_discrepancy($1, 'resolved', 'Explained', $2)`,
        [discrepancy, id]);
      await db.query(
        `select * from app.resolve_cash_discrepancy($1, 'resolved', 'Explained', $2)`,
        [discrepancy, id]);
      await becomeOwner(db);
      const { rows } = await db.query<{ status: string }>(
        `select status from public.cash_discrepancies where id = $1`, [discrepancy]);
      expect(rows[0].status).toBe('resolved');
    });
  });
});

describe('cash discrepancies: recovering a shortage', () => {
  it('REPORTS a loss incident and charges nothing', async () => {
    await asAdminDb(async (db) => {
      const { discrepancy, staff } = await discrepancyFor(db, -5_000);
      const reviewer = await makeUser(db, {
        role: 'manager',
        permissions: ['after_hours.discrepancy.review', 'losses.create', 'losses.view'],
      });
      await becomeClient(db, reviewer);
      const { rows } = await db.query<{ loss_number: string }>(
        `select * from app.resolve_cash_discrepancy($1, 'resolved', 'Cash was short', $2, true)`,
        [discrepancy, requestId('recover')]);
      await becomeOwner(db);

      expect(rows[0].loss_number).toMatch(/^RMX-LOSS-\d{6}$/);
      const { rows: incident } = await db.query<{
        status: string; amount_ugx: string; staff_uid: string; source_type: string;
        deduction_id: string | null; recovered_ugx: string;
      }>(`select status, amount_ugx, staff_uid, source_type, deduction_id, recovered_ugx
            from public.loss_incidents where loss_number = $1`, [rows[0].loss_number]);
      expect(incident[0].status).toBe('reported');
      expect(Number(incident[0].amount_ugx)).toBe(5_000);
      expect(incident[0].staff_uid).toBe(staff);
      expect(incident[0].source_type).toBe('cash_discrepancy');

      // NOTHING has been deducted, scheduled or recovered.
      expect(incident[0].deduction_id).toBeNull();
      expect(Number(incident[0].recovered_ugx)).toBe(0);
      const { rows: deductions } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.salary_deductions where staff_uid = $1`, [staff]);
      expect(Number(deductions[0].n)).toBe(0);
    });
  });

  it('refuses recovery on an excess', async () => {
    await asAdminDb(async (db) => {
      const { discrepancy } = await discrepancyFor(db, 5_000);
      const reviewer = await makeUser(db, {
        role: 'manager', permissions: ['after_hours.discrepancy.review', 'losses.create'],
      });
      await becomeClient(db, reviewer);
      expect(await db.expectError(
        `select * from app.resolve_cash_discrepancy($1, 'resolved', 'Over', $2, true)`,
        [discrepancy, requestId('notashortage')])).toMatch(/only a shortage/i);
      await becomeOwner(db);
    });
  });

  it('refuses recovery on a waived discrepancy', async () => {
    await asAdminDb(async (db) => {
      const { discrepancy } = await discrepancyFor(db, -5_000);
      const reviewer = await makeUser(db, {
        role: 'manager', permissions: ['after_hours.discrepancy.review', 'losses.create'],
      });
      await becomeClient(db, reviewer);
      expect(await db.expectError(
        `select * from app.resolve_cash_discrepancy($1, 'waived', 'Let it go', $2, true)`,
        [discrepancy, requestId('waivedrecover')])).toMatch(/waived discrepancy is not recovered/i);
      await becomeOwner(db);
    });
  });

  it('refuses recovery without losses.create', async () => {
    await asAdminDb(async (db) => {
      const { discrepancy } = await discrepancyFor(db, -5_000);
      // The Manager role carries `losses.create`, so this reviewer is denied it.
      const reviewer = await makeUser(db, {
        role: 'manager', permissions: ['after_hours.discrepancy.review'],
        deniedPermissions: ['losses.create'],
      });
      await becomeClient(db, reviewer);
      expect(await db.expectError(
        `select * from app.resolve_cash_discrepancy($1, 'resolved', 'Short', $2, true)`,
        [discrepancy, requestId('nopermission')])).toMatch(/do not have permission/i);
      await becomeOwner(db);
    });
  });
});

describe('cash discrepancies: the optional adjustment', () => {
  it('posts exactly the difference out of Cash at Hand for a shortage', async () => {
    await asAdminDb(async (db) => {
      const { discrepancy } = await discrepancyFor(db, -5_000);
      const admin = SEED.admin;
      await fund(db, 'cash_at_hand', 500_000);
      const before = await balanceOf(db, 'cash_at_hand');

      await becomeClient(db, admin);
      const { rows } = await db.query<{ adjustment_transaction_number: string }>(
        `select * from app.resolve_cash_discrepancy($1, 'resolved', 'Aligning the account', $2,
           false, true)`, [discrepancy, requestId('adjust')]);
      await becomeOwner(db);

      expect(rows[0].adjustment_transaction_number).toMatch(/^RMX-TXN-/);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before - 5_000);
      expect(await ledgerDisagreements(db)).toEqual([]);

      const { rows: entry } = await db.query<{ entry_type: string; amount_ugx: string }>(
        `select entry_type, amount_ugx from public.financial_transactions
          where transaction_number = $1`, [rows[0].adjustment_transaction_number]);
      expect(entry[0].entry_type).toBe('adjustment');
      expect(Number(entry[0].amount_ugx)).toBe(5_000);
    });
  });

  it('posts it INTO Cash at Hand for an excess', async () => {
    await asAdminDb(async (db) => {
      const { discrepancy } = await discrepancyFor(db, 5_000);
      const before = await balanceOf(db, 'cash_at_hand');
      await becomeClient(db, SEED.admin);
      await db.query(
        `select * from app.resolve_cash_discrepancy($1, 'resolved', 'Aligning the account', $2,
           false, true)`, [discrepancy, requestId('adjust-in')]);
      await becomeOwner(db);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before + 5_000);
    });
  });

  it('is never automatic: resolving alone posts nothing', async () => {
    await asAdminDb(async (db) => {
      const { counter, discrepancy } = await discrepancyFor(db, -5_000);
      const before = await balanceOf(db, 'cash_at_hand');
      await becomeClient(db, counter);
      const { rows } = await db.query<{ adjustment_transaction_number: string | null }>(
        `select * from app.resolve_cash_discrepancy($1, 'resolved', 'Explained', $2)`,
        [discrepancy, requestId('noadjust')]);
      await becomeOwner(db);
      expect(rows[0].adjustment_transaction_number).toBeNull();
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before);
    });
  });

  it('refuses the adjustment without finance.adjust', async () => {
    await asAdminDb(async (db) => {
      const { counter, discrepancy } = await discrepancyFor(db, -5_000);
      // No `finance.adjust`: only an Administrator posts the adjustment.
      await becomeClient(db, counter);
      expect(await db.expectError(
        `select * from app.resolve_cash_discrepancy($1, 'resolved', 'Align it', $2, false, true)`,
        [discrepancy, requestId('nofinance')])).toMatch(/do not have permission/i);
      await becomeOwner(db);
    });
  });
});
