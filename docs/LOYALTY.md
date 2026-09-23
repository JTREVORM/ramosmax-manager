# Loyalty (Phase 4)

Loyalty belongs to the **vehicle**, not the customer. A customer with two cars has two accounts. The server code is
in `functions/src/loyalty.js`, and earning and redemption also run inside `billing.js`. The app code is in
`lib/features/billing/presentation/loyalty_screens.dart`.

## Rules

| Rule | Default | Setting (`settings/loyalty`) |
|---|---|---|
| Points per completed qualifying service | 20 | `pointsPerQualifyingService` |
| Points needed to unlock a reward | 200 | `rewardThreshold` |
| Reward | 25% off one invoice | `rewardDiscountPercent` |
| Points used when redeemed | 200 | `pointsConsumedOnRedemption` |
| "Nearing a reward" event at | 160 | `nearThresholdPoints` |

The settings document is readable by active staff and written only server-side (Admin SDK). Invalid or missing
values fall back to the defaults field by field. The percentage is capped at 100.

A service qualifies through its catalogue flag `qualifiesForLoyalty`. The flag is copied into the job's price
snapshot, so a later change to the flag doesn't affect past visits.

## Earning

Points are earned when an invoice becomes **fully paid**, in the same transaction as that payment:

- **amount:** qualifying lines × points per service;
- **once per invoice:** `loyaltyEarned` guards against repeats;
- **no partial payments:** nothing is earned until the invoice is fully paid.

A fully discounted invoice (total 0) is never paid through `recordPayment`, so it earns nothing.

When a payment is reversed, or an invoice with earned points is cancelled, the points are taken back. They can only
be taken back while the vehicle still has them. If they have already been spent, the reversal takes what is left
and records the shortfall; the balance never goes negative. Paying the invoice again earns the points again.

## Reward lifecycle

```
balance ≥ threshold, no available reward ──► reward "available" (one per vehicle)
available ──redeem on an invoice──► "redeemed"   (points consumed)
redeemed ──invoice cancelled──► "reversed"       (points returned; a fresh reward unlocks if balance allows)
available ──correction drops balance below cost──► "revoked"
```

- **One available reward per vehicle.** Points above the threshold don't unlock a second reward until the first is
  used.
- **No double redemption.** The reward is read and updated inside the redeeming transaction. Two invoices
  redeeming at once can't both succeed; an emulator test checks this. An invoice that already has a discount can't
  take a reward.
- **Explicit and previewed.** `applyLoyaltyReward({invoiceId, expectedDiscountUgx})` requires `loyalty.redeem`
  (Manager, Cashier, Admin). The app shows the exact amount off, the new total and the points before and after,
  then sends the amount it showed. If the server would apply anything else, it refuses with `preview_stale` and
  returns the correct amount.
- Redeeming is recorded as a discount on the invoice (`reasonCode: loyalty_reward`), as a `redeemed` ledger entry
  of −200, and in the audit log.

## Ledger

`loyalty_transactions` is immutable. Each entry records:

- `type`: `earned`, `redeemed`, `adjustment`, `reversal` or `expiry` (reserved);
- `points` (signed), `balanceBefore` and `balanceAfter`;
- `referenceType` and `referenceId` (invoice, transaction or manual);
- `reason`;
- `createdBy` and `createdAt`.

`loyalty_accounts/{vehicleId}` holds `pointsBalance`, `lifetimePoints`, `rewardsUnlocked`, `rewardsRedeemed` and
`lastEarnedAt`. The balance is never changed without a ledger entry in the same transaction. The sum of the
ledger always equals the balance; an emulator test checks this.

## Corrections

| Correction | Permission | Details |
|---|---|---|
| **Adjust** (`adjustLoyaltyPoints`) | `loyalty.adjust` (Manager, Admin) | Up to ±10,000 points. A reason is required. The balance never goes below 0. |
| **Reverse an entry** (`reverseLoyaltyTransaction`) | `loyalty.adjust` | A reason is required. Only once per entry: `unique_keys/loyalty_reversal_{id}` protects against double reversal, even under concurrent requests. Reversals can't be reversed, and redemptions are undone by cancelling their invoice. |

Nothing is ever deleted or edited.

## Events and notifications

Loyalty events are written to `loyalty_events` (`reward_nearing`, `reward_unlocked`, `reward_redeemed`) with the
vehicle, plate and balance, and `delivered: false`. They are the hand-off point for customer messages (SMS or
WhatsApp) in a later phase; customers are not app users.

The staff member whose payment unlocked a reward also gets `loyalty_reward_unlocked` through the existing
FCM and in-app path.

## Screens

| Screen | What it shows |
|---|---|
| **Vehicle detail → Loyalty** | Balance, progress to the next reward, and any available reward. |
| **Loyalty** (`/app/loyalty`) | The rules and the vehicles with the most points. |
| **Vehicle loyalty** (`/app/loyalty/:vehicleId`) | Full ledger, with Adjust and Reverse for `loyalty.adjust` holders. |
| **Invoice detail** | Offers the available reward, with an exact preview. |
