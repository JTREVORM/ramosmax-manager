// ===========================================================================
// RamosMAX shares - issues, transfers, adjustments, contributions, reversals
// and point-in-time ownership (Phase 7).
// ===========================================================================
//
// `share_transactions` is the immutable ownership ledger (RMX-SHR-TXN-000001).
// Every change of ownership is an entry with signed per-shareholder `lines`:
//
//   shares_issued       (SHARES_ISSUED / SHARES_PURCHASED)  +n to one holder, commitment = n × value per share
//   shares_transferred  (SHARES_TRANSFERRED)                −n from one holder, +n to another; total unchanged
//   shares_adjusted     (SHARES_ADJUSTED)                   ±n correction with a reason (never an overwrite)
//   reversal            (REVERSAL)                          the mirror of a posted entry, effective when made
//
//   pending_approval ──approve (shares.approve, another person)──► posted ──reverse (shares.adjust)──► reversed
//          └──────────reject (reason)──────────► rejected
//
// Nothing is edited or deleted. A holding is the sum of the posted lines, so
// ownership on any date is the sum of the lines effective on or before it
// (holdingsAsOf) - later entries never rewrite earlier ownership, and a
// reversal takes effect on its own date. Entries are effective per EAT day.
//
// Money: a share issue records a COMMITMENT (shares × value per share, computed
// here from the class - never taken from the client). Money actually received
// is a `share_contributions` record (RMX-SHR-CON-000001) and, when it came
// through a business account, ONE `share_capital_contribution` entry in the
// Phase 5 ledger (finance.js) - owners' capital, never revenue. Money paid
// before RamosMAX tracked the accounts is recorded as `prior_record` without
// touching any balance. Reversing a contribution reverses its ledger entry in
// the same transaction.
//
// Totals (holdings, shareholder totals and ownership %, class totals and the
// register) are recomputed here from the holdings after every posting.
// ===========================================================================

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { deny, invalid, optionalText, precondition, requirePermission, requireReason } from './access.js';
import { audit, freshActor, notFound, requireDocId, stamp } from './operations.js';
import {
  dayKey, dayStart, holdersOf, openLedger, postReversal, readCounter, readRequest, readTransaction, requireAmount,
  requireBusinessDate, requireChoice, requireRequestId, saveRequest,
} from './finance.js';
import {
  CONTRIBUTIONS, HOLDINGS, MAX_CAPITAL_UGX, MAX_SHARES, SHAREHOLDERS, SHARE_TXNS, lockedRecordDate, nameOf, readSharePolicy,
  readShareClass, readShareholder, registerRef, requireNotOwnShareholding, requireRecordDateOpen,
} from './shareholders.js';
import { NotificationType, loadActor, notifySafely, requireObject } from './user_admin.js';

export const SHARE_TXN_TYPES = Object.freeze(['shares_issued', 'shares_transferred', 'shares_adjusted', 'reversal']);
export const SHARE_TXN_STATUSES = Object.freeze(['pending_approval', 'posted', 'rejected', 'reversed']);
export const PAYMENT_SOURCES = Object.freeze(['none', 'account', 'prior_record']);

// ---------------------------------------------------------------------------
// Pure calculations (unit-tested)
// ---------------------------------------------------------------------------

export function requireShares(input, field = 'number of shares') {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1 || input > MAX_SHARES) {
    throw invalid(`Enter the ${field} as a whole number greater than zero.`, 'shares');
  }
  return input;
}

/** Contribution = number of shares × value per share (whole shillings). */
export function contributionFor(shares, valuePerShareUgx) {
  const total = shares * valuePerShareUgx;
  if (!Number.isSafeInteger(total) || total > MAX_CAPITAL_UGX) throw invalid('That share commitment is too large.', 'amount');
  return total;
}

/** Ownership % = shares ÷ total shares × 100, to four decimal places. */
export function ownershipPercent(shares, totalShares) {
  if (!totalShares) return 0;
  return Math.round((shares * 1_000_000) / totalShares) / 10_000;
}

const effMs = (t) => (typeof t.effectiveDate === 'number' ? t.effectiveDate : t.effectiveDate.toMillis());

/**
 * Shares held on the EAT day starting [dayMs]: the sum of every applied
 * (posted or later reversed) entry's lines effective on or before that day.
 * Returns Map shareholderId -> {shares, byClass, shareholderNumber, shareholderName}.
 */
export function holdingsAsOf(txns, dayMs, { classIds = null } = {}) {
  const out = new Map();
  for (const t of txns) {
    if (t.applied !== true || effMs(t) > dayMs) continue;
    if (classIds && !classIds.includes(t.classId)) continue;
    for (const l of t.lines) {
      const h = out.get(l.shareholderId) ?? { shareholderId: l.shareholderId, shares: 0, byClass: {} };
      h.shares += l.deltaShares;
      h.byClass[t.classId] = (h.byClass[t.classId] ?? 0) + l.deltaShares;
      h.shareholderNumber = l.shareholderNumber;
      h.shareholderName = l.shareholderName;
      out.set(l.shareholderId, h);
    }
  }
  return out;
}

/**
 * True when [shareholderId]'s holding in [classId] never goes below zero at
 * the end of any day, with [extra] ({effectiveMs, delta} lines) added. This is
 * what stops a backdated transfer or correction from creating an impossible
 * history (e.g. transferring shares before they were issued).
 */
export function neverNegative(txns, shareholderId, classId, extra = []) {
  const byDay = new Map();
  const add = (day, d) => byDay.set(day, (byDay.get(day) ?? 0) + d);
  for (const t of txns) {
    if (t.applied !== true || t.classId !== classId) continue;
    for (const l of t.lines) if (l.shareholderId === shareholderId) add(effMs(t), l.deltaShares);
  }
  for (const e of extra) add(e.effectiveMs, e.delta);
  let balance = 0;
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    balance += byDay.get(day);
    if (balance < 0) return false;
  }
  return true;
}

/** Whether a payment of [amount] leaves an allowed outstanding under [policy]. */
export function checkPayment(policy, outstanding, amount) {
  if (amount > outstanding) {
    throw invalid(`The payment cannot be more than the UGX ${outstanding.toLocaleString('en-US')} outstanding.`, 'overpayment');
  }
  if (outstanding - amount > 0) {
    if (amount === 0 && !policy.allowUnpaidShares) {
      throw precondition('The share policy requires shares to be paid when they are issued.', 'full_payment_required');
    }
    if (amount > 0 && !policy.allowPartialPayment) {
      throw precondition('The share policy does not allow shares to be part-paid.', 'partial_payment_not_allowed');
    }
  }
}

export const paymentStatusOf = (committed, paid) => (paid >= committed ? 'paid' : paid > 0 ? 'partially_paid' : 'unpaid');

/** Totals from a list of holdings: per shareholder, per class and overall. Pure. */
export function aggregate(holdings) {
  const total = holdings.reduce((s, h) => s + h.shares, 0);
  const byShareholder = new Map();
  const byClass = new Map();
  for (const h of holdings) {
    const s = byShareholder.get(h.shareholderId) ?? {
      shareholderId: h.shareholderId, shareholderNumber: h.shareholderNumber, shareholderName: h.shareholderName,
      shares: 0, committedUgx: 0, paidUgx: 0,
    };
    s.shares += h.shares;
    s.committedUgx += h.committedUgx;
    s.paidUgx += h.paidUgx;
    byShareholder.set(h.shareholderId, s);
    const c = byClass.get(h.classId) ?? { classId: h.classId, classCode: h.classCode, issuedShares: 0, committedUgx: 0, paidUgx: 0 };
    c.issuedShares += h.shares;
    c.committedUgx += h.committedUgx;
    c.paidUgx += h.paidUgx;
    byClass.set(h.classId, c);
  }
  for (const s of byShareholder.values()) {
    s.outstandingUgx = s.committedUgx - s.paidUgx;
    s.ownershipPercent = ownershipPercent(s.shares, total);
  }
  for (const c of byClass.values()) c.outstandingUgx = c.committedUgx - c.paidUgx;
  return { totalShares: total, byShareholder, byClass };
}

// ---------------------------------------------------------------------------
// The book: every holding, read once per transaction and written back with
// all derived totals.
// ---------------------------------------------------------------------------

const holdingId = (shareholderId, classId) => `${shareholderId}_${classId}`;

async function readBook(tx, db, shareholderIds, classId) {
  const snap = await tx.get(db.collection(HOLDINGS));
  const holdings = new Map(snap.docs.map((d) => [d.id, { ...d.data() }]));
  const before = aggregate([...holdings.values()]);
  const shareholders = new Map();
  for (const id of new Set(shareholderIds)) shareholders.set(id, await readShareholder(tx, db, id));
  const cls = classId ? await readShareClass(tx, db, classId) : null;
  return { holdings, before, shareholders, cls, touched: new Set() };
}

/** Applies share / commitment / payment deltas to one holding (validated, in memory). */
function change(book, shareholderId, { shares = 0, committedUgx = 0, paidUgx = 0 }) {
  const cls = book.cls.data;
  const sh = book.shareholders.get(shareholderId).data;
  const id = holdingId(shareholderId, cls.classId);
  const h = book.holdings.get(id) ?? {
    holdingId: id, shareholderId, classId: cls.classId, shares: 0, committedUgx: 0, paidUgx: 0, outstandingUgx: 0,
  };
  h.shareholderNumber = sh.shareholderNumber;
  h.shareholderName = sh.fullName;
  h.classCode = cls.code;
  h.shares += shares;
  h.committedUgx += committedUgx;
  h.paidUgx += paidUgx;
  h.outstandingUgx = h.committedUgx - h.paidUgx;
  if (h.shares < 0) throw precondition(`${sh.fullName} does not hold enough ${cls.code} shares for this.`, 'insufficient_shares');
  if (h.committedUgx < 0 || h.paidUgx < 0 || h.outstandingUgx < 0) {
    throw precondition('This would leave the share commitment below what has been paid.', 'commitment_below_paid');
  }
  book.holdings.set(id, h);
  book.touched.add(id);
  return h;
}

/** Writes changed holdings and every total derived from them. Call after all reads. */
function writeBook(tx, db, book) {
  for (const id of book.touched) {
    tx.set(db.collection(HOLDINGS).doc(id), { ...book.holdings.get(id), updatedAt: stamp() });
  }
  const after = aggregate([...book.holdings.values()]);
  const ids = new Set([...book.before.byShareholder.keys(), ...after.byShareholder.keys()]);
  const fields = ['shares', 'committedUgx', 'paidUgx', 'outstandingUgx', 'ownershipPercent'];
  for (const id of ids) {
    const a = after.byShareholder.get(id);
    const b = book.before.byShareholder.get(id);
    if (a && b && fields.every((f) => a[f] === b[f])) continue;
    tx.set(db.collection(SHAREHOLDERS).doc(id), {
      totalShares: a?.shares ?? 0, ownershipPercent: a?.ownershipPercent ?? 0, committedUgx: a?.committedUgx ?? 0,
      paidUgx: a?.paidUgx ?? 0, outstandingUgx: a?.outstandingUgx ?? 0, updatedAt: stamp(),
    }, { merge: true });
  }
  for (const [classId, c] of after.byClass) {
    const b = book.before.byClass.get(classId);
    if (b && ['issuedShares', 'committedUgx', 'paidUgx'].every((f) => b[f] === c[f])) continue;
    tx.set(db.collection('share_classes').doc(classId), {
      issuedShares: c.issuedShares, committedUgx: c.committedUgx, paidUgx: c.paidUgx, outstandingUgx: c.outstandingUgx, updatedAt: stamp(),
    }, { merge: true });
  }
  const holders = [...after.byShareholder.values()]
    .filter((s) => s.shares > 0 || s.committedUgx > 0)
    .sort((x, y) => (y.shares - x.shares) || String(x.shareholderNumber).localeCompare(String(y.shareholderNumber)))
    .map((s) => ({
      shareholderId: s.shareholderId, shareholderNumber: s.shareholderNumber, shareholderName: s.shareholderName,
      shares: s.shares, ownershipPercent: s.ownershipPercent,
    }));
  let committed = 0;
  let paid = 0;
  for (const c of after.byClass.values()) {
    committed += c.committedUgx;
    paid += c.paidUgx;
  }
  tx.set(registerRef(db), {
    totalShares: after.totalShares,
    totalCommittedUgx: committed,
    totalPaidUgx: paid,
    outstandingUgx: committed - paid,
    holderCount: holders.filter((h) => h.shares > 0).length,
    holders,
    byClass: Object.fromEntries([...after.byClass.values()].map((c) => [c.classId, {
      classCode: c.classCode, issuedShares: c.issuedShares, committedUgx: c.committedUgx, paidUgx: c.paidUgx,
    }])),
    updatedAt: stamp(),
  }, { merge: true });
  return after;
}

/** Reads the applied history touching [shareholderId] and checks it stays non-negative. */
async function requireHistoryHolds(tx, db, shareholderId, classId, extra, name) {
  const snap = await tx.get(db.collection(SHARE_TXNS).where('shareholderIds', 'array-contains', shareholderId));
  if (!neverNegative(snap.docs.map((d) => d.data()), shareholderId, classId, extra)) {
    throw precondition(`${name} would not have held enough shares on that date. Choose a later effective date.`, 'insufficient_shares');
  }
}

// ---------------------------------------------------------------------------
// Posting (shared by immediate posting and approval)
// ---------------------------------------------------------------------------

function requireCanReceive(sh) {
  if (sh.status !== 'active') {
    throw precondition(`${sh.fullName} is ${sh.status} and cannot receive new shares.`, 'shareholder_not_active');
  }
}

function requireCanTransferOut(sh) {
  if (sh.status === 'suspended' || sh.status === 'exited') {
    throw precondition(`${sh.fullName} is ${sh.status}; their shares cannot be transferred.`, 'shareholder_not_active');
  }
}

/**
 * Reads everything posting [t] needs (call before any write) and returns the
 * function that performs the writes. Everything is re-validated here, so an
 * approval never posts something that stopped being valid while it waited.
 */
async function preparePosting(tx, db, t, actor, now) {
  const book = await readBook(tx, db, t.shareholderIds, t.classId);
  requireRecordDateOpen(effMs(t), await lockedRecordDate(tx, db));
  const sh = (id) => book.shareholders.get(id).data;
  if (t.type === 'shares_issued') {
    requireCanReceive(sh(t.toShareholderId));
    if (book.cls.data.active !== true) throw precondition(`The ${book.cls.data.code} share class is inactive.`, 'share_class_inactive');
  } else if (t.type === 'shares_transferred') {
    requireCanTransferOut(sh(t.fromShareholderId));
    requireCanReceive(sh(t.toShareholderId));
    const source = book.holdings.get(holdingId(t.fromShareholderId, t.classId));
    if ((source?.outstandingUgx ?? 0) > 0) {
      throw precondition(`${sh(t.fromShareholderId).fullName} has an unpaid ${t.classCode} share commitment. Record the payment before transferring.`,
        'outstanding_commitment');
    }
  } else if (t.type === 'shares_adjusted') {
    if (sh(t.lines[0].shareholderId).status === 'exited') throw precondition('This shareholder has exited.', 'shareholder_not_active');
  }
  for (const l of t.lines) {
    if (l.deltaShares < 0) {
      await requireHistoryHolds(tx, db, l.shareholderId, t.classId, [{ effectiveMs: effMs(t), delta: l.deltaShares }], sh(l.shareholderId).fullName);
    }
  }
  const pay = t.type === 'shares_issued' ? t.payment : null;
  const ledger = pay?.source === 'account' && pay.amountUgx > 0 ? await openLedger(tx, db, [pay.accountId], now) : null;
  const numbers = pay?.amountUgx > 0 ? await readCounter(tx, db, 'share_contributions', 'RMX-SHR-CON-', 6) : null;
  if (ledger) ledger.requireActive(pay.accountId, actor.uid);

  return (ref) => {
    // Share and commitment changes (validated in `change`).
    const after = {};
    for (const l of t.lines) after[l.shareholderId] = change(book, l.shareholderId, { shares: l.deltaShares, committedUgx: l.committedDeltaUgx ?? 0 }).shares;
    const lines = t.lines.map((l) => ({ ...l, sharesAfter: after[l.shareholderId] }));
    let contribution = null;
    if (pay?.amountUgx > 0) {
      contribution = writeContribution(tx, db, {
        actor, now, numbers, ledger, book, shareTxn: { ...t, transactionId: ref.id }, amountUgx: pay.amountUgx, source: pay.source,
        accountId: pay.accountId, reference: t.reference, paymentDate: t.acquisitionDate, requestId: t.requestId,
      });
    }
    if (ledger) ledger.commit(actor.uid);
    numbers?.commit();
    writeBook(tx, db, book);
    const paid = contribution?.amountUgx ?? 0;
    return {
      lines,
      ...(t.type === 'shares_issued' ? {
        paidUgx: paid, outstandingUgx: t.committedUgx - paid, paymentStatus: paymentStatusOf(t.committedUgx, paid),
        contributionIds: contribution ? [contribution.contributionId] : [],
      } : {}),
      contribution,
    };
  };
}

/** Writes one contribution (and its ledger entry for account payments). Returns its identifiers. */
function writeContribution(tx, db, { actor, now, numbers, ledger, book, shareTxn, amountUgx, source, accountId, reference, paymentDate, requestId }) {
  const shId = shareTxn.toShareholderId;
  const sh = book.shareholders.get(shId).data;
  const ref = db.collection(CONTRIBUTIONS).doc();
  const contributionNumber = numbers.next();
  let posting = { transactionId: null, transactionNumber: null };
  let account = null;
  if (source === 'account') {
    account = ledger.account(accountId, actor.uid);
    posting = ledger.post({
      type: 'share_capital_contribution', amountUgx, toId: accountId, actor, at: paymentDate,
      fields: {
        shareholderId: shId, shareholderNumber: sh.shareholderNumber, shareTransactionId: shareTxn.transactionId,
        shareTransactionNumber: shareTxn.transactionNumber, contributionId: ref.id, contributionNumber,
        reference: reference ?? null, requestId: requestId ?? null, approvedBy: actor.uid,
        description: `Share capital ${contributionNumber} from ${sh.shareholderNumber} (${shareTxn.transactionNumber})`,
      },
    });
  }
  change(book, shId, { paidUgx: amountUgx });
  tx.set(ref, {
    contributionId: ref.id,
    contributionNumber,
    shareholderId: shId,
    shareholderNumber: sh.shareholderNumber,
    shareholderName: sh.fullName,
    classId: shareTxn.classId,
    classCode: shareTxn.classCode,
    shareTransactionId: shareTxn.transactionId,
    shareTransactionNumber: shareTxn.transactionNumber,
    amountUgx,
    source,
    accountId: account ? accountId : null,
    accountName: account?.name ?? null,
    accountType: account?.type ?? null,
    financialTransactionId: posting.transactionId,
    financialTransactionNumber: posting.transactionNumber,
    paymentDate,
    reference: reference ?? null,
    status: 'posted',
    requestId: requestId ?? null,
    reversedAt: null,
    reversalReason: null,
    reversalTransactionId: null,
    createdBy: actor.uid,
    createdByName: nameOf(actor),
    createdAt: stamp(),
    updatedAt: stamp(),
  });
  audit(tx, db, actor, 'shareholders', 'share_contribution.recorded', ref.id, {
    newValue: {
      contributionNumber, shareholderNumber: sh.shareholderNumber, shareTransactionNumber: shareTxn.transactionNumber, amountUgx, source,
      accountId: account ? accountId : null, financialTransactionNumber: posting.transactionNumber,
    },
  });
  return { contributionId: ref.id, contributionNumber, amountUgx, ...posting };
}

// ---------------------------------------------------------------------------
// Requests: issue, transfer, adjust
// ---------------------------------------------------------------------------

function baseFields(t, actor, requestId, extra) {
  return {
    ...t,
    reversalOfType: null,
    reversalOfTransactionId: null,
    reversalOfTransactionNumber: null,
    reversedByTransactionId: null,
    reversedByTransactionNumber: null,
    reversalReason: null,
    requestedBy: actor.uid,
    requestedByName: nameOf(actor),
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    decisionReason: null,
    requestId,
    ...extra,
  };
}

/**
 * Records [t] as pending approval, or posts it at once when the share policy
 * does not require approval. [readsFirst] runs the request's own reads.
 */
async function submit(deps, callerUid, now, { permission, kind, requestId, build, auditAction }) {
  const { db } = deps;
  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, permission);
    const request = await readRequest(tx, db, requestId, actor.uid, kind);
    if (request.earlier) return { result: request.earlier, notify: false };
    const policy = await readSharePolicy(tx, db);
    const t = await build(tx, actor, policy);
    requireRecordDateOpen(effMs(t), await lockedRecordDate(tx, db));
    const ref = db.collection(SHARE_TXNS).doc();
    const numbers = await readCounter(tx, db, 'share_transactions', 'RMX-SHR-TXN-', 6);
    t.transactionNumber = numbers.next();
    const post = policy.requireApproval ? null : await preparePosting(tx, db, t, actor, now);

    // Writes.
    numbers.commit();
    let posted = null;
    if (post) posted = post(ref);
    const doc = {
      transactionId: ref.id,
      ...t,
      ...(posted ? { lines: posted.lines } : {}),
      ...(posted && t.type === 'shares_issued' ? { paidUgx: posted.paidUgx, outstandingUgx: posted.outstandingUgx, paymentStatus: posted.paymentStatus,
        contributionIds: posted.contributionIds } : {}),
      status: post ? 'posted' : 'pending_approval',
      applied: Boolean(post),
      ...(post ? { approvedBy: actor.uid, approvedByName: nameOf(actor), approvedAt: Timestamp.fromMillis(now), autoApproved: true } : {}),
      createdAt: stamp(),
      updatedAt: stamp(),
    };
    tx.set(ref, doc);
    if (!post) tx.set(registerRef(db), { pendingApprovals: FieldValue.increment(1), updatedAt: stamp() }, { merge: true });
    audit(tx, db, actor, 'shareholders', post ? auditAction : 'shares.requested', ref.id, {
      newValue: {
        transactionNumber: t.transactionNumber, type: t.type, classCode: t.classCode, shares: t.shares,
        lines: t.lines.map((l) => ({ shareholderNumber: l.shareholderNumber, deltaShares: l.deltaShares })),
        committedUgx: t.committedUgx ?? null, payment: t.payment ?? null, effectiveDate: dayKey(effMs(t)), status: doc.status,
      },
      reason: t.reason ?? null,
    });
    const result = {
      transactionId: ref.id, transactionNumber: t.transactionNumber, status: doc.status,
      ...(t.type === 'shares_issued' ? { committedUgx: t.committedUgx, paidUgx: doc.paidUgx, outstandingUgx: doc.outstandingUgx } : {}),
      ...(posted?.contribution ? { contributionId: posted.contribution.contributionId, financialTransactionId: posted.contribution.transactionId } : {}),
    };
    saveRequest(tx, request.ref, kind, actor.uid, result);
    return { result, notify: !post };
  });
  if (out.notify) {
    for (const uid of await holdersOf(db, ['shares.approve'], now)) {
      if (uid !== callerUid) await notifySafely(deps, uid, NotificationType.shareTransactionPending, out.result.transactionId);
    }
  }
  return out.result;
}

function paymentInput(input) {
  if (input == null) return { source: 'none', amountUgx: 0, accountId: null };
  requireObject(input);
  const source = requireChoice(input.source ?? 'account', PAYMENT_SOURCES, 'Choose how the shares were paid for.', 'payment_source');
  if (source === 'none') return { source, amountUgx: 0, accountId: null };
  const amountUgx = requireAmount(input.amountUgx, { field: 'amount paid' });
  const accountId = source === 'account' ? requireDocId(input.accountId, 'account') : null;
  return { source, amountUgx, accountId };
}

const lineFor = (sh, deltaShares, committedDeltaUgx = 0) => ({
  shareholderId: sh.shareholderId, shareholderNumber: sh.shareholderNumber, shareholderName: sh.fullName,
  deltaShares, committedDeltaUgx, sharesAfter: null,
});

/**
 * Issues [shares] of a class to a shareholder (a purchase / allotment). The
 * commitment is shares × the class's value per share, calculated here; any
 * contribution total sent by the app is ignored.
 */
export async function issueShares(deps, callerUid, rawData, now = Date.now()) {
  const data = requireObject(rawData);
  const shares = requireShares(data.shares);
  const effective = requireBusinessDate(data.effectiveDate, now, { field: 'effective date' });
  const acquisition = requireBusinessDate(data.acquisitionDate ?? data.effectiveDate, now, { field: 'acquisition date' });
  const payment = paymentInput(data.payment);
  const reference = optionalText(data.reference, 'Reference', 60);
  const notes = optionalText(data.notes, 'Notes', 500);
  const reason = requireReason(data.reason, { required: payment.source === 'prior_record' });
  const requestId = requireRequestId(data.requestId);

  return submit(deps, callerUid, now, {
    permission: 'shares.issue', kind: 'share_issue', requestId, auditAction: 'shares.issued',
    build: async (tx, actor, policy) => {
      const { data: sh } = await readShareholder(tx, deps.db, data.shareholderId);
      const { data: cls } = await readShareClass(tx, deps.db, data.classId);
      requireCanReceive(sh);
      if (cls.active !== true) throw precondition(`The ${cls.code} share class is inactive.`, 'share_class_inactive');
      const committed = contributionFor(shares, cls.valuePerShareUgx);
      checkPayment(policy, committed, payment.amountUgx);
      return baseFields({
        type: 'shares_issued', classId: cls.classId, classCode: cls.code, className: cls.name, shares,
        valuePerShareUgx: cls.valuePerShareUgx, committedUgx: committed, paidUgx: 0, outstandingUgx: committed,
        paymentStatus: paymentStatusOf(committed, 0), contributionIds: [],
        lines: [lineFor(sh, shares, committed)], shareholderIds: [sh.shareholderId],
        fromShareholderId: null, toShareholderId: sh.shareholderId,
        payment, acquisitionDate: acquisition, effectiveDate: effective, reference, notes, reason,
      }, actor, requestId);
    },
  });
}

/** Moves shares between two shareholders. Creates no shares: the total is unchanged. */
export async function transferShares(deps, callerUid, rawData, now = Date.now()) {
  const data = requireObject(rawData);
  const shares = requireShares(data.shares);
  const effective = requireBusinessDate(data.effectiveDate, now, { field: 'effective date' });
  const reason = requireReason(data.reason);
  const reference = optionalText(data.reference, 'Reference', 60);
  const notes = optionalText(data.notes, 'Notes', 500);
  const requestId = requireRequestId(data.requestId);
  const fromId = requireDocId(data.fromShareholderId, 'source shareholder');
  const toId = requireDocId(data.toShareholderId, 'destination shareholder');
  if (fromId === toId) throw invalid('Choose two different shareholders.', 'same_shareholder');

  return submit(deps, callerUid, now, {
    permission: 'shares.transfer', kind: 'share_transfer', requestId, auditAction: 'shares.transferred',
    build: async (tx, actor) => {
      const { data: from } = await readShareholder(tx, deps.db, fromId);
      const { data: to } = await readShareholder(tx, deps.db, toId);
      const { data: cls } = await readShareClass(tx, deps.db, data.classId);
      requireCanTransferOut(from);
      requireCanReceive(to);
      const holding = await tx.get(deps.db.collection(HOLDINGS).doc(holdingId(fromId, cls.classId)));
      if ((holding.get('shares') ?? 0) < shares) {
        throw precondition(`${from.fullName} holds only ${(holding.get('shares') ?? 0).toLocaleString('en-US')} ${cls.code} shares.`, 'insufficient_shares');
      }
      return baseFields({
        type: 'shares_transferred', classId: cls.classId, classCode: cls.code, className: cls.name, shares,
        lines: [lineFor(from, -shares), lineFor(to, shares)], shareholderIds: [fromId, toId],
        fromShareholderId: fromId, toShareholderId: toId, effectiveDate: effective, reference, notes, reason,
      }, actor, requestId);
    },
  });
}

/**
 * A correction: ±n shares with a reason. The earlier entries stay as they
 * were; the adjustment is a new entry. With adjustCommitment the commitment
 * moves by n × the class's current value per share.
 */
export async function adjustShares(deps, callerUid, rawData, now = Date.now()) {
  const data = requireObject(rawData);
  const delta = data.deltaShares;
  if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_SHARES) {
    throw invalid('Enter the correction as a whole number of shares, e.g. -5 or 10.', 'shares');
  }
  const adjustCommitment = data.adjustCommitment === true;
  const effective = requireBusinessDate(data.effectiveDate, now, { field: 'effective date' });
  const reason = requireReason(data.reason);
  const reference = optionalText(data.reference, 'Reference', 60);
  const notes = optionalText(data.notes, 'Notes', 500);
  const requestId = requireRequestId(data.requestId);

  return submit(deps, callerUid, now, {
    permission: 'shares.adjust', kind: 'share_adjustment', requestId, auditAction: 'shares.adjusted',
    build: async (tx, actor) => {
      const { data: sh } = await readShareholder(tx, deps.db, data.shareholderId);
      const { data: cls } = await readShareClass(tx, deps.db, data.classId);
      if (sh.status === 'exited') throw precondition('This shareholder has exited.', 'shareholder_not_active');
      const committedDelta = adjustCommitment ? Math.sign(delta) * contributionFor(Math.abs(delta), cls.valuePerShareUgx) : 0;
      return baseFields({
        type: 'shares_adjusted', classId: cls.classId, classCode: cls.code, className: cls.name, shares: Math.abs(delta),
        adjustmentShares: delta, adjustCommitment, valuePerShareUgx: adjustCommitment ? cls.valuePerShareUgx : null,
        committedUgx: adjustCommitment ? committedDelta : null,
        lines: [lineFor(sh, delta, committedDelta)], shareholderIds: [sh.shareholderId],
        fromShareholderId: null, toShareholderId: null, effectiveDate: effective, reference, notes, reason,
      }, actor, requestId);
    },
  });
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

async function readShareTxn(tx, db, id) {
  const ref = db.collection(SHARE_TXNS).doc(requireDocId(id, 'share transaction'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That share transaction could not be found.', 'share_transaction_not_found');
  return { ref, t: snap.data() };
}

/**
 * approve: posts a pending entry (everything re-validated); reject: closes it
 * with a reason. The requester cannot decide their own request, and nobody
 * decides a transaction on their own shareholding (Administrators excepted).
 */
export async function decideShareTransaction(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const decision = requireChoice(data.decision, ['approve', 'reject'], 'Choose approve or reject.', 'decision');
  const reason = requireReason(data.reason, { required: decision === 'reject' });

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'shares.approve');
    const { ref, t } = await readShareTxn(tx, db, data.transactionId);
    if (t.status !== 'pending_approval') throw precondition('This share transaction has already been decided.', 'already_decided');
    if (t.requestedBy === actor.uid && actor.data.role !== 'admin') {
      throw deny('Another person must approve a share transaction you requested.', 'self_approval');
    }
    const involved = [];
    for (const id of t.shareholderIds) involved.push((await readShareholder(tx, db, id)).data);
    requireNotOwnShareholding(actor, involved, 'decide a transaction on');
    let post = null;
    if (decision === 'approve') {
      if (t.type === 'shares_issued') checkPayment(await readSharePolicy(tx, db), t.committedUgx, t.payment?.amountUgx ?? 0);
      post = await preparePosting(tx, db, t, actor, now);
    }
    // Writes.
    const at = Timestamp.fromMillis(now);
    let update;
    if (post) {
      const posted = post(ref);
      update = {
        status: 'posted', applied: true, lines: posted.lines, approvedBy: actor.uid, approvedByName: nameOf(actor), approvedAt: at,
        decisionReason: reason,
        ...(t.type === 'shares_issued' ? { paidUgx: posted.paidUgx, outstandingUgx: posted.outstandingUgx, paymentStatus: posted.paymentStatus,
          contributionIds: posted.contributionIds } : {}),
      };
    } else {
      update = { status: 'rejected', approvedBy: null, rejectedBy: actor.uid, rejectedByName: nameOf(actor), rejectedAt: at, decisionReason: reason };
    }
    tx.update(ref, { ...update, updatedAt: stamp() });
    tx.set(registerRef(db), { pendingApprovals: FieldValue.increment(-1), updatedAt: stamp() }, { merge: true });
    audit(tx, db, actor, 'shareholders', post ? t.type.replace('shares_', 'shares.') : 'shares.rejected', ref.id, {
      previousValue: { status: 'pending_approval' },
      newValue: { status: update.status, transactionNumber: t.transactionNumber, type: t.type, shares: t.shares, requestedBy: t.requestedBy },
      reason,
    });
    return { result: { transactionId: ref.id, transactionNumber: t.transactionNumber, status: update.status }, requester: t.requestedBy };
  });
  if (out.requester && out.requester !== callerUid) {
    await notifySafely(deps, out.requester, NotificationType.shareTransactionCompleted, out.result.transactionId);
  }
  return out.result;
}

// ---------------------------------------------------------------------------
// Contributions (money received for shares already issued)
// ---------------------------------------------------------------------------

/** Money paid towards an issued, not fully paid share commitment. */
export async function recordShareContribution(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const payment = paymentInput({ source: data.source ?? 'account', amountUgx: data.amountUgx, accountId: data.accountId });
  if (payment.source === 'none') throw invalid('Choose how the money was received.', 'payment_source');
  const requestId = requireRequestId(data.requestId);
  const reference = optionalText(data.reference, 'Reference', 60);
  const reason = requireReason(data.reason, { required: payment.source === 'prior_record' });
  const paymentDate = requireBusinessDate(data.paymentDate, now, { field: 'payment date' });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'shares.issue');
    const request = await readRequest(tx, db, requestId, actor.uid, 'share_contribution');
    if (request.earlier) return request.earlier;
    const { ref, t } = await readShareTxn(tx, db, data.shareTransactionId);
    if (t.type !== 'shares_issued' || t.status !== 'posted') {
      throw precondition('Payments are recorded against posted share issues only.', 'not_payable');
    }
    const policy = await readSharePolicy(tx, db);
    checkPayment(policy, t.outstandingUgx, payment.amountUgx);
    const book = await readBook(tx, db, [t.toShareholderId], t.classId);
    if (book.shareholders.get(t.toShareholderId).data.status === 'exited') throw precondition('This shareholder has exited.', 'shareholder_not_active');
    const ledger = payment.source === 'account' ? await openLedger(tx, db, [payment.accountId], now) : null;
    if (ledger) ledger.requireActive(payment.accountId, actor.uid);
    const numbers = await readCounter(tx, db, 'share_contributions', 'RMX-SHR-CON-', 6);

    const c = writeContribution(tx, db, {
      actor, now, numbers, ledger, book, shareTxn: t, amountUgx: payment.amountUgx, source: payment.source,
      accountId: payment.accountId, reference, paymentDate, requestId,
    });
    ledger?.commit(actor.uid);
    numbers.commit();
    writeBook(tx, db, book);
    const paid = t.paidUgx + payment.amountUgx;
    tx.update(ref, {
      paidUgx: paid, outstandingUgx: t.committedUgx - paid, paymentStatus: paymentStatusOf(t.committedUgx, paid),
      contributionIds: FieldValue.arrayUnion(c.contributionId), updatedAt: stamp(),
    });
    const result = { ...c, outstandingUgx: t.committedUgx - paid, ...(ledger ? { balanceUgx: ledger.balance(payment.accountId) } : {}) };
    if (reason) audit(tx, db, actor, 'shareholders', 'share_contribution.prior_record', c.contributionId, { newValue: { amountUgx: payment.amountUgx }, reason });
    saveRequest(tx, request.ref, 'share_contribution', actor.uid, result);
    return result;
  });
}

/**
 * Reverses one contribution: its ledger entry is reversed (the money leaves
 * the account again - refused if the account no longer holds it) and the
 * commitment is outstanding again. The contribution stays, marked reversed.
 */
export async function reverseShareContribution(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'shares.adjust');
    const cRef = db.collection(CONTRIBUTIONS).doc(requireDocId(data.contributionId, 'contribution'));
    const cSnap = await tx.get(cRef);
    if (!cSnap.exists) throw notFound('That contribution could not be found.');
    const c = cSnap.data();
    if (c.status !== 'posted') throw precondition('This contribution has already been reversed.', 'already_reversed');
    const { ref, t } = await readShareTxn(tx, db, c.shareTransactionId);
    const book = await readBook(tx, db, [c.shareholderId], c.classId);
    const original = c.financialTransactionId ? await readTransaction(tx, db, c.financialTransactionId) : null;
    const ledger = original ? await openLedger(tx, db, [original.data.destinationAccountId], now) : null;

    let reversal = { transactionId: null, transactionNumber: null };
    if (original) {
      reversal = postReversal(tx, ledger, original, actor, reason, {
        shareholderId: c.shareholderId, contributionId: c.contributionId, contributionNumber: c.contributionNumber,
        shareTransactionId: c.shareTransactionId,
      });
      ledger.commit(actor.uid);
    }
    change(book, c.shareholderId, { paidUgx: -c.amountUgx });
    writeBook(tx, db, book);
    tx.update(cRef, {
      status: 'reversed', reversedAt: stamp(), reversedBy: actor.uid, reversalReason: reason,
      reversalTransactionId: reversal.transactionId, reversalTransactionNumber: reversal.transactionNumber, updatedAt: stamp(),
    });
    const paid = t.paidUgx - c.amountUgx;
    tx.update(ref, { paidUgx: paid, outstandingUgx: t.committedUgx - paid, paymentStatus: paymentStatusOf(t.committedUgx, paid), updatedAt: stamp() });
    audit(tx, db, actor, 'shareholders', 'share_contribution.reversed', cRef.id, {
      previousValue: { status: 'posted', amountUgx: c.amountUgx, financialTransactionNumber: c.financialTransactionNumber ?? null },
      newValue: { status: 'reversed', reversalTransactionNumber: reversal.transactionNumber, outstandingUgx: t.committedUgx - paid },
      reason,
    });
    return { contributionId: cRef.id, ...reversal };
  });
}

// ---------------------------------------------------------------------------
// Reversal of an ownership entry
// ---------------------------------------------------------------------------

/**
 * Posts the mirror image of a posted issue / transfer / adjustment, effective
 * today; the original stays in the history marked reversed. Reversing an issue
 * also reverses its live contributions (and their ledger entries) atomically.
 * Refused when the shares are no longer held (e.g. already transferred on).
 */
export async function reverseShareTransaction(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  const requestId = requireRequestId(data.requestId);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'shares.adjust');
    const request = await readRequest(tx, db, requestId, actor.uid, 'share_reversal');
    if (request.earlier) return request.earlier;
    const { ref, t } = await readShareTxn(tx, db, data.transactionId);
    if (t.type === 'reversal') throw precondition('A reversal cannot itself be reversed.', 'is_reversal');
    if (t.status === 'reversed') throw precondition('This share transaction has already been reversed.', 'already_reversed');
    if (t.status !== 'posted') throw precondition('Only a posted share transaction can be reversed.', 'not_posted');
    const today = dayStart(now);
    requireRecordDateOpen(today, await lockedRecordDate(tx, db));
    const book = await readBook(tx, db, t.shareholderIds, t.classId);
    const liveContributions = [];
    if (t.type === 'shares_issued') {
      const snap = await tx.get(db.collection(CONTRIBUTIONS).where('shareTransactionId', '==', ref.id));
      for (const d of snap.docs) if (d.get('status') === 'posted') liveContributions.push(d);
    }
    const originals = [];
    for (const d of liveContributions) if (d.get('financialTransactionId')) originals.push(await readTransaction(tx, db, d.get('financialTransactionId')));
    const ledger = originals.length ? await openLedger(tx, db, originals.map((o) => o.data.destinationAccountId), now) : null;
    const numbers = await readCounter(tx, db, 'share_transactions', 'RMX-SHR-TXN-', 6);

    // Writes.
    const reversalRef = db.collection(SHARE_TXNS).doc();
    const reversalNumber = numbers.next();
    numbers.commit();
    for (const d of liveContributions) {
      const o = originals.find((x) => x.ref.id === d.get('financialTransactionId'));
      let r = { transactionId: null, transactionNumber: null };
      if (o) {
        r = postReversal(tx, ledger, o, actor, reason, {
          shareholderId: d.get('shareholderId'), contributionId: d.id, contributionNumber: d.get('contributionNumber'), shareTransactionId: ref.id,
        });
      }
      change(book, d.get('shareholderId'), { paidUgx: -d.get('amountUgx') });
      tx.update(d.ref, {
        status: 'reversed', reversedAt: stamp(), reversedBy: actor.uid, reversalReason: reason,
        reversalTransactionId: r.transactionId, reversalTransactionNumber: r.transactionNumber, updatedAt: stamp(),
      });
    }
    ledger?.commit(actor.uid);
    const lines = t.lines.map((l) => {
      if (l.deltaShares < 0 && book.shareholders.get(l.shareholderId).data.status === 'exited') {
        throw precondition(`${l.shareholderName} has exited; reactivate them before shares are returned to them.`, 'shareholder_not_active');
      }
      const h = change(book, l.shareholderId, { shares: -l.deltaShares, committedUgx: -(l.committedDeltaUgx ?? 0) });
      return { ...l, deltaShares: -l.deltaShares, committedDeltaUgx: -(l.committedDeltaUgx ?? 0), sharesAfter: h.shares };
    });
    writeBook(tx, db, book);
    tx.set(reversalRef, {
      transactionId: reversalRef.id,
      transactionNumber: reversalNumber,
      type: 'reversal',
      reversalOfType: t.type,
      reversalOfTransactionId: ref.id,
      reversalOfTransactionNumber: t.transactionNumber,
      status: 'posted',
      applied: true,
      classId: t.classId,
      classCode: t.classCode,
      className: t.className ?? null,
      shares: t.shares,
      lines,
      shareholderIds: t.shareholderIds,
      fromShareholderId: t.toShareholderId ?? null,
      toShareholderId: t.fromShareholderId ?? null,
      effectiveDate: Timestamp.fromMillis(today),
      reason,
      requestedBy: actor.uid,
      requestedByName: nameOf(actor),
      approvedBy: actor.uid,
      approvedByName: nameOf(actor),
      approvedAt: Timestamp.fromMillis(now),
      requestId,
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    tx.update(ref, {
      status: 'reversed', reversedByTransactionId: reversalRef.id, reversedByTransactionNumber: reversalNumber,
      reversedAt: stamp(), reversedBy: actor.uid, reversalReason: reason,
      ...(t.type === 'shares_issued' ? { paidUgx: 0, outstandingUgx: 0, paymentStatus: 'reversed' } : {}),
      updatedAt: stamp(),
    });
    audit(tx, db, actor, 'shareholders', 'shares.reversed', ref.id, {
      previousValue: { status: 'posted', transactionNumber: t.transactionNumber, type: t.type },
      newValue: { status: 'reversed', reversalTransactionNumber: reversalNumber, contributionsReversed: liveContributions.length },
      reason,
    });
    const result = { transactionId: reversalRef.id, transactionNumber: reversalNumber, contributionsReversed: liveContributions.length };
    saveRequest(tx, request.ref, 'share_reversal', actor.uid, result);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Historical ownership
// ---------------------------------------------------------------------------

export async function readAppliedTransactions(source, db) {
  const q = db.collection(SHARE_TXNS).where('applied', '==', true);
  const snap = await (source ? source.get(q) : q.get());
  return snap.docs.map((d) => d.data());
}

/** The ownership distribution as it stood at the end of an EAT day, from the immutable ledger. */
export function distributionAsOf(txns, dayMs, options = {}) {
  const map = holdingsAsOf(txns, dayMs, options);
  const total = [...map.values()].reduce((s, h) => s + h.shares, 0);
  const holders = [...map.values()].filter((h) => h.shares > 0)
    .map((h) => ({ ...h, ownershipPercent: ownershipPercent(h.shares, total) }))
    .sort((a, b) => (b.shares - a.shares) || String(a.shareholderNumber).localeCompare(String(b.shareholderNumber)));
  return { asOf: dayKey(dayMs), totalShares: total, holders };
}

export async function getOwnershipAsOf(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData ?? {});
  const actor = await loadActor(db, callerUid, now);
  requirePermission(actor.perms, 'shares.view', 'shareholders.reports.view');
  const day = requireBusinessDate(data.date, now, { field: 'date' }).toMillis();
  const classIds = data.classId == null ? null : [requireDocId(data.classId, 'share class')];
  return distributionAsOf(await readAppliedTransactions(null, db), day, { classIds });
}
