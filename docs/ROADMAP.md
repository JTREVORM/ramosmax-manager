# Roadmap and business rules

## Phases

| Phase | Scope |
|---|---|
| **1 — Foundation** (done) | Environments, phone auth, profiles, roles and permissions, rules, services, navigation shell, branding, docs |
| **2 — Authentication, Users & Roles** (done) | In-app user management, staff records and links, Cloud Functions for every access change, staff IDs, permission editor, temporary permissions with start/end, last-Admin protection, audit history, emulator-tested rules and functions |
| **3 — Customers, Vehicles & Services** (done) | Plate-first vehicle search and registration, customers, customer ↔ vehicle links, service catalogue with whole-UGX prices, service intake (select services), audit, rules, emulator tests |
| **4 — Operations, Billing & Loyalty** (done) | Jobs with `RMX-JOB` numbers, per-service worker orders with a controlled status flow, assignment and reassignment with history, worker dashboard; invoices (`RMX-INV`), discounts with reasons and approval, partial payments with idempotency, receipts (`RMX-RCP`) with share, credit and receivables; vehicle loyalty with ledger, rewards and corrections; see OPERATIONS.md, BILLING_AND_PAYMENTS.md, LOYALTY.md |
| **5 — Finance, Expenses & Inventory** (done) | Financial accounts (Cash at Hand, MTN/Airtel Merchant, banks) with an immutable ledger (`RMX-TXN`); every customer payment posts to its account atomically; transfers, bank deposits (`RMX-BNK`), cash awaiting banking, reconciliation (`RMX-REC`) with explicit adjustments, reversals; expenses (`RMX-EXP`) with review → approve → pay, categories, recurring reminders, reports; inventory items (SKUs), suppliers (`RMX-SUP`), purchases (`RMX-PUR`), stock movements (`RMX-STM`), adjustments, no negative stock, low-stock alerts; see FINANCE.md, EXPENSES.md, INVENTORY.md |
| **6 — Attendance, Allowances, Payroll & Losses** (done) | Attendance (`RMX-ATT`) with server-side lateness from a configurable policy, verification, audited corrections, biometric-ready data model; daily allowances (`RMX-ALL`, UGX 5,000 configurable) with FULL / DEDUCT / REJECT for late arrivals, approval and payment through the Phase 5 ledger; effective-dated salary history; payroll (`RMX-PAY`) with server-side gross/deductions/net, review → Admin approval → one-transaction payment → lock, corrections and reversals; loss incidents (`RMX-LOSS`) with approved recoveries scheduled as deductions (`RMX-DED`); worker-isolated rules; see ATTENDANCE.md, ALLOWANCES.md, PAYROLL.md, LOSSES_AND_DEDUCTIONS.md |
| 7 — next | Not started |
| Later | cash handovers · after-hours · shareholders & dividends · reports · full notifications |

## Role menus (implemented in `RoleNavigation`)

| Role | Menu |
|---|---|
| Admin | Dashboard, New Service, Vehicles, Customers, Services, Jobs, Invoices, Payments, Receipts, Credit, Loyalty, Staff, Finance, Expenses, Inventory, Attendance, Allowances, Payroll, Loss Incidents, Reports, User Management, Settings, Audit |
| Manager | Dashboard, New Service, Vehicles, Jobs, Customers, Services, Invoices, Payments, Receipts, Credit, Loyalty, Attendance, Allowances, Payroll, Loss Incidents, Finance, Expenses, Inventory, Reports, Cash Handover, User Management (view + temporary access) |
| Cashier | Dashboard, New Service, Vehicles, Customers, Jobs, Services, Invoices, Payments, Receipts, Credit, Loyalty, Expenses (record for approval), Reconciliation (only if finance access is granted), Attendance (own), Allowances (My pay) |
| Worker | Dashboard, My Jobs, Vehicles (look-up), Services, Attendance (own, clock in/out), Allowances (My pay: allowances, payslips, salary, deductions), My Profile |
| Shareholder | Dashboard, Financial Summary, Business Performance, Reports, Dividends |
| Auditor | Dashboard, Audit Logs, Finance, Transactions, Expenses, Inventory, Payroll, Attendance, Allowances, Loss Incidents, Reconciliation, Discrepancies, User Management, Jobs, Invoices, Payments, Receipts, Credit, Loyalty, Vehicles, Customers, Services (all read-only) |

## Business rules the foundation supports

| Rule | Where the foundation prepares for it |
|---|---|
| Number plate is the primary vehicle identifier | Implemented (Phase 3): `NumberPlates`, `numberPlate` + unique `normalizedNumberPlate`, plate-first search; see CUSTOMERS_AND_VEHICLES.md |
| Loyalty belongs to a vehicle: +20 points per qualifying wash; at 200 points a 25% reward unlocks | Implemented (Phase 4); see LOYALTY.md |
| Daily allowance: UGX 5,000 per working day for eligible approved staff | Implemented (Phase 6), configurable in `settings/payroll_policy`; see ALLOWANCES.md |
| Payroll never alters history; deductions need an approved source; net pay never negative | Implemented (Phase 6); see PAYROLL.md, LOSSES_AND_DEDUCTIONS.md |
| Separate accounts: Cash at Hand, MTN Merchant, Airtel Merchant, bank accounts | Implemented (Phase 5): every account lives in `financial_accounts`; see FINANCE.md |
| Outstanding credit is not cash received | Credit and payments are separate collections and permissions (`credit.*` vs `payments.*`) |
| Expenses reduce an account only when actually paid | Implemented (Phase 5): only `payExpense` moves money; see EXPENSES.md |
| Temporary after-hours permissions expire automatically | `temporaryPermissions` expiry map, checked against `request.time` in the rules and against the clock in the app |
| Important actions are traceable to the authenticated user | `audit_logs`: append-only, caller-attributed, server-timestamped |
| Immutable financial history | Implemented (Phase 5): `financial_transactions` and `stock_movements` are append-only with reversals |
| Stock never goes negative; stock purchases are not expenses | Implemented (Phase 5); see INVENTORY.md |
