# Salaries and payroll (Phase 6)

The server code is in `functions/src/payroll.js`. The app code is in `lib/features/payroll/` (`payroll_screens.dart`)
and `lib/models/payroll.dart`.

## Salary profiles and history

`salary_profiles/{staffUid}` holds the **latest** version for display. Every change — creation, a raise, a change of
allowance eligibility, deactivation — is a **new** `salary_history/{staffUid}_v{n}` version with an effective date.
Versions are never edited or deleted.

| Field | Notes |
|---|---|
| `basicSalaryUgx` | Whole UGX, 0 to 100,000,000 (0 for staff paid only allowances) |
| `paymentFrequency` | `monthly` (default) or `weekly` |
| `allowanceEligible`, `allowanceAmountUgx` | Daily allowance eligibility and an optional personal amount (null = policy default) |
| `active` | An inactive version stops basic salary from its effective date |
| `effectiveFrom` | EAT day the version applies from (past allowed, up to a year ahead) |
| `reason`, `previousValue`, `createdBy`/`Name` | Required reason for every change after the first |

`setSalaryProfile` (`salary.manage`, Admin by default). Nobody sets their own salary. A version cannot take effect
before the latest one (`backdated`); a same-day correction is a new version that supersedes the earlier one.

**Which version a payroll uses:** the newest version whose `effectiveFrom` is on or before the **last day of the
payroll period**. Example: Jan–Jun 500,000; a new version from 1 July of 600,000 → the June payroll uses 500,000,
July uses 600,000. The payroll item copies the figures and the version number, so later changes never alter an
earlier payroll. There is no pro-rating inside a period (see Known limitations).

## The formula (server-side, `payFor`)

```
Basic salary (version in force at period end, 0 if inactive)
+ Approved allowances in the period not yet paid directly
+ Other authorised earnings (payroll.adjust, with a reason)
------------------------------------------------------------
Gross pay

Gross pay
− Authorised salary deductions            (salary_deductions, type authorized_deduction)
− Approved loss recoveries                (type loss_recovery, LOSSES_AND_DEDUCTIONS.md)
− Other approved deductions               (type other)
------------------------------------------------------------
Net pay   (never negative)
```

Each deduction schedule takes `min(instalment, remaining)` per payroll (and never more than its incident still has
outstanding). Together, deductions are limited to `maxDeductionPercentOfGross` of gross pay (policy, default 100%):
when the limit bites, later deductions are reduced (`deductionCapped`) and their remainder carries to the next
payroll. So the system never produces a negative net salary and never takes a deduction without a documented,
approved source. The app shows the same formula (`PayCalculator`) only to explain figures; the server's numbers are
the ones stored.

Example (tested): basic 600,000 + allowances 100,000 = gross 700,000; deductions 50,000; net 650,000.

## Payroll periods and statuses

`createPayroll({frequency: 'monthly', year, month})` (or `{frequency: 'weekly', weekStart}` — a Monday) creates
`payroll/{id}` with number `RMX-PAY-000001`. One payroll per frequency and period (`duplicate_payroll`, reserved in
`unique_keys`); no future periods.

```
draft ──prepare──► prepared ──submit──► pending_review ──review──► (reviewed) ──approve──► approved ──pay──► paid ──lock──► locked
                     ▲   │                  │                                            │              │
                     │   └─ earnings ±      └──return (reason)──► prepared               │              │
                     └───────── correct (payroll.adjust, reason) ◄───────────────────────┘              │
approved ◄──── reverse payment (payroll.adjust, reason; not once locked) ────────────────────────────────┘
draft / prepared / pending_review / approved ──cancel (reason)──► cancelled   (the period is free again)
```

| Step | Function | Permission (default holder) |
|---|---|---|
| Create, prepare (calculate) | `createPayroll`, `preparePayroll` | `payroll.prepare` (Manager, Admin; legacy `payroll.process` also accepted) |
| Submit for review | `updatePayrollStatus {action: submit}` | `payroll.prepare` |
| Review / return for correction | `{action: review}` / `{action: return, reason}` | `payroll.review` (Manager, Admin) |
| Approve | `{action: approve}` | `payroll.approve` (Admin). While `payrollRequiresAdminApproval` (default true) only an Administrator can approve |
| Pay | `payPayroll` | `payroll.pay` (Admin) |
| Lock | `lockPayroll` | `payroll.approve` |
| Correct, other earnings, reverse payment, cancel | `correctPayroll`, `addPayrollEarning`, `removePayrollEarning`, `reversePayrollPayment`, `cancelPayroll` | `payroll.adjust` (Admin) |

Review must happen before approval (`not_reviewed`). **Nobody reviews or approves a payroll that includes their own
pay** unless they are an Administrator (`self_action`). A manager given `payroll.approve` still cannot approve while
the policy requires an Administrator — the explicit configuration switch is `payrollRequiresAdminApproval`.

## Payroll items (payslips)

`payroll_items/{payrollId}_v{version}_{staffUid}` — one per employee per calculation, numbered
`RMX-PAY-000001-001`… Fields: basic salary, allowances (ids, count, total), other earnings, gross, each deduction
line (planned and applied amounts, source number), the three deduction totals, total deductions, net,
`deductionCapped`, `paymentStatus`, the salary version used.

Preparing again (or a correction) writes a **new version** of the items and marks the old ones
`current: false, status: superseded` — the history of every calculation is kept. Only the current version is paid.

## Payment: one batch transaction

Chosen structure: **one `payroll_payment` ledger entry per payroll** (total net pay), not one per employee, so
Finance shows a single outflow per payroll while each employee still has a clear record: their payroll item
(`paymentStatus: paid`, `paidAt`, `financialTransactionId`) is their payslip.

`payPayroll({payrollId, accountId, requestId, reference?, paymentDate?})`, all in **one** transaction:

1. the payroll must be `approved` (`not_approved`; `already_paid` if paid or locked);
2. every included allowance must still be approved and unpaid, every deduction still active with enough remaining
   and not yet applied to this payroll, every loss incident not cancelled with enough outstanding — otherwise
   `stale_payroll` (correct the payroll first);
3. the Phase 5 account must be active and hold the total (`insufficient_funds`);
4. post the `payroll_payment` entry (an outflow; `isRevenue: false`; daily summary `payrollPaidUgx`);
5. mark the payroll and items paid; items become visible to their employees (`visibleToStaff`);
6. mark included allowances paid (`paidVia: payroll`), apply each deduction (recovered +, remaining −, an
   `applications` entry) and each loss recovery (incident recovered +, outstanding −, status);
7. audit everything and remember the `requestId` (a retried request pays once).

A payroll whose total net pay is 0 is marked paid without a ledger entry.

## Corrections after approval

* **Before payment:** `correctPayroll({payrollId, reason})` recalculates (new item version), clears review and
  approval, and the payroll goes back through the workflow. Audited as `payroll.corrected`.
* **After payment, before locking:** `reversePayrollPayment({payrollId, reason})` posts the reversal ledger entry,
  returns the money and undoes everything the payment applied (allowances back to approved, deduction applications
  marked reversed and balances restored, loss incidents restored). The payroll returns to `approved`, to be paid
  again or corrected.
* **After locking:** nothing is reversed; adjust the next payroll (other earnings, or an approved deduction).

Nothing is ever deleted.

## Who sees what

| Data | Readable by |
|---|---|
| `payroll/{id}` (totals only) | `payroll.view` (Admin, Manager, Auditor); `reports.payroll.view` for management totals without individual pay (granted to nobody by default — e.g. a shareholder if the Admin chooses) |
| `payroll_items` | `payroll.view`; the employee for their own item **once paid** (`payroll.view.own` + `visibleToStaff`) |
| `salary_profiles` | `salary.view` (Manager, Auditor; legacy `staff.salary.view`); the employee for their own |
| `salary_history` | `salary.history.view` (Auditor, Admin); the employee for their own |

A worker cannot query another worker's salary or payroll: the rules refuse any query that is not limited to their
own `staffUid` (tested in `functions/test/rules.test.js`).

## Screens and routes

| Route | Screen |
|---|---|
| `/app/payroll` | Payroll runs · Salaries · Deductions · Policy (tabs by permission) |
| `/app/payroll/run/{payrollId}` | Totals, history, workflow buttons by permission and status, each employee's payslip |
| `/app/payroll/salary/{staffUid}` | Current salary, change (new version), version history |
| `/app/payroll/deduction/{deductionId}` | A deduction schedule, its applications, approve / reject / stop |

## Audit actions

`salary.created`, `salary.changed`, `salary.deactivated`, `salary.activated`, `payroll.created`, `payroll.prepared`,
`payroll.submitted`, `payroll.reviewed`, `payroll.returned`, `payroll.approved`, `payroll.paid`, `payroll.locked`,
`payroll.corrected`, `payroll.earning_added`, `payroll.earning_removed`, `payroll.payment_reversed`,
`payroll.cancelled`, `deduction.applied`, `deduction.reversed`, `payroll_policy.updated`.

## Known limitations

* No pro-rating: a salary change or a start/leave date inside a period does not split that period's salary; the
  version in force on the period's last day applies. Adjust with other earnings or a deduction if needed.
* The app creates monthly payrolls; weekly payroll periods exist in the server and its tests but have no screen yet.
* No PAYE / NSSF or other statutory calculations — Phase 6 does not assume Uganda employment-law rules. Statutory
  deductions, if required, must be entered as authorised deductions with their source until a later phase adds them.
* A payroll with a very large number of employees and unpaid daily allowances writes many documents in one
  transaction; the business size (tens of staff) is far below Firestore's limits.
