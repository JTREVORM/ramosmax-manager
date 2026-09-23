# Firestore data conventions

## Collections

All names are constants in `lib/core/constants/firestore_collections.dart`. Never type a collection name as a
string literal.

| Area | Collections |
|---|---|
| Identity & staff | `users`, `users/{uid}/temporary_grants`, `staff`, `staff_documents` |
| Customers & vehicles | `customers`, `vehicles` |
| Operations | `services`, `service_intakes` (the job), `worker_orders` (Phase 4), `service_jobs`, `job_items` (unused) |
| Sales | `invoices`, `payments`, `receipts`, `discounts` (Phase 4) |
| Loyalty | `loyalty_accounts`, `loyalty_transactions`, `loyalty_rewards`, `loyalty_events` (Phase 4) |
| Finance | `financial_accounts`, `financial_transactions`, `finance_daily_summaries`, `bank_deposits`, `reconciliations` (Phase 5); `bank_accounts`, `mobile_money_accounts` (unused: every account is in `financial_accounts`), `cash_handovers` (later) |
| Expenses | `expenses`, `expense_categories`, `recurring_expenses` (Phase 5) |
| Inventory | `inventory_items`, `suppliers`, `stock_movements`, `inventory_purchases` (Phase 5); `inventory` (unused) |
| People costs | `attendance`, `worker_allowances`, `salary_profiles`, `payroll`, `payroll_items`, `salary_deductions`, `loss_incidents` |
| After-hours | `after_hours_access`, `after_hours_sessions` |
| Shareholding | `shareholders`, `shares`, `dividends` |
| Platform | `notifications`, `audit_logs`, `settings`, `counters` (server-only sequences), `unique_keys` (server-only uniqueness reservations) |

Rules exist for `users` (+ `temporary_grants`), `staff`, `customers`, `vehicles`, `services`, `service_intakes`,
`worker_orders`, `invoices`, `discounts`, `payments`, `receipts` and the four loyalty collections, the twelve
Phase 5 finance, expense and inventory collections (all read-only to clients), `audit_logs`, `notifications` and
`settings`. The full map is in `DATA_MODEL.md`. **Every other collection is denied by default** until the phase that implements it ships its rules
with its code.

**Exception to "document ID ≠ business identifier": `staff/{staffId}`.** The staff ID (`RMX-STF-0001`) is the
document ID, so uniqueness is guaranteed by Firestore itself. It is allocated on the server from `counters/staff`
and never renamed; an account is relinked to a different record instead. See `USER_MANAGEMENT.md`.

## Document shape

Every business document carries:

| Field | Type | Rule |
|---|---|---|
| `createdAt` | Timestamp | `FieldValue.serverTimestamp()`, never the device clock |
| `updatedAt` | Timestamp | Server timestamp on every write |
| `createdBy` | string | Firebase UID of the actor |
| `updatedBy` | string | Firebase UID of the actor |
| `status` | string | Where the record has a lifecycle (`draft`, `active`, `void` …) |

Use `FirestoreService.createMetadata(uid)` and `updateMetadata(uid)`.

## Document ID ≠ business identifier

Firestore document IDs are auto-generated and never shown to users. Human-facing numbers are separate
fields, allocated server-side (Phase 2+) so they are gap-free and unique:

| Record | Field | Example |
|---|---|---|
| Staff | `staffId` | `RMX-STF-0001` |
| Customer | `customerNumber` | `RMX-CUS-000001` |
| Job | `jobNumber` | `RMX-JOB-000001` (worker orders: `RMX-JOB-000001/1`) |
| Invoice | `invoiceNumber` | `RMX-INV-000001` |
| Receipt | `receiptNumber` | `RMX-RCP-000001` |
| Financial transaction | `transactionNumber` | `RMX-TXN-000001` |
| Bank deposit | `depositNumber` | `RMX-BNK-000001` |
| Reconciliation | `reconciliationNumber` | `RMX-REC-000001` |
| Expense | `expenseNumber` | `RMX-EXP-000001` |
| Supplier | `supplierNumber` | `RMX-SUP-000001` |
| Stock purchase | `purchaseNumber` | `RMX-PUR-000001` (`RMX-INV-` is taken by invoices) |
| Stock movement | `movementNumber` | `RMX-STM-000001` |
| Inventory item | `sku` | `RMX-CHEM-001` (per-category sequence) or a custom SKU |

Numbers are allocated inside the same transaction as the record (`readCounter` in `functions/src/finance.js`
hands out several in one transaction). A failed or retried request never consumes or reuses a number, and a
reversal always gets a new one.

Exception: **vehicles are identified by number plate.** Normalise it with `NumberPlates.parse` (built on
`Validators.normalizePlate`, e.g. `uba-123a` → `UBA 123A`) and store it as `numberPlate` plus the search key
`normalizedNumberPlate` (`UBA123A`, unique). Keep a separate document ID so a corrected plate doesn't orphan
history. See `CUSTOMERS_AND_VEHICLES.md`.

## Money

- Type: `Money` (`lib/core/money/money.dart`), a whole number of **UGX**. UGX has no minor unit in circulation.
- Storage: an integer field whose name ends in `Ugx`, e.g. `amountUgx: 25000`, `balanceUgx`. **Never a double.**
- Percentages use basis points (`Money.percentage(2500)` = 25%) with explicit half-up rounding.
- Display: `Money.format()` gives `UGX 25,000`. `formatCompact()` is for charts only.

## Dates and times

- Store `Timestamp` (UTC instants). Never strings or epoch numbers.
- Present and bucket in **East Africa Time (UTC+3)** via `EastAfricaTime` and `DateTimeFormatter`,
  independent of the handset's time zone.
- Business days (attendance, allowances, daily reports) are keyed by `EastAfricaTime.businessDayKey()`
  (`2026-09-21`). Payroll periods use `EastAfricaTime.monthBounds()`.

## Financial immutability (for Phase 2+ modules)

- Balances are never written directly by clients. They are derived from, or maintained by trusted code
  alongside, `financial_transactions`.
- Financial records are **append-only**: no deletes, and no edits to amounts after posting. Corrections are new
  reversal or adjustment entries that reference the original.
- Posting financial records happens in transactions or Cloud Functions that require a live connection.
- Credit sales are **not** cash received. Expenses reduce an account only when actually paid.
- Phase 5 implements this: every balance change is a `financial_transactions` entry recording per-account
  `deltaUgx` and `balanceAfterUgx`. Every stock change is a `stock_movements` entry recording `quantityBefore` and
  `quantityAfter`. Both are written in the same transaction as the balance or quantity (FINANCE.md, INVENTORY.md).
- Business dates chosen by a person (expense, deposit, transfer, purchase and due dates) are stored as the Timestamp
  of the start of that EAT day.

## Audit logs

`audit_logs` entries (`AuditLogEntry`):

| Field | Notes |
|---|---|
| `userId`, `userRole` | Must equal the caller (enforced by the rules) |
| `action` | e.g. `session.sign_in`, `payment.recorded`, `user.deactivated` |
| `module` | `AuditModule` key |
| `recordId` | Affected document |
| `previousValue`, `newValue` | Changed fields only. No secrets or full sensitive records. |
| `description` | Human-readable |
| `timestamp` | Server time (enforced by the rules) |

The collection is append-only for everyone, admins included. The app logs sign-in and sign-out. The Cloud
Functions log every access change (user, role, permission, temporary, status, staff link) in the same transaction
as the change, with `reason`, `targetUserId` and `source: 'cloud_function'`. The admin CLI logs its changes with
`source: 'admin_cli'`. Financial actions will be audited by the server code that performs them.

## Indexes

Composite indexes are declared in `firebase/firestore.indexes.json` and deployed with the rules. Add indexes
there, never only in the console.
