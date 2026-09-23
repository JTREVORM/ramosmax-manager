# After-hours operations (Phase 8)

Code: `functions/src/after_hours.js` (plus the tags in `billing.js` and `jobs.js`). Tests:
`functions/test/after_hours.test.js`, the Phase 8 block in `functions/test/rules.test.js`, `test/unit/after_hours_test.dart`
and `test/widget/after_hours_test.dart`.

When the manager or cashier leaves, an eligible worker can be authorised to keep serving customers: record services,
create invoices and collect payments. Every shilling collected is tied to that worker's session, and the cash has to be
handed over later (see [CASH_HANDOVERS.md](CASH_HANDOVERS.md)).

## Authorisations — `after_hours_access/{id}` (`RMX-AH-000001`)

`authorizeAfterHours({staffUid, startsAt, expiresAt, reason, permissions?, openingFloatUgx?, requestId})` requires
`after_hours.approve` (Manager, Administrator).

**It is refused when:**

| Reason code | Why |
|---|---|
| `self_authorization` | The supervisor tried to authorise themselves |
| `window` | The window is longer than `maxAuthorizationHours` (policy, default 16) or outside the Phase 2 temporary-window rules |
| `float` | The float exceeds `maxOpeningFloatUgx` (policy, default UGX 1,000,000) |
| (anti-escalation) | The supervisor may not administer the target, as for any Phase 2 access change |
| `target_inactive` | The target's account is inactive |
| `not_eligible` | The target lacks the **permanent** `after_hours.request` permission (workers have it by default) |
| `denied` | The target has `after_hours.operate` explicitly denied |
| `authorization_overlaps` | An active authorisation for the same person overlaps the window |
| `permission_not_allowed` | The permission list includes anything outside the grantable list below |

**The grantable list** (`AFTER_HOURS_GRANTABLE`):

- `after_hours.operate`, `after_hours.cash.collect`;
- `jobs.view`, `jobs.create`, `jobs.assign`;
- `invoices.view`, `invoices.create`;
- `customers.view`, `customers.manage`, `vehicles.manage`.

The default grants are the first seven. `after_hours.operate` is always included.

**What is never grantable:** user or role management, password resets, salaries, payroll, finance configuration and
accounts, payment reversal, dividends, shareholders, shares, inventory configuration, prices, discounts, attendance
approval, settings and audit logs. The server refuses them because they are not on the list, and a Flutter unit test
checks the Dart mirror against the server list.

### How it reuses Phase 2 temporary permissions

In **one** transaction the server:

1. writes one `users/{uid}/temporary_grants/{grantId}` record per permission the worker does not already hold
   permanently (`source: 'after_hours'`, `authorizationId`);
2. updates the profile's `temporaryPermissions[perm] = {startsAt, expiresAt, grantId}` map, the enforcement index the
   Firestore rules and `effectivePermissions` read;
3. marks older active grants of the same permission as superseded;
4. writes the authorisation and the audit entry (`after_hours.authorized`).

It then notifies the worker (`after_hours_authorized`).

**Why nothing becomes permanent:**

- **Expiry:** a temporary grant stops working at `expiresAt` on its own, in the rules and in every function, whether or
  not a sweep runs.
- **Authorisation-only permissions:** `after_hours.operate` and `after_hours.cash.collect` are listed in
  `authorizationOnlyPermissions` (access_catalog.json). `setUserPermissions` and `grantTemporaryPermission` refuse to
  add them (`authorization_only`), so they only ever arrive through an authorisation. The in-app permission editor
  never offers them.

**Revocation.** `revokeAfterHours({authorizationId, reason})` needs `after_hours.approve`. It marks the grants revoked,
removes the profile entries, sets the status to `revoked` and audits `after_hours.revoked`. A session that is still
open must still be closed and handed over: closing works after revocation or expiry.

**Statuses.** The server writes `active`, `revoked` or `expired`. The sweep (every 15 minutes, with the Phase 2
temporary-grant sweep) marks ended authorisations `expired` and sends one `after_hours_expiring` notice 30 minutes
before the end. Enforcement never depends on the sweep.

## Sessions — `after_hours_sessions/{id}` (`RMX-AHS-000001`)

| Call | Who | What it does |
|---|---|---|
| `openAfterHoursSession({requestId, notes?})` | The worker: `after_hours.operate` (live) and `after_hours.request` | Needs an authorisation in force now (`no_authorization` otherwise). One open session per person (`session_already_open`, enforced by `unique_keys/after_hours_open_session_{uid}`). The authorisation's opening float goes to its **first** session and is recorded as a custody entry. Idempotent |
| `closeAfterHoursSession({sessionId, notes?})` | The owner, or `after_hours.approve` | Recalculates the expected cash from the session's payments, freezes it, and creates a `pending` handover if there is cash to hand over (status `handover_pending`), otherwise `closed` |
| `cancelAfterHoursSession({sessionId, reason})` | The owner, or `after_hours.approve` | Only when nothing was collected and there is no float (`has_payments`, `has_float`) |

**Statuses:** `open` → `handover_pending` → `reconciled`; or `open` → `closed` when there is no cash; or `open` →
`cancelled`.

**Counters on a session:** `intakesCreated`, `invoicesCreated`, `jobsCompleted`, `paymentCount`, `cashCollectedUgx`,
`nonCashCollectedUgx`, `cashReversedUgx` and `expectedCashUgx`. All are server-maintained.

## Tagging the normal flows

There are no separate after-hours versions of the business flows. The existing Phase 3/4 functions look up the
caller's open session and tag what they create:

| Flow | Tag | Counter |
|---|---|---|
| `createServiceIntake` | `isAfterHours`, `afterHoursSessionId`, `afterHoursSessionNumber`, `afterHoursWorkerUid` | `intakesCreated` |
| `createInvoice` | same | `invoicesCreated` |
| `updateWorkerOrderStatus` (complete) | same | `jobsCompleted` |
| `recordPayment` | same on the payment, the receipt **and** the Phase 5 ledger entry | custody entry + totals |

### Payments (`recordPayment`)

- **Who:** `payments.record` or `after_hours.cash.collect`.
- **Without an open session:** anyone without `payments.record` is refused (`after_hours_session_required`).
- **With an open session:**
  - the authorisation must still be in force (`after_hours_expired`);
  - the method must be in the policy's `allowedPaymentMethods` (`method_not_allowed`; by default cash, MTN and Airtel
    merchant; no bank).
- **In the ledger:** the payment posts to the Phase 5 ledger exactly as it does in the daytime: it is revenue once, in
  the account of its method. There is **no second ledger**.
- **In the custody sub-ledger:** in the same transaction a custody entry is written to `after_hours_cash/{id}`
  (`RMX-AHC-…`, kind `payment`). For a cash payment the session's `expectedCashUgx` rises by the amount. Mobile money
  never enters the worker's custody.
- **Reversals** keep using the Phase 4 `reversePayment` (`payments.reverse`, never granted after hours):
  - **while the session is open:** the reversal lowers the expected cash (custody entry `payment_reversal`);
  - **after the session has closed:** the handover's expected cash stays frozen, because the refund comes out of Cash at
    Hand and not the worker's pocket. The entry is recorded with `afterSessionClosed: true`.

**The Flutter payment sheet:**

- during an open session, or for someone who may only collect after hours, it offers only the policy's methods;
- it states that cash is added to the handover;
- without an open session a collect-only worker is told to start one.

## Policy — `settings/after_hours_policy`

`updateAfterHoursPolicy({changes, reason})` (`settings.manage`) sets `allowedPaymentMethods`, `maxAuthorizationHours`
(1–24) and `maxOpeningFloatUgx` (0–10,000,000). The change is audited as `after_hours_policy.updated`. Any active user
may read the policy.

## Permissions

| Permission | Who by default | Meaning |
|---|---|---|
| `after_hours.request` | Worker | Eligible to be authorised; read own after-hours records |
| `after_hours.approve` | Manager (Admin) | Authorise, revoke; close someone else's session |
| `after_hours.view` | Manager, Auditor (Admin) | Read all after-hours records (dashboard, reports) |
| `after_hours.discrepancy.review` | Manager (Admin) | Review and resolve handover discrepancies |
| `after_hours.operate` | Authorisation only | Open a session |
| `after_hours.cash.collect` | Authorisation only | Collect customer payments in a session |
| `cash_handover.submit` | Manager, Cashier | Submit a handover for someone else |
| `cash_handover.approve` | Manager (Admin) | Receive (count) handovers |

## Screens

| Route | Who | Screen |
|---|---|---|
| `/app/after-hours` | `after_hours.view`, `after_hours.approve`, `cash_handover.approve` or `after_hours.discrepancy.review` | **After-Hours** dashboard (see below) |
| `/app/after-hours/session/:id` | Same | Session detail: cash make-up, custody entries, close or cancel |
| `/app/after-hours/handover/:id` | Same | Handover detail: receive |
| `/app/after-hours/discrepancy/:id` | Same | Discrepancy detail: review, resolve or waive |
| `/app/my-after-hours` (+ `/session`, `/handover`, `/discrepancy`) | `after_hours.request` | **My After-Hours** (see below) |

**The After-Hours dashboard tabs:**

- **Overview:** authorisations in force, open sessions, handovers to receive, open discrepancies.
- **Authorisations:** authorise and revoke.
- **Sessions**
- **Handovers**
- **Discrepancies**
- **Reports:** by period and worker: expected, received, shortages, excesses.
- **Policy**

**My After-Hours** shows:

- the current authorisation;
- start and close session;
- the expected cash, which the worker can only read;
- the custody entries;
- handovers to submit;
- history.

**What a worker sees:** the menu gains *New Service*, *Jobs*, *Invoices* and *Receipts* **only while** the temporary
grants are live. They disappear when the grants end. No administration, payroll, user, settings or finance menu is ever
added.

## Audit actions

- **Module `after_hours`:**
  - authorisations: `after_hours.authorized`, `after_hours.revoked`;
  - sessions: `after_hours.session_opened`, `after_hours.session_closed`, `after_hours.session_cancelled`;
  - payments: `after_hours.payment_linked`, `after_hours.payment_reversal_linked`;
  - policy: `after_hours_policy.updated`.
- **Module `cash_handover`:** see CASH_HANDOVERS.md.

Audit values hold numbers, amounts and statuses, never phone or ID numbers.

## Limitations

- The worker needs a connection for every step. Commands are never queued offline (see OFFLINE.md).
- **Floats:** one opening float per authorisation. Giving extra float during a session is not modelled; authorise again
  instead.
- **Report scope:** the Reports tab summarises the most recent 100 handovers. Longer histories need a server-side
  report, which is not part of this phase.
