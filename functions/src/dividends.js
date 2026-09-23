// ===========================================================================
// RamosMAX dividends - declaration, record-date allocation, approval,
// payment through the Phase 5 ledger, reversal and cancellation (Phase 7).
// ===========================================================================
//
//   draft ──calculate (record date reached)──► draft+allocations ──declare──► declared ──approve──► approved
//     ▲  │ (edit / recalculate: earlier allocations kept, marked superseded)      │                    │
//     │  └──────────────────────────────────────── return (reason) ◄─────────────┘                    │
//   approved ──pay (per allocation)──► partially_paid ──pay rest──► paid                                │
//   paid / partially_paid ──reverse a payment (dividends.adjust, reason)──► partially_paid / approved  │
//   draft / declared / approved (nothing paid) ──cancel (reason)──► cancelled ◄─────────────────────────┘
//
// The business enters the amount it has approved for distribution (or an
// amount per share); RamosMAX does NOT work out profit or what is legally
// distributable, and applies NO tax or other deduction unless one is
// configured in future (deductionsUgx is always 0 today).
//
// Eligibility: whoever held eligible shares at the end of the RECORD DATE,
// from the immutable share ledger (shares.holdingsAsOf) - never today's
// holdings. The snapshot is frozen onto the allocations (dividend_allocations,
// RMX-DIV-PAY-000001), and once calculated no share transaction may take
// effect on or before the record date (`recordLocked`), so it cannot drift.
//
//   pool:       gross_i = floor(pool × shares_i ÷ eligible shares); the few
//               shillings lost to rounding are reported as unallocatedUgx.
//   per_share:  gross_i = amount per share × shares_i.
//
// Payment: ONE `dividend_payment` ledger entry per allocation (finance.js) -
// a distribution to owners, never an operating expense. No overdraft.
// ===========================================================================

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { deny, invalid, optionalText, precondition, requireReason } from './access.js';
import { audit, freshActor, notFound, requireDocId, stamp } from './operations.js';
import {
  dayKey, dayStart, holdersOf, openLedger, postReversal, readCounter, readRequest, readTransaction, requireAmount,
  requireBusinessDate, requireChoice, requireRequestId, requireText, saveRequest,
} from './finance.js';
import {
  ALLOCATIONS, DIVIDENDS, MAX_CAPITAL_UGX, MAX_VALUE_PER_SHARE_UGX, SHAREHOLDERS, nameOf, readDividendPolicy, readShareClass,
  requireNotOwnShareholding,
} from './shareholders.js';
import { holdingsAsOf, ownershipPercent, readAppliedTransactions } from './shares.js';
import { NotificationType, notifySafely, requireObject } from './user_admin.js';
import { requireIdList } from './workforce.js';

export const DIVIDEND_STATUSES = Object.freeze(['draft', 'declared', 'approved', 'partially_paid', 'paid', 'cancelled']);
export const CALCULATION_METHODS = Object.freeze(['pool', 'per_share']);

// ---------------------------------------------------------------------------
// Pure calculation (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Allocations for [holders] ({shareholderId, shares, ...}) under [method].
 * Integer arithmetic only (BigInt for the pool split).
 */
export function allocate({ method, poolUgx = null, perShareUgx = null, holders }) {
  const eligible = holders.filter((h) => h.shares > 0);
  const totalShares = eligible.reduce((s, h) => s + h.shares, 0);
  if (totalShares === 0) throw precondition('Nobody held eligible shares at the end of the record date.', 'no_eligible_shares');
  let pool;
  let perShare;
  if (method === 'per_share') {
    const p = BigInt(perShareUgx) * BigInt(totalShares);
    if (p > BigInt(MAX_CAPITAL_UGX)) throw invalid('That dividend is too large.', 'amount');
    pool = Number(p);
    perShare = perShareUgx;
  } else {
    pool = poolUgx;
    perShare = Math.round((pool / totalShares) * 10_000) / 10_000; // for display; allocations below are exact
  }
  const lines = eligible.map((h) => {
    const gross = method === 'per_share' ? perShareUgx * h.shares : Number((BigInt(pool) * BigInt(h.shares)) / BigInt(totalShares));
    return { ...h, ownershipPercent: ownershipPercent(h.shares, totalShares), grossUgx: gross, deductionsUgx: 0, netUgx: gross };
  });
  const allocated = lines.reduce((s, l) => s + l.grossUgx, 0);
  return { totalShares, poolUgx: pool, dividendPerShareUgx: perShare, lines, allocatedUgx: allocated, unallocatedUgx: pool - allocated };
}

/** Status after payments: every payable allocation paid → paid; some → partially_paid; none → approved. */
export function statusAfterPayments(paidCount, payableCount) {
  if (paidCount === 0) return 'approved';
  return paidCount >= payableCount ? 'paid' : 'partially_paid';
}

// ---------------------------------------------------------------------------
// Declaration (draft)
// ---------------------------------------------------------------------------

function dividendInput(data, now) {
  const out = {
    financialPeriod: requireText(data.financialPeriod, 'Financial period', 60),
    declarationDate: requireBusinessDate(data.declarationDate, now, { field: 'declaration date', futureDays: 366 }),
    recordDate: requireBusinessDate(data.recordDate, now, { field: 'record date', futureDays: 366 }),
    paymentDate: data.paymentDate == null ? null : requireBusinessDate(data.paymentDate, now, { field: 'payment date', futureDays: 366 }),
    calculationMethod: requireChoice(data.calculationMethod ?? 'pool', CALCULATION_METHODS, 'Choose a total amount or an amount per share.', 'method'),
    classId: data.classId == null || data.classId === '' ? null : requireDocId(data.classId, 'share class'),
    notes: optionalText(data.notes, 'Notes', 500),
  };
  if (out.paymentDate && out.paymentDate.toMillis() < out.recordDate.toMillis()) {
    throw invalid('The payment date cannot be before the record date.', 'payment_date');
  }
  out.totalDistributableUgx = out.calculationMethod === 'pool'
    ? requireAmount(data.totalDistributableUgx, { field: 'distributable amount', max: MAX_CAPITAL_UGX }) : null;
  out.dividendPerShareUgx = out.calculationMethod === 'per_share'
    ? requireAmount(data.dividendPerShareUgx, { field: 'dividend per share', max: MAX_VALUE_PER_SHARE_UGX }) : null;
  return out;
}

async function readDividend(tx, db, id) {
  const ref = db.collection(DIVIDENDS).doc(requireDocId(id, 'dividend'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That dividend could not be found.', 'dividend_not_found');
  return { ref, d: snap.data() };
}

/** The recipients' CURRENT sign-in links (an account may be linked after the calculation). */
async function recipients(tx, db, allocations) {
  const out = [];
  for (const id of new Set(allocations.map((a) => a.get('shareholderId')))) {
    const s = await tx.get(db.collection(SHAREHOLDERS).doc(id));
    out.push({ shareholderId: id, linkedUid: s.exists ? s.get('linkedUid') ?? null : null });
  }
  return out;
}

async function currentAllocations(tx, db, dividendId) {
  const snap = await tx.get(db.collection(ALLOCATIONS).where('dividendId', '==', dividendId));
  return snap.docs.filter((s) => s.get('current') === true);
}

const CALCULATION_RESET = {
  calculatedAt: null, calculatedBy: null, calculatedByName: null, recordLocked: false,
  eligibleShares: 0, eligibleShareholderCount: 0, allocatedUgx: 0, unallocatedUgx: 0, allocationCount: 0, payableCount: 0,
  outstandingUgx: 0, snapshot: null,
};

export async function createDividend(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const input = dividendInput(data, now);
  const requestId = requireRequestId(data.requestId);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'dividends.create');
    const request = await readRequest(tx, db, requestId, actor.uid, 'dividend_create');
    if (request.earlier) return request.earlier;
    const cls = input.classId ? (await readShareClass(tx, db, input.classId)).data : null;
    const numbers = await readCounter(tx, db, 'dividends', 'RMX-DIV-', 6);
    const ref = db.collection(DIVIDENDS).doc();
    const dividendNumber = numbers.next();
    numbers.commit();
    tx.set(ref, {
      dividendId: ref.id,
      dividendNumber,
      ...input,
      classCode: cls?.code ?? null,
      status: 'draft',
      ...CALCULATION_RESET,
      paidUgx: 0,
      paidCount: 0,
      version: 0,
      declaredBy: null, declaredByName: null, declaredAt: null,
      approvedBy: null, approvedByName: null, approvedAt: null,
      cancelledBy: null, cancelledAt: null, cancelReason: null, returnedReason: null,
      requestId,
      createdBy: actor.uid,
      createdByName: nameOf(actor),
      createdAt: stamp(),
      updatedAt: stamp(),
      updatedBy: actor.uid,
    });
    audit(tx, db, actor, 'shareholders', 'dividend.created', ref.id, {
      newValue: {
        dividendNumber, financialPeriod: input.financialPeriod, recordDate: dayKey(input.recordDate.toMillis()),
        calculationMethod: input.calculationMethod, totalDistributableUgx: input.totalDistributableUgx, dividendPerShareUgx: input.dividendPerShareUgx,
        classCode: cls?.code ?? null,
      },
    });
    const result = { dividendId: ref.id, dividendNumber };
    saveRequest(tx, request.ref, 'dividend_create', actor.uid, result);
    return result;
  });
}

/** Changes a draft. Any calculation is discarded (allocations kept, superseded). */
export async function updateDividend(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const input = dividendInput(data, now);
  const reason = requireReason(data.reason, { required: false });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'dividends.create');
    const { ref, d } = await readDividend(tx, db, data.dividendId);
    if (d.status !== 'draft') throw precondition('Only a draft dividend can be changed.', 'invalid_status');
    const cls = input.classId ? (await readShareClass(tx, db, input.classId)).data : null;
    const allocations = await currentAllocations(tx, db, ref.id);
    const fields = Object.keys(input);
    const changed = fields.filter((k) => !same(input[k], d[k]));
    if (changed.length === 0) throw precondition('Nothing has changed.', 'no_changes');
    for (const a of allocations) tx.update(a.ref, { current: false, dividendStatus: 'superseded', updatedAt: stamp() });
    tx.update(ref, { ...input, classCode: cls?.code ?? null, ...CALCULATION_RESET, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'shareholders', 'dividend.updated', ref.id, {
      previousValue: Object.fromEntries(changed.map((k) => [k, show(d[k])])),
      newValue: Object.fromEntries(changed.map((k) => [k, show(input[k])])),
      reason,
    });
    return { dividendId: ref.id, changed };
  });
}

const same = (a, b) => (a instanceof Timestamp || b instanceof Timestamp ? a?.toMillis?.() === b?.toMillis?.() : (a ?? null) === (b ?? null));
const show = (v) => (v instanceof Timestamp ? dayKey(v.toMillis()) : v ?? null);

// ---------------------------------------------------------------------------
// Calculation: the record-date snapshot
// ---------------------------------------------------------------------------

export async function calculateDividend(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'dividends.calculate');
    const { ref, d } = await readDividend(tx, db, data.dividendId);
    if (d.status !== 'draft') throw precondition('Only a draft dividend can be calculated.', 'invalid_status');
    const recordMs = d.recordDate.toMillis();
    if (recordMs > dayStart(now)) {
      throw precondition(`Allocations can be calculated once the record date (${dayKey(recordMs)}) has been reached.`, 'record_date_future');
    }
    const txns = await readAppliedTransactions(tx, db);
    const holders = [...holdingsAsOf(txns, recordMs, { classIds: d.classId ? [d.classId] : null }).values()].filter((h) => h.shares > 0);
    const calc = allocate({ method: d.calculationMethod, poolUgx: d.totalDistributableUgx, perShareUgx: d.dividendPerShareUgx, holders });
    const profiles = new Map();
    for (const h of calc.lines) {
      const s = await tx.get(db.collection(SHAREHOLDERS).doc(h.shareholderId));
      profiles.set(h.shareholderId, s.exists ? s.data() : {});
    }
    const previous = await currentAllocations(tx, db, ref.id);
    const numbers = await readCounter(tx, db, 'dividend_allocations', 'RMX-DIV-PAY-', 6);

    // Writes.
    for (const a of previous) tx.update(a.ref, { current: false, dividendStatus: 'superseded', updatedAt: stamp() });
    const version = (d.version ?? 0) + 1;
    for (const l of calc.lines) {
      const a = db.collection(ALLOCATIONS).doc();
      const p = profiles.get(l.shareholderId);
      tx.set(a, {
        allocationId: a.id,
        allocationNumber: numbers.next(),
        dividendId: ref.id,
        dividendNumber: d.dividendNumber,
        financialPeriod: d.financialPeriod,
        recordDate: d.recordDate,
        classId: d.classId ?? null,
        classCode: d.classCode ?? null,
        shareholderId: l.shareholderId,
        shareholderNumber: p.shareholderNumber ?? l.shareholderNumber,
        shareholderName: p.fullName ?? l.shareholderName,
        linkedUid: p.linkedUid ?? null,
        sharesAtRecordDate: l.shares,
        totalSharesAtRecordDate: calc.totalShares,
        ownershipPercentAtRecordDate: l.ownershipPercent,
        dividendPerShareUgx: calc.dividendPerShareUgx,
        grossUgx: l.grossUgx,
        deductionsUgx: l.deductionsUgx,
        netUgx: l.netUgx,
        paymentStatus: l.netUgx > 0 ? 'unpaid' : 'not_payable',
        dividendStatus: 'draft',
        current: true,
        version,
        paidAt: null, paymentDate: null, paymentReference: null, accountId: null, accountName: null,
        financialTransactionId: null, financialTransactionNumber: null, paidBy: null, paidByName: null,
        reversals: [],
        createdAt: stamp(),
        updatedAt: stamp(),
      });
    }
    numbers.commit();
    const payable = calc.lines.filter((l) => l.netUgx > 0).length;
    tx.update(ref, {
      totalDistributableUgx: calc.poolUgx,
      dividendPerShareUgx: calc.dividendPerShareUgx,
      eligibleShares: calc.totalShares,
      eligibleShareholderCount: calc.lines.length,
      allocatedUgx: calc.allocatedUgx,
      unallocatedUgx: calc.unallocatedUgx,
      outstandingUgx: calc.allocatedUgx,
      allocationCount: calc.lines.length,
      payableCount: payable,
      recordLocked: true,
      snapshot: {
        asOf: dayKey(recordMs),
        totalShares: calc.totalShares,
        holders: calc.lines.map((l) => ({ shareholderId: l.shareholderId, shareholderNumber: l.shareholderNumber, shares: l.shares, ownershipPercent: l.ownershipPercent })),
      },
      calculatedAt: stamp(),
      calculatedBy: actor.uid,
      calculatedByName: nameOf(actor),
      version,
      updatedAt: stamp(),
      updatedBy: actor.uid,
    });
    audit(tx, db, actor, 'shareholders', 'dividend.calculated', ref.id, {
      newValue: {
        recordDate: dayKey(recordMs), eligibleShares: calc.totalShares, eligibleShareholders: calc.lines.length,
        totalDistributableUgx: calc.poolUgx, dividendPerShareUgx: calc.dividendPerShareUgx, allocatedUgx: calc.allocatedUgx,
        unallocatedUgx: calc.unallocatedUgx, version,
      },
    });
    return { dividendId: ref.id, eligibleShares: calc.totalShares, allocationCount: calc.lines.length, allocatedUgx: calc.allocatedUgx,
      unallocatedUgx: calc.unallocatedUgx, dividendPerShareUgx: calc.dividendPerShareUgx };
  });
}

// ---------------------------------------------------------------------------
// Declare / return / approve
// ---------------------------------------------------------------------------

/** declare (dividends.declare) · return to draft (dividends.approve, reason) · approve (dividends.approve). */
export async function updateDividendStatus(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const action = requireChoice(data.action, ['declare', 'return', 'approve'], 'Choose a valid action.', 'action');
  const reason = requireReason(data.reason, { required: action === 'return' });
  const permission = action === 'declare' ? 'dividends.declare' : 'dividends.approve';

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, permission);
    const { ref, d } = await readDividend(tx, db, data.dividendId);
    const allocations = await currentAllocations(tx, db, ref.id);
    const linked = action === 'approve' ? await recipients(tx, db, allocations) : [];
    const at = Timestamp.fromMillis(now);
    let update;
    if (action === 'declare') {
      if (d.status !== 'draft') throw precondition('Only a draft dividend can be declared.', 'invalid_status');
      if (!d.calculatedAt || allocations.length === 0) throw precondition('Calculate the allocations before declaring.', 'not_calculated');
      update = { status: 'declared', declaredBy: actor.uid, declaredByName: nameOf(actor), declaredAt: at, returnedReason: null };
    } else if (action === 'return') {
      if (d.status !== 'declared') throw precondition('Only a declared dividend can be returned to draft.', 'invalid_status');
      update = { status: 'draft', declaredBy: null, declaredByName: null, declaredAt: null, returnedReason: reason };
    } else {
      if (d.status === 'approved') throw precondition('This dividend is already approved.', 'already_approved');
      if (d.status !== 'declared') throw precondition('Only a declared dividend can be approved.', 'invalid_status');
      const policy = await readDividendPolicy(tx, db);
      if (policy.requireAdminApproval && actor.data.role !== 'admin') {
        throw deny('Dividends must be approved by an Administrator.', 'admin_approval_required');
      }
      if (d.declaredBy === actor.uid && actor.data.role !== 'admin') {
        throw deny('Another person must approve a dividend you declared.', 'self_approval');
      }
      requireNotOwnShareholding(actor, linked, 'approve a dividend that pays');
      update = { status: 'approved', approvedBy: actor.uid, approvedByName: nameOf(actor), approvedAt: at };
    }
    tx.update(ref, { ...update, updatedAt: stamp(), updatedBy: actor.uid });
    for (const a of allocations) tx.update(a.ref, { dividendStatus: update.status, updatedAt: stamp() });
    audit(tx, db, actor, 'shareholders', `dividend.${{ declare: 'declared', return: 'returned', approve: 'approved' }[action]}`, ref.id, {
      previousValue: { status: d.status }, newValue: { status: update.status, allocatedUgx: d.allocatedUgx }, reason,
    });
    return { dividendId: ref.id, status: update.status };
  });
  const notify = { declare: ['dividends.approve', NotificationType.dividendDeclared], approve: ['dividends.pay', NotificationType.dividendApproved] }[action];
  if (notify) {
    for (const uid of await holdersOf(db, [notify[0]], now)) if (uid !== callerUid) await notifySafely(deps, uid, notify[1], out.dividendId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Payment and reversal
// ---------------------------------------------------------------------------

/**
 * Pays approved allocations from one account: one `dividend_payment` ledger
 * entry per allocation, refused if the account does not hold the money.
 * Retrying with the same requestId never pays twice; an allocation already
 * paid is refused.
 */
export async function payDividend(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const allocationIds = requireIdList(data.allocationIds, 'allocation', 50);
  const accountId = requireDocId(data.accountId, 'account');
  const requestId = requireRequestId(data.requestId);
  const reference = optionalText(data.reference, 'Payment reference', 60);
  const at = requireBusinessDate(data.paymentDate, now, { field: 'payment date' });

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'dividends.pay');
    const request = await readRequest(tx, db, requestId, actor.uid, 'dividend_payment');
    if (request.earlier) return { result: request.earlier, notify: [] };
    const { ref, d } = await readDividend(tx, db, data.dividendId);
    if (d.status === 'paid') throw precondition('This dividend has already been paid in full.', 'already_paid');
    if (!['approved', 'partially_paid'].includes(d.status)) throw precondition('Only an approved dividend can be paid.', 'not_approved');
    const allocations = [];
    for (const id of allocationIds) {
      const s = await tx.get(db.collection(ALLOCATIONS).doc(id));
      if (!s.exists || s.get('dividendId') !== ref.id || s.get('current') !== true) {
        throw notFound('One of the allocations does not belong to this dividend.', 'allocation_not_found');
      }
      if (s.get('paymentStatus') === 'paid') throw precondition(`${s.get('allocationNumber')} has already been paid.`, 'already_paid');
      if (s.get('paymentStatus') !== 'unpaid' || !(s.get('netUgx') > 0)) {
        throw precondition(`${s.get('allocationNumber')} has nothing to pay.`, 'not_payable');
      }
      allocations.push(s);
    }
    const linked = await recipients(tx, db, allocations);
    requireNotOwnShareholding(actor, linked, 'pay a dividend to');
    const ledger = await openLedger(tx, db, [accountId], now);
    const account = ledger.requireActive(accountId, actor.uid);

    // Writes (the ledger refuses an overdraft before anything is committed).
    let total = 0;
    const results = [];
    for (const s of allocations) {
      const a = s.data();
      const posting = ledger.post({
        type: 'dividend_payment', amountUgx: a.netUgx, fromId: accountId, actor, at,
        fields: {
          dividendId: ref.id, dividendNumber: d.dividendNumber, allocationId: s.id, allocationNumber: a.allocationNumber,
          shareholderId: a.shareholderId, shareholderNumber: a.shareholderNumber, reference, requestId, approvedBy: d.approvedBy,
          description: `Dividend ${a.allocationNumber} (${d.dividendNumber}, ${d.financialPeriod}) to ${a.shareholderNumber}`,
        },
      });
      tx.update(s.ref, {
        paymentStatus: 'paid', paidAt: Timestamp.fromMillis(now), paymentDate: at, paymentReference: reference,
        accountId, accountName: account.name, financialTransactionId: posting.transactionId, financialTransactionNumber: posting.transactionNumber,
        paidBy: actor.uid, paidByName: nameOf(actor), updatedAt: stamp(),
      });
      tx.set(db.collection(SHAREHOLDERS).doc(a.shareholderId), { dividendsPaidUgx: FieldValue.increment(a.netUgx), updatedAt: stamp() }, { merge: true });
      audit(tx, db, actor, 'shareholders', 'dividend.allocation_paid', s.id, {
        newValue: { allocationNumber: a.allocationNumber, dividendNumber: d.dividendNumber, netUgx: a.netUgx, accountId, transactionNumber: posting.transactionNumber },
      });
      total += a.netUgx;
      results.push({ allocationId: s.id, ...posting });
    }
    ledger.commit(actor.uid);
    const paidCount = (d.paidCount ?? 0) + allocations.length;
    const paidUgx = (d.paidUgx ?? 0) + total;
    const status = statusAfterPayments(paidCount, d.payableCount);
    tx.update(ref, { status, paidUgx, paidCount, outstandingUgx: d.allocatedUgx - paidUgx, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'shareholders', 'dividend.paid', ref.id, {
      previousValue: { status: d.status, paidUgx: d.paidUgx ?? 0 },
      newValue: { status, paidUgx, amountUgx: total, allocations: allocations.length, accountId },
    });
    const result = { dividendId: ref.id, status, amountUgx: total, payments: results, balanceUgx: ledger.balance(accountId) };
    saveRequest(tx, request.ref, 'dividend_payment', actor.uid, result);
    const uidOf = new Map(linked.map((r) => [r.shareholderId, r.linkedUid]));
    return { result, notify: allocations.map((s) => [uidOf.get(s.get('shareholderId')), s.id]).filter(([uid]) => uid) };
  });
  for (const [uid, allocationId] of out.notify) await notifySafely(deps, uid, NotificationType.dividendPaid, allocationId);
  return out.result;
}

/**
 * Reverses one allocation's payment: its ledger entry is reversed (the money
 * returns to the account) and the allocation is unpaid again, keeping a
 * record of the reversal. The original ledger entry stays, marked reversed.
 */
export async function reverseDividendPayment(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'dividends.adjust');
    const aRef = db.collection(ALLOCATIONS).doc(requireDocId(data.allocationId, 'allocation'));
    const aSnap = await tx.get(aRef);
    if (!aSnap.exists) throw notFound('That allocation could not be found.', 'allocation_not_found');
    const a = aSnap.data();
    if (a.paymentStatus !== 'paid') throw precondition('Only a paid allocation can be reversed.', 'not_paid');
    const { ref, d } = await readDividend(tx, db, a.dividendId);
    const original = await readTransaction(tx, db, a.financialTransactionId);
    const ledger = await openLedger(tx, db, [original.data.sourceAccountId], now);

    const r = postReversal(tx, ledger, original, actor, reason, {
      dividendId: ref.id, dividendNumber: d.dividendNumber, allocationId: aRef.id, allocationNumber: a.allocationNumber, shareholderId: a.shareholderId,
    });
    ledger.commit(actor.uid);
    tx.update(aRef, {
      paymentStatus: 'unpaid', paidAt: null, paymentDate: null, paymentReference: null, accountId: null, accountName: null,
      financialTransactionId: null, financialTransactionNumber: null, paidBy: null, paidByName: null,
      reversals: FieldValue.arrayUnion({
        financialTransactionId: a.financialTransactionId, financialTransactionNumber: a.financialTransactionNumber,
        reversalTransactionId: r.transactionId, reversalTransactionNumber: r.transactionNumber, amountUgx: a.netUgx,
        reversedAt: Timestamp.fromMillis(now), reversedBy: actor.uid, reason,
      }),
      updatedAt: stamp(),
    });
    tx.set(db.collection(SHAREHOLDERS).doc(a.shareholderId), { dividendsPaidUgx: FieldValue.increment(-a.netUgx), updatedAt: stamp() }, { merge: true });
    const paidCount = d.paidCount - 1;
    const paidUgx = d.paidUgx - a.netUgx;
    const status = statusAfterPayments(paidCount, d.payableCount);
    tx.update(ref, { status, paidCount, paidUgx, outstandingUgx: d.allocatedUgx - paidUgx, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'shareholders', 'dividend.payment_reversed', aRef.id, {
      previousValue: { paymentStatus: 'paid', transactionNumber: a.financialTransactionNumber },
      newValue: { paymentStatus: 'unpaid', reversalTransactionNumber: r.transactionNumber, netUgx: a.netUgx, dividendStatus: status },
      reason,
    });
    return { allocationId: aRef.id, dividendStatus: status, ...r };
  });
}

/** Cancels a dividend on which nothing is paid. Its allocations are kept, marked cancelled. */
export async function cancelDividend(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'dividends.adjust');
    const { ref, d } = await readDividend(tx, db, data.dividendId);
    if (d.status === 'cancelled') throw precondition('This dividend is already cancelled.', 'invalid_status');
    if ((d.paidUgx ?? 0) > 0 || !['draft', 'declared', 'approved'].includes(d.status)) {
      throw precondition('Reverse the payments made on this dividend before cancelling it.', 'reverse_payments_first');
    }
    const allocations = await currentAllocations(tx, db, ref.id);
    for (const a of allocations) tx.update(a.ref, { dividendStatus: 'cancelled', updatedAt: stamp() });
    tx.update(ref, {
      status: 'cancelled', recordLocked: false, cancelledBy: actor.uid, cancelledByName: nameOf(actor), cancelledAt: stamp(), cancelReason: reason,
      updatedAt: stamp(), updatedBy: actor.uid,
    });
    audit(tx, db, actor, 'shareholders', 'dividend.cancelled', ref.id, { previousValue: { status: d.status }, newValue: { status: 'cancelled' }, reason });
    return { dividendId: ref.id, status: 'cancelled' };
  });
}
