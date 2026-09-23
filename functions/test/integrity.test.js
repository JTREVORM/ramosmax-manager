// Cross-phase data integrity (Phase 9): simultaneous and repeated requests
// against the Firestore emulator. Firestore transactions must leave exactly
// one outcome - never an overpayment, a double payment, negative stock, a
// second count of the same cash or two decisions on one item.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as ah from '../src/after_hours.js';
import * as billing from '../src/billing.js';
import * as expenses from '../src/expenses.js';
import * as finance from '../src/finance.js';
import * as inv from '../src/inventory.js';
import * as jobs from '../src/jobs.js';
import { emulatorDb, financeHelpers, helpers, resetAndSeed, rid } from './helpers.js';

const db = emulatorDb('integrity-tests');
const { deps, doc, world, invoicedJob, ordersOf, audits } = helpers(db);
const { balance, txns, assertLedgerConsistent } = financeHelpers(db);
const NOW = Date.now();
const all = async (collection, filter = {}) => (await db.collection(collection).get()).docs.map((d) => d.data())
  .filter((x) => Object.entries(filter).every(([k, v]) => x[k] === v));

/** Runs the calls at the same moment; returns [fulfilled values, rejection codes]. */
async function race(...calls) {
  const out = await Promise.allSettled(calls.map((c) => c()));
  return [out.filter((r) => r.status === 'fulfilled').map((r) => r.value), out.filter((r) => r.status === 'rejected').map((r) => r.reason?.code ?? r.reason?.message)];
}

beforeEach(() => resetAndSeed(db));

describe('payments', () => {
  test('two cashiers paying the same invoice at once can never overpay it', async () => {
    const w = await world();
    const { invoiceId } = await invoicedJob(w.vehicleId, [w.wash]); // UGX 15,000
    const pay = (actor) => () => billing.recordPayment(deps, actor, { invoiceId, amountUgx: 10000, method: 'cash', requestId: rid() }, NOW);
    const [ok, failed] = await race(pay('cash'), pay('mgr'));
    assert.equal(ok.length, 1);
    assert.equal(failed.length, 1);
    const i = await doc(`invoices/${invoiceId}`);
    assert.deepEqual([i.paidUgx, i.outstandingUgx, i.paymentStatus], [10000, 5000, 'partially_paid']);
    assert.equal((await all('payments', { invoiceId })).length, 1);
    assert.equal(await balance('cash_at_hand'), 10000);
    await assertLedgerConsistent();
  });

  test('the same payment request sent twice at once (double tap, retry) is recorded once', async () => {
    const w = await world();
    const { invoiceId } = await invoicedJob(w.vehicleId, [w.wash]);
    const requestId = rid();
    const send = () => billing.recordPayment(deps, 'cash', { invoiceId, amountUgx: 15000, method: 'cash', requestId }, NOW);
    const [ok] = await race(send, send, send);
    assert.ok(ok.length >= 1);
    assert.equal(new Set(ok.map((r) => r.paymentId)).size, 1, 'every success reports the same payment');
    assert.equal((await all('payments', { invoiceId })).length, 1);
    assert.equal((await txns({ type: 'customer_payment' })).length, 1, 'posted to the ledger once');
    assert.equal(await balance('cash_at_hand'), 15000);
    await assertLedgerConsistent();
  });

  test('a reversal raced with itself happens once', async () => {
    const w = await world();
    const { invoiceId } = await invoicedJob(w.vehicleId, [w.wash]);
    const p = await billing.recordPayment(deps, 'cash', { invoiceId, amountUgx: 15000, method: 'cash', requestId: rid() }, NOW);
    const reverse = () => billing.reversePayment(deps, 'admin', { paymentId: p.paymentId, reason: 'Wrong vehicle' }, NOW);
    const [ok] = await race(reverse, reverse);
    assert.equal(ok.length, 1);
    assert.equal((await txns({ type: 'reversal' })).length, 1);
    assert.equal(await balance('cash_at_hand'), 0);
    await assertLedgerConsistent();
  });
});

describe('jobs', () => {
  test('two managers assigning the same order at once: one assignment wins', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash] });
    const [o] = await ordersOf(intakeId);
    const [ok] = await race(
      () => jobs.assignWorkerOrder(deps, 'mgr', { workerOrderId: o.workerOrderId, workerId: 'wkr' }),
      () => jobs.assignWorkerOrder(deps, 'admin', { workerOrderId: o.workerOrderId, workerId: 'wkr2' }),
    );
    assert.equal(ok.length, 1);
    const after = await doc(`worker_orders/${o.workerOrderId}`);
    assert.equal(after.workerId, ok[0].workerId ?? after.workerId);
    assert.equal(after.assignmentHistory.length, 1);
  });

  test('a worker completing the same job twice at once completes it once', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash] });
    const [o] = await ordersOf(intakeId);
    await jobs.assignWorkerOrder(deps, 'mgr', { workerOrderId: o.workerOrderId, workerId: 'wkr' });
    for (const action of ['accept', 'start']) await jobs.updateWorkerOrderStatus(deps, 'wkr', { workerOrderId: o.workerOrderId, action });
    const complete = () => jobs.updateWorkerOrderStatus(deps, 'wkr', { workerOrderId: o.workerOrderId, action: 'complete' });
    const [ok, failed] = await race(complete, complete);
    assert.deepEqual([ok.length, failed.length], [1, 1]);
    assert.equal((await audits('work_order.completed')).length, 1);
  });
});

describe('expenses and stock', () => {
  test('one approval and one payment per expense, however many arrive at once', async () => {
    await finance.recordOpeningBalance(deps, 'admin', { accountId: 'cash_at_hand', amountUgx: 1_000_000 });
    const { expenseId } = await expenses.createExpense(deps, 'cash', {
      categoryId: 'utilities', description: 'Power', amountUgx: 150_000, payee: 'UMEME', requestId: rid(), submit: true,
    });
    await expenses.updateExpenseStatus(deps, 'mgr', { expenseId, action: 'review', notes: 'Checked' });
    const approve = (actor) => () => expenses.updateExpenseStatus(deps, actor, { expenseId, action: 'approve' });
    const [approved] = await race(approve('mgr'), approve('admin'));
    assert.equal(approved.length, 1);
    assert.equal((await audits('expense.approved')).length, 1);
    const payIt = () => expenses.payExpense(deps, 'admin', { expenseId, accountId: 'cash_at_hand', requestId: rid() });
    const [paid] = await race(payIt, payIt);
    assert.equal(paid.length, 1);
    assert.equal(await balance('cash_at_hand'), 850_000, 'money left the account once');
    assert.equal((await txns({ type: 'expense_payment' })).length, 1);
    await assertLedgerConsistent();
  });

  test('simultaneous stock usage can never take stock below zero', async () => {
    const { itemId } = await inv.createInventoryItem(deps, 'mgr', {
      name: 'Car Shampoo', category: 'chemicals', unit: 'bottle', minimumStock: 1, reorderLevel: 2, openingQuantity: 5,
    });
    const use = () => inv.recordStockMovement(deps, 'mgr', { itemId, type: 'usage', quantity: 2, reason: 'Wash', requestId: rid() });
    const [ok, failed] = await race(use, use, use, use);
    assert.equal(ok.length, 2);
    assert.equal(failed.length, 2);
    const item = await doc(`inventory_items/${itemId}`);
    assert.equal(item.quantity, 1);
    const moves = await all('stock_movements', { itemId });
    assert.equal(moves.reduce((q, m) => q + m.quantityChange, 0), 1, 'stock equals the sum of its movements');
  });
});

describe('after-hours cash', () => {
  test('two managers receiving the same handover at once count it once', async () => {
    const w = await world();
    const { invoiceId } = await invoicedJob(w.vehicleId, [w.wash]);
    const H = 3600_000;
    await ah.authorizeAfterHours(deps, 'mgr', { staffUid: 'wkr', startsAt: NOW, expiresAt: NOW + 4 * H, reason: 'Evening cover', requestId: rid() }, NOW);
    const s = await ah.openAfterHoursSession(deps, 'wkr', { requestId: rid() }, NOW);
    await billing.recordPayment(deps, 'wkr', { invoiceId, amountUgx: 15000, method: 'cash', requestId: rid() }, NOW);
    const { handoverId } = await ah.closeAfterHoursSession(deps, 'wkr', { sessionId: s.sessionId }, NOW);
    const receive = (actor, amount) => () => ah.receiveCashHandover(deps, actor, { handoverId, actualAmountUgx: amount, explanation: 'Counted', requestId: rid() }, NOW);
    const [ok, failed] = await race(receive('mgr', 15000), receive('admin', 10000));
    assert.deepEqual([ok.length, failed.length], [1, 1]);
    const h = await doc(`cash_handovers/${handoverId}`);
    assert.equal(h.actualAmountUgx, ok[0].differenceUgx + 15000);
    assert.ok((await all('cash_discrepancies')).length <= 1);
    assert.equal((await txns({ type: 'customer_payment' })).length, 1, 'the handover added no ledger entry');
    await assertLedgerConsistent();
  });

  test('two sessions opened at once for the same worker: only one is open', async () => {
    const H = 3600_000;
    await ah.authorizeAfterHours(deps, 'mgr', { staffUid: 'wkr', startsAt: NOW, expiresAt: NOW + 4 * H, reason: 'Evening cover', requestId: rid() }, NOW);
    const openIt = () => ah.openAfterHoursSession(deps, 'wkr', { requestId: rid() }, NOW);
    const [ok] = await race(openIt, openIt, openIt);
    assert.equal(ok.length, 1);
    assert.equal((await all('after_hours_sessions', { status: 'open' })).length, 1);
  });
});
