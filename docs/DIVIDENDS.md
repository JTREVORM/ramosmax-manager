# Dividends (Phase 7)

Code: `functions/src/dividends.js`. Tests: `functions/test/dividends.test.js`.

RamosMAX does **not** calculate profit or decide what is legally distributable. It applies **no** withholding tax or
other deduction. An authorised person enters the amount the business has approved for distribution. If a statutory
deduction is ever needed, it must be configured explicitly after legal review. Every allocation already carries a
`deductionsUgx` field, which is always 0 today.

## Workflow

```
draft ──calculate (record date reached)──► draft + allocations ──declare──► declared ──approve──► approved
  ▲ (edit / recalculate: earlier allocations kept, marked superseded)          │
  └──────────────────────── return to draft (reason) ◄─────────────────────────┘
approved ──pay (per allocation)──► partially_paid ──pay the rest──► paid
paid / partially_paid ──reverse one payment (reason)──► partially_paid / approved
draft / declared / approved with nothing paid ──cancel (reason)──► cancelled
```

Statuses: `draft`, `declared`, `approved`, `partially_paid`, `paid` and `cancelled` (the brief's DRAFT … CANCELLED).

## Declaration — `dividends/{id}` (`RMX-DIV-000001`)

The declaration records:

- `financialPeriod`, `declarationDate`, `recordDate` and `paymentDate` (planned);
- `calculationMethod`, one of:
  - **pool:** `totalDistributableUgx` (the approved amount);
  - **per_share:** `dividendPerShareUgx`;
- `classId` (optional; all classes when empty);
- notes, created / declared / approved by;
- the server totals `eligibleShares`, `eligibleShareholderCount`, `allocatedUgx`, `unallocatedUgx`, `paidUgx`,
  `outstandingUgx`, `paidCount` and `payableCount`;
- the frozen `snapshot` and the `recordLocked` flag.

Creation is idempotent (`requestId`). Allocations or totals sent by the app are ignored.

## Eligibility and the record date

- **Who is eligible:** whoever held eligible shares **at the end of the record date**, taken from the immutable share
  ledger. Today's holdings are never used. The tested example: John held 500 shares on 31 October and sold 250 in
  November, and his allocation is still based on 500. Someone who bought after the record date gets nothing.
- **When it can be calculated:** only once the record date has been reached (`record_date_future` otherwise).
- **The record-date lock:** after calculation, `recordLocked` stops any share transaction from taking effect on or
  before the record date, so the snapshot can never drift. Cancelling the dividend releases the lock.
- **Where the snapshot is kept:** on each allocation (shares, ownership % at the record date) and in
  `dividends.snapshot`.
- **Shareholder status** does not change entitlement: eligibility is ownership only. This is a documented assumption;
  a policy for suspended shareholders can be added if the business requires one.

## Calculation (server only)

| Method | Allocation |
|---|---|
| per share | gross = dividend per share × eligible shares |
| pool | dividend per share = pool ÷ eligible shares; gross = ⌊pool × shares ÷ eligible shares⌋ (integer arithmetic) |

Worked example (tested): a pool of UGX 10,000,000 over 1,000 shares is UGX 10,000 a share, so a holder of 100 shares
gets UGX 1,000,000.

- **Rounding:** the pool method rounds each allocation down to the shilling. The few shillings left over are reported
  as `unallocatedUgx` and never paid or invented.
- **Net:** net = gross − deductions, and deductions are always 0.

## Allocations — `dividend_allocations/{id}` (`RMX-DIV-PAY-000001`)

Each allocation holds:

- the dividend and shareholder;
- `sharesAtRecordDate`, `ownershipPercentAtRecordDate`, `dividendPerShareUgx`;
- `grossUgx`, `deductionsUgx`, `netUgx`;
- `paymentStatus` (`unpaid` / `paid` / `not_payable`), `paidAt`, `paymentDate`, `paymentReference`, `accountId`;
- `financialTransactionId` / `financialTransactionNumber`, and the `reversals` history;
- `current` (false once superseded by a recalculation; superseded allocations are never deleted).

## Approval

- **Who declares:** `dividends.declare`.
- **Who approves:** `dividends.approve`. By default (`settings/dividend_policy.requireAdminApproval: true`) only an
  **Administrator** may approve.
- **When the policy is off:**
  - the declarer cannot approve their own declaration;
  - nobody may approve a dividend that pays their own linked shareholding.

  Administrators are exempt from both, as in payroll.
- **Return:** a declared dividend can be returned to draft with a reason.

## Payment (`payDividend`, `dividends.pay`)

In **one** Firestore transaction the server:

1. verifies the dividend is approved or partially paid;
2. verifies each allocation belongs to it, is current, unpaid and above zero;
3. verifies the account is active;
4. posts one `dividend_payment` ledger entry per allocation. The ledger refuses an overdraft, so if funds are
   insufficient nothing at all is paid;
5. marks the allocations paid;
6. updates the dividend totals and status and each shareholder's `dividendsPaidUgx`;
7. writes the audit log.

A retry with the same `requestId` returns the first result. Paying an already-paid allocation is refused
(`already_paid`). Linked shareholders are notified (generic text).

## Reversal (`reverseDividendPayment`, `dividends.adjust`)

The allocation's ledger entry is reversed and the money returns to the account. The original entry stays, marked
`reversed`. The allocation becomes unpaid again and records the reversal (who, when, why, which entries), and the
dividend's totals and status are updated. All of this is atomic. The generic `reverseFinancialTransaction` refuses
`dividend_payment` entries (`use_ownership_reversal`), so ledger and allocation cannot disagree.

## Cancellation (`cancelDividend`, `dividends.adjust`)

Only a dividend with nothing paid can be cancelled. Reverse any payments first. The dividend and its allocations are
kept, marked cancelled.

## Accounting

A dividend payment is a **distribution to owners**:

- it is `dividend_payment` in the ledger, with `isRevenue: false`;
- the daily summary adds it to `dividendsPaidUgx`, **not** to `expensesPaidUgx`;
- *Finance → Reports* shows it under **Owners' money (not income, not operating expenses)**;
- operating-expense totals and expense categories are unchanged.

## Reports

**Dividends → Reports** can be filtered by record-date year. It shows:

- totals declared, approved, paid and outstanding;
- for each dividend: pool, per share, and paid of allocated.

The dividend detail screen lists every allocation with shares at the record date, net amount and payment status. The
Shareholders dashboard shows the dividend status too.

## Screens and permissions

| Route | Needs |
|---|---|
| `/app/dividends` (Declarations, Reports, Policy) | `dividends.view` or `shareholders.reports.view` (headers and totals only) |
| `/app/dividends/:id` allocations and payments | `dividends.view` |
| New / edit / calculate / declare / approve / pay / reverse / cancel | `dividends.create` / `.calculate` / `.declare` / `.approve` / `.pay` / `.adjust` |

A cashier can be given `dividends.view` + `dividends.pay` to pay approved dividends. Nothing is granted by default.

## Audit actions

- **Lifecycle:** `dividend.created`, `dividend.updated`, `dividend.calculated`, `dividend.declared`,
  `dividend.returned`, `dividend.approved`, `dividend.cancelled`.
- **Payments:** `dividend.allocation_paid`, `dividend.paid`, `dividend.payment_reversed`.
