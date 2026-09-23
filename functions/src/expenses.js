// ===========================================================================
// RamosMAX expenses - categories, the approval workflow, payment and
// recurring bills (Phase 5).
// ===========================================================================
//
//   draft ──submit──► pending_review ──review──► (reviewed) ──approve──► approved ──pay──► paid
//                         │                                                  │
//                         └──reject (reason)──► rejected                     │
//   draft / pending_review / approved ──cancel (reason)──► cancelled         │
//   paid ──reverse payment (expenses.adjust, reason)──► approved ◄───────────┘
//
// Creating, reviewing or approving an expense moves NO money. Only payExpense
// takes the amount out of a financial account, in one transaction with the
// `expense_payment` ledger entry and the status change (finance.js).
// Inventory purchases are NOT expenses (see inventory.js / docs/EXPENSES.md).
// ===========================================================================

import { createRequire } from 'node:module';
import { Timestamp } from 'firebase-admin/firestore';

import { invalid, optionalText, precondition, requirePermission, requireReason } from './access.js';
import { alreadyExists, audit, freshActor, notFound, requireDocId, stamp, uniqueRef } from './operations.js';
import { NotificationType, notifySafely, requireObject } from './user_admin.js';
import {
  dayStart, holdersOf, openLedger, optionalAttachment, readCounter, readRequest, requireAmount, requireBusinessDate,
  requireChoice, requireRequestId, requireText, saveRequest,
} from './finance.js';

const require = createRequire(import.meta.url);
const catalog = require('./access_catalog.json');

export const EXPENSES = 'expenses';
export const CATEGORIES = 'expense_categories';
export const RECURRING = 'recurring_expenses';

const LABELS = {
  utilities: 'Utilities', operations: 'Operations', premises: 'Premises', repairs: 'Repairs',
  financial_charges: 'Financial Charges', marketing: 'Marketing', transport: 'Transport', office: 'Office',
  licences: 'Licences', miscellaneous: 'Miscellaneous',
};
/** Built-in categories (id → name). Stored only once someone edits them. */
export const DEFAULT_CATEGORIES = Object.freeze(Object.fromEntries(catalog.expenseCategories.map((k) => [k, LABELS[k]])));

export const EXPENSE_STATUSES = Object.freeze(['draft', 'pending_review', 'approved', 'rejected', 'paid', 'cancelled']);
export const FREQUENCIES = Object.freeze(['weekly', 'monthly', 'quarterly', 'yearly']);
const EDITABLE = new Set(['draft', 'pending_review']);
const CANCELLABLE = new Set(['draft', 'pending_review', 'approved']);

const actorOf = (a) => ({ by: a.uid, byName: a.data.fullName ?? null });

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const categoryKey = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

/** {id, name} of an active category (stored, or built-in and never edited). */
export async function readCategory(tx, db, id) {
  const categoryId = requireDocId(id, 'category');
  const snap = await tx.get(db.collection(CATEGORIES).doc(categoryId));
  if (snap.exists) {
    if (snap.get('active') !== true) throw invalid(`"${snap.get('name')}" is no longer in use.`, 'inactive_category');
    return { id: categoryId, name: snap.get('name') };
  }
  if (DEFAULT_CATEGORIES[categoryId]) return { id: categoryId, name: DEFAULT_CATEGORIES[categoryId] };
  throw invalid('Choose a valid category.', 'category');
}

async function allCategoryNames(tx, db) {
  const snap = await tx.get(db.collection(CATEGORIES));
  const names = new Map(Object.entries(DEFAULT_CATEGORIES));
  for (const d of snap.docs) names.set(d.id, d.get('name'));
  return names;
}

export async function createExpenseCategory(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const name = requireText(data.name, 'Category name', 40);
  const id = categoryKey(name);
  if (!id) throw invalid('Use letters or digits in the category name.', 'name');
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'expenses.categories.manage');
    const names = await allCategoryNames(tx, db);
    if (names.has(id) || [...names.values()].some((n) => n.toLowerCase() === name.toLowerCase())) {
      throw alreadyExists(`A category called "${name}" already exists.`, 'duplicate_category');
    }
    tx.set(db.collection(CATEGORIES).doc(id), {
      categoryId: id, name, active: true, isDefault: false,
      createdAt: stamp(), updatedAt: stamp(), createdBy: actor.uid, updatedBy: actor.uid,
    });
    audit(tx, db, actor, 'expenses', 'expense_category.created', id, { newValue: { name } });
    return { categoryId: id };
  });
}

export async function updateExpenseCategory(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const id = requireDocId(data.categoryId, 'category');
  const name = 'name' in data ? requireText(data.name, 'Category name', 40) : null;
  const active = 'active' in data ? data.active === true : null;
  const reason = requireReason(data.reason, { required: active === false });
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'expenses.categories.manage');
    const names = await allCategoryNames(tx, db);
    if (!names.has(id)) throw notFound('That category could not be found.');
    const ref = db.collection(CATEGORIES).doc(id);
    const snap = await tx.get(ref);
    const before = snap.exists ? snap.data() : { categoryId: id, name: DEFAULT_CATEGORIES[id], active: true, isDefault: true };
    const update = {};
    if (name && name !== before.name) {
      if ([...names.entries()].some(([k, n]) => k !== id && n.toLowerCase() === name.toLowerCase())) {
        throw alreadyExists(`A category called "${name}" already exists.`, 'duplicate_category');
      }
      update.name = name;
    }
    if (active !== null && active !== before.active) update.active = active;
    if (Object.keys(update).length === 0) throw precondition('Nothing has changed.', 'no_changes');
    tx.set(ref, { ...before, ...update, updatedAt: stamp(), updatedBy: actor.uid, ...(snap.exists ? {} : { createdAt: stamp(), createdBy: actor.uid }) });
    audit(tx, db, actor, 'expenses', 'expense_category.updated', id, {
      previousValue: Object.fromEntries(Object.keys(update).map((k) => [k, before[k]])), newValue: update, reason,
    });
    return { categoryId: id };
  });
}

// ---------------------------------------------------------------------------
// Expense records
// ---------------------------------------------------------------------------

const EXPENSE_FIELDS = ['categoryId', 'description', 'amountUgx', 'expenseDate', 'payee', 'paymentAccountId', 'reference', 'attachmentPath', 'notes'];

function expenseInput(data, now, { partial }) {
  const out = {};
  const has = (k) => !partial || k in data;
  if (has('categoryId')) out.categoryId = requireDocId(data.categoryId, 'category');
  if (has('description')) out.description = requireText(data.description, 'Description', 200);
  if (has('amountUgx')) out.amountUgx = requireAmount(data.amountUgx);
  if (has('expenseDate')) out.expenseDate = requireBusinessDate(data.expenseDate, now, { field: 'expense date', futureDays: 366 });
  if (has('payee')) out.payee = optionalText(data.payee, 'Vendor / payee', 80);
  if (has('paymentAccountId')) out.paymentAccountId = data.paymentAccountId == null ? null : requireDocId(data.paymentAccountId, 'account');
  if (has('reference')) out.reference = optionalText(data.reference, 'Reference', 60);
  if (has('attachmentPath')) out.attachmentPath = optionalAttachment(data.attachmentPath, 'expenses');
  if (has('notes')) out.notes = optionalText(data.notes, 'Notes', 500);
  return out;
}

async function readExpense(tx, db, id) {
  const ref = db.collection(EXPENSES).doc(requireDocId(id, 'expense'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That expense could not be found.');
  return { ref, expense: snap.data() };
}

function newExpense(ref, number, input, category, status, actor, extra = {}) {
  return {
    expenseId: ref.id,
    expenseNumber: number,
    ...input,
    categoryName: category.name,
    status,
    reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNotes: null,
    approvedBy: null, approvedByName: null, approvedAt: null,
    rejectedBy: null, rejectedAt: null, rejectionReason: null,
    paidBy: null, paidByName: null, paidAt: null, paidFromAccountId: null, paidFromAccountName: null,
    financialTransactionId: null, financialTransactionNumber: null,
    cancelledBy: null, cancelledAt: null, cancelReason: null,
    submittedAt: status === 'pending_review' ? stamp() : null,
    recurringExpenseId: null,
    dueDate: null,
    createdBy: actor.uid,
    createdByName: actor.data.fullName ?? null,
    createdAt: stamp(),
    updatedAt: stamp(),
    updatedBy: actor.uid,
    ...extra,
  };
}

export async function createExpense(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const input = expenseInput(data, now, { partial: false });
  const requestId = requireRequestId(data.requestId);
  const status = data.submit === true ? 'pending_review' : 'draft';

  let fresh = false;
  const result = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'expenses.create');
    const request = await readRequest(tx, db, requestId, actor.uid, 'expense');
    if (request.earlier) return request.earlier;
    fresh = true;
    const category = await readCategory(tx, db, input.categoryId);
    const numbers = await readCounter(tx, db, 'expenses', 'RMX-EXP-', 6);
    const ref = db.collection(EXPENSES).doc();
    const number = numbers.next();
    numbers.commit();
    tx.set(ref, newExpense(ref, number, input, category, status, actor, { requestId }));
    const result = { expenseId: ref.id, expenseNumber: number, status };
    saveRequest(tx, request.ref, 'expense', actor.uid, result);
    audit(tx, db, actor, 'expenses', 'expense.created', ref.id, {
      newValue: { expenseNumber: number, categoryId: category.id, amountUgx: input.amountUgx, status },
    });
    return result;
  });
  if (fresh && result.status === 'pending_review') await notifyReviewers(deps, result.expenseId, callerUid, now);
  return result;
}

/** Phase 9: reviewers and approvers hear about an expense waiting for them (not its author). */
async function notifyReviewers(deps, expenseId, exceptUid, now) {
  for (const uid of await holdersOf(deps.db, ['expenses.review', 'expenses.approve'], now)) {
    if (uid !== exceptUid) await notifySafely(deps, uid, NotificationType.expenseAwaitingApproval, expenseId);
  }
}

/** Changes an expense that nobody has reviewed yet. Money never moves here. */
export async function updateExpense(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const changes = expenseInput(data, now, { partial: true });
  const reason = requireReason(data.reason, { required: false });
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'expenses.create');
    const { ref, expense } = await readExpense(tx, db, data.expenseId);
    if (!EDITABLE.has(expense.status) || expense.reviewedAt) {
      throw precondition('Only a draft or an unreviewed expense can be edited.', 'not_editable');
    }
    if (expense.createdBy !== actor.uid) requirePermission(actor.perms, 'expenses.review');
    const category = 'categoryId' in changes ? await readCategory(tx, db, changes.categoryId) : null;
    const changed = EXPENSE_FIELDS.filter((k) => k in changes && String(changes[k]?.toMillis?.() ?? changes[k]) !== String(expense[k]?.toMillis?.() ?? expense[k]));
    if (changed.length === 0) throw precondition('Nothing has changed.', 'no_changes');
    const update = Object.fromEntries(changed.map((k) => [k, changes[k]]));
    if (category) update.categoryName = category.name;
    tx.update(ref, { ...update, updatedAt: stamp(), updatedBy: actor.uid });
    const plain = (v) => v?.toMillis?.() ?? v ?? null;
    audit(tx, db, actor, 'expenses', 'expense.updated', ref.id, {
      previousValue: Object.fromEntries(changed.map((k) => [k, plain(expense[k])])),
      newValue: Object.fromEntries(changed.map((k) => [k, plain(changes[k])])),
      reason,
    });
    return { expenseId: ref.id };
  });
}

/** submit · review · approve · reject · cancel. */
export const EXPENSE_ACTIONS = Object.freeze({
  submit: { permissions: ['expenses.create'], from: ['draft'] },
  review: { permissions: ['expenses.review'], from: ['pending_review'] },
  approve: { permissions: ['expenses.approve'], from: ['pending_review'] },
  reject: { permissions: ['expenses.review', 'expenses.approve'], from: ['pending_review'], reason: true },
  cancel: { permissions: ['expenses.cancel'], from: [...CANCELLABLE], reason: true },
});

export async function updateExpenseStatus(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const action = Object.hasOwn(EXPENSE_ACTIONS, data.action) ? data.action : null;
  if (!action) throw invalid('Choose a valid action.', 'action');
  const rule = EXPENSE_ACTIONS[action];
  const reason = requireReason(data.reason, { required: Boolean(rule.reason) });
  const notes = optionalText(data.notes, 'Notes', 500);

  let author = null;
  const result = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, ...rule.permissions);
    const { ref, expense } = await readExpense(tx, db, data.expenseId);
    author = expense.createdBy ?? null;
    if (!rule.from.includes(expense.status)) {
      throw precondition(expense.status === 'paid' ? 'This expense has already been paid.' : `This expense is ${expense.status.replace('_', ' ')}.`, 'invalid_status');
    }
    if (action === 'submit' && expense.createdBy !== actor.uid) requirePermission(actor.perms, 'expenses.review');
    if (action === 'review' && expense.reviewedAt) throw precondition('This expense has already been reviewed.', 'already_reviewed');
    if (action === 'approve' && !expense.reviewedAt) throw precondition('Review the expense before approving it.', 'not_reviewed');
    const at = Timestamp.fromMillis(now);
    const who = actorOf(actor);
    const update = {
      submit: { status: 'pending_review', submittedAt: at },
      review: { reviewedBy: who.by, reviewedByName: who.byName, reviewedAt: at, reviewNotes: notes },
      approve: { status: 'approved', approvedBy: who.by, approvedByName: who.byName, approvedAt: at },
      reject: { status: 'rejected', rejectedBy: who.by, rejectedAt: at, rejectionReason: reason },
      cancel: { status: 'cancelled', cancelledBy: who.by, cancelledAt: at, cancelReason: reason },
    }[action];
    tx.update(ref, { ...update, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'expenses', `expense.${{ submit: 'submitted', review: 'reviewed', approve: 'approved', reject: 'rejected', cancel: 'cancelled' }[action]}`, ref.id, {
      previousValue: { status: expense.status },
      newValue: { status: update.status ?? expense.status, amountUgx: expense.amountUgx },
      reason: reason ?? notes,
    });
    return { expenseId: ref.id, status: update.status ?? expense.status };
  });
  // Phase 9: submitted → reviewers; approved / rejected → the person who recorded it.
  if (action === 'submit') await notifyReviewers(deps, result.expenseId, callerUid, now);
  if ((action === 'approve' || action === 'reject') && author && author !== callerUid) {
    await notifySafely(deps, author, NotificationType.expenseDecided, result.expenseId);
  }
  return result;
}

/** The only step that moves money: account −amount, expense PAID, ledger entry - atomically. */
export async function payExpense(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const requestId = requireRequestId(data.requestId);
  const reference = optionalText(data.reference, 'Payment reference', 60);
  const at = requireBusinessDate(data.paymentDate, now, { field: 'payment date' });

  let paidFor = null;
  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'expenses.pay');
    const request = await readRequest(tx, db, requestId, actor.uid, 'expense_payment');
    if (request.earlier) return request.earlier;
    const { ref, expense } = await readExpense(tx, db, data.expenseId);
    if (expense.status === 'paid') throw precondition('This expense has already been paid.', 'already_paid');
    if (expense.status !== 'approved') throw precondition('Only an approved expense can be paid.', 'not_approved');
    const accountId = requireDocId(data.accountId ?? expense.paymentAccountId, 'payment account');
    const ledger = await openLedger(tx, db, [accountId], now);
    const account = ledger.requireActive(accountId, actor.uid);
    const r = ledger.post({
      type: 'expense_payment', amountUgx: expense.amountUgx, fromId: accountId, actor, at, categoryId: expense.categoryId,
      fields: {
        expenseId: ref.id, expenseNumber: expense.expenseNumber, reference: reference ?? expense.reference ?? null,
        description: `${expense.expenseNumber}: ${expense.description}`, approvedBy: expense.approvedBy, requestId,
      },
    });
    ledger.commit(actor.uid);
    tx.update(ref, {
      status: 'paid', paidBy: actor.uid, paidByName: actor.data.fullName ?? null, paidAt: at,
      paidFromAccountId: accountId, paidFromAccountName: account.name, paymentReference: reference,
      financialTransactionId: r.transactionId, financialTransactionNumber: r.transactionNumber,
      updatedAt: stamp(), updatedBy: actor.uid,
    });
    const result = { expenseId: ref.id, ...r, balanceUgx: ledger.balance(accountId) };
    saveRequest(tx, request.ref, 'expense_payment', actor.uid, result);
    audit(tx, db, actor, 'expenses', 'expense.paid', ref.id, {
      previousValue: { status: 'approved' },
      newValue: { status: 'paid', amountUgx: expense.amountUgx, accountId, transactionNumber: r.transactionNumber },
    });
    paidFor = expense.createdBy && expense.createdBy !== actor.uid ? expense.createdBy : null;
    return result;
  });
  // Phase 9: the person who recorded the expense hears it was paid.
  if (paidFor) await notifySafely(deps, paidFor, NotificationType.expenseDecided, out.expenseId);
  return out;
}

// ---------------------------------------------------------------------------
// Recurring expenses: reminders and due items, never automatic payment
// ---------------------------------------------------------------------------

const EAT_MS = 3 * 3600_000;

/**
 * The due date after [dueMs] (an EAT day start). Months keep the anchor day
 * where the month has it and clamp otherwise (31 Jan → 28/29 Feb → 31 Mar).
 */
export function advanceDueDate(dueMs, frequency, anchorDay) {
  if (frequency === 'weekly') return dueMs + 7 * 24 * 3600_000;
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[frequency];
  if (!months) throw new Error(`unknown frequency ${frequency}`);
  const d = new Date(dueMs + EAT_MS);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay ?? d.getUTCDate(), lastDay);
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day) - EAT_MS;
}

const reminderAt = (dueMs, days) => Timestamp.fromMillis(dueMs - days * 24 * 3600_000);
const anchorOf = (dueMs) => new Date(dueMs + EAT_MS).getUTCDate();

function recurringInput(data, now, { partial }) {
  const out = {};
  const has = (k) => !partial || k in data;
  if (has('name')) out.name = requireText(data.name, 'Name', 80);
  if (has('categoryId')) out.categoryId = requireDocId(data.categoryId, 'category');
  if (has('expectedAmountUgx')) out.expectedAmountUgx = requireAmount(data.expectedAmountUgx, { field: 'expected amount' });
  if (has('frequency')) out.frequency = requireChoice(data.frequency, FREQUENCIES, 'Choose weekly, monthly, quarterly or yearly.', 'frequency');
  if (has('nextDueDate')) {
    const due = requireBusinessDate(data.nextDueDate, now, { field: 'next due date', futureDays: 400 });
    out.nextDueDate = due;
    out.anchorDay = anchorOf(due.toMillis());
  }
  if (has('payee')) out.payee = optionalText(data.payee, 'Vendor / payee', 80);
  if (has('paymentAccountId')) out.paymentAccountId = data.paymentAccountId == null ? null : requireDocId(data.paymentAccountId, 'account');
  if (has('reminderDaysBefore')) {
    const r = data.reminderDaysBefore ?? 3;
    if (!Number.isInteger(r) || r < 0 || r > 30) throw invalid('Remind between 0 and 30 days before.', 'reminder');
    out.reminderDaysBefore = r;
  }
  if (has('notes')) out.notes = optionalText(data.notes, 'Notes', 500);
  return out;
}

export async function createRecurringExpense(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const input = recurringInput(data, now, { partial: false });
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'expenses.recurring.manage');
    const category = await readCategory(tx, db, input.categoryId);
    const ref = db.collection(RECURRING).doc();
    tx.set(ref, {
      recurringExpenseId: ref.id, ...input, categoryName: category.name, active: true,
      reminderAt: reminderAt(input.nextDueDate.toMillis(), input.reminderDaysBefore),
      lastGeneratedExpenseId: null, lastGeneratedAt: null,
      createdAt: stamp(), updatedAt: stamp(), createdBy: actor.uid, updatedBy: actor.uid,
    });
    audit(tx, db, actor, 'expenses', 'recurring_expense.created', ref.id, {
      newValue: { name: input.name, expectedAmountUgx: input.expectedAmountUgx, frequency: input.frequency },
    });
    return { recurringExpenseId: ref.id };
  });
}

export async function updateRecurringExpense(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const changes = recurringInput(data, now, { partial: true });
  const active = 'active' in data ? data.active === true : null;
  const reason = requireReason(data.reason, { required: active === false });
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'expenses.recurring.manage');
    const ref = db.collection(RECURRING).doc(requireDocId(data.recurringExpenseId, 'recurring expense'));
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('That recurring expense could not be found.');
    const before = snap.data();
    const category = 'categoryId' in changes ? await readCategory(tx, db, changes.categoryId) : null;
    const plain = (v) => v?.toMillis?.() ?? v ?? null;
    const changed = Object.keys(changes).filter((k) => plain(changes[k]) !== plain(before[k]));
    const activeChanged = active !== null && active !== before.active;
    if (changed.length === 0 && !activeChanged) throw precondition('Nothing has changed.', 'no_changes');
    const next = { ...before, ...changes };
    const update = { ...Object.fromEntries(changed.map((k) => [k, changes[k]])), updatedAt: stamp(), updatedBy: actor.uid };
    if (category) update.categoryName = category.name;
    if (activeChanged) update.active = active;
    update.reminderAt = reminderAt(next.nextDueDate.toMillis(), next.reminderDaysBefore);
    tx.update(ref, update);
    audit(tx, db, actor, 'expenses', activeChanged && !active ? 'recurring_expense.deactivated' : 'recurring_expense.updated', ref.id, {
      previousValue: { ...Object.fromEntries(changed.map((k) => [k, plain(before[k])])), ...(activeChanged ? { active: before.active } : {}) },
      newValue: { ...Object.fromEntries(changed.map((k) => [k, plain(changes[k])])), ...(activeChanged ? { active } : {}) },
      reason,
    });
    return { recurringExpenseId: ref.id };
  });
}

const SYSTEM = { uid: 'system', data: { role: 'system', fullName: 'RamosMAX' } };

/**
 * Scheduled: for every active recurring expense whose reminder time has
 * come, creates ONE draft expense for the due date (a "due item") and
 * notifies whoever approves or pays expenses. Nothing is ever paid here.
 * Safe to run repeatedly: each due date is generated once.
 */
export async function sweepRecurringExpenses(deps, now = Date.now()) {
  const { db } = deps;
  const due = await db.collection(RECURRING)
    .where('active', '==', true)
    .where('reminderAt', '<=', Timestamp.fromMillis(now))
    .limit(200)
    .get();
  const created = [];
  for (const doc of due.docs) {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(doc.ref);
      if (!snap.exists) return null;
      const r = snap.data();
      if (r.active !== true || r.reminderAt.toMillis() > now) return null;
      const dueMs = r.nextDueDate.toMillis();
      const onceRef = uniqueRef(db, 'recurring_due', `${doc.id}_${dayStart(dueMs)}`);
      if ((await tx.get(onceRef)).exists) return null;
      let category;
      try {
        category = await readCategory(tx, db, r.categoryId);
      } catch {
        category = { id: r.categoryId, name: r.categoryName ?? r.categoryId };
      }
      const numbers = await readCounter(tx, db, 'expenses', 'RMX-EXP-', 6);
      const ref = db.collection(EXPENSES).doc();
      const number = numbers.next();
      numbers.commit();
      tx.set(ref, newExpense(ref, number, {
        categoryId: category.id, description: r.name, amountUgx: r.expectedAmountUgx, expenseDate: r.nextDueDate,
        payee: r.payee ?? null, paymentAccountId: r.paymentAccountId ?? null, reference: null, attachmentPath: null,
        notes: 'Created from a recurring expense. Confirm the amount, then submit it for review.',
      }, category, 'draft', SYSTEM, { recurringExpenseId: doc.id, dueDate: r.nextDueDate }));
      const nextDue = advanceDueDate(dueMs, r.frequency, r.anchorDay);
      tx.update(doc.ref, {
        nextDueDate: Timestamp.fromMillis(nextDue), reminderAt: reminderAt(nextDue, r.reminderDaysBefore),
        lastGeneratedExpenseId: ref.id, lastGeneratedAt: stamp(), updatedAt: stamp(),
      });
      tx.set(onceRef, { kind: 'recurring_due', recurringExpenseId: doc.id, expenseId: ref.id });
      audit(tx, db, SYSTEM, 'expenses', 'recurring_expense.due', doc.id, {
        newValue: { expenseId: ref.id, expenseNumber: number, dueDate: dueMs, nextDueDate: nextDue },
      });
      return ref.id;
    });
    if (result) created.push(result);
  }
  if (created.length > 0) {
    const recipients = await holdersOf(db, ['expenses.approve', 'expenses.pay'], now);
    for (const expenseId of created) {
      for (const uid of recipients) await notifySafely(deps, uid, NotificationType.recurringExpenseDue, expenseId);
    }
  }
  return { created: created.length };
}
