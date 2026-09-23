# Shares, contributions and ownership (Phase 7)

Code: `functions/src/shares.js`. Tests: `functions/test/shares.test.js`.

## Share classes — `share_classes/{code}`

A class is configured by an Administrator (`shareholders.manage`). Its fields:

- `code` (e.g. `ORDINARY`, `PREFERENCE`, `OTHER`), which is also the document ID in lower case;
- `name`, `description`;
- `valuePerShareUgx`;
- `active`;
- the server totals `issuedShares`, `committedUgx`, `paidUgx` and `outstandingUgx`.

- **No hard-coded share price.** No class and no price exist until the business creates them.
- **Business fields only.** No legal characteristics are modelled for any class.
- **Value per share changes need a reason.** A change applies to **future** issues only. Every issue stores the value
  it used.
- **An inactive class cannot receive new shares.** Existing holdings in it can still be transferred or adjusted.

## The ownership ledger — `share_transactions/{id}` (`RMX-SHR-TXN-000001`)

Every change of ownership is an immutable entry. Its signed `lines` are
`{shareholderId, shareholderNumber, shareholderName, deltaShares, committedDeltaUgx, sharesAfter}`.

| Type | Brief | Lines |
|---|---|---|
| `shares_issued` | SHARES_ISSUED / SHARES_PURCHASED | +n to one shareholder; commitment = n × value per share |
| `shares_transferred` | SHARES_TRANSFERRED | −n from one shareholder, +n to another (the total is unchanged) |
| `shares_adjusted` | SHARES_ADJUSTED | ±n correction with a reason (optionally ± commitment) |
| `reversal` | REVERSAL | The mirror image of a posted entry, effective on the day it is made |

`SHARES_REDEEMED` (buy-back) is **not** implemented. It moves money out to owners and has legal preconditions the
business has not specified. Record a verified correction as an adjustment instead.

Statuses: `pending_approval → posted → reversed`, or `pending_approval → rejected`. `applied` is true for `posted`
and `reversed` entries, which are the ones that count in the history.

### Approval (`settings/share_policy.requireApproval`, default **true**)

- An issue, transfer or adjustment is recorded as **pending**, and holders of `shares.approve` are notified.
- A holder of `shares.approve` approves or rejects it. Rejection needs a reason.
- Nobody approves their own request (Administrators excepted, as in payroll).
- Nobody approves a transaction on a shareholding linked to their own sign-in (Administrators excepted).
- On approval **everything is re-validated** before ownership changes: status, holdings, the history, the record-date
  lock and the payment policy. Two pending transfers therefore cannot together take more shares than are owned.
- If the policy is switched off, requests post immediately. They are still validated, audited and idempotent.

## Validation (server-side)

- Share numbers must be whole and between 1 and 1,000,000,000. Negative, zero or fractional numbers are refused.
- Amounts must be whole shillings.
- Share class: an unknown class is refused, and an inactive class cannot receive new shares.
- Shareholder status: an inactive, suspended or exited shareholder cannot receive shares, and a suspended or exited
  shareholder's shares cannot be transferred.
- **No over-transfer.** A shareholder cannot transfer or adjust away more shares than they hold. This is checked now
  **and at every date after the effective date**, so a backdated transfer cannot happen before the shares existed.
- Ownership totals can never go negative.
- **Record-date lock:** no entry may take effect on or before the record date of a dividend whose allocations have
  been calculated (see DIVIDENDS.md).
- Duplicate processing is stopped by `requestId` (`unique_keys/request_…`). A double tap or a retry after a network
  failure returns the first result.
- Anything the app sends as a total, percentage or contribution (`contributionUgx`, `ownershipPercent`, …) is
  ignored.

## Contribution and payment

The server calculates **contribution = number of shares × value per share** from the class. The client total is never
used. A share issue records a **commitment**, and money received is a separate **contribution**
(`share_contributions/{id}`, `RMX-SHR-CON-000001`). A contribution comes from one of three sources:

| Source | Effect |
|---|---|
| `account` (Cash, MTN Merchant, Airtel Merchant, a bank account) | One `share_capital_contribution` entry in the Phase 5 ledger: the account balance rises, in the same transaction |
| `prior_record` | Money paid before RamosMAX tracked the accounts (e.g. at incorporation). It counts as paid, needs a reason, and **no** balance changes |
| `none` | Nothing received yet (only if the policy allows unpaid shares) |

Policy (`settings/share_policy`):

- `allowPartialPayment` (default false) allows shares to be issued part-paid.
- `allowUnpaidShares` (default false) allows a commitment with nothing paid.

By default shares must be paid in full when they are issued. Unpaid commitments are never counted as cash.

Each issue tracks `committedUgx`, `paidUgx`, `outstandingUgx` and `paymentStatus` (`paid` / `partially_paid` /
`unpaid`). `recordShareContribution` records later money against an issue, and can never pay more than is
outstanding.

A transfer of shares that still have an unpaid commitment is refused until the payment is recorded. Contributions
stay with the person who paid them; a transfer moves shares, not historical contributions.

### Reversals

- **Contribution** (`reverseShareContribution`, `shares.adjust`, reason): the ledger entry is reversed (the money
  leaves the account again; refused if the account no longer holds it). The amount becomes outstanding again and the
  contribution stays, marked reversed.
- **Share entry** (`reverseShareTransaction`, `shares.adjust`, reason, `requestId`): a mirror entry is posted
  **today** and the original stays, marked `reversed`. Reversing an issue also reverses its live contributions and
  their ledger entries **in the same transaction**. The reversal is refused if the shares are no longer held (e.g.
  already transferred on), or if they would return to an exited shareholder.
- The generic finance reversal (`reverseFinancialTransaction`) refuses `share_capital_contribution` entries
  (`use_ownership_reversal`). Shareholder records and the ledger therefore cannot drift apart. This follows the
  Phase 6 payroll pattern.

## Ownership calculation

```
Ownership % = shareholder's shares ÷ total issued shares × 100   (four decimal places)
```

The server recomputes and stores it on every shareholder, holding and the register after each posting. The app only
displays it.

- **Across classes:** ownership counts shares of every class equally. This is a display metric, not a statement of
  legal rights.
- **Rounding:** each percentage is rounded to 4 d.p., so the displayed percentages may add up to 99.9999 or 100.0001.

Example (tested): John 100, Mary 50, Peter 50 → 50%, 25%, 25%.

## Historical ownership

Ownership at the end of any EAT day is the sum of the applied entries effective on or before that day
(`holdingsAsOf`). Later entries never rewrite it, and a reversal counts from its own date. `getOwnershipAsOf({date,
classId?})` (`shares.view` or `shareholders.reports.view`) serves **Shareholders → Reports → Ownership on a date**.
Dividends freeze their record-date snapshot onto the allocations.

## Holdings — `shareholdings/{shareholderId}_{classId}`

`shares`, `committedUgx`, `paidUgx` and `outstandingUgx` for one shareholder in one class. These are written only
by the server.

## Callable functions

| Function | Permission |
|---|---|
| `issueShares` | `shares.issue` |
| `transferShares` | `shares.transfer` |
| `adjustShares` | `shares.adjust` |
| `decideShareTransaction` | `shares.approve` |
| `recordShareContribution` | `shares.issue` |
| `reverseShareContribution`, `reverseShareTransaction` | `shares.adjust` |
| `getOwnershipAsOf` | `shares.view` or `shareholders.reports.view` |

## Screens

**Shares** (`/app/shares`, `shares.view`) has four tabs:

- **Transactions:** filters for pending, all, issues, transfers, adjustments and reversals; **New** opens issue,
  transfer or adjust.
- **Share classes**
- **Contributions**
- **Policy**

A share-transaction detail screen (`/app/shares/txn/:id`) offers approve and reject, record a payment, and reverse.
The shareholder detail screen offers **Issue shares** and **Transfer**.

## Audit actions

- **Requests and decisions:** `shares.requested`, `shares.issued`, `shares.transferred`, `shares.adjusted`,
  `shares.rejected`, `shares.reversed`.
- **Contributions:** `share_contribution.recorded`, `share_contribution.prior_record`, `share_contribution.reversed`.

## Assumptions

- Effective dates are EAT business days; future effective dates are refused.
- Transfers between shareholders move no money through the business. Any price agreed between them is private and not
  recorded as business money.
