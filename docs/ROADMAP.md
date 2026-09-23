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
| **7 — Shareholders, Shares & Dividends** (done) | Shareholder profiles (`RMX-SHR`) with search, statuses and self-service for linked shareholders; configurable share classes; an immutable ownership ledger (`RMX-SHR-TXN`) for issues, transfers, adjustments and reversals with second-person approval; server-side contributions (shares × value per share, `RMX-SHR-CON`) posted to the Phase 5 ledger as share capital (never revenue); server-side ownership % and ownership on any date; dividends (`RMX-DIV`) from an approved amount, with record-date eligibility, frozen allocations (`RMX-DIV-PAY`), Administrator approval, payment through the ledger as distributions (never operating expenses), guarded reversals and cancellation; see SHAREHOLDERS.md, SHARES.md, DIVIDENDS.md |
| **8 — After-Hours Operations & Cash Handovers** (done) | After-hours authorisations (`RMX-AH`) carried by Phase 2 temporary permissions from a fixed allow-list (never permanent, never administrative or financial); sessions (`RMX-AHS`) that tag jobs, invoices and payments made through the normal flows; policy-limited payment methods; a cash-custody sub-ledger (`RMX-AHC`) and a server-calculated, frozen expected cash; handovers (`RMX-HO`) counted by a manager; discrepancies (`RMX-AHD`) reviewed and resolved or waived, optionally reported as a Phase 6 loss incident (no automatic deduction) or aligned with an existing Phase 5 adjustment; no second ledger and no revenue on handover; see AFTER_HOURS.md, CASH_HANDOVERS.md |
| **9 — Hardening, Notifications, Reports & Production Readiness** (done) | Notification hardening (de-duplication, preferences with always-on critical notices, delivery records, token clean-up, nine new events, overdue-handover reminder, in-app inbox and push taps); server-calculated, permission-filtered reports with CSV export (executive, money in and out, revenue, payment methods, outstanding, expenses, inventory, workforce, shareholders, after-hours); Audit Logs and Settings screens; modified-client rules tests for every server-owned collection; storage-rule tests; concurrency and idempotency tests; "unconfirmed" handling of lost answers; bounded queries; small-phone layout fixes; production-readiness, backup and manual-test documentation; see REPORTS.md, PRODUCTION_READINESS.md |

All planned phases (1–9) are complete. **No Phase 10 is planned.** What remains before real business data is
deployment, configuration, manual testing and business, legal and accounting decisions (PRODUCTION_READINESS.md §8),
not development.

## Role menus (implemented in `RoleNavigation`)

| Role | Menu |
|---|---|
| Admin | Dashboard, New Service, Vehicles, Customers, Services, Jobs, Invoices, Payments, Receipts, Credit, Loyalty, Finance, Expenses, Inventory, Attendance, Allowances, Payroll, Loss Incidents, Shareholders, Shares, Dividends, After-Hours, Reports, User Management, Settings, Audit |
| Manager | Dashboard, New Service, Vehicles, Jobs, Customers, Services, Invoices, Payments, Receipts, Credit, Loyalty, Attendance, Allowances, Payroll, Loss Incidents, Finance, Expenses, Inventory, Reports, After-Hours (authorisations, sessions, handovers, discrepancies, reports), Shareholders (register reports only), Dividends (headers and totals), User Management (view + temporary access) |
| Cashier | Dashboard, New Service, Vehicles, Customers, Jobs, Services, Invoices, Payments, Receipts, Credit, Loyalty, Expenses (record for approval), Reconciliation (only if finance access is granted), Attendance (own), Allowances (My pay), Reports (operations, credit, expenses) |
| Worker | Dashboard, My Jobs, Vehicles (look-up), Services, Attendance (own, clock in/out), Allowances (My pay: allowances, payslips, salary, deductions), My After-Hours, My Profile; while an after-hours authorisation is in force also New Service, Jobs, Invoices and Receipts |
| Shareholder | Dashboard, Financial Summary, Business Performance, Reports, My Shareholding (own shares, contributions and dividends only) |
| Auditor | Dashboard, Audit Logs, Finance, Transactions, Expenses, Inventory, Payroll, Attendance, Allowances, Loss Incidents, Reconciliation, After-Hours, Reports, User Management, Jobs, Invoices, Payments, Receipts, Credit, Loyalty, Vehicles, Customers, Services, Shareholders, Shares, Dividends, Settings (all read-only) |

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
| Temporary after-hours permissions expire automatically | Implemented (Phase 8): authorisations are Phase 2 temporary grants, checked against `request.time` in the rules and the server clock in every function; see AFTER_HOURS.md |
| Important actions are traceable to the authenticated user | `audit_logs`: append-only, caller-attributed, server-timestamped |
| Immutable financial history | Implemented (Phase 5): `financial_transactions` and `stock_movements` are append-only with reversals |
| Stock never goes negative; stock purchases are not expenses | Implemented (Phase 5); see INVENTORY.md |
