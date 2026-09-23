# Loss incidents and salary deductions (Phase 6)

The server code is in `functions/src/losses.js` (recoveries are applied by `functions/src/payroll.js` when a payroll is
paid). The app code is in `lib/features/payroll/` (`loss_screens.dart`, the Deductions tab in `payroll_screens.dart`).

## The rule

**An incident never deducts anything by itself.** A staff member repays only an amount an approver has decided they
are liable for, through a schedule someone has set up, and only when a payroll is actually paid. So nothing is ever
recovered above the approved amount, after cancellation, or from anyone other than the staff member linked to the
incident.

```
reported ──review──► under_review ──decide (losses.approve)──► approved ──schedule──► recovery_scheduled
    │                     │                     └──► rejected                               │ (payroll paid)
    └─────────────────────┴──decide──────────────────────────────────────────► partially_recovered ──► recovered
anything not finished ──cancel (losses.adjust, reason)──► cancelled
```

| `status` | Meaning |
|---|---|
| `reported` | Recorded (`losses.create`); nothing owed |
| `under_review` | Being investigated (`losses.review`) |
| `approved` | Decided: `approvedRecoveryUgx` is owed (0 = the business absorbs it) |
| `rejected` | Staff member not liable (reason) |
| `recovery_scheduled` | A loss-recovery deduction exists |
| `partially_recovered` | Some of it has been recovered through paid payrolls |
| `recovered` | Outstanding is 0 |
| `cancelled` | Stopped with a reason; what was recovered stays recorded, the rest is written off (`cancelledOutstandingUgx`) |

## The incident

`loss_incidents/{id}`, number `RMX-LOSS-000001`: staff member (optional; one per incident — record one incident per
person when several are responsible), date, type (damaged equipment, damaged customer property, stock loss,
documented worker-related loss, other approved business loss), amount, description, evidence (a photo uploaded to
`payroll_uploads/losses/…`, readable only by admins, managers and auditors), reporter, reviewer, approver,
`approvedRecoveryUgx`, `recoveredUgx`, `outstandingUgx`, reasons and timestamps.

The staff member can see an incident about them once it has been decided (`visibleToStaff`), never while it is being
investigated.

## Decision (`decideLossIncident`, `losses.approve`, Admin by default)

`approve` with the amount to recover (0 to the full loss — `over_recovery` otherwise; a recovery needs a linked staff
member) or `reject`; a reason is always required. Nobody reviews, decides or schedules an incident about themselves.

## Schedule (`scheduleLossRecovery`, `losses.schedule`)

Creates **one** `salary_deductions` record (`RMX-DED-000001`) of type `loss_recovery`:
`totalAmountUgx = outstanding`, `instalmentUgx` (not more than the outstanding), the first payroll date. Example
(tested):

```
Loss 300,000 · approved recovery 150,000 · 50,000 per payroll
outstanding  150,000 → 100,000 → 50,000 → 0     (partially_recovered, partially_recovered, recovered)
```

A later payroll takes nothing more. A last instalment takes only what is left.

## Recovery through payroll

When a payroll is prepared, each active deduction for the employee plans `min(instalment, remaining)` (and never
more than the incident's outstanding amount). The amounts are **applied only when the payroll is paid**
(PAYROLL.md): the deduction's `recoveredUgx`/`remainingUgx`, an `applications` entry (`payrollId`, period, amount),
the incident's `recoveredUgx`/`outstandingUgx` and status change in the same transaction as the ledger entry. The
incident stays linked to the payroll item through the deduction line (`lossIncidentId`, `lossNumber`). A reversed
payroll payment gives the recovery back.

Guards: an incident cannot be cancelled while an unpaid payroll plans its recovery (`deduction_in_payroll` — correct
or cancel that payroll first); at payment everything is re-checked (`stale_payroll`), so a recovery can never be
applied twice, above the approved amount, after cancellation, or to a different staff member.

## Other salary deductions

`createSalaryDeduction` (`deductions.manage`, Admin by default) for an **authorised salary deduction** or **another
approved deduction**. Every deduction records its type, total amount, amount per payroll, reason, **source** (e.g. a
signed agreement number — required), the first payroll date and, once decided, its approver. It applies only after
`decideSalaryDeduction` (`payroll.approve`) approves it. Nobody creates or approves a deduction from their own pay.
`cancelSalaryDeduction` stops a schedule (`deductions.manage`; for a loss recovery `losses.adjust`, which returns the
incident to `approved` so it can be rescheduled).

Salary advances are **not** implemented in Phase 6. Legal deduction limits are not assumed: the business rule is the
configurable `maxDeductionPercentOfGross` (PAYROLL.md), and net pay can never be negative.

| `salary_deductions.status` | Meaning |
|---|---|
| `pending_approval` | Created, not yet approved — never applied |
| `active` | Applied in each payroll until nothing remains |
| `completed` | Fully recovered |
| `rejected` / `cancelled` | Not applied (reason kept) |

## Permissions (defaults)

| Permission | Admin | Manager | Auditor |
|---|---|---|---|
| `losses.view` | ✓ | ✓ | ✓ (read-only) |
| `losses.create`, `losses.review`, `losses.schedule` | ✓ | ✓ | |
| `losses.approve`, `losses.adjust` | ✓ | | |
| `deductions.manage` | ✓ | | |

Workers see their own deductions and decided incidents in **My pay**.

## Incidents from cash handovers (Phase 8)

When a cash-handover shortage is resolved with **Report the shortage as a loss incident**
(`resolveCashDiscrepancy({recoverFromWorker: true})`, which needs `losses.create`), a `worker_related_loss` incident is
created in the same transaction. It is created in status `reported`, with `sourceType: 'cash_discrepancy'`,
`sourceId` and `sourceNumber` (`RMX-AHD-…`). From there it follows the normal flow above:

- review;
- approval;
- recovery scheduling;
- deduction only through a paid payroll.

Nothing is deducted automatically. See CASH_HANDOVERS.md.

## Screens and routes

| Route | Screen |
|---|---|
| `/app/losses` | Incidents with status filter and the outstanding total; Report loss |
| `/app/losses/{incidentId}` | Details, decision and recovery; review / decide / schedule / cancel by permission |
| `/app/payroll` → Deductions | All deduction schedules; new salary deduction |

## Audit actions

`loss.created`, `loss.reviewed`, `loss.approved`, `loss.rejected`, `loss.recovery_scheduled`, `loss.recovered`,
`loss.recovery_reversed`, `loss.cancelled`, `deduction.created`, `deduction.approved`, `deduction.rejected`,
`deduction.applied`, `deduction.reversed`, `deduction.cancelled`.
