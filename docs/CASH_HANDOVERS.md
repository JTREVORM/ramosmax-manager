# Cash handovers and discrepancies (Phase 8)

Code: `functions/src/after_hours.js`. See also [AFTER_HOURS.md](AFTER_HOURS.md) for authorisations and sessions.

## Expected cash

The server works it out; the app only displays it:

```
expected cash = opening float + cash payments in the session − cash payments reversed while the session was open
```

- **Mobile money** (MTN / Airtel merchant) is recorded on the session, but it goes straight to the merchant account
  and is **not** in the worker's custody.
- **At close** `closeAfterHoursSession` recomputes the figure from the session's payments (`expectedFromPayments`), not
  from the running total. The result is **frozen** on the handover.
- **Never editable:** nothing in the app sends an expected amount, and no function accepts one.
- **Tested example** (`functions/test/after_hours.test.js`):
  - float UGX 50,000 + cash payments UGX 30,000 (+ Airtel merchant UGX 15,000, not counted) → expected UGX 80,000;
  - reversing a UGX 15,000 cash payment while the session is open → UGX 65,000;
  - closing recalculates UGX 65,000 from the payments themselves;
  - a later reversal leaves it at UGX 65,000.

## Handovers — `cash_handovers/{id}` (`RMX-HO-000001`)

```
pending ──submit (worker states the amount)──► submitted ──receive (manager counts)──► received            (difference 0)
   └───────────────receive directly─────────────────┘                          └──► discrepancy ──resolve / waive──► reconciled
```

| Call | Who | Rules |
|---|---|---|
| `submitCashHandover({handoverId, declaredAmountUgx, notes?, requestId})` | The worker (`after_hours.request`, own) or `cash_handover.submit` | Informational: what the worker says they hand over. Repeat → `already_submitted` |
| `receiveCashHandover({handoverId, actualAmountUgx, explanation?, notes?, requestId})` | `cash_handover.approve` | Nobody receives their own (`self_receipt`). Only once (`already_received`). A non-zero difference needs an explanation and opens a discrepancy |

The counted amount decides:

- **equal:** the handover is `received` and the session `reconciled`;
- **short:** difference −5,000 (tested);
- **over:** difference +5,000 (tested).

The difference is `actual − expected`. The expected, declared and actual figures are never changed afterwards.

Handovers are **never cancelled or deleted**. Every difference goes through a discrepancy.

## Finance: no new revenue, no second ledger

Each after-hours payment was posted to the Phase 5 ledger (Cash at Hand for cash) **when it was collected**. The
handover is custody accounting: it records that the cash physically reached the manager. It therefore:

- posts **nothing** to `financial_transactions`;
- changes **no** account balance;
- records `destinationAccountId: 'cash_at_hand'` for reference.

The emulator test *a payment is posted once; the handover adds no revenue and no ledger entry; balances stay
consistent* checks that the ledger count and balances are identical before and after a receipt. The generic
`reverseFinancialTransaction` keeps refusing customer payments (`use_payment_reversal`).

## Discrepancies — `cash_discrepancies/{id}` (`RMX-AHD-000001`)

Created by `receiveCashHandover` when the difference is not zero. Each discrepancy has:

- `kind`: `shortage` or `excess`;
- the original `expectedCashUgx`, `declaredAmountUgx`, `actualAmountUgx` and `differenceUgx`;
- `reason` (the receiver's explanation).

| Call | Who | What |
|---|---|---|
| `reviewCashDiscrepancy({discrepancyId, notes})` | `after_hours.discrepancy.review` | `open` → `under_review` |
| `resolveCashDiscrepancy({discrepancyId, outcome, resolution, recoverFromWorker?, postAdjustment?, requestId})` | `after_hours.discrepancy.review` | `outcome` is `resolved` or `waived`. The handover and session become `reconciled` |

Nobody reviews or resolves a discrepancy about their own handover (`self_action`). A closed one cannot be closed again
(`already_resolved`).

**Optional, explicit follow-ups:**

- **`recoverFromWorker`**:
  - allowed only for a **shortage** that is being **resolved** (`not_a_shortage` otherwise);
  - needs `losses.create`;
  - reports a Phase 6 **loss incident** (`worker_related_loss`, `sourceType: 'cash_discrepancy'`) in the same
    transaction.

  Nothing is charged: the incident goes through the normal Phase 6 approval, and any salary deduction needs its own
  authorisation. **No payroll deduction is ever created automatically.**
- **`postAdjustment`**:
  - needs `finance.adjust` (Administrator by default);
  - posts one Phase 5 `adjustment` on Cash at Hand for the difference: money out for a shortage, in for an excess;
  - the recorded balance then matches the counted cash.

  It is never automatic and never an arbitrary amount: it is always exactly the recorded difference.

## Notifications (generic text only)

| Type | To |
|---|---|
| `cash_handover_pending` | The worker (when someone else closed the session) and `cash_handover.approve` holders |
| `cash_handover_submitted` | `cash_handover.approve` holders |
| `cash_discrepancy_detected` | The worker and `after_hours.discrepancy.review` holders |
| `cash_discrepancy_resolved` | The worker and the person who recorded it |

## Audit actions (module `cash_handover`)

- **Handovers:** `cash_handover.submitted`, `cash_handover.received`, `cash_handover.reconciled`.
- **Discrepancies:** `cash_discrepancy.created`, `cash_discrepancy.reviewed`, `cash_discrepancy.resolved`,
  `cash_discrepancy.waived`.

A recovery also writes `loss.created` (module `losses`); an adjustment writes the Phase 5 ledger audit.

## Idempotency

Submit, receive, resolve, authorise and open all take a `requestId`, stored in `unique_keys/request_…`. A retry after
a lost response returns the first result, and a second tap never records a second count.
