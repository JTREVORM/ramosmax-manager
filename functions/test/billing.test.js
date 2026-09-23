// Invoices, discounts, payments, receipts and credit (Phase 4) - against the
// Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as billing from '../src/billing.js';
import * as jobs from '../src/jobs.js';
import * as ops from '../src/operations.js';
import { emulatorDb, helpers, rejects, resetAndSeed } from './helpers.js';

const db = emulatorDb('billing-tests');
const { deps, doc, audits, ordersOf, world, newVehicle, completeJob, invoicedJob, pay } = helpers(db);

beforeEach(() => resetAndSeed(db));

const discount = (actor, invoiceId, extra) => billing.applyInvoiceDiscount(deps, actor, { invoiceId, reasonCode: 'promotional', ...extra });

describe('pure helpers', () => {
  test('percentages round half-up to whole shillings', () => {
    assert.equal(billing.percentOf(35000, 25), 8750);
    assert.equal(billing.percentOf(15002, 25), 3751); // 3750.5 → 3751
    assert.equal(billing.percentOf(15001, 25), 3750); // 3750.25 → 3750
    assert.equal(billing.percentOf(0, 25), 0);
  });

  test('payment status follows the amounts', () => {
    const s = (inv) => billing.paymentStatusFor({ status: 'issued', onCredit: false, ...inv });
    assert.equal(s({ outstandingUgx: 100, paidUgx: 0 }), 'unpaid');
    assert.equal(s({ outstandingUgx: 50, paidUgx: 50 }), 'partially_paid');
    assert.equal(s({ outstandingUgx: 50, paidUgx: 50, onCredit: true }), 'credit');
    assert.equal(s({ outstandingUgx: 0, paidUgx: 100, onCredit: true }), 'paid');
    assert.equal(s({ outstandingUgx: 100, paidUgx: 0, status: 'cancelled' }), 'cancelled');
  });
});

describe('invoices', () => {
  test('created from a completed job with price snapshots; numbered RMX-INV; one invoice per job', async () => {
    const w = await world();
    const { intakeId, invoiceId, invoiceNumber } = await invoicedJob(w.vehicleId, [w.wash, w.interior]);
    assert.equal(invoiceNumber, 'RMX-INV-000001');
    const inv = await doc(`invoices/${invoiceId}`);
    assert.deepEqual(inv.items.map((i) => [i.serviceName, i.priceUgx, i.qualifiesForLoyalty]),
      [['Full Wash', 15000, true], ['Interior Cleaning', 20000, true]]);
    assert.deepEqual([inv.subtotalUgx, inv.discountUgx, inv.totalUgx, inv.paidUgx, inv.outstandingUgx, inv.paymentStatus],
      [35000, 0, 35000, 0, 35000, 'unpaid']);
    const intake = await doc(`service_intakes/${intakeId}`);
    assert.deepEqual([intake.invoiceId, intake.invoiceNumber], [invoiceId, 'RMX-INV-000001']);
    await rejects(billing.createInvoice(deps, 'cash', { intakeId }), 'failed-precondition', 'already_invoiced');
    assert.equal((await audits('invoice.created')).length, 1);
    // Invoiced jobs are frozen.
    const [o] = await ordersOf(intakeId);
    await rejects(jobs.cancelWorkerOrder(deps, 'mgr', { workerOrderId: o.workerOrderId, reason: 'Mistake' }), 'failed-precondition', 'invoiced');
  });

  test('a later catalogue price change does not change the invoice', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash] });
    await ops.updateService(deps, 'admin', { serviceId: w.wash, priceUgx: 99000 });
    await completeJob(intakeId);
    const { invoiceId } = await billing.createInvoice(deps, 'cash', { intakeId });
    assert.equal((await doc(`invoices/${invoiceId}`)).subtotalUgx, 15000);
  });

  test('unfinished jobs cannot be invoiced; cancelled services are left off', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash, w.interior] });
    await rejects(billing.createInvoice(deps, 'cash', { intakeId }), 'failed-precondition', 'job_not_completed');
    const [, o2] = await ordersOf(intakeId);
    await jobs.cancelWorkerOrder(deps, 'mgr', { workerOrderId: o2.workerOrderId, reason: 'Not needed' });
    await completeJob(intakeId);
    const { invoiceId } = await billing.createInvoice(deps, 'cash', { intakeId });
    const inv = await doc(`invoices/${invoiceId}`);
    assert.deepEqual(inv.items.map((i) => i.serviceName), ['Full Wash']);
    assert.equal(inv.totalUgx, 15000);
  });

  test('who may invoice', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash] });
    await completeJob(intakeId);
    for (const uid of ['wkr', 'aud', 'sh']) await rejects(billing.createInvoice(deps, uid, { intakeId }), 'permission-denied');
    assert.ok((await billing.createInvoice(deps, 'mgr', { intakeId })).invoiceId);
  });

  test('concurrent invoicing of one job creates exactly one invoice', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash] });
    await completeJob(intakeId);
    const r = await Promise.allSettled([1, 2, 3].map(() => billing.createInvoice(deps, 'cash', { intakeId })));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((await db.collection('invoices').get()).size, 1);
    assert.equal((await doc('counters/invoices')).next, 2);
  });
});

describe('discounts', () => {
  test('percentage and fixed; reason required; stored with who and why; total recalculated', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash, w.interior]); // 35,000
    await rejects(billing.applyInvoiceDiscount(deps, 'mgr', { invoiceId: a.invoiceId, discountType: 'percentage', discountValue: 10 }),
      'invalid-argument', 'reason_code');
    await rejects(discount('mgr', a.invoiceId, { discountType: 'percentage', discountValue: 10, reasonCode: 'other' }), 'invalid-argument', 'reason');
    const r = await discount('mgr', a.invoiceId, { discountType: 'percentage', discountValue: 10 });
    assert.deepEqual([r.discountUgx, r.totalUgx], [3500, 31500]);
    const inv = await doc(`invoices/${a.invoiceId}`);
    assert.deepEqual([inv.discount.discountType, inv.discount.discountValue, inv.discount.discountAmount, inv.discount.approvedBy, inv.discount.createdBy],
      ['percentage', 10, 3500, 'mgr', 'mgr']);
    assert.equal(inv.discount.reason, 'Promotional offer');
    assert.equal(inv.outstandingUgx, 31500);
    assert.equal((await db.collection('discounts').get()).size, 1);
    await rejects(discount('mgr', a.invoiceId, { discountType: 'fixed', discountValue: 1000 }), 'failed-precondition', 'discount_exists');
    const [log] = await audits('discount.applied');
    assert.equal(log.reason, 'Promotional offer');

    const b = await invoicedJob(await newVehicle(w.customerId), [w.wash]);
    await discount('mgr', b.invoiceId, { discountType: 'fixed', discountValue: 2000, reasonCode: 'other', description: 'Regular customer' });
    const binv = await doc(`invoices/${b.invoiceId}`);
    assert.deepEqual([binv.totalUgx, binv.discount.reason], [13000, 'Regular customer']);
  });

  test('no negative totals: over-large, zero, negative or fractional discounts are refused', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]); // 15,000
    for (const [discountType, discountValue] of [['fixed', 15001], ['fixed', 0], ['fixed', -5], ['fixed', 10.5],
      ['percentage', 101], ['percentage', 0], ['bogus', 5]]) {
      await rejects(discount('mgr', a.invoiceId, { discountType, discountValue }), 'invalid-argument');
    }
    // 100% is allowed and leaves nothing to pay (never below zero).
    await discount('mgr', a.invoiceId, { discountType: 'percentage', discountValue: 100, reasonCode: 'service_issue' });
    const inv = await doc(`invoices/${a.invoiceId}`);
    assert.deepEqual([inv.totalUgx, inv.outstandingUgx, inv.paymentStatus], [0, 0, 'paid']);
  });

  test('permissions: cashier only when granted, within the limit; larger discounts need approval', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash, w.interior]); // 35,000
    for (const uid of ['cash', 'wkr', 'aud', 'sh']) {
      await rejects(discount(uid, a.invoiceId, { discountType: 'fixed', discountValue: 1000 }), 'permission-denied');
    }
    await rejects(discount('cashDisc', a.invoiceId, { discountType: 'percentage', discountValue: 30 }), 'permission-denied', 'approval_required');
    await discount('cashDisc', a.invoiceId, { discountType: 'percentage', discountValue: 25 });
    const inv = await doc(`invoices/${a.invoiceId}`);
    assert.deepEqual([inv.discount.createdBy, inv.discount.approvedBy], ['cashDisc', null]);
  });

  test('no discount after a payment has been recorded', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    await pay('cash', a.invoiceId, 5000);
    await rejects(discount('mgr', a.invoiceId, { discountType: 'fixed', discountValue: 1000 }), 'failed-precondition', 'payments_exist');
  });
});

describe('payments and receipts', () => {
  test('partial payments, then full; receipts numbered RMX-RCP with a full snapshot; statuses follow', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash, w.interior]); // 35,000
    const p1 = await pay('cash', a.invoiceId, 10000);
    assert.deepEqual([p1.receiptNumber, p1.outstandingUgx, p1.paymentStatus], ['RMX-RCP-000001', 25000, 'partially_paid']);
    const p2 = await pay('cash', a.invoiceId, 25000, { method: 'mtn_merchant', reference: 'MP240921.1234' });
    assert.deepEqual([p2.receiptNumber, p2.outstandingUgx, p2.paymentStatus], ['RMX-RCP-000002', 0, 'paid']);
    const inv = await doc(`invoices/${a.invoiceId}`);
    assert.deepEqual([inv.paidUgx, inv.outstandingUgx, inv.paymentCount, inv.paymentStatus], [35000, 0, 2, 'paid']);
    const pm = await doc(`payments/${p2.paymentId}`);
    assert.deepEqual([pm.method, pm.accountKey, pm.reference, pm.receivedBy, pm.status], ['mtn_merchant', 'mtn_merchant', 'MP240921.1234', 'cash', 'completed']);
    const rc = await doc(`receipts/${p2.receiptId}`);
    assert.equal(rc.businessName, 'RamosMAX Automotive Care (U) Ltd');
    assert.deepEqual([rc.numberPlate, rc.invoiceNumber, rc.amountPaidUgx, rc.totalPaidUgx, rc.outstandingUgx, rc.methodLabel],
      [inv.numberPlate, inv.invoiceNumber, 25000, 35000, 0, 'MTN Merchant']);
    assert.equal(rc.items.length, 2);
    assert.equal((await audits('payment.recorded')).length, 2);
    await rejects(pay('cash', a.invoiceId, 1), 'failed-precondition', 'already_paid');
  });

  test('overpayment, bad amounts, bad methods and missing references are refused', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]); // 15,000
    await assert.rejects(pay('cash', a.invoiceId, 15001), (e) => {
      assert.equal(e.details.reason, 'overpayment');
      assert.equal(e.details.outstandingUgx, 15000);
      return true;
    });
    for (const amount of [0, -100, 10.5, '5000']) await rejects(pay('cash', a.invoiceId, amount), 'invalid-argument', 'amount');
    await rejects(pay('cash', a.invoiceId, 100, { method: 'bitcoin' }), 'invalid-argument', 'method');
    for (const method of ['mtn_merchant', 'airtel_merchant', 'bank']) {
      await rejects(pay('cash', a.invoiceId, 100, { method }), 'invalid-argument', 'reference');
    }
    await rejects(pay('cash', a.invoiceId, 100, { requestId: 'x' }), 'invalid-argument', 'request_id');
    assert.equal((await db.collection('payments').get()).size, 0);
  });

  test('a retried request is recorded once (idempotent)', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    const data = { invoiceId: a.invoiceId, amountUgx: 5000, method: 'cash', requestId: 'retry-1234567' };
    const first = await billing.recordPayment(deps, 'cash', data);
    const again = await billing.recordPayment(deps, 'cash', data);
    assert.equal(again.paymentId, first.paymentId);
    assert.equal(again.duplicate, true);
    assert.equal((await doc(`invoices/${a.invoiceId}`)).paidUgx, 5000);
    // The same request ID cannot be replayed against another invoice.
    const b = await invoicedJob(await newVehicle(w.customerId), [w.wash]);
    await rejects(billing.recordPayment(deps, 'cash', { ...data, invoiceId: b.invoiceId }), 'invalid-argument', 'request_id');
  });

  test('concurrent payments can never overpay the invoice', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]); // 15,000
    const r = await Promise.allSettled([1, 2, 3, 4].map(() => pay('cash', a.invoiceId, 5000)));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 3);
    const inv = await doc(`invoices/${a.invoiceId}`);
    assert.deepEqual([inv.paidUgx, inv.outstandingUgx, inv.paymentStatus], [15000, 0, 'paid']);
    const receipts = (await db.collection('receipts').get()).docs.map((d) => d.get('receiptNumber'));
    assert.equal(new Set(receipts).size, 3);
  });

  test('who may record and reverse payments', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    for (const uid of ['wkr', 'aud', 'sh']) await rejects(pay(uid, a.invoiceId, 100), 'permission-denied');
    const p = await pay('mgr', a.invoiceId, 100);
    // Reversal is admin-only by default (payments.reverse).
    for (const uid of ['cash', 'mgr', 'wkr', 'aud']) {
      await rejects(billing.reversePayment(deps, uid, { paymentId: p.paymentId, reason: 'Wrong' }), 'permission-denied');
    }
  });

  test('reversal: needs a reason, restores the balance, marks the receipt, never deletes; only once', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    const p = await pay('cash', a.invoiceId, 15000);
    await rejects(billing.reversePayment(deps, 'admin', { paymentId: p.paymentId }), 'invalid-argument', 'reason');
    await billing.reversePayment(deps, 'admin', { paymentId: p.paymentId, reason: 'Recorded on wrong invoice' });
    const inv = await doc(`invoices/${a.invoiceId}`);
    assert.deepEqual([inv.paidUgx, inv.outstandingUgx, inv.paymentStatus], [0, 15000, 'unpaid']);
    assert.equal((await doc(`payments/${p.paymentId}`)).status, 'reversed');
    assert.equal((await doc(`receipts/${p.receiptId}`)).status, 'reversed');
    await rejects(billing.reversePayment(deps, 'admin', { paymentId: p.paymentId, reason: 'Again' }), 'failed-precondition', 'already_reversed');
    const [log] = await audits('payment.reversed');
    assert.equal(log.reason, 'Recorded on wrong invoice');
  });
});

describe('credit and cancellation', () => {
  test('mark as credit with a reason; paying it off makes it paid', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash, w.interior]);
    await pay('cash', a.invoiceId, 5000);
    await rejects(billing.markInvoiceCredit(deps, 'cash', { invoiceId: a.invoiceId }), 'invalid-argument', 'reason');
    for (const uid of ['wkr', 'aud', 'sh']) {
      await rejects(billing.markInvoiceCredit(deps, uid, { invoiceId: a.invoiceId, reason: 'Mistake' }), 'permission-denied');
    }
    await billing.markInvoiceCredit(deps, 'cash', { invoiceId: a.invoiceId, reason: 'Corporate client, pays monthly' });
    let inv = await doc(`invoices/${a.invoiceId}`);
    assert.deepEqual([inv.paymentStatus, inv.outstandingUgx, inv.onCredit], ['credit', 30000, true]);
    await rejects(billing.markInvoiceCredit(deps, 'cash', { invoiceId: a.invoiceId, reason: 'Mistake' }), 'failed-precondition', 'already_credit');
    await pay('cash', a.invoiceId, 30000);
    inv = await doc(`invoices/${a.invoiceId}`);
    assert.deepEqual([inv.paymentStatus, inv.outstandingUgx], ['paid', 0]);
    await rejects(billing.markInvoiceCredit(deps, 'cash', { invoiceId: a.invoiceId, reason: 'Mistake' }), 'failed-precondition', 'already_paid');
  });

  test('cancel only without active payments; the job can be re-invoiced; nothing is deleted', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    const p = await pay('cash', a.invoiceId, 1000);
    await rejects(billing.cancelInvoice(deps, 'mgr', { invoiceId: a.invoiceId, reason: 'Wrong' }), 'failed-precondition', 'payments_exist');
    await rejects(billing.cancelInvoice(deps, 'cash', { invoiceId: a.invoiceId, reason: 'Wrong' }), 'permission-denied');
    await billing.reversePayment(deps, 'admin', { paymentId: p.paymentId, reason: 'Wrong invoice' });
    await rejects(billing.cancelInvoice(deps, 'mgr', { invoiceId: a.invoiceId }), 'invalid-argument', 'reason');
    await billing.cancelInvoice(deps, 'mgr', { invoiceId: a.invoiceId, reason: 'Discount forgotten' });
    const inv = await doc(`invoices/${a.invoiceId}`);
    assert.deepEqual([inv.status, inv.paymentStatus], ['cancelled', 'cancelled']);
    assert.equal((await doc(`service_intakes/${a.intakeId}`)).invoiceId, null);
    await rejects(pay('cash', a.invoiceId, 100), 'failed-precondition', 'cancelled');
    const again = await billing.createInvoice(deps, 'cash', { intakeId: a.intakeId });
    assert.equal(again.invoiceNumber, 'RMX-INV-000002');
    assert.equal((await db.collection('invoices').get()).size, 2);
    assert.equal((await audits('invoice.cancelled')).length, 1);
  });
});
