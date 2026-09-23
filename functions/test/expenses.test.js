// Expenses: categories, the review/approval workflow, payment, recurring
// bills (Phase 5) - against the Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as expenses from '../src/expenses.js';
import * as finance from '../src/finance.js';
import { emulatorDb, financeHelpers, helpers, rejects, resetAndSeed, rid } from './helpers.js';

const db = emulatorDb('expenses-tests');
const { deps, doc, audits } = helpers(db);
const { balance, txns, today, assertLedgerConsistent } = financeHelpers(db);

beforeEach(async () => {
  await resetAndSeed(db);
  await finance.recordOpeningBalance(deps, 'admin', { accountId: 'cash_at_hand', amountUgx: 1_000_000 });
});

const DAY = 86_400_000;
const create = (actor, extra = {}) => expenses.createExpense(deps, actor, {
  categoryId: 'utilities', description: 'Office electricity', amountUgx: 150_000, payee: 'UMEME', requestId: rid(), ...extra,
});
const act = (actor, expenseId, action, extra = {}) => expenses.updateExpenseStatus(deps, actor, { expenseId, action, ...extra });
const payIt = (actor, expenseId, extra = {}) => expenses.payExpense(deps, actor, { expenseId, accountId: 'cash_at_hand', requestId: rid(), ...extra });

/** create (submitted) → review → approve. */
async function approved(amountUgx = 150_000) {
  const { expenseId } = await create('cash', { amountUgx, submit: true });
  await act('mgr', expenseId, 'review', { notes: 'Bill checked' });
  await act('mgr', expenseId, 'approve');
  return expenseId;
}

describe('creating expenses', () => {
  test('draft or submitted; RMX-EXP numbers; category snapshot; audited', async () => {
    const a = await create('cash');
    assert.deepEqual([a.expenseNumber, a.status], ['RMX-EXP-000001', 'draft']);
    const b = await create('mgr', { submit: true, categoryId: 'financial_charges' });
    assert.deepEqual([b.expenseNumber, b.status], ['RMX-EXP-000002', 'pending_review']);
    const e = await doc(`expenses/${b.expenseId}`);
    assert.deepEqual([e.categoryName, e.amountUgx, e.createdBy, e.payee], ['Financial Charges', 150_000, 'mgr', 'UMEME']);
    assert.equal((await audits('expense.created')).length, 2);
  });

  test('creating (or approving) an expense does not touch any balance', async () => {
    const id = await approved();
    assert.equal((await doc(`expenses/${id}`)).status, 'approved');
    assert.equal(await balance('cash_at_hand'), 1_000_000);
    assert.equal((await txns({ type: 'expense_payment' })).length, 0);
  });

  test('validation and tampering', async () => {
    for (const amountUgx of [0, -1, 1.5, '150000', 3_000_000_000]) await rejects(create('mgr', { amountUgx }), 'invalid-argument', 'amount');
    await rejects(create('mgr', { categoryId: 'bribes' }), 'invalid-argument', 'category');
    await rejects(create('mgr', { description: ' ' }), 'invalid-argument', 'required');
    await rejects(create('mgr', { requestId: 'x' }), 'invalid-argument', 'request_id');
    await rejects(create('mgr', { attachmentPath: '../../secret' }), 'invalid-argument', 'attachment');
    // Status, payment and approval fields sent by the client are ignored.
    const r = await create('cash', { status: 'paid', approvedBy: 'cash', paidAt: 1, financialTransactionId: 'x' });
    const e = await doc(`expenses/${r.expenseId}`);
    assert.deepEqual([e.status, e.approvedBy, e.paidAt, e.financialTransactionId], ['draft', null, null, null]);
  });

  test('duplicate create request makes one expense', async () => {
    const requestId = 'expense-dup-1';
    const a = await create('mgr', { requestId });
    const b = await create('mgr', { requestId });
    assert.equal(b.expenseId, a.expenseId);
    assert.equal((await db.collection('expenses').get()).size, 1);
  });

  test('who may create: admin, manager, cashier; not workers, auditors, shareholders or inactive accounts', async () => {
    for (const uid of ['wkr', 'aud', 'sh', 'mgrOff', 'mgrPending']) await rejects(create(uid), 'permission-denied');
    for (const uid of ['admin', 'mgr', 'cash']) assert.ok((await create(uid)).expenseId);
  });

  test('editing: drafts and unreviewed expenses only, by the creator or a reviewer; audited', async () => {
    const { expenseId } = await create('cash');
    await expenses.updateExpense(deps, 'cash', { expenseId, amountUgx: 160_000, reason: 'Late fee added' });
    assert.equal((await doc(`expenses/${expenseId}`)).amountUgx, 160_000);
    await rejects(expenses.updateExpense(deps, 'cash', { expenseId, amountUgx: 160_000 }), 'failed-precondition', 'no_changes');
    const [log] = await audits('expense.updated');
    assert.deepEqual([log.previousValue.amountUgx, log.newValue.amountUgx], [150_000, 160_000]);
    const other = await create('mgr');
    await rejects(expenses.updateExpense(deps, 'cash', { expenseId: other.expenseId, amountUgx: 1 }), 'permission-denied');
    await act('cash', expenseId, 'submit');
    await act('mgr', expenseId, 'review');
    await rejects(expenses.updateExpense(deps, 'cash', { expenseId, amountUgx: 1 }), 'failed-precondition', 'not_editable');
  });
});

describe('workflow: create → review → approve → pay', () => {
  test('paying: account −amount, status PAID, ledger entry, daily totals by category - atomically', async () => {
    const id = await approved();
    const r = await payIt('mgr', id, { reference: 'UMEME-RCPT-9' });
    assert.equal(r.balanceUgx, 850_000);
    assert.equal(await balance('cash_at_hand'), 850_000);
    const e = await doc(`expenses/${id}`);
    assert.deepEqual([e.status, e.paidBy, e.paidFromAccountId, e.financialTransactionId], ['paid', 'mgr', 'cash_at_hand', r.transactionId]);
    const t = await doc(`financial_transactions/${r.transactionId}`);
    assert.deepEqual([t.type, t.amountUgx, t.sourceAccountId, t.expenseId, t.categoryId, t.isRevenue], ['expense_payment', 150_000, 'cash_at_hand', id, 'utilities', false]);
    const day = await today();
    assert.equal(day.expensesPaidUgx, 150_000);
    assert.equal(day.expensesByCategory.utilities, 150_000);
    for (const action of ['expense.reviewed', 'expense.approved', 'expense.paid']) assert.equal((await audits(action)).length, 1, action);
    await assertLedgerConsistent();
  });

  test('order is enforced: no approval before review, no payment before approval, no second payment', async () => {
    const { expenseId } = await create('cash', { submit: true });
    await rejects(act('mgr', expenseId, 'approve'), 'failed-precondition', 'not_reviewed');
    await rejects(payIt('mgr', expenseId), 'failed-precondition', 'not_approved');
    await act('mgr', expenseId, 'review');
    await rejects(act('mgr', expenseId, 'review'), 'failed-precondition', 'already_reviewed');
    await act('mgr', expenseId, 'approve');
    await payIt('mgr', expenseId);
    await rejects(payIt('mgr', expenseId), 'failed-precondition', 'already_paid');
    await rejects(act('mgr', expenseId, 'cancel', { reason: 'Too late' }), 'failed-precondition', 'invalid_status');
    assert.equal(await balance('cash_at_hand'), 850_000);
  });

  test('a duplicate pay request pays once', async () => {
    const id = await approved();
    const requestId = 'pay-dup-1';
    const a = await payIt('mgr', id, { requestId });
    const b = await payIt('mgr', id, { requestId });
    assert.equal(b.duplicate, true);
    assert.equal(b.transactionId, a.transactionId);
    assert.equal(await balance('cash_at_hand'), 850_000);
    assert.equal((await txns({ type: 'expense_payment' })).length, 1);
  });

  test('insufficient funds: refused, expense stays approved, nothing moves', async () => {
    const id = await approved(1_000_001);
    await rejects(payIt('mgr', id), 'failed-precondition', 'insufficient_funds');
    assert.equal((await doc(`expenses/${id}`)).status, 'approved');
    assert.equal(await balance('cash_at_hand'), 1_000_000);
  });

  test('reject and cancel need reasons', async () => {
    const a = await create('cash', { submit: true });
    await rejects(act('mgr', a.expenseId, 'reject'), 'invalid-argument', 'reason');
    await act('mgr', a.expenseId, 'reject', { reason: 'Duplicate bill' });
    const e = await doc(`expenses/${a.expenseId}`);
    assert.deepEqual([e.status, e.rejectionReason, e.rejectedBy], ['rejected', 'Duplicate bill', 'mgr']);
    const b = await create('cash');
    await rejects(act('mgr', b.expenseId, 'cancel'), 'invalid-argument', 'reason');
    await act('mgr', b.expenseId, 'cancel', { reason: 'Entered twice' });
    assert.equal((await doc(`expenses/${b.expenseId}`)).status, 'cancelled');
    await rejects(act('mgr', b.expenseId, 'submit'), 'failed-precondition', 'invalid_status');
    await rejects(act('mgr', b.expenseId, 'explode'), 'invalid-argument', 'action');
    assert.equal((await db.collection('expenses').get()).size, 2, 'nothing deleted');
  });

  test('permissions: cashiers create but never review, approve, pay or cancel; auditors and workers do nothing', async () => {
    const { expenseId } = await create('cash', { submit: true });
    for (const uid of ['cash', 'wkr', 'aud', 'sh']) {
      await rejects(act(uid, expenseId, 'review'), 'permission-denied');
      await rejects(act(uid, expenseId, 'approve'), 'permission-denied');
      await rejects(act(uid, expenseId, 'cancel', { reason: 'Not needed' }), 'permission-denied');
    }
    await act('mgr', expenseId, 'review');
    await act('mgr', expenseId, 'approve');
    for (const uid of ['cash', 'wkr', 'aud', 'sh', 'mgrOff']) await rejects(payIt(uid, expenseId), 'permission-denied');
  });

  test('a paid expense is corrected by reversing its payment (expenses.adjust): money back, status approved', async () => {
    const id = await approved();
    const paid = await payIt('mgr', id);
    await rejects(finance.reverseFinancialTransaction(deps, 'mgr', { transactionId: paid.transactionId, reason: 'Paid twice' }), 'permission-denied');
    await finance.reverseFinancialTransaction(deps, 'admin', { transactionId: paid.transactionId, reason: 'Paid from the wrong account' });
    assert.equal(await balance('cash_at_hand'), 1_000_000);
    const e = await doc(`expenses/${id}`);
    assert.deepEqual([e.status, e.paymentReversalReason], ['approved', 'Paid from the wrong account']);
    assert.equal((await today()).expensesByCategory.utilities, 0);
    await payIt('mgr', id, { accountId: 'cash_at_hand' });
    assert.equal(await balance('cash_at_hand'), 850_000);
    await assertLedgerConsistent();
  });
});

describe('categories', () => {
  test('built-in categories need no setup; custom ones can be added, renamed and retired', async () => {
    const { categoryId } = await expenses.createExpenseCategory(deps, 'mgr', { name: 'Security Services' });
    assert.equal(categoryId, 'security_services');
    await rejects(expenses.createExpenseCategory(deps, 'mgr', { name: 'security services' }), 'already-exists', 'duplicate_category');
    await rejects(expenses.createExpenseCategory(deps, 'mgr', { name: 'Utilities' }), 'already-exists', 'duplicate_category');
    await rejects(expenses.createExpenseCategory(deps, 'cash', { name: 'Snacks' }), 'permission-denied');
    await rejects(expenses.createExpenseCategory(deps, 'aud', { name: 'Snacks' }), 'permission-denied');
    assert.ok((await create('mgr', { categoryId })).expenseId);
    await rejects(expenses.updateExpenseCategory(deps, 'mgr', { categoryId: 'marketing', active: false }), 'invalid-argument', 'reason');
    await expenses.updateExpenseCategory(deps, 'mgr', { categoryId: 'marketing', active: false, reason: 'Not used' });
    await rejects(create('mgr', { categoryId: 'marketing' }), 'invalid-argument', 'inactive_category');
    await expenses.updateExpenseCategory(deps, 'mgr', { categoryId: 'office', name: 'Office & Stationery' });
    assert.equal((await doc('expense_categories/office')).name, 'Office & Stationery');
  });
});

describe('recurring expenses', () => {
  const now = Date.UTC(2026, 8, 21, 6); // 09:00 EAT, 21 Sep 2026
  const eatDay = (y, m, d) => Date.UTC(y, m - 1, d) - 3 * 3600_000;
  const recurring = (actor, extra = {}) => expenses.createRecurringExpense(deps, actor, {
    name: 'Office rent', categoryId: 'premises', expectedAmountUgx: 800_000, frequency: 'monthly',
    nextDueDate: eatDay(2026, 9, 25), payee: 'Landlord', reminderDaysBefore: 5, paymentAccountId: 'cash_at_hand', ...extra,
  }, now);

  test('due-date arithmetic keeps the anchor day and clamps short months', () => {
    assert.equal(expenses.advanceDueDate(eatDay(2026, 1, 31), 'monthly', 31), eatDay(2026, 2, 28));
    assert.equal(expenses.advanceDueDate(eatDay(2026, 2, 28), 'monthly', 31), eatDay(2026, 3, 31));
    assert.equal(expenses.advanceDueDate(eatDay(2026, 9, 21), 'weekly'), eatDay(2026, 9, 28));
    assert.equal(expenses.advanceDueDate(eatDay(2026, 11, 30), 'quarterly', 30), eatDay(2027, 2, 28));
    assert.equal(expenses.advanceDueDate(eatDay(2028, 2, 29), 'yearly', 29), eatDay(2029, 2, 28));
    assert.equal(expenses.advanceDueDate(eatDay(2026, 12, 15), 'monthly', 15), eatDay(2027, 1, 15));
  });

  test('create, edit and deactivate (with a reason); permissions; validation', async () => {
    for (const uid of ['cash', 'wkr', 'aud']) await rejects(recurring(uid), 'permission-denied');
    await rejects(recurring('mgr', { frequency: 'daily' }), 'invalid-argument', 'frequency');
    await rejects(recurring('mgr', { reminderDaysBefore: 45 }), 'invalid-argument', 'reminder');
    await rejects(recurring('mgr', { expectedAmountUgx: 0 }), 'invalid-argument', 'amount');
    const { recurringExpenseId } = await recurring('mgr');
    let r = await doc(`recurring_expenses/${recurringExpenseId}`);
    assert.deepEqual([r.active, r.frequency, r.categoryName, r.reminderAt.toMillis()], [true, 'monthly', 'Premises', eatDay(2026, 9, 20)]);
    await expenses.updateRecurringExpense(deps, 'mgr', { recurringExpenseId, expectedAmountUgx: 850_000, reminderDaysBefore: 2 }, now);
    r = await doc(`recurring_expenses/${recurringExpenseId}`);
    assert.deepEqual([r.expectedAmountUgx, r.reminderAt.toMillis()], [850_000, eatDay(2026, 9, 23)]);
    await rejects(expenses.updateRecurringExpense(deps, 'mgr', { recurringExpenseId, active: false }, now), 'invalid-argument', 'reason');
    await expenses.updateRecurringExpense(deps, 'mgr', { recurringExpenseId, active: false, reason: 'Moved premises' }, now);
    assert.equal((await doc(`recurring_expenses/${recurringExpenseId}`)).active, false);
    assert.equal((await audits('recurring_expense.deactivated')).length, 1);
  });

  test('the sweep creates one draft due item per due date, notifies approvers, advances the date and never pays', async () => {
    const sent = [];
    const notifyDeps = { db, notify: async (uid, type, id) => sent.push([uid, type, id]) };
    const { recurringExpenseId } = await recurring('mgr');
    const { recurringExpenseId: later } = await recurring('mgr', { name: 'Internet', nextDueDate: eatDay(2026, 10, 30) });
    const { recurringExpenseId: off } = await recurring('mgr', { name: 'Old lease' });
    await expenses.updateRecurringExpense(deps, 'mgr', { recurringExpenseId: off, active: false, reason: 'Ended' }, now);

    const r = await expenses.sweepRecurringExpenses(notifyDeps, now);
    assert.equal(r.created, 1);
    const [e] = (await db.collection('expenses').get()).docs.map((d) => d.data());
    assert.deepEqual([e.status, e.amountUgx, e.recurringExpenseId, e.description, e.createdBy, e.dueDate.toMillis()],
      ['draft', 800_000, recurringExpenseId, 'Office rent', 'system', eatDay(2026, 9, 25)]);
    const rec = await doc(`recurring_expenses/${recurringExpenseId}`);
    assert.equal(rec.nextDueDate.toMillis(), eatDay(2026, 10, 25));
    assert.equal((await doc(`recurring_expenses/${later}`)).lastGeneratedExpenseId, null);
    assert.ok(sent.length >= 2 && sent.every(([, type, id]) => type === 'recurring_expense_due' && id === e.expenseId));
    assert.ok(sent.some(([uid]) => uid === 'mgr') && sent.some(([uid]) => uid === 'admin'));
    assert.ok(!sent.some(([uid]) => ['cash', 'wkr', 'aud'].includes(uid)));
    assert.equal(await balance('cash_at_hand'), 1_000_000, 'never paid automatically');

    // Running again at the same time creates nothing new.
    assert.equal((await expenses.sweepRecurringExpenses(notifyDeps, now)).created, 0);
    // Five weeks later both the rent and the internet bill are due.
    assert.equal((await expenses.sweepRecurringExpenses(notifyDeps, now + 35 * DAY)).created, 2);
    assert.equal((await audits('recurring_expense.due')).length, 3);
  });
});
