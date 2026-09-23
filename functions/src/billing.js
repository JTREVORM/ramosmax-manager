// ===========================================================================
// RamosMAX billing - invoices, discounts, payments, receipts, credit (Phase 4).
// ===========================================================================
// Money is whole UGX, integers only, in fields ending in `Ugx`. The server
// computes every amount; clients send what they WANT (an amount to pay, a
// discount type and value) and never a total, balance, number or reward.
//
//   subtotalUgx  = sum of the completed services' price snapshots
//   discountUgx  = one discount per invoice (manual or loyalty reward), <= subtotal
//   totalUgx     = subtotalUgx - discountUgx
//   paidUgx      = sum of active (non-reversed) payments, <= totalUgx
//   outstandingUgx = totalUgx - paidUgx
//
// paymentStatus: unpaid → partially_paid → paid, or credit (a manager/cashier
// accepted that the balance is owed), or cancelled. Nothing is deleted:
// payments are reversed, invoices are cancelled (only with no active payment).
//
// Every write runs in one transaction that reads everything first, then
// writes the records, the counters and the audit entries together, so two
// cashiers acting at once cannot overpay an invoice or double-issue a number.
// ===========================================================================

import { Timestamp } from 'firebase-admin/firestore';

import { deny, invalid, optionalText, precondition, requireReason } from './access.js';
import { INTAKES, audit, freshActor, nextNumber, notFound, requireDocId, stamp, uniqueRef } from './operations.js';
import { ORDERS } from './jobs.js';
import { REWARDS, TRANSACTIONS, pointsForItems, readLoyaltyState } from './loyalty.js';
import { NotificationType, notifySafely, requireObject } from './user_admin.js';
import { openLedger, postCustomerPayment, postReversal, readTransaction, resolvePaymentAccount } from './finance.js';
import {
  afterHoursTags, countOnSession, readAfterHoursContext, readReversalCustody, recordPaymentCustody, recordReversalCustody,
  requireAfterHoursPaymentAllowed,
} from './after_hours.js';

export const INVOICES = 'invoices';
export const PAYMENTS = 'payments';
export const RECEIPTS = 'receipts';
export const DISCOUNTS = 'discounts';

export const BUSINESS_NAME = 'RamosMAX Automotive Care (U) Ltd';
export const MAX_PAYMENT_UGX = 2_000_000_000;

/**
 * Payment methods and the financial account each one lands in (Phase 5:
 * finance.js posts every payment to its account in the same transaction).
 * Bank payments go to the chosen bank account (`accountId`).
 */
export const PAYMENT_METHODS = Object.freeze({
  cash: { accountKey: 'cash_at_hand', label: 'Cash', needsReference: false },
  mtn_merchant: { accountKey: 'mtn_merchant', label: 'MTN Merchant', needsReference: true },
  airtel_merchant: { accountKey: 'airtel_merchant', label: 'Airtel Merchant', needsReference: true },
  bank: { accountKey: 'bank', label: 'Bank', needsReference: true },
});

/** Discount reasons. `loyalty_reward` is applied only by applyLoyaltyReward. */
export const DISCOUNT_REASONS = Object.freeze({
  manager_approval: 'Manager approval',
  promotional: 'Promotional offer',
  service_issue: 'Service issue / goodwill',
  other: 'Other',
});

/** Discounts above this share of the subtotal need `discounts.approve`. */
export const APPROVAL_THRESHOLD_PERCENT = 25;

/** Half-up whole-UGX percentage of [amountUgx]. */
export function percentOf(amountUgx, percent) {
  return Math.floor((amountUgx * percent + 50) / 100);
}

export function paymentStatusFor(inv) {
  if (inv.status === 'cancelled') return 'cancelled';
  if (inv.outstandingUgx === 0) return 'paid';
  if (inv.onCredit) return 'credit';
  if (inv.paidUgx > 0) return 'partially_paid';
  return 'unpaid';
}

function withTotals(invoice, changes) {
  const next = { ...invoice, ...changes };
  next.totalUgx = next.subtotalUgx - next.discountUgx;
  next.outstandingUgx = next.totalUgx - next.paidUgx;
  if (next.totalUgx < 0 || next.outstandingUgx < 0 || next.paidUgx < 0) {
    // Defensive: every caller validates first; this must never be reachable.
    throw precondition('That change would make an amount negative.', 'negative_amount');
  }
  next.paymentStatus = paymentStatusFor(next);
  return {
    ...changes,
    totalUgx: next.totalUgx,
    outstandingUgx: next.outstandingUgx,
    paymentStatus: next.paymentStatus,
  };
}

async function readInvoice(tx, db, invoiceId) {
  const ref = db.collection(INVOICES).doc(requireDocId(invoiceId, 'invoice'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That invoice could not be found.');
  return { ref, invoice: snap.data() };
}

function requireOpen(invoice) {
  if (invoice.status === 'cancelled') throw precondition('This invoice was cancelled.', 'cancelled');
}

// ---------------------------------------------------------------------------
// createInvoice - from a completed job
// ---------------------------------------------------------------------------

export async function createInvoice(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const intakeId = requireDocId(data.intakeId, 'job');
  const notes = optionalText(data.notes, 'Notes', 500);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'invoices.create');
    // Phase 8: an invoice raised in a live after-hours session is marked as such.
    const afterHours = await readAfterHoursContext(tx, db, actor.uid, now);
    const intakeRef = db.collection(INTAKES).doc(intakeId);
    const intakeSnap = await tx.get(intakeRef);
    if (!intakeSnap.exists) throw notFound('That job could not be found.');
    const intake = intakeSnap.data();
    if (intake.invoiceId) {
      throw precondition(`This job is already invoiced (${intake.invoiceNumber}).`, 'already_invoiced',
        { invoiceId: intake.invoiceId });
    }
    if (intake.status !== 'completed') {
      throw precondition('Only a completed job can be invoiced. Finish or cancel its remaining services first.', 'job_not_completed');
    }
    const orderSnaps = await tx.get(db.collection(ORDERS).where('serviceIntakeId', '==', intakeId));
    const completed = orderSnaps.docs.map((d) => d.data()).filter((o) => o.status === 'completed')
      .sort((a, b) => a.orderNumber.localeCompare(b.orderNumber, 'en', { numeric: true }));
    if (completed.length === 0) throw precondition('This job has no completed services to invoice.', 'job_not_completed');
    const prices = new Map((intake.selectedServices ?? []).map((s) => [s.serviceId, s]));
    const items = completed.map((o) => {
      const snap = prices.get(o.serviceId);
      if (!snap || !Number.isInteger(snap.priceUgx) || snap.priceUgx < 0) {
        throw precondition(`"${o.serviceName}" has no price on this job.`, 'missing_price');
      }
      return {
        workerOrderId: o.workerOrderId,
        orderNumber: o.orderNumber,
        serviceId: o.serviceId,
        serviceName: o.serviceName,
        category: o.category,
        priceUgx: snap.priceUgx,
        qualifiesForLoyalty: snap.qualifiesForLoyalty === true,
        workerId: o.workerId ?? null,
        workerName: o.workerName ?? null,
      };
    });
    const number = await nextNumber(tx, db, 'invoices', 'RMX-INV-', 6);

    const subtotalUgx = items.reduce((sum, i) => sum + i.priceUgx, 0);
    const ref = db.collection(INVOICES).doc();
    const invoice = {
      invoiceId: ref.id,
      invoiceNumber: number.value,
      serviceIntakeId: intakeId,
      jobNumber: intake.jobNumber,
      vehicleId: intake.vehicleId,
      numberPlate: intake.numberPlate,
      normalizedNumberPlate: intake.normalizedNumberPlate ?? null,
      vehicleSummary: intake.vehicleSummary ?? null,
      customerId: intake.customerId ?? null,
      customerName: intake.customerName ?? null,
      items,
      itemCount: items.length,
      subtotalUgx,
      discountUgx: 0,
      discount: null,
      paidUgx: 0,
      status: 'issued',
      onCredit: false,
      paymentCount: 0,
      lastPaymentAt: null,
      loyaltyEarned: false,
      loyaltyPointsEarned: 0,
      loyaltyEarnTransactionId: null,
      loyaltyRewardId: null,
      notes,
      issuedAt: Timestamp.fromMillis(now),
      createdAt: stamp(),
      createdBy: actor.uid,
      createdByName: actor.data.fullName ?? null,
      updatedAt: stamp(),
      updatedBy: actor.uid,
      ...afterHoursTags(afterHours),
    };
    Object.assign(invoice, withTotals(invoice, {}));
    number.commit();
    tx.set(ref, invoice);
    countOnSession(tx, afterHours, 'invoicesCreated');
    tx.update(intakeRef, { invoiceId: ref.id, invoiceNumber: number.value, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'sales', 'invoice.created', ref.id, {
      newValue: { invoiceNumber: number.value, jobNumber: intake.jobNumber, subtotalUgx, itemCount: items.length },
    });
    return { invoiceId: ref.id, invoiceNumber: number.value, totalUgx: invoice.totalUgx };
  });
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

function requireDiscount(data, subtotalUgx) {
  const type = data.discountType;
  const value = data.discountValue;
  if (type !== 'percentage' && type !== 'fixed') throw invalid('Choose a percentage or fixed-amount discount.', 'discount_type');
  if (!Number.isInteger(value) || value <= 0) throw invalid('Enter a whole number greater than zero.', 'discount_value');
  if (type === 'percentage' && value > 100) throw invalid('A percentage discount cannot exceed 100%.', 'discount_value');
  if (type === 'fixed' && value > subtotalUgx) throw invalid('The discount cannot be more than the invoice subtotal.', 'discount_value');
  const amount = type === 'percentage' ? percentOf(subtotalUgx, value) : value;
  if (amount <= 0) throw invalid('That discount rounds to nothing on this invoice.', 'discount_value');
  return { type, value, amount };
}

function requireDiscountReason(data) {
  const code = data.reasonCode;
  if (!Object.hasOwn(DISCOUNT_REASONS, code)) throw invalid('Choose a reason for the discount.', 'reason_code');
  const description = code === 'other'
    ? requireReason(data.description)
    : optionalText(data.description, 'Description', 200);
  return { code, description, reason: description ?? DISCOUNT_REASONS[code] };
}

function requireDiscountable(invoice) {
  requireOpen(invoice);
  if (invoice.discount) throw precondition('This invoice already has a discount.', 'discount_exists');
  if (invoice.paidUgx > 0) throw precondition('A discount can only be applied before any payment is recorded.', 'payments_exist');
}

export async function applyInvoiceDiscount(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireDiscountReason(data);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'discounts.apply');
    const { ref, invoice } = await readInvoice(tx, db, data.invoiceId);
    requireDiscountable(invoice);
    const d = requireDiscount(data, invoice.subtotalUgx);
    const canApprove = actor.perms.has('discounts.approve');
    if (!canApprove && d.amount * 100 > invoice.subtotalUgx * APPROVAL_THRESHOLD_PERCENT) {
      throw deny(`Discounts above ${APPROVAL_THRESHOLD_PERCENT}% need a manager's approval.`, 'approval_required');
    }
    const discountRef = db.collection(DISCOUNTS).doc();
    const discount = {
      discountId: discountRef.id,
      source: 'manual',
      discountType: d.type,
      discountValue: d.value,
      discountAmount: d.amount,
      reasonCode: reason.code,
      reason: reason.reason,
      description: reason.description,
      approvedBy: canApprove ? actor.uid : null,
      createdBy: actor.uid,
      createdByName: actor.data.fullName ?? null,
      createdAt: Timestamp.fromMillis(now),
    };
    const changes = withTotals(invoice, { discountUgx: d.amount, discount });
    tx.update(ref, { ...changes, updatedAt: stamp(), updatedBy: actor.uid });
    tx.set(discountRef, {
      ...discount, invoiceId: ref.id, invoiceNumber: invoice.invoiceNumber, vehicleId: invoice.vehicleId,
      numberPlate: invoice.numberPlate, subtotalUgx: invoice.subtotalUgx, status: 'active',
    });
    audit(tx, db, actor, 'sales', 'discount.applied', ref.id, {
      previousValue: { totalUgx: invoice.totalUgx },
      newValue: { discountType: d.type, discountValue: d.value, discountAmount: d.amount, totalUgx: changes.totalUgx },
      reason: reason.reason,
    });
    return { invoiceId: ref.id, discountUgx: d.amount, totalUgx: changes.totalUgx };
  });
}

/**
 * Redeems the vehicle's available loyalty reward as this invoice's discount.
 * The client shows a preview (same formula) and sends the amount it showed as
 * `expectedDiscountUgx`; if anything changed meanwhile the request is refused
 * rather than applying a different amount than the customer was told.
 */
export async function applyLoyaltyReward(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const expected = data.expectedDiscountUgx;
  if (!Number.isInteger(expected) || expected < 0) throw invalid('Preview the reward before applying it.', 'expected_discount');

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'loyalty.redeem');
    const { ref, invoice } = await readInvoice(tx, db, data.invoiceId);
    requireDiscountable(invoice);
    const state = await readLoyaltyState(tx, db, invoice.vehicleId);
    const reward = state.availableReward;
    if (!reward) throw precondition(`${invoice.numberPlate} has no loyalty reward available.`, 'no_reward');
    if (state.balance < reward.data.pointsCost) {
      throw precondition(`${invoice.numberPlate} no longer has enough points for this reward.`, 'insufficient_points');
    }
    const amount = percentOf(invoice.subtotalUgx, reward.data.discountPercent);
    if (amount !== expected) {
      throw precondition('The reward amount has changed. Review the preview again.', 'preview_stale', { discountUgx: amount });
    }
    if (amount <= 0) throw precondition('This invoice is too small for the reward.', 'discount_value');

    const discountRef = db.collection(DISCOUNTS).doc();
    const discount = {
      discountId: discountRef.id,
      source: 'loyalty_reward',
      rewardId: reward.ref.id,
      discountType: 'percentage',
      discountValue: reward.data.discountPercent,
      discountAmount: amount,
      reasonCode: 'loyalty_reward',
      reason: 'Loyalty reward',
      description: null,
      approvedBy: actor.uid,
      createdBy: actor.uid,
      createdByName: actor.data.fullName ?? null,
      createdAt: Timestamp.fromMillis(now),
    };
    const redeemId = state.redeem({ reward, invoiceId: ref.id, actor, vehicle: { numberPlate: invoice.numberPlate } });
    const changes = withTotals(invoice, { discountUgx: amount, discount, loyaltyRewardId: reward.ref.id, loyaltyRedeemTransactionId: redeemId });
    tx.update(ref, { ...changes, updatedAt: stamp(), updatedBy: actor.uid });
    tx.update(reward.ref, { discountUgx: amount });
    tx.set(discountRef, {
      ...discount, invoiceId: ref.id, invoiceNumber: invoice.invoiceNumber, vehicleId: invoice.vehicleId,
      numberPlate: invoice.numberPlate, subtotalUgx: invoice.subtotalUgx, status: 'active',
    });
    audit(tx, db, actor, 'sales', 'discount.loyalty_reward_applied', ref.id, {
      previousValue: { totalUgx: invoice.totalUgx },
      newValue: { rewardId: reward.ref.id, discountPercent: reward.data.discountPercent, discountAmount: amount, totalUgx: changes.totalUgx },
      reason: 'Loyalty reward',
    });
    return { invoiceId: ref.id, discountUgx: amount, totalUgx: changes.totalUgx, pointsBalance: state.balance };
  });
}

// ---------------------------------------------------------------------------
// Payments and receipts
// ---------------------------------------------------------------------------

function requirePayment(data) {
  const amount = data.amountUgx;
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_PAYMENT_UGX) {
    throw invalid('Enter the amount received in whole shillings.', 'amount');
  }
  const method = PAYMENT_METHODS[data.method] ? data.method : null;
  if (!method) throw invalid('Choose how the customer paid.', 'method');
  const reference = optionalText(data.reference, 'Reference', 60);
  if (PAYMENT_METHODS[method].needsReference && !reference) {
    throw invalid('Enter the transaction reference.', 'reference');
  }
  const requestId = data.requestId;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
    throw invalid('The request is not valid.', 'request_id');
  }
  const accountId = data.accountId == null ? null : requireDocId(data.accountId, 'bank account');
  if (accountId && method !== 'bank') throw invalid('Only bank payments take an account.', 'account');
  return { amount, method, reference, requestId, accountId, notes: optionalText(data.notes, 'Notes', 200) };
}

/**
 * Points for a now fully-paid invoice. Reads first (loyalty state), returns a
 * function that performs the writes, or null when nothing is earned.
 */
async function prepareEarn(tx, db, invoice) {
  if (invoice.loyaltyEarned) return null;
  const state = await readLoyaltyState(tx, db, invoice.vehicleId);
  const points = pointsForItems(invoice.items, state.config);
  if (points <= 0) return null;
  return {
    state,
    points,
    write(actor, invoiceId) {
      const hadReward = Boolean(state.availableReward);
      const id = state.apply({
        type: 'earned', points, referenceType: 'invoice', referenceId: invoiceId,
        reason: `${points / state.config.pointsPerQualifyingService} qualifying service(s) paid`,
        actor, vehicle: { numberPlate: invoice.numberPlate },
      });
      return { transactionId: id, rewardUnlocked: !hadReward && Boolean(state.availableReward) };
    },
  };
}

/** One loyalty state per transaction, read on first use (it tracks the balance). */
function lazyLoyaltyState(tx, db, vehicleId) {
  let pending = null;
  return () => (pending ??= readLoyaltyState(tx, db, vehicleId));
}

/**
 * Undoes an invoice's earned points (payment reversed / invoice cancelled).
 * Points already spent cannot be taken back below zero; the shortfall is
 * recorded on the ledger entry's reason and the audit log.
 */
async function prepareEarnReversal(tx, db, invoice, loyaltyState) {
  if (!invoice.loyaltyEarned || !invoice.loyaltyEarnTransactionId) return null;
  const onceRef = uniqueRef(db, 'loyalty_reversal', invoice.loyaltyEarnTransactionId);
  if ((await tx.get(onceRef)).exists) return { write: () => null }; // already reversed by hand
  const state = await loyaltyState();
  return {
    write(actor, reason) {
      const points = Math.min(invoice.loyaltyPointsEarned, state.balance);
      const shortfall = invoice.loyaltyPointsEarned - points;
      let id = null;
      if (points > 0) {
        id = state.apply({
          type: 'reversal', points: -points, referenceType: 'transaction', referenceId: invoice.loyaltyEarnTransactionId,
          reason: shortfall > 0 ? `${reason} (${shortfall} points already spent)` : reason,
          actor, vehicle: { numberPlate: invoice.numberPlate },
        });
      }
      tx.set(onceRef, { kind: 'loyalty_reversal', transactionId: invoice.loyaltyEarnTransactionId, reversalId: id, shortfall });
      return id;
    },
  };
}

export async function recordPayment(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const p = requirePayment(data);

  const result = await db.runTransaction(async (tx) => {
    // Phase 8: an after-hours worker collects with a temporary
    // after_hours.cash.collect instead of payments.record (checked below).
    const actor = await freshActor(tx, db, callerUid, now, 'payments.record', 'after_hours.cash.collect');
    // Idempotency: a retried request (lost response, double tap) returns the
    // first result instead of taking the money twice.
    const requestRef = uniqueRef(db, 'payment_request', p.requestId);
    const earlier = await tx.get(requestRef);
    if (earlier.exists) {
      if (earlier.get('invoiceId') !== data.invoiceId || earlier.get('recordedBy') !== actor.uid) {
        throw invalid('The request is not valid.', 'request_id');
      }
      return { ...earlier.get('result'), duplicate: true };
    }
    const { ref, invoice } = await readInvoice(tx, db, data.invoiceId);
    requireOpen(invoice);
    if (invoice.outstandingUgx === 0) throw precondition('This invoice is already fully paid.', 'already_paid');
    if (p.amount > invoice.outstandingUgx) {
      throw precondition(`The customer owes only UGX ${invoice.outstandingUgx.toLocaleString('en-US')}. `
        + 'Record the exact amount; give change for cash.', 'overpayment', { outstandingUgx: invoice.outstandingUgx });
    }
    const willBePaid = p.amount === invoice.outstandingUgx;
    const earn = willBePaid ? await prepareEarn(tx, db, invoice) : null;
    const receiptNumber = await nextNumber(tx, db, 'receipts', 'RMX-RCP-', 6);
    // Phase 5: the money lands in its financial account in this same
    // transaction - if the posting fails, the payment is not recorded either.
    const accountId = await resolvePaymentAccount(tx, db, p.method, p.accountId);
    const ledger = await openLedger(tx, db, [accountId], now);
    // Phase 8: inside an open after-hours session the authorisation must be in
    // force and the method allowed after hours; the payment is tagged and the
    // cash the worker holds is tracked. Nothing else about the payment changes.
    const afterHours = await readAfterHoursContext(tx, db, actor.uid, now);
    const custody = await requireAfterHoursPaymentAllowed(tx, db, actor, afterHours, p.method, now);
    const tags = afterHoursTags(afterHours);

    // --- writes ---
    const at = Timestamp.fromMillis(now);
    const paymentRef = db.collection(PAYMENTS).doc();
    const receiptRef = db.collection(RECEIPTS).doc();
    const posted = postCustomerPayment(ledger, {
      accountId, method: p.method, actor, amountUgx: p.amount,
      payment: { paymentId: paymentRef.id, invoiceId: ref.id, invoiceNumber: invoice.invoiceNumber, numberPlate: invoice.numberPlate,
        receiptNumber: receiptNumber.value, reference: p.reference },
      extra: tags.isAfterHours ? tags : {},
    });
    const earned = earn ? earn.write(actor, ref.id) : null;
    const changes = withTotals(invoice, {
      paidUgx: invoice.paidUgx + p.amount,
      paymentCount: (invoice.paymentCount ?? 0) + 1,
      lastPaymentAt: at,
      ...(willBePaid ? { paidAt: at } : {}),
      ...(earned ? { loyaltyEarned: true, loyaltyPointsEarned: earn.points, loyaltyEarnTransactionId: earned.transactionId } : {}),
    });
    const method = PAYMENT_METHODS[p.method];
    const payment = {
      paymentId: paymentRef.id,
      invoiceId: ref.id,
      invoiceNumber: invoice.invoiceNumber,
      jobNumber: invoice.jobNumber,
      vehicleId: invoice.vehicleId,
      numberPlate: invoice.numberPlate,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      amountUgx: p.amount,
      method: p.method,
      accountKey: method.accountKey,
      financialAccountId: accountId,
      financialTransactionId: posted.transactionId,
      financialTransactionNumber: posted.transactionNumber,
      reference: p.reference,
      notes: p.notes,
      outstandingBeforeUgx: invoice.outstandingUgx,
      outstandingAfterUgx: changes.outstandingUgx,
      status: 'completed',
      receiptId: receiptRef.id,
      receiptNumber: receiptNumber.value,
      requestId: p.requestId,
      receivedBy: actor.uid,
      receivedByName: actor.data.fullName ?? null,
      receivedAt: at,
      ...tags,
      createdAt: stamp(),
    };
    const receipt = {
      receiptId: receiptRef.id,
      receiptNumber: receiptNumber.value,
      businessName: BUSINESS_NAME,
      paymentId: paymentRef.id,
      invoiceId: ref.id,
      invoiceNumber: invoice.invoiceNumber,
      jobNumber: invoice.jobNumber,
      vehicleId: invoice.vehicleId,
      numberPlate: invoice.numberPlate,
      vehicleSummary: invoice.vehicleSummary,
      customerName: invoice.customerName,
      items: invoice.items.map((i) => ({ serviceName: i.serviceName, priceUgx: i.priceUgx })),
      subtotalUgx: invoice.subtotalUgx,
      discountUgx: invoice.discountUgx,
      discountLabel: invoice.discount?.reason ?? null,
      totalUgx: invoice.totalUgx,
      amountPaidUgx: p.amount,
      totalPaidUgx: invoice.paidUgx + p.amount,
      outstandingUgx: changes.outstandingUgx,
      paymentStatus: changes.paymentStatus,
      method: p.method,
      methodLabel: method.label,
      reference: p.reference,
      cashierId: actor.uid,
      cashierName: actor.data.fullName ?? null,
      loyaltyPointsEarned: earned ? earn.points : 0,
      loyaltyPointsBalance: earn ? earn.state.balance : null,
      status: 'issued',
      issuedAt: at,
      ...tags,
      createdAt: stamp(),
    };
    const out = {
      paymentId: paymentRef.id,
      receiptId: receiptRef.id,
      receiptNumber: receiptNumber.value,
      outstandingUgx: changes.outstandingUgx,
      paymentStatus: changes.paymentStatus,
      pointsEarned: earned ? earn.points : 0,
      rewardUnlocked: earned?.rewardUnlocked ?? false,
      financialAccountId: accountId,
      transactionNumber: posted.transactionNumber,
    };
    receiptNumber.commit();
    ledger.commit(actor.uid);
    tx.set(paymentRef, payment);
    tx.set(receiptRef, receipt);
    tx.update(ref, { ...changes, updatedAt: stamp(), updatedBy: actor.uid });
    tx.set(requestRef, { kind: 'payment_request', invoiceId: ref.id, recordedBy: actor.uid, result: out, createdAt: stamp() });
    if (custody) recordPaymentCustody(tx, db, afterHours, custody, actor, payment);
    audit(tx, db, actor, 'sales', 'payment.recorded', paymentRef.id, {
      newValue: {
        invoiceNumber: invoice.invoiceNumber, amountUgx: p.amount, method: p.method,
        receiptNumber: receiptNumber.value, outstandingUgx: changes.outstandingUgx,
        financialAccountId: accountId, transactionNumber: posted.transactionNumber,
      },
    });
    return out;
  });
  if (result.rewardUnlocked && !result.duplicate) {
    await notifySafely(deps, callerUid, NotificationType.loyaltyRewardUnlocked, data.invoiceId);
  }
  return result;
}

export async function reversePayment(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const paymentId = requireDocId(data.paymentId, 'payment');
  const reason = requireReason(data.reason);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'payments.reverse');
    const paymentRef = db.collection(PAYMENTS).doc(paymentId);
    const snap = await tx.get(paymentRef);
    if (!snap.exists) throw notFound('That payment could not be found.');
    const payment = snap.data();
    if (payment.status === 'reversed') throw precondition('This payment has already been reversed.', 'already_reversed');
    const { ref, invoice } = await readInvoice(tx, db, payment.invoiceId);
    const unearn = await prepareEarnReversal(tx, db, invoice, lazyLoyaltyState(tx, db, invoice.vehicleId));
    // Phase 5: take the money back out of the account it was posted to.
    // Payments recorded before Phase 5 have no ledger entry and move nothing.
    const posted = payment.financialTransactionId ? await readTransaction(tx, db, payment.financialTransactionId) : null;
    const ledger = posted ? await openLedger(tx, db, [posted.data.destinationAccountId], now) : null;
    // Phase 8: an after-hours payment's reversal is recorded against its session.
    const custody = await readReversalCustody(tx, db, payment);

    // --- writes ---
    const reversal = posted ? postReversal(tx, ledger, posted, actor, `Payment ${payment.receiptNumber} reversed: ${reason}`) : null;
    ledger?.commit(actor.uid);
    const at = Timestamp.fromMillis(now);
    unearn?.write(actor, `Payment ${payment.receiptNumber} reversed: ${reason}`);
    const changes = withTotals(invoice, {
      paidUgx: invoice.paidUgx - payment.amountUgx,
      paidAt: null,
      ...(unearn ? { loyaltyEarned: false, loyaltyPointsEarned: 0, loyaltyEarnTransactionId: null } : {}),
    });
    tx.update(paymentRef, {
      status: 'reversed', reversedAt: at, reversedBy: actor.uid, reversalReason: reason,
      reversalTransactionId: reversal?.transactionId ?? null, reversalTransactionNumber: reversal?.transactionNumber ?? null,
    });
    tx.update(db.collection(RECEIPTS).doc(payment.receiptId), { status: 'reversed', reversedAt: at, reversalReason: reason });
    recordReversalCustody(tx, db, custody, actor, { ...payment, paymentId }, reason);
    tx.update(ref, { ...changes, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'sales', 'payment.reversed', paymentId, {
      previousValue: { status: 'completed', invoiceOutstandingUgx: invoice.outstandingUgx },
      newValue: { status: 'reversed', amountUgx: payment.amountUgx, invoiceOutstandingUgx: changes.outstandingUgx },
      reason,
    });
    return { paymentId, invoiceId: ref.id, outstandingUgx: changes.outstandingUgx, paymentStatus: changes.paymentStatus };
  });
}

// ---------------------------------------------------------------------------
// Credit and cancellation
// ---------------------------------------------------------------------------

export async function markInvoiceCredit(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'credit.manage');
    const { ref, invoice } = await readInvoice(tx, db, data.invoiceId);
    requireOpen(invoice);
    if (invoice.outstandingUgx === 0) throw precondition('This invoice is fully paid.', 'already_paid');
    if (invoice.onCredit) throw precondition('This invoice is already on credit.', 'already_credit');
    const changes = withTotals(invoice, {
      onCredit: true, creditMarkedAt: Timestamp.fromMillis(now), creditMarkedBy: actor.uid, creditReason: reason,
    });
    tx.update(ref, { ...changes, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'sales', 'invoice.marked_credit', ref.id, {
      previousValue: { paymentStatus: invoice.paymentStatus },
      newValue: { paymentStatus: changes.paymentStatus, outstandingUgx: invoice.outstandingUgx },
      reason,
    });
    return { invoiceId: ref.id, paymentStatus: changes.paymentStatus };
  });
}

export async function cancelInvoice(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'invoices.void');
    const { ref, invoice } = await readInvoice(tx, db, data.invoiceId);
    requireOpen(invoice);
    if (invoice.paidUgx > 0) {
      throw precondition('This invoice has payments. Reverse them before cancelling it.', 'payments_exist');
    }
    const intakeRef = db.collection(INTAKES).doc(invoice.serviceIntakeId);
    const intake = await tx.get(intakeRef);
    // A redeemed reward goes back: its points return to the vehicle (which
    // unlocks a fresh reward if the balance allows).
    const loyaltyState = lazyLoyaltyState(tx, db, invoice.vehicleId);
    const redeemId = invoice.loyaltyRewardId ? invoice.loyaltyRedeemTransactionId : null;
    const rewardRef = redeemId ? db.collection(REWARDS).doc(invoice.loyaltyRewardId) : null;
    const restoreOnce = redeemId ? uniqueRef(db, 'loyalty_reversal', redeemId) : null;
    const redeemTx = restoreOnce && !(await tx.get(restoreOnce)).exists
      ? await tx.get(db.collection(TRANSACTIONS).doc(redeemId)) : null;
    const unearn = await prepareEarnReversal(tx, db, invoice, loyaltyState);
    const loyalty = redeemTx?.exists ? await loyaltyState() : null;

    // --- writes ---
    unearn?.write(actor, `Invoice ${invoice.invoiceNumber} cancelled: ${reason}`);
    if (loyalty) {
      const reversalId = loyalty.apply({
        type: 'reversal', points: -redeemTx.get('points'), referenceType: 'transaction', referenceId: redeemTx.id,
        reason: `Invoice ${invoice.invoiceNumber} cancelled: ${reason}`, actor, vehicle: { numberPlate: invoice.numberPlate },
      });
      tx.set(restoreOnce, { kind: 'loyalty_reversal', transactionId: redeemTx.id, reversalId });
      tx.update(rewardRef, { status: 'reversed', reversedAt: stamp(), reversedReason: reason });
    }
    if (invoice.discount?.discountId) {
      tx.update(db.collection(DISCOUNTS).doc(invoice.discount.discountId), { status: 'cancelled', cancelledAt: stamp() });
    }
    tx.update(ref, {
      status: 'cancelled', paymentStatus: 'cancelled', cancelledAt: Timestamp.fromMillis(now), cancelledBy: actor.uid,
      cancelReason: reason, updatedAt: stamp(), updatedBy: actor.uid,
    });
    if (intake.exists && intake.get('invoiceId') === ref.id) {
      // The job can be invoiced again (e.g. with the right discount).
      tx.update(intakeRef, { invoiceId: null, invoiceNumber: null, updatedAt: stamp(), updatedBy: actor.uid });
    }
    audit(tx, db, actor, 'sales', 'invoice.cancelled', ref.id, {
      previousValue: { paymentStatus: invoice.paymentStatus, totalUgx: invoice.totalUgx },
      newValue: { paymentStatus: 'cancelled' },
      reason,
    });
    return { invoiceId: ref.id, paymentStatus: 'cancelled' };
  });
}
