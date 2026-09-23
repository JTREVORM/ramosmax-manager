// ===========================================================================
// RamosMAX vehicle loyalty (Phase 4).
// ===========================================================================
// Loyalty belongs to the VEHICLE. Each vehicle has one account at
// `loyalty_accounts/{vehicleId}`; every change is an immutable ledger entry in
// `loyalty_transactions` (earned, redeemed, adjustment, reversal, expiry) with
// balanceBefore / balanceAfter. The balance is never written without a ledger
// entry, and ledger entries are never edited - mistakes are reversed.
//
// Rules (defaults; overridable in `settings/loyalty`, written server-side):
//   * each completed qualifying service on a FULLY PAID invoice earns 20;
//   * at 200 points an available reward (25% off one invoice) is unlocked;
//   * redeeming the reward consumes 200 points;
//   * one available reward per vehicle at a time.
// Earning happens inside the payment transaction (billing.js), so points,
// balance, reward and audit entry are written atomically with the payment.
// ===========================================================================

import { FieldValue } from 'firebase-admin/firestore';

import { invalid, precondition, requireReason } from './access.js';
import { audit, freshActor, notFound, requireDocId, stamp, uniqueRef } from './operations.js';
import { requireObject } from './user_admin.js';

export const ACCOUNTS = 'loyalty_accounts';
export const TRANSACTIONS = 'loyalty_transactions';
export const REWARDS = 'loyalty_rewards';
export const EVENTS = 'loyalty_events';

export const DEFAULT_LOYALTY = Object.freeze({
  pointsPerQualifyingService: 20,
  rewardThreshold: 200,
  rewardDiscountPercent: 25,
  pointsConsumedOnRedemption: 200,
  nearThresholdPoints: 160,
});

/** Reads `settings/loyalty`, falling back to the defaults field by field. */
export async function readLoyaltyConfig(tx, db) {
  const snap = await tx.get(db.collection('settings').doc('loyalty'));
  const stored = snap.exists ? snap.data() : {};
  const config = { ...DEFAULT_LOYALTY };
  for (const key of Object.keys(DEFAULT_LOYALTY)) {
    const v = stored[key];
    if (Number.isInteger(v) && v > 0 && v <= 100_000) config[key] = v;
  }
  config.rewardDiscountPercent = Math.min(config.rewardDiscountPercent, 100);
  return config;
}

/**
 * Everything a loyalty change needs, read inside [tx] (reads first, as
 * Firestore transactions require). Returns a state object whose `apply`
 * writes a ledger entry and keeps the reward consistent.
 */
export async function readLoyaltyState(tx, db, vehicleId) {
  const accountRef = db.collection(ACCOUNTS).doc(vehicleId);
  const [accountSnap, config, rewardSnaps] = await Promise.all([
    tx.get(accountRef),
    readLoyaltyConfig(tx, db),
    tx.get(db.collection(REWARDS).where('vehicleId', '==', vehicleId).where('status', '==', 'available').limit(1)),
  ]);
  const account = accountSnap.exists ? accountSnap.data() : null;
  let balance = account?.pointsBalance ?? 0;
  let availableReward = rewardSnaps.empty ? null : { ref: rewardSnaps.docs[0].ref, data: rewardSnaps.docs[0].data() };
  let created = !account;
  let lifetime = account?.lifetimePoints ?? 0;
  const events = [];

  return {
    config,
    get balance() { return balance; },
    get availableReward() { return availableReward; },
    accountRef,

    /**
     * Writes one ledger entry of [points] (signed) and the new balance, then
     * unlocks or revokes the reward as the threshold requires. Returns the
     * transaction id.
     */
    apply({ type, points, referenceType, referenceId, reason, actor, vehicle }) {
      if (!Number.isInteger(points) || points === 0) throw invalid('Points must be a whole, non-zero number.', 'points');
      const before = balance;
      const after = before + points;
      if (after < 0) throw precondition(`The vehicle has only ${before} points.`, 'insufficient_points');
      const txRef = db.collection(TRANSACTIONS).doc();
      tx.set(txRef, {
        transactionId: txRef.id,
        loyaltyAccountId: vehicleId,
        vehicleId,
        numberPlate: vehicle?.numberPlate ?? account?.numberPlate ?? null,
        type,
        points,
        balanceBefore: before,
        balanceAfter: after,
        referenceType,
        referenceId,
        reason,
        createdBy: actor.uid,
        createdByName: actor.data.fullName ?? null,
        createdAt: stamp(),
      });
      balance = after;
      if (type === 'earned' || (type === 'adjustment' && points > 0)) lifetime += Math.max(points, 0);
      const accountData = {
        loyaltyAccountId: vehicleId,
        vehicleId,
        numberPlate: vehicle?.numberPlate ?? account?.numberPlate ?? null,
        pointsBalance: balance,
        lifetimePoints: lifetime,
        status: 'active',
        updatedAt: stamp(),
        ...(type === 'earned' ? { lastEarnedAt: stamp() } : {}),
      };
      if (created) {
        tx.set(accountRef, { ...accountData, rewardsUnlocked: 0, rewardsRedeemed: 0, createdAt: stamp() });
        created = false;
      } else {
        tx.set(accountRef, accountData, { merge: true });
      }
      audit(tx, db, actor, 'loyalty', `loyalty.points_${type}`, vehicleId, {
        previousValue: { pointsBalance: before }, newValue: { pointsBalance: after, points }, reason,
        description: `${referenceType}:${referenceId}`,
      });

      // Reward bookkeeping.
      if (!availableReward && balance >= config.rewardThreshold) {
        const rewardRef = db.collection(REWARDS).doc();
        const reward = {
          rewardId: rewardRef.id,
          vehicleId,
          numberPlate: accountData.numberPlate,
          type: 'percentage_discount',
          threshold: config.rewardThreshold,
          discountPercent: config.rewardDiscountPercent,
          pointsCost: config.pointsConsumedOnRedemption,
          status: 'available',
          unlockedAt: stamp(),
          redeemedAt: null,
          redeemedBy: null,
          redemptionInvoiceId: null,
        };
        tx.set(rewardRef, reward);
        tx.set(accountRef, { rewardsUnlocked: FieldValue.increment(1) }, { merge: true });
        availableReward = { ref: rewardRef, data: reward };
        audit(tx, db, actor, 'loyalty', 'loyalty.reward_unlocked', vehicleId,
          { newValue: { rewardId: rewardRef.id, discountPercent: reward.discountPercent } });
        events.push({ type: 'reward_unlocked', rewardId: rewardRef.id });
      } else if (availableReward && balance < availableReward.data.pointsCost) {
        // A correction took the vehicle back under the cost of its reward.
        tx.update(availableReward.ref, { status: 'revoked', revokedAt: stamp(), revokedReason: reason });
        audit(tx, db, actor, 'loyalty', 'loyalty.reward_revoked', vehicleId,
          { previousValue: { rewardId: availableReward.ref.id }, reason });
        availableReward = null;
      } else if (points > 0 && before < config.nearThresholdPoints && balance >= config.nearThresholdPoints
          && balance < config.rewardThreshold) {
        events.push({ type: 'reward_nearing' });
      }
      for (const e of events.splice(0)) {
        // Customer-facing delivery (SMS/WhatsApp) is a later phase; the event
        // record is the hand-off point. Customers are not app users.
        tx.set(db.collection(EVENTS).doc(), {
          ...e, vehicleId, numberPlate: accountData.numberPlate, pointsBalance: balance, delivered: false, createdAt: stamp(),
        });
      }
      return txRef.id;
    },

    /** Marks the reward redeemed and consumes its points. */
    redeem({ reward, invoiceId, actor, vehicle }) {
      tx.update(reward.ref, { status: 'redeemed', redeemedAt: stamp(), redeemedBy: actor.uid, redemptionInvoiceId: invoiceId });
      tx.set(accountRef, { rewardsRedeemed: FieldValue.increment(1) }, { merge: true });
      availableReward = null; // consumed: `apply` may unlock the next one
      const id = this.apply({
        type: 'redeemed', points: -reward.data.pointsCost, referenceType: 'invoice', referenceId: invoiceId,
        reason: 'Loyalty reward redeemed', actor, vehicle,
      });
      audit(tx, db, actor, 'loyalty', 'loyalty.reward_redeemed', vehicleId,
        { newValue: { rewardId: reward.ref.id, invoiceId, discountPercent: reward.data.discountPercent } });
      tx.set(db.collection(EVENTS).doc(), {
        type: 'reward_redeemed', rewardId: reward.ref.id, vehicleId, numberPlate: vehicle?.numberPlate ?? null,
        pointsBalance: balance, delivered: false, createdAt: stamp(),
      });
      return id;
    },
  };
}

/** Points a fully paid invoice earns: per completed qualifying service line. */
export function pointsForItems(items, config) {
  return items.filter((i) => i.qualifiesForLoyalty === true).length * config.pointsPerQualifyingService;
}

// ---------------------------------------------------------------------------
// Callable: manual adjustment and reversal (loyalty.adjust)
// ---------------------------------------------------------------------------

export async function adjustLoyaltyPoints(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const vehicleId = requireDocId(data.vehicleId, 'vehicle');
  const points = data.points;
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 10_000) {
    throw invalid('Enter a whole number of points (positive to add, negative to remove).', 'points');
  }
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'loyalty.adjust');
    const vehicle = await tx.get(db.collection('vehicles').doc(vehicleId));
    if (!vehicle.exists) throw notFound('That vehicle could not be found.', 'vehicle_missing');
    const state = await readLoyaltyState(tx, db, vehicleId);
    const transactionId = state.apply({
      type: 'adjustment', points, referenceType: 'manual', referenceId: vehicleId, reason, actor, vehicle: vehicle.data(),
    });
    return { transactionId, pointsBalance: state.balance, rewardAvailable: Boolean(state.availableReward) };
  });
}

export async function reverseLoyaltyTransaction(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const transactionId = requireDocId(data.transactionId, 'loyalty transaction');
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'loyalty.adjust');
    const original = await tx.get(db.collection(TRANSACTIONS).doc(transactionId));
    if (!original.exists) throw notFound('That loyalty transaction could not be found.');
    const o = original.data();
    if (o.type === 'reversal' || o.type === 'redeemed') {
      throw precondition(o.type === 'redeemed'
        ? 'Redemptions are reversed by cancelling the invoice they were applied to.'
        : 'A reversal cannot itself be reversed.', 'not_reversible');
    }
    // One reversal per ledger entry, even under concurrent requests.
    const onceRef = uniqueRef(db, 'loyalty_reversal', transactionId);
    if ((await tx.get(onceRef)).exists) throw precondition('This transaction has already been reversed.', 'already_reversed');
    const state = await readLoyaltyState(tx, db, o.vehicleId);
    const id = state.apply({
      type: 'reversal', points: -o.points, referenceType: 'transaction', referenceId: transactionId, reason, actor,
      vehicle: { numberPlate: o.numberPlate },
    });
    tx.set(onceRef, { kind: 'loyalty_reversal', transactionId, reversalId: id });
    return { transactionId: id, pointsBalance: state.balance };
  });
}
