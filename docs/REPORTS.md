# Reports (Phase 9)

Code: `functions/src/reports.js` (callable `getBusinessReport`) and `lib/features/reports/`.
Tests: `functions/test/reports.test.js`, `test/unit/phase9_test.dart`, `test/widget/phase9_test.dart`.

## How reports work

- **Calculated on the server.** The app sends only the report name and the period. It never totals anything itself and
  never sends a total.
- **From authoritative records.** Nothing is stored twice.

  | Figures | Source |
  |---|---|
  | Money totals by day | `finance_daily_summaries`, written by the Phase 5 ledger in the **same transaction** as every ledger entry (so they always agree with the ledger) |
  | Balances | `financial_accounts`, maintained by the ledger |
  | Everything else | The records themselves: payments, invoices, expenses, stock, attendance, payroll, shares, dividends, after-hours |
- **Read-only.** A report writes nothing.
- **Permission-controlled twice:**
  - each report needs one of its permissions (table below), or the server refuses it (`report_forbidden`);
  - inside a report, each section appears only if the caller may read that data. A cashier's executive summary
    shows operations only; a manager's ownership section is register-level only.
- **Bounded:**
  - a period is at most **400 days**;
  - every query has a limit (5,000 records);
  - a report that hit a limit says so (`truncated`), and the app asks for a shorter period.
- **Periods** are East Africa Time business days: today, yesterday, this week (Monday first), this month, previous
  month, or a custom range. The server validates the dates, their order, the 400-day limit and that the period does
  not start in the future.
- **Online only:** reports are calculated on the server. Offline, the screen says so and nothing is requested.

## Reports and who can run them

| Report | Opens with (any one) | Default roles |
|---|---|---|
| Executive summary | `reports.operational.view`, `reports.financial.view` | Admin, Manager, Auditor, Cashier (operations only), Shareholder (operations, revenue, balances) |
| Money in and out (daily) | `reports.financial.view`, `finance.view` | Admin, Manager, Auditor, Shareholder |
| Revenue | `reports.financial.view`, `finance.view` | Admin, Manager, Auditor, Shareholder |
| Payment methods | `reports.financial.view`, `finance.view` | Admin, Manager, Auditor, Shareholder |
| Outstanding and credit | `credit.view` (customer names only with `customers.view`) | Admin, Manager, Auditor, Cashier |
| Expenses | `expenses.view` | Admin, Manager, Auditor, Cashier |
| Inventory | `inventory.reports.view`, `inventory.view` | Admin, Manager, Auditor |
| Workforce | `attendance.view`, `payroll.view`, `reports.payroll.view` | Admin, Manager, Auditor |
| Shareholders | `shareholders.reports.view`, `shares.view`, `shareholders.view` | Admin, Manager (register level), Auditor |
| After-hours | `after_hours.view` | Admin, Manager, Auditor |

Workers have no report permission and never see the Reports menu. Adding reports gave no role any new data access:
each section needs the same permission as the screen that shows that data.

## What each report contains

- **Executive summary**, each section only with its permission:
  - **Operations:** jobs started, completed, open and cancelled; vehicles serviced; work in progress; services by
    category.
  - **Revenue:** operating revenue net of reversals, gross, reversals, each payment method, the after-hours share, and
    what customers owe now.
  - **Finance:** each account's balance now; operating expenses, purchases, staff pay, transfers, deposits and
    adjustments; reconciliations and differences.
  - **Workforce:** active staff, attendance counts, allowances, payroll, losses.
  - **Inventory:** items, low stock, indicative stock value, movements, purchases, suppliers.
  - **Ownership:** the register totals, capital received and outstanding, dividends declared and paid, and the
    ownership distribution.
  - **After-hours:** sessions, expected versus counted cash, shortages and excesses, and discrepancies.
- **Money in and out:**
  - one row per day: payments, reversals, expenses, purchases, staff pay, transfers, deposits, adjustments, share
    capital and dividends;
  - totals over the period.
- **Revenue:**
  - amounts invoiced, discounts, payments received, reversals, and **operating revenue**;
  - a separate table of money that is **not** revenue: share capital, dividends, transfers, deposits, opening balances
    and adjustments.
- **Payment methods:** cash, MTN, Airtel and bank, each with count, gross, reversed and net. A reversed payment is
  counted once, as reversed, and is excluded from net (tested).
- **Outstanding and credit:**
  - every open invoice with plate, customer (with `customers.view`), original, paid, remaining, age, payment count and
    last payment;
  - totals by age: 0–7, 8–30, 31–60 and 61+ days.
- **Expenses:**
  - by status and by category (expense date), and the expense list;
  - with financial report access, money paid out split into operating expenses, inventory purchases, staff pay and
    dividends.
- **Inventory:**
  - current stock with **indicative** value (quantity × last purchase cost, labelled as not an audited valuation);
  - low stock;
  - movements by type, stock-out reasons included (write-offs, damage, wastage);
  - purchases and suppliers.
- **Workforce:**
  - attendance by staff member: present, late, minutes late, absent, excused;
  - allowances by status;
  - payroll runs (gross, deductions, net), shown only with `payroll.view` or `reports.payroll.view`;
  - losses reported, recovered and outstanding.
- **Shareholders:**
  - register totals, ownership distribution, shares by class, dividends declared in the period;
  - with `shares.view`, also issues, transfers, adjustments and contributions.
- **After-hours:**
  - sessions, jobs and payments per worker, expected cash;
  - handovers waiting;
  - discrepancies resolved and unresolved, with each difference.

## Accounting rules the reports follow

| Kind of money | How reports treat it |
|---|---|
| Operating revenue | Customer payments **minus** their reversals, counted once when collected (after-hours included) |
| Not revenue | Share capital, transfers between accounts, bank deposits, opening balances, adjustments, and after-hours handovers (custody only) |
| Operating expenses | Expense payments minus reversals |
| Shown apart from operating expenses | Inventory purchases, staff pay (allowances and payroll) and dividends (distributions to owners) |
| Credit and outstanding balances | Owed, **not** revenue until paid |
| Profit | Not calculated |

## Export

**Export CSV** (share icon) produces a UTF-8 CSV of every figure and table in the report, whatever the caller was
allowed to see, and nothing more.

- **Amounts:** whole shillings without separators, so spreadsheets can add them up.
- **Formula protection:** any text that starts with `=`, `+`, `-` or `@` gets a leading apostrophe, so a spreadsheet
  never runs it as a formula (tested).
- **Delivery:** through the phone's share sheet (e-mail, Drive, WhatsApp). Nothing is uploaded by the app.

## Other Phase 9 screens

| Screen | Needs |
|---|---|
| **Audit Logs** (`/app/audit`) | `audit.view`. The append-only trail, newest first, filterable by module, 100 entries at a time |
| **Settings** (`/app/settings`) | `settings.view`. Shows the connected environment (development or production), the Firebase project and the application ID, with links to each policy's own screen. No setting is copied here |
| **Business Performance** (shareholder menu) | Opens the executive summary |
