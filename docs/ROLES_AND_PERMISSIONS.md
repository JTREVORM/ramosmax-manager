# Roles and permissions

The access model is **role + permissions + temporary permissions**. Every user has exactly one role. Explicit grants
and denials adjust it per person, and temporary grants add time-boxed access.

## Where the model is defined

The same catalogue exists in three places, one for each enforcement point. A unit test
(`test/unit/permissions_test.dart` and `test/unit/user_management_test.dart`) fails if any of them drift apart.

| Copy | Used by |
|---|---|
| `lib/core/auth/permissions.dart`, `user_role.dart` | The app: menus, buttons, screens (user experience only) |
| `firebase/firestore.rules` → `rolePermissions()` | Security rules: every Firestore read and write |
| `functions/src/access_catalog.json` | Cloud Functions and the admin CLI: every privileged change |

Never check a role by name in feature code. Ask `user.can(Permission.x, now)` or `AccessPolicy`.

## Roles

| Role | Rank | Scope |
|---|---|---|
| Admin | 100 | Everything, including user management and settings |
| Manager | 50 | Operations, staff (view), jobs, payments, discounts, attendance recording/approval/correction, allowances (calculate, decide, pay), payroll preparation and review, salary view, loss incidents (report, review, schedule), expenses, inventory, reports. **Can view users, grant temporary access to cashiers and workers, and reset Workers' passwords.** Cannot change salaries, approve or pay payroll, decide losses, create users or change roles. |
| Auditor | 50 | **Read-only**: records, transactions, attendance, allowances, salaries and their history, payroll, loss incidents, audit logs, users. Holds no write permission at all. |
| Shareholder | 50 | Financial summaries, business performance, reports, dividends |
| Cashier | 10 | Customers, vehicles, starting services (intake), invoices, payments, receipts, credit, redeeming loyalty rewards, cash handover submission. Discounts **only when `discounts.apply` is granted** (up to 25%). Views services and prices; cannot change them. |
| Worker | 10 | Own jobs (only orders assigned to them: accept, start, pause, resume, complete), own attendance, own allowances, after-hours requests; number-plate look-up and the service catalogue (read-only, no customer phone numbers) |

A worker's trade (Detailer, Car Washer, Polisher, Interior Cleaner, Mechanic, General Worker, Other) is the profile
field `specialization`, not a role.

**Rank** controls who may administer whom: a non-admin may only manage accounts ranked **below** their own. So a
manager can manage cashiers and workers, but never another manager, an auditor, a shareholder or an admin.

## Permission catalogue

Keys are `module.action`. Grouped as in the permission editor:

| Group | Permissions |
|---|---|
| Users | `users.view`, `users.create`, `users.edit`, `users.activate`, `users.deactivate`, `users.roles.manage`, `users.permissions.manage`, `users.permissions.temporary`, `users.passwords.reset` |
| Staff | `staff.view`, `staff.manage`, `staff.documents.view`, `staff.salary.view` |
| Customers & vehicles | `customers.view`, `customers.manage`, `vehicles.view`, `vehicles.manage` |
| Services & jobs | `services.view`, `services.manage`, `jobs.view`, `jobs.view.own`, `jobs.create`, `jobs.assign`, `jobs.manage`, `jobs.complete` |
| Invoices, payments & discounts | `invoices.view`, `invoices.create`, `invoices.void`, `payments.view`, `payments.record`, `payments.reverse`, `discounts.apply`, `discounts.approve`, `credit.view`, `credit.manage` |
| Loyalty | `loyalty.view`, `loyalty.redeem` (apply a vehicle's reward to an invoice, Phase 4), `loyalty.adjust` |
| Finance | `finance.view`, `finance.transactions.view`, `finance.accounts.manage`, `finance.transfer`, `finance.deposit`, `finance.reconcile`, `finance.adjust`, `cash_handover.submit`, `cash_handover.approve` |
| Expenses | `expenses.view`, `expenses.create`, `expenses.review`, `expenses.approve`, `expenses.pay`, `expenses.cancel`, `expenses.adjust`, `expenses.categories.manage`, `expenses.recurring.manage` |
| Inventory | `inventory.view`, `inventory.manage`, `inventory.suppliers.manage`, `inventory.purchase.create`, `inventory.purchase.approve`, `inventory.stock.in`, `inventory.stock.out`, `inventory.stock.adjust`, `inventory.reports.view` |
| Attendance & allowances | `attendance.view`, `attendance.view.own`, `attendance.mark`, `attendance.approve`, `attendance.record`, `attendance.review`, `attendance.correct`, `allowances.view`, `allowances.view.own`, `allowances.approve`, `allowances.calculate`, `allowances.pay`, `allowances.adjust`, `after_hours.request`, `after_hours.approve` |
| Salary, payroll & losses | `salary.view`, `salary.manage`, `salary.history.view`, `payroll.view`, `payroll.view.own`, `payroll.process` (legacy), `payroll.approve`, `payroll.prepare`, `payroll.review`, `payroll.pay`, `payroll.adjust`, `deductions.manage`, `losses.view`, `losses.create`, `losses.review`, `losses.approve`, `losses.schedule`, `losses.adjust` |
| Shareholders | `shareholders.view`, `shareholders.manage`, `dividends.view`, `dividends.declare` |
| Reports | `reports.operational.view`, `reports.financial.view`, `reports.payroll.view` |
| System | `audit.view`, `notifications.view`, `settings.view`, `settings.manage` |

The Phase 2 brief used names such as `create_users` or `receive_payments`. The Phase 1 names were kept wherever
they already existed. The mapping:

| Brief | RamosMAX key |
|---|---|
| view/create/edit/activate/deactivate_users | `users.view` / `.create` / `.edit` / `.activate` / `.deactivate` |
| manage_roles / manage_permissions | `users.roles.manage` / `users.permissions.manage` (+ `users.permissions.temporary`) |
| reset passwords | `users.passwords.reset` (non-admins: Workers only) |
| receive_payments, issue_receipts | `payments.record` |
| record_credit | `credit.manage` |
| edit_customers / create_customers | `customers.manage` (same for vehicles, services) |
| manage_prices | `services.manage` |
| service_intake.create / edit | `jobs.create` (Admin, Manager, Cashier) |
| service_intake.view | `jobs.view` |
| customers.create/edit, vehicles.create/edit | `customers.manage`, `vehicles.manage` |
| services.create/edit/prices | `services.manage` (Admin, Manager) |
| assign_jobs, reassign_jobs | `jobs.assign` |
| update_job_status | `jobs.complete` |
| manage_loyalty | `loyalty.adjust` |
| manage_financial_accounts, transfer_funds, reconcile_accounts | `finance.accounts.manage`, `finance.transfer`, `finance.reconcile` |
| manage_payroll | `payroll.process` |
| create_staff, edit_staff, manage_staff_documents | `staff.manage` (+ `staff.documents.view`) |
| export_reports | covered by the `reports.*` view permissions until the reports phase |
| view_audit_logs, manage_settings | `audit.view`, `settings.manage` |
| view_dashboard | the dashboard needs no permission; every active user has it |

Phase 2 replaced Phase 1's single `users.manage` with the fine-grained `users.*` permissions above. No stored profile
held `users.manage` (Admins receive every permission through their role), so no data migration was needed.

## Effective permissions

```
effective = ( role permissions
            ∪ explicit grants
            ∪ temporary grants whose window contains "now" )
            − explicit denials
```

The result is empty when the account is inactive, `accessExpiresAt` has passed, a **temporary password is pending**
(`mustChangePassword`), or the role is unknown. A denial
beats everything, including a temporary grant and the Admin role. The same formula is implemented in the rules
(`hasPermission`), the functions (`effectivePermissions` in `access.js`) and the app (`AppUser.effectivePermissions`).

## Temporary permissions

- Each grant has a **start** and an **end** (at most 30 days long, starting within 30 days).
- The rules compare `startsAt ≤ request.time < expiresAt` on **every request**. Access switches on and off on time,
  with no job needed and no way for the client to extend it.
- The full record is `users/{uid}/temporary_grants/{grantId}`: permission, start, end, reason, granted by (UID,
  name, role), status (`active` → `expired` / `revoked` / `superseded`), created at.
- A scheduled function (`sweepTemporaryGrants`, every 15 minutes) marks ended grants `expired`, removes their
  index entry and sends an "ending soon" notification 30 minutes before the end. Enforcement never depends on it.
- A grant is refused if the person already holds the permission permanently or it is explicitly denied.

Example: a Worker normally lacks `payments.record`. A Manager grants it from 18:00 to 22:00 with the reason
"Evening cover". It is effective only between those times.

## Anti-escalation rules (enforced by the Cloud Functions)

1. The caller's identity comes from the verified ID token. Their role and permissions are read from Firestore on
   the server. Nothing the client sends about itself is trusted.
2. The caller needs the specific permission for the action.
3. Nobody changes their own role, permissions, temporary access, active status, staff link or phone number.
4. Administrator accounts are managed only by Administrators. Only Administrators assign the Admin role.
5. Non-admins manage only roles ranked below their own, and assign only such roles.
6. Nobody hands out (grants, grants temporarily, or un-denies) a permission they do not hold themselves.
   Admin-only permissions (`users.*` except `users.view`, and `settings.manage`) are granted only by Admins.
7. Password resets: Admins for anyone they may administer; everyone else with `users.passwords.reset` only for the
   roles in `passwordResetRolesForNonAdmins` (Workers). Managers therefore cannot reset a Cashier's, another
   Manager's, an Auditor's, a Shareholder's or an Admin's password. Nobody resets their own; they change it.
8. An account holding a temporary password can do nothing (rules, functions and app) until it chooses its own.
9. `users.*` permissions cannot be denied to an Admin. To reduce an Admin's access, change their role.
10. RamosMAX always keeps at least one active Administrator. Deactivating or demoting an Admin checks this inside a
   transaction, so two admins removing each other at the same moment cannot both succeed.

## Phase 4 changes

- **Added** `loyalty.redeem` (Manager, Cashier; Admin through `*`). Redeeming a reward is an explicit,
  previewed action, separate from `loyalty.adjust` (corrections: Manager, Admin).
- **Removed** `discounts.apply` from the Cashier defaults. The specification allows cashier discounts only when
  granted: grant `discounts.apply` (permanently or temporarily) to a cashier who needs it. Without
  `discounts.approve` the server caps them at 25% of the subtotal.
- No other permission changed. Workers already had `jobs.view.own` and `jobs.complete`. Payment reversal
  (`payments.reverse`) stays Admin-only by default.

The three copies (Dart `permissions.dart`, `firestore.rules`, `functions/src/access_catalog.json`) are kept in
sync and checked by tests.

## Phase 5 changes

**Added (14 permissions):**

- `finance.transactions.view`, `finance.deposit`, `finance.adjust`
- `expenses.review`, `expenses.cancel`, `expenses.adjust`, `expenses.categories.manage`, `expenses.recurring.manage`
- `inventory.suppliers.manage`, `inventory.purchase.create`, `inventory.purchase.approve`, `inventory.stock.in`,
  `inventory.stock.out`, `inventory.reports.view`

Two names differ from the brief:

- `inventory.items.manage` is the existing `inventory.manage`.
- `inventory.reports` is named `inventory.reports.view`. View permissions end in `.view`, which keeps the Auditor
  role structurally read-only; a test asserts it.

The existing `finance.*`, `expenses.*` and `inventory.*` keys are unchanged.

| Role | Phase 5 defaults |
|---|---|
| Admin | Everything, as always |
| Manager | **Finance:** view, transactions.view, transfer, deposit, reconcile. **Expenses:** view, create, review, approve, pay, cancel, categories.manage, recurring.manage. **Inventory:** every inventory permission. **Not held:** `finance.accounts.manage`, `finance.adjust`, `expenses.adjust`. Account set-up, balance adjustments and reversals stay Admin-only unless granted. |
| Cashier | Added `expenses.view` and `expenses.create`, to record expenses for review. **Removed `finance.view`**: cashiers record payments without seeing business-wide balances. No review, approval or payment authority. |
| Auditor | Added `finance.transactions.view` and `inventory.reports.view`. Still read-only; already had the finance, expense and inventory view permissions. |
| Worker | Nothing new. No financial or inventory authority by default. Grant `inventory.view` + `inventory.stock.out` if a worker should record their own usage. |
| Shareholder | Unchanged: `finance.view` shows balances and daily totals, not ledger detail |

**Menus:**

- Finance is added for Managers and Auditors.
- Inventory is added for Auditors.
- Expenses is added for Cashiers.
- The Cashier's Reconciliation entry now needs finance access, so it is hidden by default.

## Phase 6 changes

**Added (20 permissions):** `attendance.record`, `attendance.review`, `attendance.correct`, `allowances.calculate`,
`allowances.pay`, `allowances.adjust`, `salary.view`, `salary.manage`, `salary.history.view`, `payroll.view.own`,
`payroll.prepare`, `payroll.review`, `payroll.pay`, `payroll.adjust`, `losses.view`, `losses.create`, `losses.review`,
`losses.approve`, `losses.schedule`, `losses.adjust`.

**Kept (Phase 1 names, so stored grants keep working):** `attendance.mark` is clocking in yourself;
`attendance.approve` approves attendance; `allowances.approve` makes an allowance decision final; `payroll.approve`
approves payrolls and deductions and locks paid payrolls; `deductions.manage` creates authorised salary deductions;
`payroll.process` is honoured by the server as `payroll.prepare`; `staff.salary.view` is honoured by the rules as
`salary.view`. `payroll.view.own` covers a person's own payslips, salary and deductions (there is no separate
`salary.view.own`).

| Role | Phase 6 defaults |
|---|---|
| Admin | Everything, as always |
| Manager | `attendance.view`/`.view.own`/`.mark`/`.record`/`.review`/`.approve`/`.correct`; `allowances.view`/`.view.own`/`.calculate`/`.approve`/`.adjust`/`.pay`; `salary.view`; `payroll.view`/`.view.own`/`.prepare`/`.review`; `losses.view`/`.create`/`.review`/`.schedule`. **Not held:** `salary.manage`, `salary.history.view`, `payroll.approve`, `payroll.pay`, `payroll.adjust`, `losses.approve`, `losses.adjust`, `deductions.manage` |
| Cashier | `attendance.mark`, `attendance.view.own`, `allowances.view.own`, `payroll.view.own` — their own records only. No salary configuration, approval or payment unless granted |
| Worker | Added `payroll.view.own` (already had `attendance.mark`, `attendance.view.own`, `allowances.view.own`) |
| Auditor | Added `salary.view`, `salary.history.view`, `losses.view` (already had `attendance.view`, `allowances.view`, `payroll.view`, `reports.payroll.view`). Still read-only |
| Shareholder | Unchanged. No individual pay; an Admin may grant `reports.payroll.view` for payroll totals only |

Server-side rules on top of permissions: nobody verifies, corrects, decides, pays or cancels their own attendance or
allowance, sets their own salary, creates or approves a deduction from their own pay, or decides an incident about
themselves; nobody but an Administrator reviews or approves a payroll that includes their own pay; while
`payrollRequiresAdminApproval` is on (default) only an Administrator approves payroll, even if `payroll.approve` is
granted to someone else.

**Menus:** Attendance and Allowances are added for Admins, Cashiers and Auditors; Payroll and Loss Incidents for
Managers; Loss Incidents for Admins and Auditors. For people who only see their own records, **Allowances** opens
**My pay** (allowances, payslips, salary, deductions). The Worker menu is unchanged.
