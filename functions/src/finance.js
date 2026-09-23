// ===========================================================================
// RamosMAX finance - financial accounts and the transaction ledger (Phase 5).
// ===========================================================================
// Money lives in `financial_accounts` (Cash at Hand, MTN Merchant, Airtel
// Merchant, bank accounts). An account's `balanceUgx` changes ONLY here, in
// the same Firestore transaction that appends the `financial_transactions`
// entry explaining the change, so every balance can be rebuilt from the
// ledger:
//
//   balanceUgx = Σ entries[].deltaUgx for the account   (checked by tests)
//
// Every ledger entry records, per account it touches, the signed change and
// the balance after it (`entries`), so a statement reads straight off the
// ledger. Nothing is deleted or edited: a mistake is corrected by a
// `reversal` (the mirror image of the original) or an explicit `adjustment`.
//
// Transaction types (the brief's names in capitals):
//   customer_payment (CUSTOMER_PAYMENT)      in   - posted by billing.recordPayment
//   expense_payment (EXPENSE_PAYMENT)        out  - expenses.payExpense
//   inventory_purchase_payment               out  - inventory.payPurchase / receivePurchase
//   account_transfer (ACCOUNT_TRANSFER)      out+in, not revenue
//   bank_deposit (BANK_DEPOSIT)              out+in, not revenue
//   adjustment (ADJUSTMENT)                  in or out, with a reason
//   opening_balance (OPENING_BALANCE)        in, once per account
//   reversal (REVERSAL)                      mirror of the original
//   allowance_payment (Phase 6)              out  - allowances.payAllowances
//   payroll_payment (Phase 6)                out  - payroll.payPayroll (one entry per payroll)
//   share_capital_contribution (Phase 7)     in   - shares.js: money a shareholder pays for shares.
//                                                  Owners' capital: NEVER revenue (isRevenue false,
//                                                  its own daily total shareCapitalInUgx).
//   dividend_payment (Phase 7)               out  - dividends.payDividend (one entry per allocation).
//                                                  A distribution to owners: NEVER an operating
//                                                  expense (its own daily total dividendsPaidUgx).
//
// No overdraft: an outflow larger than the account's balance is refused.
// ===========================================================================

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { effectivePermissions, invalid, optionalText, precondition, requireReason, requirePermission } from './access.js';
import { alreadyExists, audit, freshActor, notFound, requireDocId, stamp, uniqueRef } from './operations.js';
import { requireObject } from './user_admin.js';

export const ACCOUNTS = 'financial_accounts';
export const TXNS = 'financial_transactions';
export const DEPOSITS = 'bank_deposits';
export const RECONCILIATIONS = 'reconciliations';
export const DAILY = 'finance_daily_summaries';
const COUNTERS = 'counters';

export const MAX_AMOUNT_UGX = 2_000_000_000;
export const ACCOUNT_TYPES = Object.freeze(['cash', 'mobile_money', 'bank']);
export const TXN_TYPES = Object.freeze([
  'customer_payment', 'expense_payment', 'inventory_purchase_payment', 'account_transfer', 'bank_deposit',
  'adjustment', 'opening_balance', 'reversal', 'allowance_payment', 'payroll_payment',
  'share_capital_contribution', 'dividend_payment',
]);

/** Staff pay (Phase 6): reversed only from the allowance / payroll screens, which undo what the payment applied. */
export const PAY_TXN_TYPES = Object.freeze(['allowance_payment', 'payroll_payment']);

/**
 * Owners' money (Phase 7): reversed only from the share-contribution and
 * dividend screens, which also restore the shareholder / allocation records.
 */
export const OWNERSHIP_TXN_TYPES = Object.freeze(['share_capital_contribution', 'dividend_payment']);

/** The accounts every installation has. Created on first use (or by ensureDefaultFinancialAccounts). */
export const DEFAULT_ACCOUNTS = Object.freeze({
  cash_at_hand: { name: 'Cash at Hand', type: 'cash', provider: null, paymentMethod: 'cash' },
  mtn_merchant: { name: 'MTN Merchant', type: 'mobile_money', provider: 'MTN Uganda', paymentMethod: 'mtn_merchant' },
  airtel_merchant: { name: 'Airtel Merchant', type: 'mobile_money', provider: 'Airtel Uganda', paymentMethod: 'airtel_merchant' },
  bank_1: { name: 'Bank Account 1', type: 'bank', provider: null, paymentMethod: 'bank' },
});

/** Accounts customer payments land in; they can never be deactivated. */
export const PAYMENT_ACCOUNTS = Object.freeze({ cash: 'cash_at_hand', mtn_merchant: 'mtn_merchant', airtel_merchant: 'airtel_merchant' });
const PERMANENT_ACCOUNTS = new Set(Object.values(PAYMENT_ACCOUNTS));

// ---------------------------------------------------------------------------
// Validation shared by finance, expenses and inventory
// ---------------------------------------------------------------------------

export function requireAmount(input, { field = 'amount', min = 1, max = MAX_AMOUNT_UGX } = {}) {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) {
    throw invalid(min > 0
      ? `Enter the ${field} as a whole number of shillings greater than zero.`
      : `Enter the ${field} as a whole number of shillings.`, 'amount');
  }
  return input;
}

export function requireRequestId(input) {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(input)) {
    throw invalid('The request is not valid.', 'request_id');
  }
  return input;
}

export function requireText(input, field, max) {
  const value = optionalText(input, field, max);
  if (!value) throw invalid(`Enter the ${field.toLowerCase()}.`, 'required');
  return value;
}

export function requireChoice(input, choices, message, reason = 'choice') {
  if (!choices.includes(input)) throw invalid(message, reason);
  return input;
}

/**
 * Attachments are uploaded by the app to `finance_uploads/{kind}/{uploadId}/{file}`
 * (firebase/storage.rules) before the request; the record stores the path only.
 */
export function optionalAttachment(input, kind) {
  if (input == null || input === '') return null;
  const re = new RegExp(`^finance_uploads/${kind}/[A-Za-z0-9_-]{8,64}/[A-Za-z0-9._-]{1,100}$`);
  if (typeof input !== 'string' || !re.test(input)) throw invalid('The attachment could not be saved.', 'attachment');
  return input;
}

// --- East Africa Time business days (UTC+3, no daylight saving) ---
const EAT_MS = 3 * 3600_000;
const DAY_MS = 24 * 3600_000;
const EARLIEST = Date.UTC(2020, 0, 1);

/** `2026-09-21` - the EAT business day containing [ms]. */
export const dayKey = (ms) => new Date(ms + EAT_MS).toISOString().slice(0, 10);

/** UTC millis of the start of the EAT day containing [ms]. */
export function dayStart(ms) {
  const d = new Date(ms + EAT_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - EAT_MS;
}

/**
 * A business date sent as epoch millis (null = today). Returns the Timestamp
 * of the start of that EAT day. Past dates are fine; future ones only up to
 * [futureDays] ahead (0 = not after today).
 */
export function requireBusinessDate(input, now, { field = 'date', futureDays = 0 } = {}) {
  const ms = input == null ? now : input;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < EARLIEST) throw invalid(`Choose a valid ${field}.`, 'date');
  const start = dayStart(ms);
  if (start > dayStart(now) + futureDays * DAY_MS) {
    throw invalid(futureDays === 0 ? `The ${field} cannot be in the future.` : `The ${field} is too far in the future.`, 'date');
  }
  return Timestamp.fromMillis(start);
}

// ---------------------------------------------------------------------------
// Idempotency: `unique_keys/request_{id}` remembers the first result.
// ---------------------------------------------------------------------------

/** Reads the request marker. Returns {ref, earlier} - earlier is the stored result or null. */
export async function readRequest(tx, db, requestId, actorUid, kind) {
  const ref = uniqueRef(db, 'request', requestId);
  const snap = await tx.get(ref);
  if (!snap.exists) return { ref, earlier: null };
  if (snap.get('kind') !== kind || snap.get('actor') !== actorUid) throw invalid('The request is not valid.', 'request_id');
  return { ref, earlier: { ...snap.get('result'), duplicate: true } };
}

export function saveRequest(tx, ref, kind, actorUid, result) {
  tx.set(ref, { kind, actor: actorUid, result, createdAt: stamp() });
}

// ---------------------------------------------------------------------------
// Counters that hand out several numbers in one transaction
// ---------------------------------------------------------------------------

export async function readCounter(tx, db, counter, prefix, width) {
  const ref = db.collection(COUNTERS).doc(counter);
  const snap = await tx.get(ref);
  let n = snap.exists ? Number(snap.get('next')) || 1 : 1;
  const start = n;
  return {
    next: () => `${prefix}${String(n++).padStart(width, '0')}`,
    commit: () => { if (n !== start) tx.set(ref, { next: n }, { merge: true }); },
  };
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

function defaultAccountData(id, actorUid) {
  const d = DEFAULT_ACCOUNTS[id];
  return {
    accountId: id,
    name: d.name,
    nameKey: nameKey(d.name),
    type: d.type,
    provider: d.provider,
    accountNumber: null,
    paymentMethod: d.paymentMethod,
    isDefault: true,
    openingBalanceUgx: 0,
    openingBalanceRecorded: false,
    balanceUgx: 0,
    awaitingBankingUgx: 0,
    active: true,
    notes: null,
    transactionCount: 0,
    lastTransactionAt: null,
    createdAt: stamp(),
    updatedAt: stamp(),
    createdBy: actorUid,
    updatedBy: actorUid,
  };
}

export const nameKey = (name) => String(name).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Reads [accountIds] (and the transaction counter) inside [tx]. Default
 * accounts that do not exist yet are created on commit. Call before any write.
 */
export async function openLedger(tx, db, accountIds, now) {
  const ids = [...new Set(accountIds.filter(Boolean))];
  const snaps = await Promise.all(ids.map((id) => tx.get(db.collection(ACCOUNTS).doc(id))));
  const counter = await readCounter(tx, db, 'financial_transactions', 'RMX-TXN-', 6);
  const accounts = new Map();
  snaps.forEach((s, i) => {
    if (s.exists) accounts.set(ids[i], { ref: s.ref, data: s.data(), create: false, touched: false });
    else if (DEFAULT_ACCOUNTS[ids[i]]) accounts.set(ids[i], { ref: s.ref, data: null, create: true, touched: false });
  });
  return new Ledger(tx, db, accounts, counter, now);
}

const AWAITING_CUSTOMER = new Set(['customer_payment', 'reversal:customer_payment']);
const AWAITING_BANKING = new Set(['bank_deposit', 'account_transfer', 'reversal:bank_deposit', 'reversal:account_transfer']);

class Ledger {
  constructor(tx, db, accounts, counter, now) {
    Object.assign(this, { tx, db, accounts, counter, now, daily: {} });
  }

  /** Account data (throws if unknown). Default accounts read as fresh, zero-balance accounts. */
  account(id, actorUid = 'system') {
    const a = this.accounts.get(id);
    if (!a) throw notFound('That financial account could not be found.', 'account_not_found');
    if (a.create && !a.data) a.data = defaultAccountData(id, actorUid);
    return a.data;
  }

  requireActive(id, actorUid) {
    const a = this.account(id, actorUid);
    if (a.active !== true) throw precondition(`${a.name} is inactive.`, 'account_inactive');
    return a;
  }

  balance(id) {
    return this.account(id).balanceUgx ?? 0;
  }

  _move(id, delta, kind, actorUid, counterpartyType) {
    const a = this.accounts.get(id);
    const data = this.account(id, actorUid);
    const before = data.balanceUgx ?? 0;
    const after = before + delta;
    if (after < 0) {
      throw precondition(`${data.name} has only UGX ${before.toLocaleString('en-US')} available.`, 'insufficient_funds',
        { accountId: id, availableUgx: before });
    }
    data.balanceUgx = after;
    // Cash awaiting banking: cash collected from customers and not yet taken
    // to a bank. It is PART of the cash balance, never extra money: it grows
    // with cash payments, shrinks when cash goes to a bank (deposit or
    // transfer) and can never exceed the cash actually held.
    if (data.type === 'cash') {
      let waiting = data.awaitingBankingUgx ?? 0;
      if (AWAITING_CUSTOMER.has(kind) || (counterpartyType === 'bank' && AWAITING_BANKING.has(kind))) waiting += delta;
      data.awaitingBankingUgx = Math.max(0, Math.min(waiting, after));
    }
    data.transactionCount = (data.transactionCount ?? 0) + 1;
    a.touched = true;
    return { accountId: id, accountName: data.name, deltaUgx: delta, balanceAfterUgx: after };
  }

  /**
   * Appends one ledger entry and moves the money. [fromId] loses [amountUgx],
   * [toId] gains it (either may be null). Returns {transactionId, transactionNumber}.
   */
  post({ type, amountUgx, fromId = null, toId = null, actor, at = null, fields = {}, reversalOfType = null, categoryId = null }) {
    if (!Number.isInteger(amountUgx) || amountUgx <= 0) throw precondition('The amount must be above zero.', 'amount');
    if (fromId && fromId === toId) throw invalid('Choose two different accounts.', 'same_account');
    const kind = type === 'reversal' ? `reversal:${reversalOfType}` : type;
    const fromType = fromId ? this.account(fromId, actor.uid).type : null;
    const toType = toId ? this.account(toId, actor.uid).type : null;
    const entries = [];
    if (fromId) entries.push(this._move(fromId, -amountUgx, kind, actor.uid, toType));
    if (toId) entries.push(this._move(toId, amountUgx, kind, actor.uid, fromType));

    const ref = this.db.collection(TXNS).doc();
    const number = this.counter.next();
    const when = at ?? Timestamp.fromMillis(this.now);
    this.tx.set(ref, {
      transactionId: ref.id,
      transactionNumber: number,
      type,
      reversalOfType,
      amountUgx,
      sourceAccountId: fromId,
      sourceAccountName: fromId ? this.account(fromId).name : null,
      destinationAccountId: toId,
      destinationAccountName: toId ? this.account(toId).name : null,
      accountIds: [fromId, toId].filter(Boolean),
      entries,
      isRevenue: type === 'customer_payment',
      categoryId,
      paymentId: null,
      invoiceId: null,
      invoiceNumber: null,
      expenseId: null,
      expenseNumber: null,
      purchaseId: null,
      purchaseNumber: null,
      depositId: null,
      depositNumber: null,
      payrollId: null,
      payrollNumber: null,
      allowanceIds: null,
      reconciliationId: null,
      reference: null,
      description: null,
      reason: null,
      approvedBy: null,
      requestId: null,
      ...fields,
      transactionDate: when,
      businessDay: dayKey(this.now),
      status: 'posted',
      reversedByTransactionId: null,
      reversalOfTransactionId: fields.reversalOfTransactionId ?? null,
      createdBy: actor.uid,
      createdByName: actor.data?.fullName ?? null,
      createdAt: stamp(),
    });
    this._summarise(kind, amountUgx, fromId, toId, categoryId);
    return { transactionId: ref.id, transactionNumber: number };
  }

  _summarise(kind, amount, fromId, toId, categoryId) {
    const d = this.daily;
    const inc = (path, v) => { d[path] = (d[path] ?? 0) + v; };
    const field = {
      customer_payment: 'customerPaymentsUgx',
      expense_payment: 'expensesPaidUgx',
      inventory_purchase_payment: 'purchasesPaidUgx',
      account_transfer: 'transfersUgx',
      bank_deposit: 'depositsUgx',
      opening_balance: 'openingBalancesUgx',
      allowance_payment: 'allowancesPaidUgx',
      payroll_payment: 'payrollPaidUgx',
      share_capital_contribution: 'shareCapitalInUgx',
      dividend_payment: 'dividendsPaidUgx',
    }[kind];
    if (field) inc(field, amount);
    if (kind === 'adjustment') inc(toId ? 'adjustmentsInUgx' : 'adjustmentsOutUgx', amount);
    if (kind.startsWith('reversal:')) inc(`reversals.${kind.slice(9)}Ugx`, amount);
    if (categoryId && (kind === 'expense_payment' || kind === 'reversal:expense_payment')) {
      inc(`expensesByCategory.${categoryId}`, kind === 'expense_payment' ? amount : -amount);
    }
    if (fromId) inc(`byAccount.${fromId}.outUgx`, amount);
    if (toId) inc(`byAccount.${toId}.inUgx`, amount);
    inc('transactionCount', 1);
  }

  /** Writes the accounts, the counter and the day's summary. */
  commit(actorUid) {
    for (const [, a] of this.accounts) {
      if (!a.touched && !a.create) continue;
      if (!a.touched && a.create && !a.data) continue;
      if (a.create) {
        this.tx.set(a.ref, { ...a.data, lastTransactionAt: a.touched ? stamp() : null, updatedAt: stamp(), updatedBy: actorUid });
      } else {
        this.tx.update(a.ref, {
          balanceUgx: a.data.balanceUgx,
          awaitingBankingUgx: a.data.awaitingBankingUgx ?? 0,
          transactionCount: a.data.transactionCount,
          lastTransactionAt: stamp(),
          updatedAt: stamp(),
          updatedBy: actorUid,
        });
      }
    }
    this.counter.commit();
    if (Object.keys(this.daily).length > 0) {
      const update = { day: dayKey(this.now), dayStart: Timestamp.fromMillis(dayStart(this.now)), updatedAt: stamp() };
      for (const [path, v] of Object.entries(this.daily)) setPath(update, path.split('.'), FieldValue.increment(v));
      this.tx.set(this.db.collection(DAILY).doc(dayKey(this.now)), update, { merge: true });
    }
  }
}

function setPath(obj, parts, value) {
  let o = obj;
  for (const p of parts.slice(0, -1)) o = (o[p] ??= {});
  o[parts.at(-1)] = value;
}

/** Reads the ledger entry [transactionId] (for reversal). */
export async function readTransaction(tx, db, transactionId) {
  const ref = db.collection(TXNS).doc(requireDocId(transactionId, 'transaction'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That transaction could not be found.');
  return { ref, data: snap.data() };
}

/**
 * Posts the mirror image of [original] and marks it reversed. The caller has
 * opened [ledger] with the original's accounts.
 */
export function postReversal(tx, ledger, original, actor, reason, fields = {}) {
  if (original.data.type === 'reversal') throw precondition('A reversal cannot itself be reversed.', 'is_reversal');
  if (original.data.status === 'reversed') throw precondition('This transaction has already been reversed.', 'already_reversed');
  const o = original.data;
  const r = ledger.post({
    type: 'reversal',
    reversalOfType: o.type,
    amountUgx: o.amountUgx,
    fromId: o.destinationAccountId,
    toId: o.sourceAccountId,
    actor,
    categoryId: o.categoryId ?? null,
    fields: {
      reversalOfTransactionId: original.ref.id,
      reversalOfTransactionNumber: o.transactionNumber,
      paymentId: o.paymentId ?? null,
      invoiceId: o.invoiceId ?? null,
      invoiceNumber: o.invoiceNumber ?? null,
      expenseId: o.expenseId ?? null,
      expenseNumber: o.expenseNumber ?? null,
      purchaseId: o.purchaseId ?? null,
      purchaseNumber: o.purchaseNumber ?? null,
      depositId: o.depositId ?? null,
      depositNumber: o.depositNumber ?? null,
      reason,
      description: `Reversal of ${o.transactionNumber}`,
      ...fields,
    },
  });
  tx.update(original.ref, {
    status: 'reversed', reversedByTransactionId: r.transactionId, reversedByTransactionNumber: r.transactionNumber,
    reversedAt: stamp(), reversedBy: actor.uid, reversalReason: reason,
  });
  return r;
}

// ---------------------------------------------------------------------------
// Customer payments (called from billing.js inside its transaction)
// ---------------------------------------------------------------------------

/**
 * Which account a payment by [method] lands in. Cash and mobile money go to
 * their fixed accounts; bank payments go to [requestedId], or the only
 * active bank account, or `bank_1` (created on first use). Reads only.
 */
export async function resolvePaymentAccount(tx, db, method, requestedId) {
  if (method !== 'bank') {
    const id = PAYMENT_ACCOUNTS[method];
    if (requestedId != null && requestedId !== id) throw invalid('That account does not receive this payment method.', 'account');
    return id;
  }
  if (requestedId != null) return requireDocId(requestedId, 'bank account');
  const active = await tx.get(db.collection(ACCOUNTS).where('type', '==', 'bank').where('active', '==', true));
  if (active.size === 1) return active.docs[0].id;
  if (active.size > 1) throw invalid('Choose which bank account received the payment.', 'bank_account_required');
  return 'bank_1';
}

/** Checks the payment account and posts the payment. Call after all reads. */
export function postCustomerPayment(ledger, { accountId, method, actor, amountUgx, payment }) {
  const account = ledger.requireActive(accountId, actor.uid);
  const expected = method === 'cash' ? 'cash' : method === 'bank' ? 'bank' : 'mobile_money';
  if (account.type !== expected) throw invalid('That account does not receive this payment method.', 'account');
  return ledger.post({
    type: 'customer_payment',
    amountUgx,
    toId: accountId,
    actor,
    fields: {
      paymentId: payment.paymentId,
      invoiceId: payment.invoiceId,
      invoiceNumber: payment.invoiceNumber,
      reference: payment.reference ?? null,
      description: `Payment ${payment.receiptNumber} for ${payment.invoiceNumber} (${payment.numberPlate})`,
      paymentMethod: method,
    },
  });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const PAYMENT_ACCOUNTS_DOC = ['settings', 'payment_accounts'];

function maskNumber(n) {
  if (!n) return null;
  return n.length <= 4 ? n : `••${n.slice(-4)}`;
}

/**
 * `settings/payment_accounts`: the active bank accounts a cashier may choose
 * for a bank payment (names and masked numbers only, no balances).
 */
function writePaymentAccounts(tx, db, all) {
  const banks = all.filter((a) => a.type === 'bank' && a.active)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => ({ accountId: a.accountId, name: a.name, provider: a.provider ?? null, accountNumberMasked: maskNumber(a.accountNumber) }));
  tx.set(db.collection(PAYMENT_ACCOUNTS_DOC[0]).doc(PAYMENT_ACCOUNTS_DOC[1]), { banks, updatedAt: stamp() });
}

/** Every account (existing + not-yet-created defaults), for duplicate checks. */
async function readAllAccounts(tx, db) {
  const snap = await tx.get(db.collection(ACCOUNTS));
  const all = snap.docs.map((d) => d.data());
  const missing = Object.keys(DEFAULT_ACCOUNTS).filter((id) => !all.some((a) => a.accountId === id));
  return { all, missing };
}

function accountInput(data, { partial }) {
  const out = {};
  if (!partial || 'name' in data) out.name = requireText(data.name, 'Account name', 60);
  if (!partial) out.type = requireChoice(data.type, ACCOUNT_TYPES, 'Choose cash, mobile money or bank.', 'account_type');
  if (!partial || 'provider' in data) out.provider = optionalText(data.provider, 'Provider / bank name', 60);
  if (!partial || 'accountNumber' in data) {
    const n = optionalText(data.accountNumber, 'Account or merchant number', 40);
    if (n && !/^[A-Za-z0-9 -]{3,40}$/.test(n)) throw invalid('Use letters, digits, spaces or dashes for the account number.', 'account_number');
    out.accountNumber = n ? n.toUpperCase() : null;
  }
  if (!partial || 'notes' in data) out.notes = optionalText(data.notes, 'Notes', 300);
  return out;
}

function requireUniqueAccount(all, missing, input, exceptId = null) {
  const others = all.filter((a) => a.accountId !== exceptId);
  const key = input.name ? nameKey(input.name) : null;
  if (key && (others.some((a) => a.nameKey === key)
      || missing.some((id) => id !== exceptId && nameKey(DEFAULT_ACCOUNTS[id].name) === key))) {
    throw alreadyExists(`An account called "${input.name}" already exists.`, 'duplicate_account');
  }
  if (input.accountNumber && others.some((a) => a.accountNumber === input.accountNumber && a.type === (input.type ?? a.type))) {
    throw alreadyExists('An account with this number already exists.', 'duplicate_account_number');
  }
}

export async function ensureDefaultFinancialAccounts(deps, callerUid, _rawData, now = Date.now()) {
  const { db } = deps;
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'finance.accounts.manage');
    const { all, missing } = await readAllAccounts(tx, db);
    for (const id of missing) {
      const data = defaultAccountData(id, actor.uid);
      tx.set(db.collection(ACCOUNTS).doc(id), data);
      all.push({ ...data });
      audit(tx, db, actor, 'finance', 'financial_account.created', id, { newValue: { name: data.name, type: data.type, default: true } });
    }
    writePaymentAccounts(tx, db, all);
    return { created: missing };
  });
}

export async function createFinancialAccount(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const input = accountInput(data, { partial: false });
  const opening = data.openingBalanceUgx == null ? 0 : requireAmount(data.openingBalanceUgx, { field: 'opening balance', min: 0 });
  if (input.type === 'cash') throw invalid('RamosMAX has one cash account, Cash at Hand.', 'account_type');

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'finance.accounts.manage');
    const { all, missing } = await readAllAccounts(tx, db);
    requireUniqueAccount(all, missing, input);
    const ref = db.collection(ACCOUNTS).doc();
    const ledger = opening > 0 ? await openLedger(tx, db, [], now) : null;
    const account = {
      accountId: ref.id,
      ...input,
      nameKey: nameKey(input.name),
      paymentMethod: input.type === 'bank' ? 'bank' : null,
      isDefault: false,
      openingBalanceUgx: opening,
      openingBalanceRecorded: opening > 0,
      balanceUgx: 0,
      awaitingBankingUgx: 0,
      active: true,
      transactionCount: 0,
      lastTransactionAt: null,
      createdAt: stamp(),
      updatedAt: stamp(),
      createdBy: actor.uid,
      updatedBy: actor.uid,
    };
    if (ledger) {
      // Register the new account with the ledger so the opening balance posts to it.
      ledger.accounts.set(ref.id, { ref, data: account, create: true, touched: false });
      ledger.post({ type: 'opening_balance', amountUgx: opening, toId: ref.id, actor, fields: { description: `Opening balance of ${input.name}` } });
      ledger.commit(actor.uid);
    } else {
      tx.set(ref, account);
    }
    writePaymentAccounts(tx, db, [...all, account]);
    audit(tx, db, actor, 'finance', 'financial_account.created', ref.id, {
      newValue: { name: input.name, type: input.type, provider: input.provider, openingBalanceUgx: opening },
    });
    return { accountId: ref.id };
  });
}

export async function updateFinancialAccount(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const accountId = requireDocId(data.accountId, 'account');
  const changes = accountInput(data, { partial: true });
  const active = 'active' in data ? data.active === true : null;
  const reason = requireReason(data.reason, { required: active === false });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'finance.accounts.manage');
    const { all, missing } = await readAllAccounts(tx, db);
    let before = all.find((a) => a.accountId === accountId);
    const create = !before && DEFAULT_ACCOUNTS[accountId];
    if (!before && !create) throw notFound('That financial account could not be found.');
    if (create) before = defaultAccountData(accountId, actor.uid);
    requireUniqueAccount(all, missing, { ...changes, type: before.type }, accountId);
    const changed = Object.keys(changes).filter((k) => (changes[k] ?? null) !== (before[k] ?? null));
    const activeChanged = active !== null && active !== before.active;
    if (changed.length === 0 && !activeChanged) throw precondition('Nothing has changed.', 'no_changes');
    if (activeChanged && !active) {
      if (PERMANENT_ACCOUNTS.has(accountId)) throw precondition(`${before.name} receives customer payments and cannot be deactivated.`, 'permanent_account');
      if ((before.balanceUgx ?? 0) !== 0) {
        throw precondition('Move the balance to another account before deactivating this one.', 'balance_not_zero');
      }
    }
    const update = { ...Object.fromEntries(changed.map((k) => [k, changes[k]])), updatedAt: stamp(), updatedBy: actor.uid };
    if ('name' in update) update.nameKey = nameKey(update.name);
    if (activeChanged) update.active = active;
    const ref = db.collection(ACCOUNTS).doc(accountId);
    if (create) tx.set(ref, { ...before, ...update });
    else tx.update(ref, update);
    const next = all.filter((a) => a.accountId !== accountId).concat([{ ...before, ...update }]);
    writePaymentAccounts(tx, db, next);
    if (changed.length > 0) {
      audit(tx, db, actor, 'finance', 'financial_account.updated', accountId, {
        previousValue: Object.fromEntries(changed.map((k) => [k, before[k] ?? null])),
        newValue: Object.fromEntries(changed.map((k) => [k, changes[k]])),
        reason,
      });
    }
    if (activeChanged) {
      audit(tx, db, actor, 'finance', active ? 'financial_account.activated' : 'financial_account.deactivated', accountId, {
        previousValue: { active: before.active }, newValue: { active }, reason,
      });
    }
    return { accountId };
  });
}

/** Once per account: the money it held when RamosMAX started tracking it. */
export async function recordOpeningBalance(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const accountId = requireDocId(data.accountId, 'account');
  const amount = requireAmount(data.amountUgx, { field: 'opening balance' });
  const reason = requireReason(data.reason, { required: false });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'finance.accounts.manage');
    const ledger = await openLedger(tx, db, [accountId], now);
    const account = ledger.requireActive(accountId, actor.uid);
    if (account.openingBalanceRecorded) {
      throw precondition('This account already has an opening balance. Use an adjustment to correct it.', 'opening_balance_exists');
    }
    const r = ledger.post({ type: 'opening_balance', amountUgx: amount, toId: accountId, actor, fields: { reason, description: `Opening balance of ${account.name}` } });
    account.openingBalanceRecorded = true;
    account.openingBalanceUgx = amount;
    ledger.commit(actor.uid);
    tx.set(db.collection(ACCOUNTS).doc(accountId), { openingBalanceRecorded: true, openingBalanceUgx: amount }, { merge: true });
    audit(tx, db, actor, 'finance', 'financial_account.opening_balance', accountId, {
      newValue: { amountUgx: amount, transactionNumber: r.transactionNumber }, reason,
    });
    return r;
  });
}

// ---------------------------------------------------------------------------
// Transfers and bank deposits (never revenue)
// ---------------------------------------------------------------------------

export async function transferFunds(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const fromId = requireDocId(data.fromAccountId, 'source account');
  const toId = requireDocId(data.toAccountId, 'destination account');
  if (fromId === toId) throw invalid('The source and destination must be different accounts.', 'same_account');
  const amount = requireAmount(data.amountUgx);
  const requestId = requireRequestId(data.requestId);
  const reason = requireReason(data.reason);
  const reference = optionalText(data.reference, 'Reference', 60);
  const description = optionalText(data.description, 'Description', 200);
  const at = requireBusinessDate(data.transferDate, now, { field: 'transfer date' });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'finance.transfer');
    const request = await readRequest(tx, db, requestId, actor.uid, 'transfer');
    if (request.earlier) return request.earlier;
    const ledger = await openLedger(tx, db, [fromId, toId], now);
    ledger.requireActive(fromId, actor.uid);
    ledger.requireActive(toId, actor.uid);
    const r = ledger.post({
      type: 'account_transfer', amountUgx: amount, fromId, toId, actor, at,
      fields: { reference, description, reason, approvedBy: actor.uid, requestId },
    });
    ledger.commit(actor.uid);
    const result = { ...r, sourceBalanceUgx: ledger.balance(fromId), destinationBalanceUgx: ledger.balance(toId) };
    saveRequest(tx, request.ref, 'transfer', actor.uid, result);
    audit(tx, db, actor, 'finance', 'finance.transfer', r.transactionId, {
      newValue: { transactionNumber: r.transactionNumber, fromAccountId: fromId, toAccountId: toId, amountUgx: amount }, reason,
    });
    return result;
  });
}

export async function recordBankDeposit(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const fromId = requireDocId(data.sourceAccountId ?? 'cash_at_hand', 'source account');
  const bankId = requireDocId(data.bankAccountId, 'bank account');
  if (fromId === bankId) throw invalid('The source and destination must be different accounts.', 'same_account');
  const amount = requireAmount(data.amountUgx);
  const requestId = requireRequestId(data.requestId);
  const bankReference = requireText(data.bankReference, 'Bank reference / slip number', 60);
  const description = optionalText(data.description, 'Description', 200);
  const attachmentPath = optionalAttachment(data.attachmentPath, 'deposits');
  const at = requireBusinessDate(data.depositDate, now, { field: 'deposit date' });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'finance.deposit');
    const request = await readRequest(tx, db, requestId, actor.uid, 'deposit');
    if (request.earlier) return request.earlier;
    const ledger = await openLedger(tx, db, [fromId, bankId], now);
    const source = ledger.requireActive(fromId, actor.uid);
    const bank = ledger.requireActive(bankId, actor.uid);
    if (bank.type !== 'bank') throw invalid('Choose a bank account to deposit into.', 'not_bank');
    if (source.type === 'bank') throw invalid('Use a transfer to move money between bank accounts.', 'source_is_bank');
    const numbers = await readCounter(tx, db, 'bank_deposits', 'RMX-BNK-', 6);
    const depositNumber = numbers.next();
    const ref = db.collection(DEPOSITS).doc();
    const r = ledger.post({
      type: 'bank_deposit', amountUgx: amount, fromId, toId: bankId, actor, at,
      fields: { depositId: ref.id, depositNumber, reference: bankReference, description: description ?? `Deposit ${depositNumber}`, requestId, approvedBy: actor.uid },
    });
    ledger.commit(actor.uid);
    numbers.commit();
    tx.set(ref, {
      depositId: ref.id,
      depositNumber,
      sourceAccountId: fromId,
      sourceAccountName: source.name,
      bankAccountId: bankId,
      bankAccountName: bank.name,
      amountUgx: amount,
      depositDate: at,
      bankReference,
      description,
      attachmentPath,
      status: 'completed',
      transactionId: r.transactionId,
      transactionNumber: r.transactionNumber,
      requestId,
      createdBy: actor.uid,
      createdByName: actor.data.fullName ?? null,
      approvedBy: actor.uid,
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    const result = { depositId: ref.id, depositNumber, ...r, awaitingBankingUgx: source.awaitingBankingUgx ?? 0 };
    saveRequest(tx, request.ref, 'deposit', actor.uid, result);
    audit(tx, db, actor, 'finance', 'finance.bank_deposit', ref.id, {
      newValue: { depositNumber, transactionNumber: r.transactionNumber, fromAccountId: fromId, bankAccountId: bankId, amountUgx: amount },
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Reconciliation and adjustments
// ---------------------------------------------------------------------------

export async function reconcileAccount(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const accountId = requireDocId(data.accountId, 'account');
  const actual = requireAmount(data.actualBalanceUgx, { field: 'counted / statement balance', min: 0 });
  const requestId = requireRequestId(data.requestId);
  const notes = optionalText(data.notes, 'Notes', 500);
  const attachmentPath = optionalAttachment(data.attachmentPath, 'reconciliations');
  const at = requireBusinessDate(data.reconciliationDate, now, { field: 'reconciliation date' });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'finance.reconcile');
    const request = await readRequest(tx, db, requestId, actor.uid, 'reconciliation');
    if (request.earlier) return request.earlier;
    const ledger = await openLedger(tx, db, [accountId], now);
    const account = ledger.account(accountId, actor.uid);
    const numbers = await readCounter(tx, db, 'reconciliations', 'RMX-REC-', 6);
    const system = account.balanceUgx ?? 0;
    const difference = actual - system; // Actual − System: positive = more money than recorded
    const ref = db.collection(RECONCILIATIONS).doc();
    const number = numbers.next();
    numbers.commit();
    // The account balance is NOT touched: a difference needs an explicit adjustment.
    tx.set(ref, {
      reconciliationId: ref.id,
      reconciliationNumber: number,
      accountId,
      accountName: account.name,
      accountType: account.type,
      reconciliationDate: at,
      systemBalanceUgx: system,
      actualBalanceUgx: actual,
      differenceUgx: difference,
      status: difference === 0 ? 'balanced' : 'discrepancy',
      notes,
      attachmentPath,
      adjustmentTransactionId: null,
      requestId,
      reconciledBy: actor.uid,
      reconciledByName: actor.data.fullName ?? null,
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    const result = { reconciliationId: ref.id, reconciliationNumber: number, systemBalanceUgx: system, differenceUgx: difference };
    saveRequest(tx, request.ref, 'reconciliation', actor.uid, result);
    audit(tx, db, actor, 'finance', 'finance.reconciled', ref.id, {
      newValue: { accountId, reconciliationNumber: number, systemBalanceUgx: system, actualBalanceUgx: actual, differenceUgx: difference },
    });
    return result;
  });
}

export async function recordAccountAdjustment(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const accountId = requireDocId(data.accountId, 'account');
  const direction = requireChoice(data.direction, ['in', 'out'], 'Choose whether money is added or removed.', 'direction');
  const amount = requireAmount(data.amountUgx);
  const reason = requireReason(data.reason);
  const requestId = requireRequestId(data.requestId);
  const reconciliationId = data.reconciliationId == null ? null : requireDocId(data.reconciliationId, 'reconciliation');

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'finance.adjust');
    const request = await readRequest(tx, db, requestId, actor.uid, 'adjustment');
    if (request.earlier) return request.earlier;
    let recRef = null;
    if (reconciliationId) {
      recRef = db.collection(RECONCILIATIONS).doc(reconciliationId);
      const rec = await tx.get(recRef);
      if (!rec.exists) throw notFound('That reconciliation could not be found.');
      if (rec.get('accountId') !== accountId) throw invalid('That reconciliation is for another account.', 'reconciliation');
      if (rec.get('status') !== 'discrepancy') throw precondition('That reconciliation has no open difference.', 'reconciliation_closed');
      const diff = rec.get('differenceUgx');
      if ((direction === 'in') !== (diff > 0) || amount !== Math.abs(diff)) {
        throw invalid(`The reconciliation difference is ${diff > 0 ? '+' : '−'}UGX ${Math.abs(diff).toLocaleString('en-US')}.`, 'adjustment_mismatch');
      }
    }
    const ledger = await openLedger(tx, db, [accountId], now);
    ledger.requireActive(accountId, actor.uid);
    const r = ledger.post({
      type: 'adjustment', amountUgx: amount, actor,
      ...(direction === 'in' ? { toId: accountId } : { fromId: accountId }),
      fields: { reason, reconciliationId, description: `Adjustment ${direction === 'in' ? '+' : '−'}`, approvedBy: actor.uid, requestId },
    });
    ledger.commit(actor.uid);
    if (recRef) tx.update(recRef, { status: 'adjusted', adjustmentTransactionId: r.transactionId, adjustedBy: actor.uid, updatedAt: stamp() });
    const result = { ...r, balanceUgx: ledger.balance(accountId) };
    saveRequest(tx, request.ref, 'adjustment', actor.uid, result);
    audit(tx, db, actor, 'finance', 'finance.adjustment', r.transactionId, {
      newValue: { accountId, direction, amountUgx: amount, transactionNumber: r.transactionNumber, reconciliationId }, reason,
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Reversals
// ---------------------------------------------------------------------------

/**
 * Reverses a transfer, deposit, adjustment or opening balance (finance.adjust),
 * or an expense / stock-purchase payment (expenses.adjust), which also puts
 * the expense back to "approved" / the purchase back to "unpaid". Customer
 * payments are reversed through reversePayment (payments.reverse).
 */
export async function reverseFinancialTransaction(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'finance.adjust', 'expenses.adjust');
    const original = await readTransaction(tx, db, data.transactionId);
    const o = original.data;
    if (o.type === 'customer_payment') {
      throw precondition('Reverse the customer payment from its invoice instead.', 'use_payment_reversal');
    }
    if (PAY_TXN_TYPES.includes(o.type)) {
      throw precondition(o.type === 'payroll_payment'
        ? 'Reverse the payroll payment from its payroll instead.'
        : 'Reverse the allowance payment from the allowances screen instead.', 'use_pay_reversal');
    }
    if (OWNERSHIP_TXN_TYPES.includes(o.type)) {
      throw precondition(o.type === 'dividend_payment'
        ? 'Reverse the dividend payment from its dividend instead.'
        : 'Reverse the share contribution from the shareholder\'s share records instead.', 'use_ownership_reversal');
    }
    const spending = o.type === 'expense_payment' || o.type === 'inventory_purchase_payment';
    requirePermission(actor.perms, spending ? 'expenses.adjust' : 'finance.adjust');
    let linked = null;
    if (o.type === 'expense_payment') linked = db.collection('expenses').doc(o.expenseId);
    if (o.type === 'inventory_purchase_payment') linked = db.collection('inventory_purchases').doc(o.purchaseId);
    if (o.type === 'bank_deposit') linked = db.collection(DEPOSITS).doc(o.depositId);
    const linkedSnap = linked ? await tx.get(linked) : null;
    const ledger = await openLedger(tx, db, [o.sourceAccountId, o.destinationAccountId], now);
    const r = postReversal(tx, ledger, original, actor, reason);
    ledger.commit(actor.uid);
    if (linkedSnap?.exists) {
      const back = { updatedAt: stamp(), updatedBy: actor.uid };
      if (o.type === 'expense_payment') {
        tx.update(linked, { ...back, status: 'approved', paidAt: null, paidBy: null, paidFromAccountId: null,
          financialTransactionId: null, paymentReversedAt: stamp(), paymentReversalReason: reason, paymentReversalTransactionId: r.transactionId });
      } else if (o.type === 'inventory_purchase_payment') {
        tx.update(linked, { ...back, paymentStatus: 'unpaid', paidAt: null, paidFromAccountId: null, financialTransactionId: null,
          paymentReversalReason: reason, paymentReversalTransactionId: r.transactionId });
      } else {
        tx.update(linked, { ...back, status: 'reversed', reversalReason: reason, reversalTransactionId: r.transactionId });
      }
    }
    if (o.type === 'opening_balance') {
      tx.set(db.collection(ACCOUNTS).doc(o.destinationAccountId), { openingBalanceRecorded: false }, { merge: true });
    }
    audit(tx, db, actor, 'finance', 'finance.transaction_reversed', original.ref.id, {
      previousValue: { status: 'posted', transactionNumber: o.transactionNumber, type: o.type },
      newValue: { status: 'reversed', reversalTransactionNumber: r.transactionNumber, amountUgx: o.amountUgx },
      reason,
    });
    return r;
  });
}

// ---------------------------------------------------------------------------
// Notifications to everyone holding a permission (small staff lists)
// ---------------------------------------------------------------------------

export async function holdersOf(db, permissions, now) {
  const users = await db.collection('users').where('active', '==', true).get();
  return users.docs.filter((d) => {
    const perms = effectivePermissions(d.data(), now);
    return permissions.some((p) => perms.has(p));
  }).map((d) => d.id);
}

