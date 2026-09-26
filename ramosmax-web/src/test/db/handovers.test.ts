import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool } from './harness';
import { invoicedJob } from './billing-helpers';
import { balanceOf, ledgerDisagreements, snapshot } from './finance-helpers';
import {
  authorize, becomeClient, becomeOwner, closeSession, collect, eligibleWorker, handoverRow,
  makeUser, openSession, requestId, SEED, sessionRow, supervisor,
} from './after-hours-helpers';

afterAll(closePool);

/** A worker who has closed a session holding `floatUgx` and nothing else. */
async function handoverFor(
  db: Parameters<Parameters<typeof asAdminDb>[0]>[0],
  floatUgx = 80_000,
) {
  const staff = await eligibleWorker(db, ['invoices.view']);
  const boss = await supervisor(db);
  await authorize(db, { staff, by: boss, floatUgx });
  const session = await openSession(db, staff);
  const closed = await closeSession(db, session.session_id, staff);
  return { staff, boss, session: session.session_id, handover: closed.handover_id! };
}

/** Somebody who may receive a handover. */
async function receiver(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) {
  return makeUser(db, {
    role: 'manager', permissions: ['cash_handover.approve', 'after_hours.view'],
  });
}

describe('cash handovers: submitting', () => {
  it('records what the worker says they are handing over', async () => {
    await asAdminDb(async (db) => {
      const { staff, handover } = await handoverFor(db);
      await becomeClient(db, staff);
      await db.query(`select * from app.submit_cash_handover($1, 80000, $2, 'Counted twice')`,
        [handover, requestId('submit')]);
      await becomeOwner(db);

      const h = await handoverRow(db, handover);
      expect(h.status).toBe('submitted');
      expect(Number(h.declared_amount_ugx)).toBe(80_000);
      expect(h.actual_amount_ugx).toBeNull();
    });
  });

  it('is informational: a declaration that disagrees is still accepted', async () => {
    await asAdminDb(async (db) => {
      const { staff, handover } = await handoverFor(db);
      await becomeClient(db, staff);
      await db.query(`select * from app.submit_cash_handover($1, 10000, $2)`,
        [handover, requestId('submit')]);
      await becomeOwner(db);
      const h = await handoverRow(db, handover);
      expect(Number(h.declared_amount_ugx)).toBe(10_000);
      expect(Number(h.expected_cash_ugx)).toBe(80_000);
    });
  });

  it('refuses a second submission', async () => {
    await asAdminDb(async (db) => {
      const { staff, handover } = await handoverFor(db);
      await becomeClient(db, staff);
      await db.query(`select * from app.submit_cash_handover($1, 80000, $2)`,
        [handover, requestId('submit')]);
      expect(await db.expectError(`select * from app.submit_cash_handover($1, 80000, $2)`,
        [handover, requestId('again')])).toMatch(/already been submitted/i);
      await becomeOwner(db);
    });
  });

  it('refuses somebody else’s handover', async () => {
    await asAdminDb(async (db) => {
      const { handover } = await handoverFor(db);
      const other = await eligibleWorker(db);
      await becomeClient(db, other);
      expect(await db.expectError(`select * from app.submit_cash_handover($1, 80000, $2)`,
        [handover, requestId('notmine')])).toMatch(/only submit your own/i);
      await becomeOwner(db);
    });
  });

  it('lets a cashier submit on the worker’s behalf', async () => {
    await asAdminDb(async (db) => {
      const { handover } = await handoverFor(db);
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.submit_cash_handover($1, 80000, $2)`,
        [handover, requestId('onbehalf')]);
      await becomeOwner(db);
      expect((await handoverRow(db, handover)).status).toBe('submitted');
    });
  });

  it('is idempotent', async () => {
    await asAdminDb(async (db) => {
      const { staff, handover } = await handoverFor(db);
      const id = requestId('idem');
      await becomeClient(db, staff);
      await db.query(`select * from app.submit_cash_handover($1, 80000, $2)`, [handover, id]);
      await db.query(`select * from app.submit_cash_handover($1, 80000, $2)`, [handover, id]);
      await becomeOwner(db);
      expect((await handoverRow(db, handover)).status).toBe('submitted');
    });
  });
});

describe('cash handovers: receiving', () => {
  it('a matching count reconciles the handover and the session', async () => {
    await asAdminDb(async (db) => {
      const { staff, session, handover } = await handoverFor(db);
      const boss = await receiver(db);
      await becomeClient(db, staff);
      await db.query(`select * from app.submit_cash_handover($1, 80000, $2)`,
        [handover, requestId('submit')]);
      await becomeClient(db, boss);
      const { rows } = await db.query<{ status: string; difference_ugx: string }>(
        `select * from app.receive_cash_handover($1, 80000, $2)`, [handover, requestId('receive')]);
      await becomeOwner(db);

      expect(rows[0].status).toBe('received');
      expect(Number(rows[0].difference_ugx)).toBe(0);
      expect((await sessionRow(db, session)).status).toBe('reconciled');
    });
  });

  it('nobody receives their own handover', async () => {
    await asAdminDb(async (db) => {
      const staff = await makeUser(db, {
        role: 'worker',
        permissions: ['after_hours.request', 'cash_handover.approve'],
      });
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss, floatUgx: 50_000 });
      const session = await openSession(db, staff);
      const closed = await closeSession(db, session.session_id, staff);

      await becomeClient(db, staff);
      expect(await db.expectError(`select * from app.receive_cash_handover($1, 50000, $2)`,
        [closed.handover_id, requestId('self')])).toMatch(/someone else must receive/i);
      await becomeOwner(db);
    });
  });

  it('refuses a second count', async () => {
    await asAdminDb(async (db) => {
      const { handover } = await handoverFor(db);
      const boss = await receiver(db);
      await becomeClient(db, boss);
      await db.query(`select * from app.receive_cash_handover($1, 80000, $2)`,
        [handover, requestId('receive')]);
      expect(await db.expectError(`select * from app.receive_cash_handover($1, 90000, $2)`,
        [handover, requestId('again')])).toMatch(/already been received/i);
      await becomeOwner(db);
    });
  });

  it('a shortage needs an explanation, and opens a discrepancy', async () => {
    await asAdminDb(async (db) => {
      const { session, handover } = await handoverFor(db);
      const boss = await receiver(db);
      await becomeClient(db, boss);
      expect(await db.expectError(`select * from app.receive_cash_handover($1, 75000, $2)`,
        [handover, requestId('noexplanation')])).toMatch(/reason|explanation/i);

      const { rows } = await db.query<{
        status: string; difference_ugx: string; discrepancy_number: string;
      }>(`select * from app.receive_cash_handover($1, 75000, $2, 'Five thousand missing')`,
        [handover, requestId('short')]);
      await becomeOwner(db);

      expect(rows[0].status).toBe('discrepancy');
      expect(Number(rows[0].difference_ugx)).toBe(-5_000);
      expect(rows[0].discrepancy_number).toMatch(/^RMX-AHD-\d{6}$/);
      // The session is NOT reconciled while the difference is open.
      expect((await sessionRow(db, session)).status).toBe('handover_pending');

      const { rows: d } = await db.query<{ kind: string; expected_cash_ugx: string }>(
        `select kind, expected_cash_ugx from public.cash_discrepancies where handover_id = $1`,
        [handover]);
      expect(d[0].kind).toBe('shortage');
      expect(Number(d[0].expected_cash_ugx)).toBe(80_000);
    });
  });

  it('an excess opens a discrepancy too', async () => {
    await asAdminDb(async (db) => {
      const { handover } = await handoverFor(db);
      const boss = await receiver(db);
      await becomeClient(db, boss);
      const { rows } = await db.query<{ difference_ugx: string }>(
        `select * from app.receive_cash_handover($1, 85000, $2, 'Five thousand over')`,
        [handover, requestId('over')]);
      await becomeOwner(db);
      expect(Number(rows[0].difference_ugx)).toBe(5_000);
      const { rows: d } = await db.query<{ kind: string }>(
        `select kind from public.cash_discrepancies where handover_id = $1`, [handover]);
      expect(d[0].kind).toBe('excess');
    });
  });

  it('may be received without being submitted first', async () => {
    await asAdminDb(async (db) => {
      const { handover } = await handoverFor(db);
      const boss = await receiver(db);
      await becomeClient(db, boss);
      const { rows } = await db.query<{ status: string }>(
        `select * from app.receive_cash_handover($1, 80000, $2)`, [handover, requestId('direct')]);
      await becomeOwner(db);
      expect(rows[0].status).toBe('received');
      expect((await handoverRow(db, handover)).declared_amount_ugx).toBeNull();
    });
  });

  it('is idempotent: a second tap never records a second count', async () => {
    await asAdminDb(async (db) => {
      const { handover } = await handoverFor(db);
      const boss = await receiver(db);
      const id = requestId('idem-receive');
      await becomeClient(db, boss);
      await db.query(`select * from app.receive_cash_handover($1, 80000, $2)`, [handover, id]);
      await db.query(`select * from app.receive_cash_handover($1, 80000, $2)`, [handover, id]);
      await becomeOwner(db);
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.cash_discrepancies where handover_id = $1`,
        [handover]);
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});

describe('cash handovers: the figures are frozen', () => {
  it('nothing may change the expected amount', async () => {
    await asAdminDb(async (db) => {
      const { handover } = await handoverFor(db);
      expect(await db.expectError(
        `update public.cash_handovers set expected_cash_ugx = 1 where id = $1`, [handover]))
        .toMatch(/expected cash on a handover cannot be changed/i);
    });
  });

  it('nothing may change a count once it is recorded', async () => {
    await asAdminDb(async (db) => {
      const { handover } = await handoverFor(db);
      const boss = await receiver(db);
      await becomeClient(db, boss);
      await db.query(`select * from app.receive_cash_handover($1, 80000, $2)`,
        [handover, requestId('receive')]);
      await becomeOwner(db);
      expect(await db.expectError(
        `update public.cash_handovers set actual_amount_ugx = 1 where id = $1`, [handover]))
        .toMatch(/counted handover cannot be counted again/i);
    });
  });

  it('a handover is never deleted', async () => {
    await asAdminDb(async (db) => {
      const { handover } = await handoverFor(db);
      expect(await db.expectError(`delete from public.cash_handovers where id = $1`, [handover]))
        .toMatch(/never deleted/i);
    });
  });
});

describe('cash handovers: custody, not money', () => {
  it('receiving posts nothing to the ledger and moves no balance', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      const counter = await receiver(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      const job = await invoicedJob(db, 'UAH 511X');
      expect(await collect(db, { invoice: job.invoice, amount: 15_000, by: staff })).toBeNull();
      const closed = await closeSession(db, session.session_id, staff);

      // The money reached Cash at Hand when it was COLLECTED.
      const before = await snapshot(db);
      const { rows: countBefore } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions`);

      await becomeClient(db, counter);
      await db.query(`select * from app.receive_cash_handover($1, $2, $3)`,
        [closed.handover_id, closed.expected_cash_ugx, requestId('receive')]);
      await becomeOwner(db);

      const { rows: countAfter } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions`);
      expect(countAfter[0].n).toBe(countBefore[0].n);
      expect(await snapshot(db)).toEqual(before);
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('the cash was counted as revenue exactly once, when it was collected', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      const counter = await receiver(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      const before = await balanceOf(db, 'cash_at_hand');
      const job = await invoicedJob(db, 'UAH 512X');
      expect(await collect(db, { invoice: job.invoice, amount: 15_000, by: staff })).toBeNull();
      const closed = await closeSession(db, session.session_id, staff);

      await becomeClient(db, counter);
      await db.query(`select * from app.receive_cash_handover($1, $2, $3)`,
        [closed.handover_id, closed.expected_cash_ugx, requestId('receive')]);
      await becomeOwner(db);

      expect(await balanceOf(db, 'cash_at_hand')).toBe(before + 15_000);
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions
          where reference_id = $1`, [closed.handover_id]);
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});
