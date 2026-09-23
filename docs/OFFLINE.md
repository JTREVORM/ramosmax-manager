# Offline strategy

RamosMAX sites may have unreliable connectivity. The rule is simple: **operational reads work offline; money
movements do not.**

## Configuration

`FirestoreService.configure` enables Firestore's on-device persistence with a 100 MB cache before any Firestore
call is made. Every snapshot listener serves cached data immediately and reconciles when the connection returns.

`ConnectivityService` and `OfflineBanner` show an amber banner while the device has no network: *"Offline —
showing saved data. Payments and other financial actions need a connection."*

## What is offline-friendly

Phase 3: customers, vehicles (including number-plate search over cached vehicles), the service catalogue and
service intakes already on the device are readable offline. Registering or editing them, and starting a service,
needs a connection (`OperationsActions`: "This needs an internet connection…"), because only the server can
guarantee unique plates and valid references.

Phase 4: jobs, a worker's own orders, invoices, payments, receipts, receivables and loyalty accounts already on
the device are readable offline. **Every Phase 4 write is online-only**: assigning, worker status changes,
invoicing, discounts, payments, credit, cancellations and loyalty (the shared `runOnline` helper in
`lib/core/services/callables.dart`). Worker status changes are online-only too, because the server enforces the
status flow and job completion. A retried payment reuses its idempotency key, so a flaky connection cannot charge
twice.

Phase 5: accounts and balances, the ledger, deposits, reconciliations, expenses, categories, recurring expenses,
inventory items, movements, suppliers and purchases already on the device are readable offline. The screens show the
server's last known balances and quantities. **Every Phase 5 write is online-only**: transfers, deposits,
reconciliations, adjustments, reversals, opening balances, account changes, creating, reviewing, approving, paying and
cancelling expenses, categories, recurring expenses, items, suppliers, purchases, receipts of stock and every stock
movement. All go through `runOnline`, which says *"This needs an internet connection…"* and sends nothing. Nothing is
queued, so an offline device can never post against a stale balance or stock level. Each money or stock form keeps
one `requestId`, so pressing the button again after a lost response is applied once.

Phase 6: attendance, allowances, payslips, salary profiles, payrolls, deductions and loss incidents already on
the device are readable offline (a worker's own history included). **Every Phase 6 write is online-only**, through
`WorkforceActions` → `runOnline`: clocking in and out, recording and correcting attendance, verification, allowance
calculation, decisions and payment, salary changes, every payroll step and payment, loss decisions and schedules,
deductions and the policy. Clocking in is deliberately not queued: the server's clock decides the time and lateness,
so an offline clock-in cannot be back-dated or replayed later. Payments keep one `requestId`, so a retry after a
lost response pays once.

## What must be online

Payments, receipts, discounts above threshold, transfers, expenses paid, cash handovers, reconciliation,
attendance, allowances, salaries, payroll, loss decisions, loyalty redemption and **user administration** (creating users, role changes, permission and temporary
access changes, activation/deactivation, staff links, profile edits, password resets and one's own password change — implemented in Phase 2 by
`UserAdminActions` / `SessionActions`, which reports *"User management needs an internet connection"*). User lists and details stay
readable offline from the cache. These must:

1. call `ConnectivityService.ensureOnline()` first, for immediate user feedback; **and**
2. execute as a Firestore **transaction** or **Cloud Function call**. Both need the server and fail when
   offline, so nothing is queued with a stale balance.

The client's cached balance is never the basis for a financial decision. The server-side total is authoritative.

## Session behaviour offline

- Previously signed-in users with a cached profile open straight into their dashboard offline.
- If the profile is not cached, the app waits (`AwaitingConnection`) rather than wrongly reporting "not
  registered".
- Access changes (deactivation, expired grants) apply as soon as the device reconnects. Rules enforce them
  server-side regardless.

## Phase 7: shareholders, shares and dividends

- **Viewable offline:** the register, shareholder profiles, share transactions, contributions, dividends and
  allocations, from the Firestore cache.
- **Online only:** every mutation goes through `ShareholderActions`, which uses `runOnline` and so is never queued.
  That covers adding or editing shareholders, status changes, links, classes, policies, issuing, transferring,
  adjusting, approving, reversing, contributions, and every dividend step including payment.
- **Also online only:** *Ownership on a date* and *My Shareholding*, which are function calls.
- **Retries:** issues, transfers, adjustments, reversals, contributions, dividend creation and dividend payments carry
  a `requestId`, so a retry after a lost response is recorded once.

## Phase 8: after-hours operations and cash handovers

- **Viewable offline:** authorisations, sessions, custody entries, handovers and discrepancies, from the Firestore
  cache. The expected cash shown offline is the last server figure, never a figure calculated on the device.
- **Online only:** every command goes through `AfterHoursActions`, which uses `runOnline`, so nothing is queued. That
  covers authorise, revoke, the policy, opening, closing and cancelling a session, submitting and receiving a
  handover, and reviewing or resolving a discrepancy. An after-hours payment is a normal `recordPayment`, which is
  online only too.
- **Why:** the server clock decides whether the authorisation is still in force, so a queued command could otherwise
  act after it ended. Widget and unit tests check that offline calls never reach the server.
- **Retries:** authorise, open, submit, receive and resolve carry a `requestId`, so a retry after a lost response is
  recorded once.

## Phase 9

- **Reports** are calculated on the server. Offline the Reports screen says a connection is needed and requests
  nothing.
- **Notifications:**
  - the inbox is readable offline from the cache;
  - marking a notice read is a harmless field update, so Firestore may queue it and apply it on reconnect;
  - "Mark all as read" and changing preferences need a connection.
- **Audit Logs and Settings** are readable offline from the cache.
- **Lost answers.** When a command was sent but its answer never arrived (timeout, the connection dropped, the app went
  to the background), the app says it **may already have been saved**, never that it failed. Retrying the same action
  is safe:
  - payments, expense payments, transfers, deposits, contributions, dividends and after-hours commands carry a
    `requestId`, and a retry returns the first result;
  - status changes refuse to run twice ("already approved", "already received").

  The concurrency tests prove a double request is recorded once.
