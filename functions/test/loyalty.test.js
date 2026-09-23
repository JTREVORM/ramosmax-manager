// Vehicle loyalty (Phase 4) - against the Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as billing from '../src/billing.js';
import * as loyalty from '../src/loyalty.js';
import { emulatorDb, helpers, rejects, resetAndSeed } from './helpers.js';

const db = emulatorDb('loyalty-tests');
const { deps, doc, audits, world, newVehicle, invoicedJob, pay } = helpers(db);

beforeEach(() => resetAndSeed(db));

const account = (vehicleId) => doc(`loyalty_accounts/${vehicleId}`);
const ledger = async (vehicleId) => (await db.collection('loyalty_transactions').where('vehicleId', '==', vehicleId).get())
  .docs.map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis() || a.balanceAfter - b.balanceAfter);
const rewards = async (vehicleId, status) => {
  let q = db.collection('loyalty_rewards').where('vehicleId', '==', vehicleId);
  if (status) q = q.where('status', '==', status);
  return (await q.get()).docs.map((d) => d.data());
};

/** A paid visit: invoice the services and pay in full. */
async function paidVisit(vehicleId, serviceIds) {
  const inv = await invoicedJob(vehicleId, serviceIds);
  const p = await pay('cash', inv.invoiceId, inv.totalUgx);
  return { ...inv, ...p };
}

async function adjust(vehicleId, points, actor = 'mgr') {
  return loyalty.adjustLoyaltyPoints(deps, actor, { vehicleId, points, reason: 'Migrated from paper card' });
}

describe('earning', () => {
  test('20 points per completed qualifying service, only once the invoice is fully paid', async () => {
    const w = await world();
    const inv = await invoicedJob(w.vehicleId, [w.wash, w.interior, w.tyre]); // 2 qualifying
    await pay('cash', inv.invoiceId, 10000);
    assert.equal(await account(w.vehicleId), undefined, 'nothing earned on a partial payment');
    const p = await pay('cash', inv.invoiceId, inv.totalUgx - 10000);
    assert.equal(p.pointsEarned, 40);
    const acc = await account(w.vehicleId);
    assert.deepEqual([acc.pointsBalance, acc.lifetimePoints, acc.numberPlate], [40, 40, (await doc(`vehicles/${w.vehicleId}`)).numberPlate]);
    const [entry] = await ledger(w.vehicleId);
    assert.deepEqual([entry.type, entry.points, entry.balanceBefore, entry.balanceAfter, entry.referenceId], ['earned', 40, 0, 40, inv.invoiceId]);
    const i = await doc(`invoices/${inv.invoiceId}`);
    assert.deepEqual([i.loyaltyEarned, i.loyaltyPointsEarned], [true, 40]);
    assert.equal((await doc(`receipts/${p.receiptId}`)).loyaltyPointsEarned, 40);
    assert.equal((await audits('loyalty.points_earned')).length, 1);
  });

  test('non-qualifying services earn nothing; loyalty belongs to the vehicle, not the customer', async () => {
    const w = await world();
    await paidVisit(w.vehicleId, [w.tyre]);
    assert.equal(await account(w.vehicleId), undefined);
    const second = await newVehicle(w.customerId); // same customer, other vehicle
    await paidVisit(second, [w.wash]);
    assert.equal((await account(second)).pointsBalance, 20);
    assert.equal(await account(w.vehicleId), undefined);
  });

  test('the rules are configurable in settings/loyalty', async () => {
    await db.doc('settings/loyalty').set({ pointsPerQualifyingService: 50, rewardThreshold: 100, rewardDiscountPercent: 10, pointsConsumedOnRedemption: 100 });
    const w = await world();
    await paidVisit(w.vehicleId, [w.wash, w.interior]);
    assert.equal((await account(w.vehicleId)).pointsBalance, 100);
    const [r] = await rewards(w.vehicleId, 'available');
    assert.deepEqual([r.discountPercent, r.pointsCost, r.threshold], [10, 100, 100]);
  });
});

describe('rewards', () => {
  test('200 points unlock one 25% reward; points past the threshold do not unlock a second', async () => {
    const w = await world();
    await adjust(w.vehicleId, 180);
    assert.equal((await rewards(w.vehicleId)).length, 0);
    const events = async () => (await db.collection('loyalty_events').where('vehicleId', '==', w.vehicleId).get()).docs.map((d) => d.get('type'));
    assert.deepEqual(await events(), ['reward_nearing']);
    const sent = [];
    const inv = await invoicedJob(w.vehicleId, [w.wash]);
    const p = await billing.recordPayment({ ...deps, notify: async (...a) => sent.push(a) }, 'cash',
      { invoiceId: inv.invoiceId, amountUgx: inv.totalUgx, method: 'cash', requestId: 'unlock-000001' });
    assert.equal(p.rewardUnlocked, true);
    assert.deepEqual(sent, [['cash', 'loyalty_reward_unlocked', inv.invoiceId]]);
    const [r] = await rewards(w.vehicleId, 'available');
    assert.deepEqual([r.discountPercent, r.pointsCost, r.status], [25, 200, 'available']);
    assert.ok((await events()).includes('reward_unlocked'));
    await paidVisit(w.vehicleId, [w.wash]);
    assert.equal((await account(w.vehicleId)).pointsBalance, 220);
    assert.equal((await rewards(w.vehicleId)).length, 1);
    assert.equal((await audits('loyalty.reward_unlocked')).length, 1);
  });

  test('applying the reward: preview must match, 25% off, 200 points consumed, recorded everywhere', async () => {
    const w = await world();
    await adjust(w.vehicleId, 210);
    const inv = await invoicedJob(w.vehicleId, [w.wash, w.interior]); // 35,000
    const preview = billing.percentOf(35000, 25); // 8,750
    await rejects(billing.applyLoyaltyReward(deps, 'cash', { invoiceId: inv.invoiceId }), 'invalid-argument', 'expected_discount');
    await assert.rejects(billing.applyLoyaltyReward(deps, 'cash', { invoiceId: inv.invoiceId, expectedDiscountUgx: 9000 }), (e) => {
      assert.equal(e.details.reason, 'preview_stale');
      assert.equal(e.details.discountUgx, preview);
      return true;
    });
    const r = await billing.applyLoyaltyReward(deps, 'cash', { invoiceId: inv.invoiceId, expectedDiscountUgx: preview });
    assert.deepEqual([r.discountUgx, r.totalUgx, r.pointsBalance], [8750, 26250, 10]);
    const i = await doc(`invoices/${inv.invoiceId}`);
    assert.deepEqual([i.discount.reasonCode, i.discount.discountValue, i.discount.approvedBy, i.outstandingUgx], ['loyalty_reward', 25, 'cash', 26250]);
    const [reward] = await rewards(w.vehicleId);
    assert.deepEqual([reward.status, reward.redeemedBy, reward.redemptionInvoiceId, reward.discountUgx], ['redeemed', 'cash', inv.invoiceId, 8750]);
    const entries = await ledger(w.vehicleId);
    assert.deepEqual(entries.map((e) => [e.type, e.points, e.balanceAfter]), [['adjustment', 210, 210], ['redeemed', -200, 10]]);
    const acc = await account(w.vehicleId);
    assert.deepEqual([acc.pointsBalance, acc.rewardsRedeemed], [10, 1]);
    assert.equal((await audits('loyalty.reward_redeemed')).length, 1);
    assert.equal((await audits('discount.loyalty_reward_applied')).length, 1);
  });

  test('a reward cannot be redeemed twice, not even by two invoices at once', async () => {
    const w = await world();
    await adjust(w.vehicleId, 200);
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    const b = await invoicedJob(w.vehicleId, [w.wash]);
    const apply = (invoiceId) => billing.applyLoyaltyReward(deps, 'cash', { invoiceId, expectedDiscountUgx: 3750 });
    const results = await Promise.allSettled([apply(a.invoiceId), apply(b.invoiceId)]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    const failed = results.find((x) => x.status === 'rejected');
    assert.equal(failed.reason.details.reason, 'no_reward');
    assert.equal((await account(w.vehicleId)).pointsBalance, 0);
    assert.equal((await rewards(w.vehicleId, 'redeemed')).length, 1);
    const winner = results[0].status === 'fulfilled' ? a.invoiceId : b.invoiceId;
    await rejects(apply(winner), 'failed-precondition', 'discount_exists');
  });

  test('no reward, an existing discount or a payment blocks applying a reward; permissions', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    const apply = (uid, invoiceId) => billing.applyLoyaltyReward(deps, uid, { invoiceId, expectedDiscountUgx: 3750 });
    await rejects(apply('cash', a.invoiceId), 'failed-precondition', 'no_reward');
    await adjust(w.vehicleId, 200);
    for (const uid of ['wkr', 'aud', 'sh']) await rejects(apply(uid, a.invoiceId), 'permission-denied');
    await pay('cash', a.invoiceId, 100);
    await rejects(apply('cash', a.invoiceId), 'failed-precondition', 'payments_exist');
  });

  test('cancelling the invoice gives the points back and a fresh reward', async () => {
    const w = await world();
    await adjust(w.vehicleId, 200);
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    await billing.applyLoyaltyReward(deps, 'mgr', { invoiceId: a.invoiceId, expectedDiscountUgx: 3750 });
    assert.equal((await account(w.vehicleId)).pointsBalance, 0);
    await billing.cancelInvoice(deps, 'mgr', { invoiceId: a.invoiceId, reason: 'Reward applied to the wrong car' });
    assert.equal((await account(w.vehicleId)).pointsBalance, 200);
    assert.deepEqual((await rewards(w.vehicleId)).map((r) => r.status).sort(), ['available', 'reversed']);
    assert.equal((await db.collection('discounts').where('status', '==', 'cancelled').get()).size, 1);
    // Re-invoice and redeem the fresh reward.
    const again = await billing.createInvoice(deps, 'cash', { intakeId: a.intakeId });
    await billing.applyLoyaltyReward(deps, 'cash', { invoiceId: again.invoiceId, expectedDiscountUgx: 3750 });
    assert.equal((await account(w.vehicleId)).pointsBalance, 0);
  });
});

describe('corrections', () => {
  test('adjustments need loyalty.adjust and a reason; the balance never goes negative', async () => {
    const w = await world();
    await rejects(loyalty.adjustLoyaltyPoints(deps, 'mgr', { vehicleId: w.vehicleId, points: 20 }), 'invalid-argument', 'reason');
    for (const points of [0, 1.5, '20', 20000]) {
      await rejects(loyalty.adjustLoyaltyPoints(deps, 'mgr', { vehicleId: w.vehicleId, points, reason: 'Fix' }), 'invalid-argument', 'points');
    }
    for (const uid of ['cash', 'wkr', 'aud', 'sh']) await rejects(adjust(w.vehicleId, 20, uid), 'permission-denied');
    await rejects(adjust('ghost', 20), 'not-found', 'vehicle_missing');
    await adjust(w.vehicleId, 30);
    await rejects(adjust(w.vehicleId, -31), 'failed-precondition', 'insufficient_points');
    await adjust(w.vehicleId, -30);
    assert.equal((await account(w.vehicleId)).pointsBalance, 0);
    const [log] = await audits('loyalty.points_adjustment');
    assert.equal(log.reason, 'Migrated from paper card');
  });

  test('a ledger entry can be reversed once; reversing below the threshold revokes the reward', async () => {
    const w = await world();
    const { transactionId } = await adjust(w.vehicleId, 200);
    assert.equal((await rewards(w.vehicleId, 'available')).length, 1);
    const rev = (id, reason = 'Entered twice') => loyalty.reverseLoyaltyTransaction(deps, 'mgr', { transactionId: id, reason });
    await rejects(loyalty.reverseLoyaltyTransaction(deps, 'mgr', { transactionId }), 'invalid-argument', 'reason');
    await rejects(loyalty.reverseLoyaltyTransaction(deps, 'cash', { transactionId, reason: 'Nope' }), 'permission-denied');
    const r = await Promise.allSettled([rev(transactionId), rev(transactionId)]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1, 'concurrent double reversal refused');
    assert.equal((await account(w.vehicleId)).pointsBalance, 0);
    assert.deepEqual((await rewards(w.vehicleId)).map((x) => x.status), ['revoked']);
    await rejects(rev(transactionId), 'failed-precondition', 'already_reversed');
    const reversal = (await ledger(w.vehicleId)).find((e) => e.type === 'reversal');
    await rejects(rev(reversal.transactionId), 'failed-precondition', 'not_reversible');
  });

  test('reversing the payment that earned points takes them back (never below zero)', async () => {
    const w = await world();
    const v = await paidVisit(w.vehicleId, [w.wash, w.interior]);
    assert.equal((await account(w.vehicleId)).pointsBalance, 40);
    await billing.reversePayment(deps, 'admin', { paymentId: v.paymentId, reason: 'Mobile money reversed' });
    assert.equal((await account(w.vehicleId)).pointsBalance, 0);
    const i = await doc(`invoices/${v.invoiceId}`);
    assert.deepEqual([i.loyaltyEarned, i.paymentStatus], [false, 'unpaid']);
    // Paying again earns again, once.
    await pay('cash', v.invoiceId, i.totalUgx);
    assert.equal((await account(w.vehicleId)).pointsBalance, 40);

    // Points already spent: the reversal takes what is left and records the shortfall.
    const w2 = await newVehicle(w.customerId);
    await adjust(w2, 180);
    const v2 = await paidVisit(w2, [w.wash]); // 200 → reward
    await billing.applyLoyaltyReward(deps, 'cash', { invoiceId: (await invoicedJob(w2, [w.wash])).invoiceId, expectedDiscountUgx: 3750 });
    assert.equal((await account(w2)).pointsBalance, 0);
    await billing.reversePayment(deps, 'admin', { paymentId: v2.paymentId, reason: 'Cheque bounced' });
    assert.equal((await account(w2)).pointsBalance, 0);
    const unlocked = await db.collection('unique_keys').where('kind', '==', 'loyalty_reversal').get();
    assert.ok(unlocked.docs.some((d) => d.get('shortfall') === 20));
  });

  test('clients cannot write balances: the ledger always reconciles with the account', async () => {
    const w = await world();
    await adjust(w.vehicleId, 160);
    await paidVisit(w.vehicleId, [w.wash, w.interior]); // 200 → reward
    const inv = await invoicedJob(w.vehicleId, [w.wash]);
    await billing.applyLoyaltyReward(deps, 'cash', { invoiceId: inv.invoiceId, expectedDiscountUgx: 3750 });
    const entries = await ledger(w.vehicleId);
    const sum = entries.reduce((s, e) => s + e.points, 0);
    assert.equal(sum, (await account(w.vehicleId)).pointsBalance);
    for (const e of entries) assert.equal(e.balanceAfter - e.balanceBefore, e.points);
  });
});
