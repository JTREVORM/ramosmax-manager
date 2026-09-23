# Daily allowances (Phase 6)

The server code is in `functions/src/allowances.js`. The app code is in `lib/features/payroll/`
(`allowance_screens.dart`) and `lib/models/payroll.dart` (`WorkerAllowance`).

## The rule

**An allowance exists only for approved attendance of an eligible staff member, and money moves only when it is
paid.** The amount is decided by the server — the app never sends one.

```
approved attendance ──calculate──► calculated ──decide (allowances.approve)──► approved ──pay──► paid
                                       │  └─decide (allowances.adjust only)─► pending_approval ─┘ (an approver decides)
                                       └──reject (reason)──► rejected
calculated / pending_approval / approved ──cancel (reason)──► cancelled   (the day can be recalculated)
paid ──reverse payment (allowances.adjust, reason)──► approved
approved ──(included in a payroll, paid with it)──► paid
```

| `status` | Brief | Meaning |
|---|---|---|
| `calculated` | CALCULATED | Worked out by the server; waiting for the manager's decision |
| `pending_approval` | PENDING_APPROVAL | Someone with `allowances.adjust` (but not `allowances.approve`) proposed a decision |
| `approved` | APPROVED | Approved amount fixed; unpaid |
| `rejected` | REJECTED | Nothing is paid (reason required) |
| `paid` | PAID | Paid directly (`paidVia: direct`) or with a payroll (`paidVia: payroll`) |
| `cancelled` | CANCELLED | Withdrawn with a reason (e.g. the attendance was corrected) |

## Eligibility

`calculateAllowances({date})` (`allowances.calculate`) looks at every attendance record of that EAT day and creates
at most one allowance per record (the record keeps the `allowanceId`, so calculating twice creates nothing new).
Skipped records are reported with the reason:

| Reason | Meaning |
|---|---|
| `rejected` / `not_verified` | Attendance rejected / not yet approved |
| `not_present` | Absent or excused |
| `already_calculated` | The day already has an allowance |
| `non_working_day` | Not a working day (unless `allowanceOnNonWorkingDays`) |
| `no_clock_out` | `requireClockOut` is on and there is no clock-out |
| `no_salary_profile` | No salary profile version in force that day, or it is inactive |
| `not_eligible` | The profile says `allowanceEligible: false` |

Eligibility comes from the staff member's **salary profile** (`allowanceEligible`, and optionally their own
`allowanceAmountUgx`), not from names or a hard-coded list. When a profile is first created, `allowanceEligible`
defaults from the policy's `allowanceEligibleRoles` (cashier, manager, worker); an Admin can change it per person.
A profile with basic salary 0 is valid for staff paid only allowances.

## Amount

`amount = profile.allowanceAmountUgx ?? policy.defaultDailyAllowanceUgx` — **UGX 5,000 by default**, set once in
`settings/payroll_policy` (DEFAULT_POLICY in `functions/src/workforce.js` is the only place the number appears).

## Late arrivals: FULL / DEDUCT / REJECT

Lateness does not remove the allowance automatically. The server suggests a decision from the policy
(`lateAllowancePolicy`, default `deduct`; `reject` for severely late) and the manager decides in
`reviewAllowance({allowanceIds, decision, deductionUgx?, reason})`:

| Decision | Paid | Rules |
|---|---|---|
| `full` | the calculated amount | No reason needed |
| `deduct` | calculated − deduction | Deduction = `deductionUgx` or the policy's `lateDeductionUgx` (UGX 2,500); at most `maxLateDeductionUgx` (UGX 5,000); must leave something (use reject to pay nothing). **Reason required** |
| `reject` | nothing | **Reason required** |

With `allowances.approve` the decision is final; with only `allowances.adjust` it is stored as a proposal
(`pending_approval`) for an approver. Nobody decides their own allowance. Up to 50 at once (the app's "Approve in
full"). When the policy's `allowanceApprovalRequired` is false, on-time allowances are approved at calculation;
late ones still wait for a decision.

## Payment (`payAllowances`, `allowances.pay`)

In **one** Firestore transaction:

1. validate every allowance: approved, not paid, amount above zero, not in a live payroll (`allowance_in_payroll`);
   nobody pays their own allowance;
2. validate the chosen Phase 5 financial account (active) and that it holds enough (`insufficient_funds`);
3. post **one** `allowance_payment` ledger entry for the batch (listing every allowance), reducing the account;
4. mark each allowance `paid` with the account, reference and transaction number;
5. write the audit entries and remember the `requestId`.

A retried request with the same `requestId` returns the first result (`duplicate: true`) and pays nothing. Paying
again with a new request is refused (`already_paid`). Payment can be from Cash at Hand, MTN Merchant, Airtel
Merchant or a bank account — the existing `financial_accounts`; no new account type exists.

Approved allowances that are not paid directly are included in the month's payroll (PAYROLL.md), which marks them
paid when the payroll is paid.

## Reversal and cancellation

* `reverseAllowancePayment({transactionId, reason})` (`allowances.adjust`) posts the mirror entry, returns the
  money and puts every allowance of that payment back to `approved`. Finance's generic reversal refuses allowance and
  payroll payments (`use_pay_reversal`), so the allowance records can never disagree with the ledger.
* `cancelAllowance({allowanceIds, reason})` (`allowances.adjust`): calculated, pending or approved (not in a
  payroll). The attendance day becomes calculable again.

## Who sees what

Managers, Admins and Auditors see all allowances (`allowances.view`). Workers and cashiers see only their own
(`allowances.view.own`); for them the **Allowances** menu entry opens **My pay**: their allowances, payslips, salary
and deductions.

## Screens and routes

`/app/allowances` — managers: To decide · Approved · unpaid (select and pay) · History · Calculate · My pay; the
allowance sheet shows the calculation, the policy suggestion and the decision form. Everyone else: My pay.

## Audit actions

`allowance.calculated`, `allowance.adjusted` (proposal), `allowance.approved`, `allowance.rejected`,
`allowance.paid`, `allowance.payment_reversed`, `allowance.cancelled`.
