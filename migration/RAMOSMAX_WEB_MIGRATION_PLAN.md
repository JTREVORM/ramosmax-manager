# RamosMAX Web Migration Plan
### Flutter + Firebase → Next.js + TypeScript + Tailwind + Supabase

**Status:** Proposal for approval. **Nothing has been built, committed, pushed or deployed.**
**Reference implementation:** `claude/zealous-pascal-qlt5ru` @ `113219d` (Phase 9, complete).

---

## 0. Repository version discrepancy — RESOLVED

Your recollection was correct and my earlier discovery was reading the wrong ref.

| Ref | Commit | Contents |
|---|---|---|
| `origin/main` | `467935d` | `Initial RamosMAX Manager Flutter app` — **Phases 1–6 only** |
| `origin/claude/zealous-pascal-qlt5ru` | **`113219d`** | **Phases 1–9 — the complete system** |
| `claude/gifted-cerf-mfgdcx` (my assigned branch) | `467935d` | Branched from stale `main`; remote copy was deleted |

`claude/zealous-pascal-qlt5ru` is `main` **+ 3 commits**, fast-forwardable (merge-base = `467935d`):

```
113219d  feat: complete final hardening reports notifications and production readiness   (Phase 9)
078a75c  feat: implement after-hours operations and cash handovers                       (Phase 8)
18da807  feat: implement shareholders shares ownership and dividends                     (Phase 7)
467935d  Initial RamosMAX Manager Flutter app                                            (Phases 1–6)
```

**Diff `main` → `113219d`: 111 files, +18,793 / −140 lines.** Phases 7–9 are missing from `main` entirely:
shareholders, shares, dividends, after-hours operations, cash handovers, reports, notification hardening,
audit-log and settings screens.

**Why the earlier discovery saw Phase 6:** the default `fetch` refspec had only pulled `main`. The Phase 9 branch
existed on the remote the whole time — `git ls-remote` confirms `refs/heads/claude/zealous-pascal-qlt5ru` points at
exactly the commit you named.

### Decisions this forces (needs your approval)

1. **`113219d` is the single source of truth.** All analysis below is from that tree, checked out read-only at
   `…/scratchpad/phase9`. Nothing in your working tree was touched.
2. **`main` is stale and dangerous.** It looks authoritative but is missing three phases. Recommend
   fast-forwarding `main` to `113219d` (no conflicts possible — it is a strict ancestor) **before** any web work
   starts, so nobody ever branches from Phase 6 again. *Not done — awaiting your word.*
3. **My assigned branch `claude/gifted-cerf-mfgdcx` is based on stale `main`** and its remote copy was deleted.
   When you approve the build, it must be re-cut from `113219d`, not from `main`.

### Verified scale of the correct version

| | |
|---|---|
| Dart source | 190 files, ~41,400 lines |
| Cloud Functions (business logic) | 25 modules, ~640 KB |
| **Callable functions** | **127** |
| Flutter screens | 76 top-level `*Screen` classes |
| Firestore collections | 60 declared |
| Firestore rules | 757 lines |
| Storage rules | 125 lines |
| Realtime listeners (`.snapshots()`) | 108 call sites |
| Tests | 57 files, ~14,200 lines |
| Documentation | 35 files, ~5,150 lines |

---

## 1. The single most important architectural finding

**Every Firestore collection in RamosMAX is `allow write: if false`.**

There are exactly three client-write exceptions in 757 lines of rules:
- `users/{uid}` — self-update of `lastLoginAt`, `fcmTokens`, `updatedAt` only, with equality guards on `role`,
  `active`, `permissions`, `deniedPermissions`, `temporaryPermissions`;
- `audit_logs` — append-only create, with `hasOnly()` field allow-list and `timestamp == request.time`;
- `notifications` — recipient may set `read`, `readAt`, `updatedAt` on their own notice.

Everything else — every invoice, payment, reversal, ledger entry, payroll run, share transaction, dividend,
handover — is written **only** by one of the 127 callable Cloud Functions, inside a transaction that re-checks the
caller's permissions and writes the audit trail atomically.

**Consequence: this is not a business-logic rewrite. The business logic is already fully server-side and already
decoupled from Flutter.** The Flutter app is a thin, permission-aware view layer over a callable API. Replacing it
with Next.js does not touch a single business rule.

This reframes the whole migration:

| Layer | Migration character |
|---|---|
| Business logic (~640 KB of Cloud Functions) | **Port, don't redesign.** JS → TS/PLpgSQL, rule-for-rule |
| Security model (rules) | **Translate.** Firestore rules → RLS, mechanically, clause by clause |
| Data | **Reshape.** Documents → normalised relational tables |
| UI (~41 kLOC Dart) | **Rebuild.** This is the genuinely new work |

---

## 2. Existing functionality that must be preserved

Every item below is **implemented and tested** in `113219d`. This is the acceptance checklist for "nothing lost."

### 2.1 Authentication & session
- **Phone number + password sign-in.** Nobody types an email. `signInWithPhonePassword` normalises the phone
  (Uganda `+256[347]xxxxxxxx`, others E.164), resolves it to the auth record, verifies the password server-side,
  then checks the business profile and mints a session token.
- **Hidden sign-in identity.** Firebase holds credentials against a random `{uuid}@users.ramosmax.invalid` address
  on the RFC 2606 reserved domain, so it can never be derived from a phone number and no mail can reach it.
- **Uniform failure message.** "Incorrect phone number or password." for every failure case — never reveals
  whether a phone number has an account.
- **Sign-in throttle.** 5 failures per phone number per 15 minutes, keyed by `sha256("ramosmax:" + phone)` in
  `login_throttle`, then a 15-minute lock-out with a minutes-remaining message.
- **Password policy** (`passwords.js`, mirrored in Dart): 8–128 chars, upper + lower + digit + symbol, common-password
  blocklist, must not contain last-6 of phone, staff ID, or any ≥4-char part of the name.
- **Generated temporary passwords:** 12 chars, CSPRNG, Fisher-Yates shuffled, no look-alike characters (no `0/O/o`,
  `1/l/I`) so they can be read aloud.
- **Forced password change.** `mustChangePassword` makes the account *inactive for everything* — the rules' own
  `isActive()` returns false — so a modified client cannot skip it. Read own profile, change password, nothing else.
- **`accessExpiresAt`** ends an account's access at contract end with no manual deactivation.
- **Session revocation.** Changing a password revokes all refresh tokens; the current device continues on a fresh token.
- Every sign-in, failed sign-in and password change writes an audit entry with `source: 'cloud_function'`.

### 2.2 Users, roles & permissions
- **6 roles:** `admin`, `manager`, `cashier`, `worker`, `shareholder`, `auditor`, with numeric ranks.
- **~150 permissions** in `module.action` form, in 14 groups.
- **Effective permission =** `(role defaults ∪ direct grants ∪ live temporary grants) − explicit denials`.
- **Temporary permissions** with `{startsAt, expiresAt, grantId}` windows, max 30 days, 5-minute clock-skew
  tolerance, enforced against `request.time` in rules and the server clock in functions — they start and stop
  **with no cleanup job**. A 15-minute sweep handles housekeeping only.
- **Admin-only permissions:** everything under `users.*` (except `users.view`) plus `settings.manage`.
- **Authorization-only permissions:** `after_hours.operate`, `after_hours.cash.collect` — grantable *only* by an
  after-hours authorisation, never permanently, never via the generic temporary-access editor.
- **Grant guards:** you cannot grant a permission you do not hold; you cannot administer a peer or senior; only an
  Admin manages Admin accounts; Managers reset **Workers'** passwords only (not Cashiers, despite rank).
- **Last-Admin protection** and "Administrators always keep user-management access — change the role instead."
- **Staff records** (`RMX-STF-0001`) independent of sign-in accounts, joined by `linkedUid`.
- Three-way permission catalogue sync (Dart enum ↔ `firestore.rules` ↔ `access_catalog.json`), enforced by a test
  that **fails the build if they drift**.

### 2.3 Customers, vehicles & services
- Plate-first workflow; `normalizedNumberPlate` uniqueness via server-side `unique_keys` reservation.
- Customer↔vehicle links; customer phone uniqueness; service catalogue with whole-UGX prices and name uniqueness.
- Workers hold `vehicles.view` + `services.view` but **not** `customers.view` — a vehicle record deliberately
  carries owner name and customer number but **never a phone number**.
- Nothing is deleted; records are deactivated.

### 2.4 Jobs & worker orders
- Jobs `RMX-JOB-*`; one open job per vehicle; one worker order per selected service.
- Controlled status flow enforced server-side; assignment/reassignment/cancellation with full history.
- Workers see only orders where `workerId == their uid` (`jobs.view.own`).
- `job_ready_to_invoice` fires when all orders on a job complete.

### 2.5 Billing, payments & credit
- Invoices `RMX-INV-*`, receipts `RMX-RCP-*`.
- Discounts with mandatory reasons, threshold-based approval, separate `discounts.apply` / `discounts.approve`.
- **Partial payments with idempotency:** every payment carries a `requestId` reserved as
  `unique_keys/payment_request_{id}` — a retry after a lost response returns the first result and **cannot charge
  twice**. The reservation covers the ledger posting too.
- **Payment reversals** — reversals, never deletions. History is immutable.
- **Customer credit is not cash.** Separate collections, separate permissions (`credit.*` vs `payments.*`),
  separate reporting lines.
- Invoice void/cancel; loyalty reward redemption as a discount.

### 2.6 Loyalty (per vehicle, not per customer)
- +20 points per qualifying wash; 200 points unlocks a 25% reward.
- Immutable ledger; adjustments and reversals (`loyalty_reversal_{txId}` guard); rewards; `loyalty_events`
  staged for a future SMS/WhatsApp channel.

### 2.7 Finance & ledgers
- `financial_accounts`: Cash at Hand, MTN Merchant, Airtel Merchant, bank accounts — server-maintained balances.
- **`financial_transactions` (`RMX-TXN-*`) is an append-only immutable ledger.** Corrections are reversals.
- Every customer payment posts to its account **atomically with the payment record**.
- `finance_daily_summaries` written **in the same transaction as every ledger entry**, so reports can never
  disagree with the ledger.
- Transfers, bank deposits (`RMX-BNK-*`), cash-awaiting-banking tracking, reconciliation (`RMX-REC-*`) with
  explicit adjustments, opening balances, and guarded reversals.

### 2.8 Expenses
- `RMX-EXP-*`; lifecycle **record → review → approve → pay**; categories; recurring expenses.
- **An expense reduces an account only when actually paid** — only `payExpense` moves money.
- Daily 06:00 EAT sweep creates *draft* due items and reminders from recurring bills; **it never pays anything**.
- Cashiers record expenses for a manager to review; they never see business-wide balances.

### 2.9 Inventory
- Items/SKUs, suppliers (`RMX-SUP-*`), purchases (`RMX-PUR-*`), movements (`RMX-STM-*`).
- **Stock never goes negative. Stock purchases are not expenses.** Low-stock alerts fire once per worsening.
- High-value stock-out requires `inventory.stock.adjust` approval.

### 2.10 Attendance
- One record per person per EAT day (`RMX-ATT-*`), `{staffUid}_{yyyy-mm-dd}`.
- **Lateness computed server-side** from `settings/payroll_policy` (reporting time + grace period), with the policy
  **snapshotted onto each record** so later policy changes never rewrite history.
- Clock-in/out, verification, rejection; audited corrections keeping original **and** corrected values.
- Biometric-ready data model.

### 2.11 Allowances
- Daily allowance UGX 5,000, configurable (`RMX-ALL-*`).
- Late arrivals resolve to **FULL / DEDUCT / REJECT** per policy; approval then payment through the Phase 5 ledger.
- Cancellation and payment reversal, with `requestId` idempotency on payment.

### 2.12 Salary & payroll
- **Effective-dated salary history**, never edited — every version kept (`salary_history/{uid}_v{n}`).
- Payroll `RMX-PAY-*`, one per period (`unique_keys/payroll_{frequency}_{periodKey}`, released on cancel).
- **Gross, deductions and net all computed server-side.** Flow: prepare → review → **Admin approval** → payment in
  one transaction → lock.
- **Net pay can never be negative.** Deductions require an approved source.
- Corrections create new item versions; superseded versions are retained.
- An employee sees their own payslip only once `visibleToStaff` is set (i.e. after payment).
- `reports.payroll.view` gives management-level totals **without any individual's pay**.

### 2.13 Loss incidents & deductions
- `RMX-LOSS-*` → review → decision → approved recovery scheduled as a salary deduction `RMX-DED-*`.
- A staff member sees an incident about them only once decided (`visibleToStaff`).
- Notifications about an incident go to reviewers, **never to the person the incident is about**.

### 2.14 Shareholders, shares & dividends
- Shareholders `RMX-SHR-*` with search, statuses, and self-service for linked accounts.
- Configurable share classes; **immutable ownership ledger** `RMX-SHR-TXN-*` for issues, transfers, adjustments and
  reversals, with **second-person approval**.
- Contributions `RMX-SHR-CON-*` = shares × value per share, computed server-side, posted to the ledger as
  **share capital — never revenue**.
- **Ownership % and ownership as-of any date computed server-side** (`getOwnershipAsOf`).
- Dividends `RMX-DIV-*`: approved amount → record-date eligibility → **frozen allocations** `RMX-DIV-PAY-*` →
  Administrator approval → payment through the ledger as **distributions, never operating expenses** → guarded
  reversal/cancellation.
- **A shareholder reads nothing from the register directly.** Their own data comes solely from the
  `getMyShareholding` function, so they can never query another shareholder.
- Managers get **register-level totals only** (`shareholders.reports.view`) — no contact or identity details.

### 2.15 After-hours operations & cash handovers
- Authorisations `RMX-AH-*` implemented **as Phase 2 temporary permissions** from a fixed allow-list —
  never permanent, never administrative or financial.
- Sessions `RMX-AHS-*` **tag** jobs, invoices and payments made through the *normal* flows — there is no parallel
  operations path and **no second ledger**.
- Policy-limited payment methods, max window, max float (`settings/after_hours_policy`).
- Cash-custody sub-ledger `RMX-AHC-*` (custody, not a financial account); **expected cash is server-calculated and
  frozen** at close.
- Handovers `RMX-HO-*` counted by a manager; **no revenue is recognised on handover**.
- Discrepancies `RMX-AHD-*` reviewed → resolved or waived, optionally raised as a loss incident
  (**with no automatic deduction**) or aligned to an existing adjustment.
- "Ending soon" notice 30 minutes before expiry; overdue-handover reminder.

### 2.16 Reports (10)
Executive summary, Money in and out (daily), Revenue, Payment methods, Outstanding & credit, Expenses, Inventory,
Workforce, Shareholders, After-hours. All:
- **server-calculated** — the client sends only a report name and a period, never a total;
- **doubly permission-filtered** — the report needs a permission, *and each section within it* needs the same
  permission as the screen that shows that data;
- **bounded** — ≤400-day period, ≤5,000 records per query, explicit `truncated` flag;
- EAT business-day periods with server-side validation;
- CSV export.

### 2.17 Notifications
- 40+ typed events across Phases 2–9.
- **Payloads carry a type and a record ID only — never a name, amount, plate, role or salary** (they appear on lock
  screens).
- De-duplication: one in-app record per `(recipient, type, record)` per window, via a **deterministic record ID
  written with `create()`** so a retried trigger cannot notify twice.
- Per-user preferences, but **critical notices cannot be muted** (access changes, personal pay, after-hours
  authorisation, cash discrepancies).
- Push outcome recorded on the in-app record for auditability; dead tokens pruned.
- Inactive/missing recipients skipped — except the "access turned off" notice itself.
- **Workers only ever receive notifications about themselves. Auditors receive none by default.**
- Sending is **server-side only**, always **after** the business transaction commits (`notifySafely` never throws
  into a transaction).

### 2.18 Audit trail
- `audit_logs` is **append-only for everyone, including Admins.** Amendments are new entries, never rewrites.
- Client-written entries are constrained by `hasOnly()` to exactly the fields the app owns, must carry
  `userId == request.auth.uid`, `userRole == role()`, `timestamp == request.time`, and **cannot** set
  `source: 'cloud_function'` or inject a reason/target.
- Phone numbers are masked in audit entries (`+256 772 •••456`).
- Every privileged action writes its audit entry **inside the same transaction** as the change.

### 2.19 Settings
Read-only reference data for all active users, written only by trusted server code:
`payroll_policy`, `share_policy`, `dividend_policy`, `after_hours_policy`, `loyalty`, `payment_accounts`
(names and masked numbers, **no balances**), plus threshold values.

### 2.20 Cross-cutting invariants
| Invariant | Enforcement |
|---|---|
| Nothing is deleted | Deactivate / cancel / reverse only |
| Financial history is immutable | Append-only ledgers + reversals |
| The client's cached balance is never the basis for a financial decision | Server total is authoritative |
| Money moves only inside a transaction that also writes the ledger and the audit entry | All 127 callables |
| Every sequence number is server-allocated | `counters/{name}`, no client access |
| Uniqueness is server-reserved | `unique_keys/*`, no client access |
| Retries are safe | `requestId` → `unique_keys/request_{id}`, bound to caller and request kind |
| Status changes refuse to run twice | "already approved", "already received" |

---

## 3. Firebase → Supabase equivalence map

| Firebase | Supabase | Migration character |
|---|---|---|
| Firebase Auth (Email/Password, hidden identity) | **Supabase Auth**, email provider, same hidden-identity scheme | Near-identical; see §7 |
| Custom token → `signInWithCustomToken` | Server-side sign-in in a Next.js Route Handler → session cookie | Mechanically different, same shape |
| `auth.createCustomToken` | `supabase.auth.admin.generateLink` / service-role `signInWithPassword` | Straightforward |
| `auth.revokeRefreshTokens` | `auth.admin.signOut(userId, 'global')` | 1:1 |
| Firestore documents | **PostgreSQL tables** | Reshape; see §6 |
| `firestore.rules` `hasPermission()` | **RLS policies** calling `app.has_permission(text)` | Clause-by-clause; see §9 |
| Callable Cloud Functions (127) | **PostgreSQL `SECURITY DEFINER` functions** (majority) + **Edge Functions** (minority) | Port; see §5 |
| `db.runTransaction` | Native PostgreSQL transactions — **strictly stronger** | Simplification |
| `FieldValue.serverTimestamp()` | `now()` / `clock_timestamp()` | 1:1 |
| `counters/{name}` (transactional counter docs) | **PostgreSQL sequences** or a `counters` table with `FOR UPDATE` | Simplification |
| `unique_keys/{kind_value}` (reservation docs) | **UNIQUE constraints** + a `request_keys` table for idempotency | Major simplification |
| `.snapshots()` listeners (108 sites) | **Supabase Realtime** on selected tables + TanStack Query | Selective; see §11 |
| Firestore offline persistence (100 MB) | **TanStack Query persisted cache** + service worker | Different mechanism, same policy; see §12 |
| Firebase Storage + storage rules | **Supabase Storage** + bucket RLS | Near-1:1; see §10 |
| FCM push | **Web Push (VAPID)** + in-app inbox via Realtime | Redesign; see §11 |
| `onSchedule` (2 scheduled functions) | **pg_cron** (or Vercel Cron → Edge Function) | 1:1 |
| Firebase Analytics (allow-listed events) | Vercel Analytics / PostHog, same allow-list | Optional, keep the allow-list |
| Crashlytics | Sentry, same "UID + role only" policy | Optional |
| Identity Toolkit REST password verify | Native — Postgres holds the hash | **Removes a whole moving part and a secret** |
| `RAMOSMAX_AUTH_API_KEY` secret | **No longer needed** | Eliminated |

### Things Supabase does *better* here
- **Real ACID transactions across arbitrary tables** — no 500-doc limits, no read-before-write restriction, no
  fan-out workarounds.
- **Real foreign keys, CHECK constraints and UNIQUE indexes** enforce invariants the Firestore version had to
  enforce in code (unique plates, non-negative stock, one payroll per period).
- **Real aggregate SQL** — the 10 reports become queries instead of bounded scans; the 400-day / 5,000-record
  caps become a *choice* rather than a necessity.
- `NUMERIC`/`BIGINT` for money instead of floats.

### Things that get *harder*
- **Offline reads.** Firestore's persistence layer is genuinely excellent and free. Supabase has no equivalent;
  §12 describes the replacement.
- **Push on iOS Safari** requires the user to install the PWA to the home screen.
- **Realtime fan-out** is per-table and coarser than Firestore's per-query listeners.

---

## 4. Flutter screens → Next.js routes

76 screens. App Router, one route group per audience, `(app)` under an authenticated responsive shell.

### 4.1 Public / auth
| Flutter | Next.js route |
|---|---|
| `SplashScreen` | `app/loading.tsx` + middleware redirect |
| `LoginScreen` | `/(auth)/login` |
| `ChangePasswordScreen` | `/(auth)/change-password` (forced + voluntary) |
| `AccessDeniedScreen` | `/(app)/access-denied` |
| `ModuleNotAvailableScreen` | `app/(app)/[...module]/page.tsx` catch-all |

### 4.2 Core operations
| Flutter | Next.js route |
|---|---|
| `DashboardHomeScreen` | `/(app)` |
| `VehicleSearchScreen` | `/(app)/vehicles` |
| `VehicleSearchScreen(intakeMode: true)` | `/(app)/new-service` |
| `VehicleDetailScreen` / `VehicleFormScreen` | `/(app)/vehicles/[vehicleId]` · `/new` · `/[vehicleId]/edit` |
| `StartServiceScreen` | `/(app)/vehicles/[vehicleId]/start` |
| `CustomersScreen` / detail / form | `/(app)/customers` · `/[customerId]` · `/new` · `/[customerId]/edit` |
| `ServicesScreen` / `ServiceFormScreen` | `/(app)/services` · `/new` · `/[serviceId]` |
| `IntakesScreen` / `IntakeDetailScreen` | `/(app)/jobs` · `/jobs/[intakeId]` |
| `MyJobsScreen` | `/(app)/my-jobs` |

### 4.3 Billing & loyalty
| Flutter | Next.js route |
|---|---|
| `InvoicesScreen` / `InvoiceDetailScreen` | `/(app)/invoices` · `/invoices/[invoiceId]` |
| `PaymentsScreen` | `/(app)/payments` |
| `ReceiptsScreen` / `ReceiptScreen` | `/(app)/receipts` · `/receipts/[receiptId]` |
| `CreditScreen` | `/(app)/credit` |
| `LoyaltyScreen` / `VehicleLoyaltyScreen` | `/(app)/loyalty` · `/loyalty/[vehicleId]` |

### 4.4 Finance
| Flutter | Next.js route |
|---|---|
| `FinanceDashboardScreen` | `/(app)/finance` and `/(app)/financial-summary` |
| `AccountsScreen` / `AccountDetailScreen` | `/(app)/finance/accounts` · `/accounts/[accountId]` |
| `TransactionsScreen` / `TransactionDetailScreen` | `/(app)/finance/transactions` · `/transactions/[transactionId]` (+ standalone `/transactions`) |
| `TransfersScreen` | `/(app)/finance/transfers` |
| `BankingScreen` | `/(app)/finance/banking` |
| `ReconciliationScreen` | `/(app)/finance/reconciliation` (+ standalone `/reconciliation`) |
| `FinanceReportsScreen` | `/(app)/finance/reports` |

### 4.5 Expenses & inventory
| Flutter | Next.js route |
|---|---|
| `ExpensesScreen` / detail / form | `/(app)/expenses` · `/new` · `/[expenseId]` · `/[expenseId]/edit` |
| `InventoryScreen` | `/(app)/inventory` |
| `ItemDetailScreen` / `ItemFormScreen` | `/(app)/inventory/items/[itemId]` · `/items/new` · `/items/[itemId]/edit` |
| `SupplierDetailScreen` | `/(app)/inventory/suppliers/[supplierId]` |
| `PurchaseFormScreen` / `PurchaseDetailScreen` | `/(app)/inventory/purchases/new` · `/purchases/[purchaseId]` |

### 4.6 Workforce
| Flutter | Next.js route |
|---|---|
| `AttendanceScreen` / `AttendanceDetailScreen` | `/(app)/attendance` · `/attendance/[attendanceId]` |
| `AllowancesScreen` / `MyPayScreen` | `/(app)/allowances` |
| `PayrollScreen` / `PayrollDetailScreen` | `/(app)/payroll` · `/payroll/run/[payrollId]` |
| `SalaryDetailScreen` | `/(app)/payroll/salary/[staffUid]` |
| `DeductionDetailScreen` | `/(app)/payroll/deduction/[deductionId]` |
| `LossesScreen` / `LossDetailScreen` | `/(app)/losses` · `/losses/[incidentId]` |

### 4.7 Shareholding
| Flutter | Next.js route |
|---|---|
| `ShareholdersScreen` / detail / form | `/(app)/shareholders` · `/new` · `/[shareholderId]` · `/[shareholderId]/edit` |
| `SharesScreen` / `ShareTransactionDetailScreen` | `/(app)/shares` · `/shares/txn/[transactionId]` |
| `DividendsScreen` / `DividendDetailScreen` | `/(app)/dividends` · `/dividends/[dividendId]` |
| `MyShareholdingScreen` | `/(app)/my-shares` |

### 4.8 After-hours
| Flutter | Next.js route |
|---|---|
| `AfterHoursScreen` | `/(app)/after-hours` |
| `AfterHoursSessionScreen` | `/(app)/after-hours/session/[sessionId]` |
| `CashHandoverScreen` | `/(app)/after-hours/handover/[handoverId]` |
| `CashDiscrepancyScreen` | `/(app)/after-hours/discrepancy/[discrepancyId]` |
| `MyAfterHoursScreen` + own variants | `/(app)/my-after-hours` and `/my-after-hours/*` (`mine: true` → separate segment, same components) |

### 4.9 Administration & platform
| Flutter | Next.js route |
|---|---|
| `UsersScreen` / detail / form | `/(app)/users` · `/new` · `/[uid]` · `/[uid]/edit` |
| `UserPermissionsScreen` | `/(app)/users/[uid]/permissions` |
| `ReportsScreen` | `/(app)/reports` (+ `/performance` → executive) |
| `AuditLogScreen` | `/(app)/audit` |
| `SettingsScreen` | `/(app)/settings` |
| `NotificationsScreen` / `NotificationSettingsScreen` | `/(app)/notifications` · `/notifications/settings` |
| `MyProfileScreen` | `/(app)/profile` |
| (own-password change) | `/(app)/profile/password` |

**Preserved exactly:** the go_router path structure, the `ModuleNotAvailableScreen` catch-all (`:module`), and the
per-role menus in `RoleNavigation` — which become a single permission-driven navigation config consumed by both
the desktop sidebar and the mobile drawer.

---

## 5. Where business logic goes

The governing rule stays what it is today: **the client never computes a number that matters, and never writes a
row directly.**

### 5.1 PostgreSQL functions (`SECURITY DEFINER`) — the default, ~95 of 127 callables

Everything that is "validate → read → compute → write several rows + ledger + audit, atomically" becomes a
PL/pgSQL function in a private `api` schema, called via PostgREST RPC. The Firestore transaction *becomes* the
Postgres transaction, which is strictly stronger.

| Module | Representative RPCs |
|---|---|
| Users & access | `create_user`, `set_user_role`, `set_user_permissions`, `grant_temporary_permission`, `revoke_temporary_permission`, `set_user_active`, `link_staff` |
| Operations | `create_customer`, `create_vehicle`, `create_service`, `create_service_intake`, `assign_worker_order`, `update_worker_order_status` |
| Billing | `create_invoice`, `apply_invoice_discount`, `record_payment`, `reverse_payment`, `mark_invoice_credit`, `cancel_invoice`, `apply_loyalty_reward` |
| Loyalty | `adjust_loyalty_points`, `reverse_loyalty_transaction` |
| Finance | `transfer_funds`, `record_bank_deposit`, `reconcile_account`, `record_account_adjustment`, `reverse_financial_transaction`, `record_opening_balance` |
| Expenses | `create_expense`, `update_expense_status`, `pay_expense`, `create_recurring_expense` |
| Inventory | `record_stock_movement`, `adjust_stock`, `receive_purchase`, `pay_purchase`, `reverse_stock_movement` |
| Workforce | `record_attendance`, `clock_out`, `verify_attendance`, `correct_attendance`, `calculate_allowances`, `review_allowance`, `pay_allowances` |
| Payroll | `set_salary_profile`, `prepare_payroll`, `update_payroll_status`, `pay_payroll`, `reverse_payroll_payment`, `lock_payroll`, `correct_payroll` |
| Losses | `create_loss_incident`, `decide_loss_incident`, `schedule_loss_recovery`, `decide_salary_deduction` |
| Shares | `issue_shares`, `transfer_shares`, `adjust_shares`, `decide_share_transaction`, `record_share_contribution`, `reverse_share_transaction` |
| Dividends | `create_dividend`, `calculate_dividend`, `update_dividend_status`, `pay_dividend`, `reverse_dividend_payment` |
| After-hours | `authorize_after_hours`, `open_after_hours_session`, `close_after_hours_session`, `submit_cash_handover`, `receive_cash_handover`, `review_cash_discrepancy`, `resolve_cash_discrepancy` |

**Why `SECURITY DEFINER` and not RLS-only writes:** it exactly reproduces today's posture. Tables are
**`INSERT`/`UPDATE`/`DELETE`-denied to `authenticated`**; only the definer functions write. Every function begins
with the same three lines the Cloud Functions begin with today:

```sql
PERFORM app.require_active();                          -- isActive()
PERFORM app.require_permission('payments.record');     -- requirePermission()
PERFORM app.claim_request(p_request_id, 'record_payment');  -- idempotency
```

and ends with `PERFORM app.audit(...)` inside the same transaction.

### 5.2 Edge Functions (Deno/TS) — the minority

Only where Postgres is the wrong tool:

| Need | Why not PL/pgSQL |
|---|---|
| `sign_in_with_phone_password` | Must mint a session and talk to GoTrue |
| `change_own_password` | Must call the Auth admin API and revoke sessions |
| `create_user` / `reset_user_password` (auth half) | Must create the GoTrue user; the profile half stays a DB function called in the same request |
| Web Push dispatch | Outbound HTTP + VAPID signing |
| CSV export streaming | Streaming response for large reports |
| Scheduled sweeps | Can also be pg_cron; Edge Function if push dispatch is involved |

**Pattern for the auth-touching ones:** Edge Function performs the Auth-side effect, then calls a single DB
function for all business state, so the business rules still live in exactly one place.

### 5.3 Server-side Next.js

Route Handlers and Server Actions, and **nothing else**:
- session cookie management and `middleware.ts` route protection;
- proxying RPC/Edge calls so the service-role key never reaches the browser;
- server-rendered read pages (lists, detail pages) using the user's own token, so RLS applies;
- CSV download endpoints.

**Explicitly not in Next.js:** any calculation of money, points, ownership %, lateness, payroll, expected cash, or
permission outcomes. Next.js is a transport and a view layer, exactly as the Flutter app is today.

### 5.4 Scheduled work (pg_cron)
| Today | Schedule | Becomes |
|---|---|---|
| `sweepRecurringExpenses` | daily 06:00 Africa/Kampala | `cron.schedule('0 3 * * *', 'SELECT app.sweep_recurring_expenses()')` (03:00 UTC = 06:00 EAT) |
| `sweepTemporaryGrants` + `sweepAfterHours` | every 15 min | `cron.schedule('*/15 * * * *', …)` |

**Note:** temporary grants expire by *time comparison*, not by the sweep. The sweep is housekeeping and
"ending soon" notices only. That property must be preserved — never make expiry depend on the cron job.

---

## 6. Supabase database schema

~60 collections → ~65 tables. Conventions first, because they encode business rules.

### 6.1 Conventions
| Concern | Decision |
|---|---|
| Money | **`BIGINT` whole Ugandan shillings.** Never float. Matches today's whole-UGX rule. `CHECK (amount_ugx >= 0)` wherever applicable |
| Timestamps | `TIMESTAMPTZ`, always `now()` server-side. Never a client clock |
| Business days | `DATE` in `Africa/Kampala`; helper `app.eat_day(ts)` |
| IDs | `UUID` primary keys + a separate **human reference** column (`RMX-INV-000123`), `UNIQUE`, from a sequence |
| Sequences | `CREATE SEQUENCE` per prefix, replacing `counters/*` |
| Uniqueness | Real `UNIQUE` indexes, replacing `unique_keys/*` (e.g. `UNIQUE (normalized_plate)`) |
| Idempotency | `app.request_keys(request_id TEXT, actor UUID, kind TEXT, result JSONB, PRIMARY KEY(request_id))`, claimed inside the transaction |
| Immutability | `BEFORE UPDATE OR DELETE` triggers raising on append-only tables (ledgers, audit, corrections) |
| Soft state | `status` enums + `active BOOLEAN`. **No hard deletes anywhere** |
| Audit | Every write function calls `app.audit(...)` in-transaction |

### 6.2 Tables by domain

**Identity & access**
`users` (mirrors `auth.users` 1:1 by id: `role`, `active`, `phone_number`, `full_name`, `staff_id`,
`must_change_password`, `access_expires_at`, `permissions TEXT[]`, `denied_permissions TEXT[]`,
`notification_preferences JSONB`, `last_login_at`) ·
`temporary_grants` (`user_id`, `permission`, `starts_at`, `expires_at`, `grant_id`, `reason`, `granted_by`,
`revoked_at`) — **normalised out of the `temporaryPermissions` map, which is the right relational shape** ·
`staff` · `staff_documents` · `login_throttle` (`phone_hash` PK)

**Customers & vehicles**
`customers` (`UNIQUE (phone_e164)`) · `vehicles` (`UNIQUE (normalized_plate)`, `customer_id FK`)

**Operations**
`services` (`UNIQUE (lower(name))`) · `service_intakes` · `worker_orders` (`intake_id`, `service_id`,
`worker_id`, `status`) · `worker_order_history`

**Billing & loyalty**
`invoices` · `invoice_items` · `discounts` · `payments` (`request_id` unique) · `receipts` ·
`loyalty_accounts` (PK `vehicle_id`) · `loyalty_transactions` (append-only) · `loyalty_rewards` · `loyalty_events`

**Finance**
`financial_accounts` (`balance_ugx`, `cash_awaiting_banking_ugx`) ·
**`financial_transactions`** (append-only ledger, `reverses_id` self-FK, `reversed_by_id`) ·
`finance_daily_summaries` (PK `business_day`) · `bank_deposits` · `reconciliations`

**Expenses**
`expense_categories` · `expenses` · `recurring_expenses`

**Inventory**
`inventory_items` (`quantity`, `CHECK (quantity >= 0)` — the "stock never goes negative" rule becomes a database
constraint) · `suppliers` · `inventory_purchases` · `purchase_items` · `stock_movements` (append-only)

**Workforce**
`attendance` (`UNIQUE (staff_uid, business_day)`, `policy_snapshot JSONB`) ·
`attendance_corrections` (append-only) · `worker_allowances` ·
`salary_profiles` (PK `staff_uid`) · `salary_history` (`UNIQUE (staff_uid, version)`, append-only) ·
`payroll` (`UNIQUE (frequency, period_key) WHERE status <> 'cancelled'` — one payroll per period as a constraint) ·
`payroll_items` (`UNIQUE (payroll_id, version, staff_uid)`, `visible_to_staff`) ·
`salary_deductions` · `loss_incidents` (`visible_to_staff`)

**Shareholding**
`shareholders` · `share_classes` · `shareholdings` (`UNIQUE (shareholder_id, class_id)`) ·
`share_transactions` (append-only ownership ledger) · `share_contributions` ·
`share_register` (singleton `current`) · `dividends` · `dividend_allocations` (frozen at calculation)

**After-hours**
`after_hours_access` · `after_hours_sessions` · `after_hours_cash` (custody sub-ledger, append-only) ·
`cash_handovers` · `cash_discrepancies`

**Platform**
`notifications` (`UNIQUE (recipient_id, type, record_id, dedupe_window)` — de-duplication as a constraint) ·
`audit_logs` (append-only, update/delete trigger-blocked) · `settings` (key/JSONB) ·
`app.request_keys` · `notification_devices` (Web Push subscriptions, replacing `fcmTokens`)

### 6.3 Invariants that become database constraints
Rules previously enforced only in code, now also enforced by Postgres — belt and braces:

| Rule | Constraint |
|---|---|
| Stock never negative | `CHECK (quantity >= 0)` |
| Net pay never negative | `CHECK (net_pay_ugx >= 0)` |
| One attendance record per person per day | `UNIQUE (staff_uid, business_day)` |
| One open job per vehicle | partial `UNIQUE (vehicle_id) WHERE status = 'open'` |
| One payroll per period | partial `UNIQUE (frequency, period_key)` |
| Unique plates / customer phones / service names | `UNIQUE` indexes |
| Ledgers and audit immutable | `BEFORE UPDATE OR DELETE` triggers |
| Payment idempotency | `UNIQUE (request_id)` |
| Notification de-duplication | `UNIQUE (recipient_id, type, record_id, window)` |

### 6.4 Data migration
**Not in scope now, and deliberately last.** When it happens: export Firestore → transform → load into a
*staging* Supabase project → reconcile ledger totals, balances, stock, ownership % and outstanding credit against
Firebase → only then cut over. **The Firebase production project is never written to.**

---

## 7. Authentication migration

The existing scheme ports almost exactly, and gets *simpler*.

### 7.1 Keep unchanged
- Phone number + password; nobody types an email.
- **Hidden sign-in identity** `{uuid}@users.ramosmax.invalid` in `auth.users.email`, email confirmation disabled,
  no mail provider configured. Reserved-domain property preserved.
- Phone normalisation (`normalizePhone`) ported verbatim — Uganda `+256[347]xxxxxxxx`, others strict E.164.
- Password policy ported verbatim from `passwords.js` (shared TS module, server authoritative, client mirrors for UX).
- Generated temporary passwords: 12 chars, CSPRNG, no look-alikes.
- `must_change_password` blocks everything (it fails `app.is_active()`, so RLS denies all reads/writes except own
  profile) — **unchanged semantics**.
- `access_expires_at` account-level expiry.
- Uniform "Incorrect phone number or password." for every failure.
- Throttle: 5 failures / 15 min per `sha256("ramosmax:" + phone)`, 15-min lock-out.
- Audit entries for sign-in, failed sign-in, password change.
- Session revocation on password change.

### 7.2 The flow
```
POST /api/auth/sign-in  (Next.js Route Handler)
  → normalise phone
  → app.check_throttle(phone_hash)                 [DB function]
  → look up users.phone_number → auth user id → hidden email
  → supabase.auth.signInWithPassword(hidden_email, password)
  → on failure: app.record_failure(phone_hash); audit; generic error
  → on success: app.assert_account_enabled(uid)    [role known, active, not expired]
  → set sb-access-token / sb-refresh-token httpOnly cookies
  → return { mustChangePassword }
```
`middleware.ts` refreshes the session on every request and redirects: unauthenticated → `/login`;
`must_change_password` → `/change-password`; inactive/expired → `/access-denied`.

### 7.3 What improves
- **The `RAMOSMAX_AUTH_API_KEY` secret and the Identity Toolkit REST round-trip disappear.** Supabase verifies the
  password natively. One fewer secret, one fewer external dependency, one fewer failure mode.
- Sessions become httpOnly cookies — **not reachable from JavaScript**, which is stronger than a mobile token store.

### 7.4 Risks to manage
| Risk | Mitigation |
|---|---|
| **Password hashes cannot be exported from Firebase** in a form Supabase accepts (Firebase uses scrypt with a project-specific signer key) | **Every user gets a new temporary password at cutover**, distributed by an Admin, with `must_change_password = true`. This flow already exists and is already tested — it is the normal provisioning path, not a new mechanism. Confirm this is acceptable operationally. |
| Firebase UIDs vs Supabase UUIDs | Preserve the Firebase UID as `users.legacy_uid` for audit-trail continuity; use new UUIDs as PKs |
| Browser session on shared kiosks | Short access-token TTL + idle timeout + explicit "Sign out" that clears the Web Push subscription (mirrors today's FCM token removal on sign-out) |

---

## 8. Roles & permissions architecture

**The model is preserved exactly.** The only change is where the catalogue lives.

### 8.1 One catalogue, three consumers
Today: Dart enum ↔ `firestore.rules` ↔ `access_catalog.json`, kept in sync by a test that fails on drift.

Proposed: **the database is the single source of truth.**
- `app.permissions` table (key, label, group, is_admin_only, is_authorization_only)
- `app.role_permissions` table (role, permission)
- TypeScript types **generated** from the database (`supabase gen types`), so the UI cannot reference a
  permission that does not exist — a compile-time guarantee stronger than today's runtime drift test.
- The drift test is retained anyway, comparing the seeded catalogue against a checked-in snapshot, so an
  *unintended* catalogue change fails CI.

### 8.2 Resolution — identical semantics
```sql
CREATE FUNCTION app.effective_permissions(uid UUID) RETURNS TEXT[] AS $$
  -- (role defaults ∪ direct grants ∪ live temporary grants) − denials
  -- empty for inactive, expired, or must_change_password accounts
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE FUNCTION app.has_permission(perm TEXT) RETURNS BOOLEAN AS $$
  SELECT perm = ANY(app.effective_permissions(auth.uid()));
$$ LANGUAGE sql STABLE SECURITY DEFINER;
```
A temporary grant is live when `starts_at <= now() AND expires_at > now()` — **expiry by time comparison, never by
a cleanup job**, exactly as today.

### 8.3 Preserved guards
`require_can_administer` · `require_can_assign_role` · `require_can_grant` (cannot grant what you do not hold) ·
`require_can_reset_password` (Managers → Workers only) · `require_not_self` · admin-only permission set ·
authorization-only permission set · last-Admin protection · "Admins always keep user-management access."

### 8.4 Client side
`usePermissions()` hook + `<Can permission="payments.record">` component, driving what the UI shows —
**a convenience, never a control**, stated as plainly in the new code as it is in the current code.

### 8.5 Performance
`effective_permissions` is called by many RLS policies. Mitigations: mark `STABLE` so it is cached per statement;
cache the array in a request-scoped GUC (`app.current_permissions`) set once per transaction; index
`temporary_grants (user_id, expires_at)`. Benchmark early — this is the one place where a faithful translation
could cost more than Firestore's `get()` caching.

---

## 9. RLS policies

Translation is mechanical because the source rules are so uniform.

### 9.1 Global posture
```sql
ALTER TABLE <every_table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <every_table> FORCE ROW LEVEL SECURITY;
REVOKE ALL ON <every_table> FROM anon, authenticated;
GRANT SELECT ON <readable_tables> TO authenticated;   -- SELECT only; no INSERT/UPDATE/DELETE grants
```
**No `authenticated` role holds write privileges on any business table.** Writes exist only through
`SECURITY DEFINER` functions. This reproduces `allow write: if false` exactly, and there is no default-allow
anywhere — an unlisted table is unreachable, matching the current `match /{document=**} { allow read, write: if false; }`.

### 9.2 Helper functions
```sql
app.is_signed_in()    app.is_active()    app.current_role()    app.is_admin()
app.has_permission(text)    app.has_either_permission(text, text)
app.own_with(text, uuid)   -- resource.staffUid == uid AND has_permission(p)
```
`app.is_active()` reproduces `isActive()` precisely: profile exists **AND** `active = true` **AND**
`must_change_password IS DISTINCT FROM true` **AND** (`access_expires_at IS NULL OR access_expires_at > now()`).

### 9.3 Representative policies (direct translations)

```sql
-- customers: allow get, list: if hasPermission('customers.view')
CREATE POLICY customers_read ON customers FOR SELECT TO authenticated
  USING (app.has_permission('customers.view'));

-- worker_orders: jobs.view OR (jobs.view.own AND workerId == uid)
CREATE POLICY worker_orders_read ON worker_orders FOR SELECT TO authenticated
  USING (app.has_permission('jobs.view')
      OR (app.has_permission('jobs.view.own') AND worker_id = auth.uid()));

-- payroll_items: own payslip only once paid
CREATE POLICY payroll_items_read ON payroll_items FOR SELECT TO authenticated
  USING ((visible_to_staff AND app.own_with('payroll.view.own', staff_uid))
      OR app.has_permission('payroll.view'));

-- loss_incidents: subject sees it only once decided
CREATE POLICY loss_incidents_read ON loss_incidents FOR SELECT TO authenticated
  USING ((visible_to_staff AND app.own_with('payroll.view.own', staff_uid))
      OR app.has_permission('losses.view'));

-- notifications: recipient only; may mark own read
CREATE POLICY notifications_read ON notifications FOR SELECT TO authenticated
  USING (app.is_active() AND recipient_id = auth.uid());
CREATE POLICY notifications_mark_read ON notifications FOR UPDATE TO authenticated
  USING (app.is_active() AND recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());
-- + BEFORE UPDATE trigger: only read, read_at, updated_at may change

-- audit_logs: append-only for everyone, including admins
CREATE POLICY audit_read ON audit_logs FOR SELECT TO authenticated
  USING (app.has_permission('audit.view'));
CREATE POLICY audit_append ON audit_logs FOR INSERT TO authenticated
  WITH CHECK (app.is_active() AND user_id = auth.uid()
              AND user_role = app.current_role() AND source = 'client');
-- NO update/delete policy exists, and a trigger raises on both.

-- users: self, or users.view; self-update limited to session bookkeeping
CREATE POLICY users_read ON users FOR SELECT TO authenticated
  USING (id = auth.uid() OR app.has_permission('users.view'));
CREATE POLICY users_self_update ON users FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());
-- + BEFORE UPDATE trigger enforcing the column allow-list AND equality of
--   role, active, permissions, denied_permissions (belt and braces, as today)

-- settings: readable by any active user
CREATE POLICY settings_read ON settings FOR SELECT TO authenticated
  USING (app.is_active());
```

### 9.4 Shareholder self-service — the one that must not be got wrong
Today a shareholder reads **nothing** from the register; their data comes only from `getMyShareholding`.
Preserved exactly: **no SELECT policy on `shareholders`, `shareholdings`, `share_transactions`,
`share_contributions`, `dividend_allocations` grants anything for `shareholders.view.own`.** That permission
authorises exactly one RPC, `app.get_my_shareholding()`, which returns only rows linked to the caller.

### 9.5 Field-level exposure
Firestore rules are document-level; Postgres RLS is row-level. Two places need **column** control:
- **`settings/payment_accounts`** — names and masked numbers only, never balances.
- **Manager view of shareholders** — register totals only, no contact or identity details.

Handled with **restricted views** (`shareholders_register_v`, `payment_accounts_v`) that expose only the permitted
columns, with `SELECT` granted on the view and not on the base table. This is *stricter* than today.

### 9.6 Rules-test parity
`functions/test/rules.test.js` and `storage_rules.test.js` — which prove that a **modified client** cannot write
any server-owned collection — port to pgTAP tests asserting the same denials per table. This is a required
deliverable, not optional.

---

## 10. File & storage requirements

Seven path families, ported 1:1 to Supabase Storage buckets, **all private, none public**.

| Current path | Bucket / prefix | Read | Write | Limits |
|---|---|---|---|---|
| `staff/{staffId}/profile/{file}` | `staff/profile/` | any active user | admin, manager | image/*, <5 MB |
| `staff/{staffId}/documents/{cat}/{file}` | `staff/documents/` | **admin only** | admin | image/* or PDF, <10 MB, **no delete** |
| `expenses/{expenseId}/receipts/{file}` | `expenses/` | admin, manager, auditor | admin, manager | <10 MB, **create only** |
| `inventory/{itemId}/documents/{file}` | `inventory/` | admin, manager, auditor | admin, manager | <10 MB, **create only** |
| `finance_uploads/{kind}/{id}/{file}` | `finance/` | admin, manager, auditor | admin, manager, cashier | kind ∈ {deposits, reconciliations, expenses, purchases}, <10 MB |
| `payroll_uploads/{kind}/{id}/{file}` | `payroll/` | admin, manager, auditor | admin, manager | kind ∈ {attendance, losses, payroll}, <10 MB, **never cashier/worker/shareholder** |
| `business/{category}/{file}` | `business/` | admin, manager, auditor, shareholder | admin | <20 MB |

**Preserved invariants**
- **Evidence is never replaced or deleted** — no UPDATE or DELETE policy on any evidence bucket.
- **Upload precedes the write.** The file is uploaded first; the RPC then accepts only a path under the expected
  prefix (`requireProfilePhotoPath`-style validation ported for each kind). Orphaned uploads are swept, never
  auto-attached.
- Storage and the database share **one source of truth** for who is active — the current storage rules already
  cross-read the Firestore profile; RLS on `storage.objects` calls the same `app.has_role()` / `app.is_active()`.
- **Default deny** on everything else.

**Web-specific additions**
- Client-side image compression before upload (phone cameras produce 5–12 MB files; the 5 MB profile-photo cap is
  otherwise hostile on mobile).
- Signed URLs with short TTL for viewing; never public URLs.
- `<input capture="environment">` so a phone opens the camera directly for receipt capture.
- Resumable uploads (TUS) for poor connections.

---

## 11. Realtime requirements

108 `.snapshots()` call sites today. **Do not translate all 108 into Realtime subscriptions** — that is both
expensive and unnecessary; most are list screens that a refetch serves better.

### 11.1 Three tiers

**Tier 1 — genuine Realtime (Supabase Realtime, `postgres_changes`)**
Things where a stale screen causes a *business* problem:
| Table | Filter | Why |
|---|---|---|
| `notifications` | `recipient_id = uid` | The inbox must be live; also drives the unread badge |
| `worker_orders` | `worker_id = uid` | A worker must see a newly assigned job without refreshing |
| `service_intakes` | open jobs | The job board is a shared operational screen |
| `after_hours_sessions`, `cash_handovers`, `cash_discrepancies` | session/actor | Two people act on the same handover in sequence, often minutes apart |
| `users` | `id = uid` | **Critical:** permission and role changes, and after-hours authorisations, must take effect immediately — including *revocation* |
| `financial_accounts` | all | Balance shown on the finance dashboard |

**Tier 2 — TanStack Query with short `staleTime` + refetch on window focus**
Invoices, payments, receipts, expenses, inventory, attendance, allowances, customers, vehicles, services, audit
logs. These are list/detail screens where a 30-second staleness is harmless and focus-refetch covers the real case
(user switches tab and comes back).

**Tier 3 — on-demand only**
Reports, `getOwnershipAsOf`, `getMyShareholding`, payroll runs. Explicit fetch, no subscription. This already
matches the current design (reports are online-only function calls).

### 11.2 Realtime + RLS
Supabase Realtime respects RLS, so a worker's subscription to `worker_orders` returns only their own rows — the
same guarantee the Firestore rules give today. **This must be explicitly tested**, per table, with a wrong-role
subscriber.

### 11.3 Permission revocation
The `users` row subscription is a security feature: when a temporary grant is revoked or an account deactivated,
the client must re-evaluate immediately — invalidate the permission cache, re-render navigation, and if the
current route is no longer permitted, redirect to `/access-denied`. RLS enforces it server-side regardless, but
the UI must not keep showing a button that will now fail.

---

## 12. Notification strategy for the web

FCM-to-mobile does not carry over. The replacement has three layers.

### 12.1 In-app inbox — primary, and unchanged in substance
The `notifications` table plus a Realtime subscription. **Every notice is always written here, regardless of push
preferences** — exactly as today. Unread badge, inbox page, mark-read, mark-all-read, deep-link from a notice to
its record. This alone preserves 100% of the notification *information*; push is a delivery optimisation.

### 12.2 Web Push (VAPID) — for when the tab is closed
- Service worker + `PushManager`, subscriptions stored in `notification_devices` (replacing `fcmTokens`).
- Dispatched from an Edge Function **after** the business transaction commits (`notifySafely` semantics: a push
  failure must never roll back or block a business write).
- Dead subscriptions pruned on 404/410 — same as today's dead-token pruning.
- Subscription removed on sign-out — same as today's FCM token removal, and important for shared machines.
- **Platform reality:** Chrome/Edge/Firefox on desktop and Android work well. **iOS Safari requires the PWA to be
  installed to the home screen** (iOS 16.4+). So the app must be an installable PWA, and iOS users must be told to
  "Add to Home Screen." This is a genuine regression from a native app and should be a conscious decision.

### 12.3 Optional third channel
For the small set of genuinely time-critical notices (cash discrepancy, after-hours expiring, account
deactivated), an SMS fallback via the same provider you eventually use for the staged `loyalty_events` customer
messaging. **Recommended as a later phase, not part of the migration.**

### 12.4 Preserved exactly
- Payloads carry **a type and a record ID only** — never a name, amount, plate, role or salary. Web Push payloads
  appear on lock screens too, so this matters just as much.
- De-duplication per `(recipient, type, record, window)` — now a `UNIQUE` constraint rather than a deterministic
  document ID, which is stronger.
- Preferences with **always-on critical categories** (access changes, personal pay, after-hours authorisation,
  cash discrepancies).
- Delivery outcome recorded on the in-app record for auditability.
- Inactive/missing recipients skipped, except the "access turned off" notice itself.
- Workers receive notices about themselves only; Auditors receive none by default.
- All 40+ event types and all recipient-selection rules.

---

## 13. Offline & poor-network considerations

This is where the platform change costs the most, and the policy is worth restating because it is *unusually
well-judged* in the current system:

> **Operational reads work offline; money movements do not. Nothing is ever queued.**

That policy is not a limitation to fix — it is a deliberate financial control. An offline device must never post
against a stale balance or a stale stock level, and an offline clock-in must never be back-dated. **Preserve it
verbatim.**

### 13.1 What must be preserved
| Property | How |
|---|---|
| Cached reads keep working | TanStack Query with `persistQueryClient` → IndexedDB; service worker (Workbox) with stale-while-revalidate for app shell and API GETs |
| **No write is ever queued** | Every mutation goes through a `runOnline()` equivalent that checks `navigator.onLine` **and** performs a real request; on failure it reports, never enqueues. **No Background Sync API for money.** |
| The offline banner | "Offline — showing saved data. Payments and other financial actions need a connection." Ported word for word |
| Idempotency on retry | `requestId` generated **once per form instance** (not per attempt) and reused — identical to today |
| **"May already have been saved"** | On timeout/abort, the message is *never* "failed". This is the single most important UX rule in the offline doc and must be ported exactly |
| Session survives offline | Cached profile → straight to dashboard; if the profile is not cached, show `AwaitingConnection`, **never** "not registered" |
| Mark-read may queue | The one harmless field update that is allowed to reconcile later |
| Reports are online-only | The screen says a connection is needed and requests nothing |

### 13.2 Where web is weaker
- Firestore's persistence is automatic and query-aware; TanStack Query's cache is per-query-key. **Cached
  number-plate search over offline vehicles needs explicit work** — pre-fetch and store the active vehicle list in
  IndexedDB and search it client-side. This is the one offline feature that needs real engineering, not
  configuration.
- A browser can evict IndexedDB under storage pressure. Request persistent storage
  (`navigator.storage.persist()`); degrade to "connection needed" rather than showing wrong data.

### 13.3 Where web is stronger
- Poor-network *online* behaviour improves: server-side rendering means a slow connection still gets a usable page
  quickly, where the Flutter app must complete a round-trip per listener.

---

## 14. Responsive UI architecture

Mobile is **not** an afterthought here: cashiers and workers will use phone browsers, in sunlight, one-handed,
sometimes with wet hands. Treat phone as the primary target and desktop as the enhancement.

### 14.1 Breakpoints
| Token | Width | Primary users |
|---|---|---|
| `base` | <640 px | **Workers, cashiers on the forecourt — design here first** |
| `sm/md` | 640–1024 px | Tablets, managers walking the site |
| `lg` | 1024–1440 px | Laptops — managers, admins |
| `xl` | >1440 px | Desktop — finance, payroll, reports |

### 14.2 Shell
One `AppShell` with three navigation presentations over **one permission-filtered navigation config** (ported from
`RoleNavigation`):
- **Phone:** bottom tab bar with the 4–5 top actions for that role, plus a slide-over drawer for the rest.
  Sticky primary action button. Back navigation always visible.
- **Tablet:** collapsible icon rail.
- **Desktop:** persistent sidebar with grouped sections, plus a command palette (`⌘K`) for the 76 destinations.

### 14.3 Data-dense screens — the hard part
The ledger, payroll runs, share transactions and reports are wide tables. A horizontally scrolling table on a
phone is a failure.
- **Phone:** each row becomes a **card** — primary identifier, amount, status chip, date; tap for detail. Filters
  in a bottom sheet, not a toolbar.
- **Tablet+:** real table with sticky header, sticky first column, column visibility control.
- One `<DataView>` component takes columns + a card renderer and switches on breakpoint, so a screen is written
  once. **This component is the single highest-leverage piece of the whole UI build** and should be built first.

### 14.4 Forms
- Single column on phone, two columns from `md`.
- `inputMode="numeric"` on money fields; UGX formatting as you type.
- Sticky submit bar above the keyboard.
- Multi-step flows (service intake, payroll, handover) become a wizard on phone and a single page on desktop.
- 44×44 px minimum touch targets throughout.

### 14.5 Rendering strategy
- **Server Components** for list and detail pages — the query runs on the server under the user's own token, so
  RLS applies and the phone downloads HTML rather than a JSON payload plus a rendering pass.
- **Client Components** only for interactive islands: forms, filters, Realtime subscribers, the inbox.
- Route-level code splitting so a Worker never downloads the payroll or finance bundles.
- `next/dynamic` for heavy pieces (charts, CSV export, report renderers).

### 14.6 Non-negotiables
Dark mode (sunlight/glare), WCAG AA contrast, full keyboard navigation for desktop finance work, `prefers-reduced-motion`,
skeletons rather than spinners, and an installable PWA manifest (required for iOS push anyway).

### 14.7 Stack
Tailwind CSS + shadcn/ui (Radix primitives — accessible by construction) · TanStack Query (server state) ·
`react-hook-form` + Zod (Zod schemas **shared with the server**, so client validation can never diverge from server
validation — a real improvement over today's hand-mirrored Dart/JS validators) · TanStack Table · Recharts.

---

## 15. Migration phases

Each phase ends in something demonstrable. **The Flutter app keeps running throughout and stays the reference
implementation until Phase F passes.**

| Phase | Scope | Exit criterion |
|---|---|---|
| **A. Foundation** | Next.js + TS + Tailwind scaffold; Supabase dev project; `app` schema, helper functions, permission catalogue seeded; `AppShell` + responsive navigation; **`<DataView>`**; design tokens; CI | Sign-in page renders and is responsive at all four breakpoints |
| **B. Auth, users, roles, permissions** | Phone+password sign-in, forced change, throttle, policy; users/staff CRUD RPCs; permission editor; temporary grants; RLS on `users`/`staff`; audit | A Manager can grant a Worker a 2-hour temporary permission and watch it expire on its own |
| **C. Customers, vehicles, services, jobs** | Plate-first search; customers; catalogue; intake; worker orders; My Jobs; **offline vehicle search** | A Worker completes a job on a phone browser |
| **D. Billing, payments, credit, loyalty** | Invoices, discounts + approval, **payments with idempotency**, reversals, receipts, credit, loyalty ledger | A payment retried after a dropped connection is recorded **once** — proven by test |
| **E. Finance, expenses, inventory** | Accounts, **immutable ledger**, daily summaries, transfers, deposits, reconciliation; expense lifecycle; inventory + stock rules; file uploads | Ledger, balances and daily summaries reconcile to the shilling against Firebase for the same inputs |
| **F. Workforce** | Attendance + server-side lateness + policy snapshot; allowances; salary history; **payroll**; losses and deductions | A payroll run produces gross/deduction/net figures **identical** to Firebase for the same inputs |
| **G. Shareholding** | Shareholders, classes, ownership ledger, contributions, ownership-as-of, dividends, `get_my_shareholding` | A Shareholder can see their own holding and **provably cannot query anyone else's** |
| **H. After-hours** | Authorisations as temporary grants, sessions, custody sub-ledger, expected cash, handovers, discrepancies | An authorisation expires mid-session and the server refuses the next action |
| **I. Reports, notifications, audit, settings** | 10 server-calculated reports + CSV; notification inbox + Web Push + preferences; audit log viewer; settings | Every report matches Firebase figures for the same period |
| **J. Hardening** | pgTAP RLS suite; modified-client tests; concurrency/idempotency; performance; accessibility; PWA; Vercel production | Full parity suite green (§16) |
| **K. Data migration & cutover** | Export → transform → staging load → **reconciliation** → password reissue → dual-run → cutover | Reconciliation report signed off; then and only then, retire Flutter |

**Sequencing rules**
1. **Phases B–I follow the original build order exactly.** Phase 5 finance is a dependency of Phase 6 payroll,
   Phase 7 contributions and Phase 8 handovers. That dependency graph is real; do not reorder it.
2. **Every phase ports the tests with the code.** A phase is not done when the screen renders; it is done when the
   ported tests pass.
3. **Firebase production is never written to.** Reconciliation reads a *restored backup*, not production.
4. **Do not delete the Flutter app until Phase K is signed off**, and keep it archived on a branch afterwards.

---

## 16. Testing strategy — proving nothing was lost

The current system has **57 test files / ~14,200 lines**. That suite is the specification. The strategy is to port
it, then add what the platform change makes newly necessary.

### 16.1 Port the existing suite
| Current | Becomes | Non-negotiable |
|---|---|---|
| `functions/test/*.test.js` (23 files) | **pgTAP** tests per RPC | Yes — these encode the business rules |
| `functions/test/rules.test.js` | pgTAP RLS tests per table | **Yes — proves a modified client cannot write** |
| `functions/test/storage_rules.test.js` | Storage RLS tests | Yes |
| `functions/test/integrity.test.js` | Cross-module integrity tests | Yes |
| `test/unit/permissions_test.dart` (catalogue drift) | Catalogue snapshot test + generated types | Yes |
| `test/unit/*.dart` (14 files) | Vitest unit tests | Yes |
| `test/widget/*.dart` (9 files) | React Testing Library | Yes |
| `test/repository/*.dart` | Data-access integration tests | Yes |

### 16.2 The parity harness — the actual proof
This is the deliverable that answers "prove functionality has not been lost."

**A. Behavioural parity.** For each of the 127 callables, a table of `(inputs, expected outcome)` extracted from
the existing tests, run against **both** the Firebase emulator and the Supabase staging project, asserting
identical outcomes: same success/failure, same error reason code (`invalid_credentials`, `rank`,
`authorization_only`, …), same resulting figures, same audit entry.

**B. Numeric parity.** Seed both systems with the same fixture business (customers, vehicles, jobs, payments,
expenses, stock, attendance, salaries, shares) and assert **to the shilling**:
account balances · ledger totals · daily summaries · outstanding credit · loyalty points · stock quantities ·
payroll gross/deductions/net · ownership percentages · dividend allocations · expected after-hours cash ·
all 10 reports.

**C. Permission-matrix parity.** For all 6 roles × ~150 permissions × every table and RPC: assert the *same*
allow/deny answer in both systems. This is generated, not hand-written — ~5,000 assertions from the catalogue.

**D. Screen-coverage checklist.** All 76 screens mapped to routes (§4) and signed off, on **three viewports each**
(390 px, 820 px, 1440 px).

### 16.3 New tests the platform change requires
- **RLS negative tests:** a raw `supabase-js` client with a valid token for role X attempting every forbidden read
  and write, per table. This is the web equivalent of "modified client" tests and is the **highest-value new
  suite**.
- **Realtime + RLS:** a wrong-role subscriber receives nothing.
- **Concurrency:** parallel `record_payment` with the same `requestId` → exactly one payment; parallel stock-out →
  never negative; parallel payroll for one period → exactly one.
- **Session/middleware:** must-change-password cannot be bypassed by direct URL; expired account redirects;
  revoked permission invalidates the open page.
- **Offline/poor network** (Playwright): reads from cache; **every money action refuses and queues nothing**;
  timeout shows "may already have been saved", never "failed"; retry with the same `requestId` is idempotent.
- **Responsive/a11y:** axe-core at each breakpoint; keyboard-only completion of the finance and payroll flows;
  visual regression at three viewports.
- **Storage:** every bucket path × every role; evidence cannot be replaced or deleted.
- **Load:** `effective_permissions` under realistic concurrency (the one likely performance cliff).

### 16.4 Definition of done
Parity is claimed only when: A, B and C are 100% green; D is signed off; the ported suite passes; the new suites
pass; and a **dual-run period** on real workload shows no divergence.

---

## 17. Migrates almost unchanged vs. needs real redevelopment

### 17.1 Ports with business rules intact (~70% of the system's value)
These are pure JS→PL/pgSQL translations. The logic, thresholds, state machines, guards and error messages all
survive. Risk is low; the work is mechanical and highly testable.

| Area | Why it ports cleanly |
|---|---|
| **Permission model** | Pure set algebra over arrays — Postgres does this natively |
| **Billing & payments** | Transactional logic; **Postgres transactions are stronger than Firestore's** |
| **Finance ledger** | Append-only + reversals maps perfectly to a relational ledger |
| **Expenses** | Straight state machine |
| **Inventory** | `CHECK (quantity >= 0)` is *better* than the code-enforced version |
| **Attendance & allowances** | Time arithmetic; `TIMESTAMPTZ` + `Africa/Kampala` is better than Firestore timestamps |
| **Payroll** | Deterministic calculation over rows — this is what SQL is *for* |
| **Losses & deductions** | Straight state machine |
| **Shares & ownership** | Ledger + aggregation; **ownership-as-of becomes a windowed SQL query instead of a scan** |
| **Dividends** | Allocation + freeze + approval |
| **After-hours** | Temporary-grant mechanics + custody sub-ledger |
| **Audit** | Append-only table + trigger |
| **Validation** (phone, password, plate, names, reasons) | Pure functions; port to shared TS + SQL |
| **Business numbering** (`RMX-*`) | Sequences are simpler than counter documents |
| **Idempotency** | `UNIQUE (request_id)` is simpler and stronger than reservation documents |

### 17.2 Ports with a changed mechanism but identical intent
| Area | Change |
|---|---|
| **Security rules → RLS** | Mechanical clause-by-clause translation, but a **different engine** — must be re-proven by tests, not assumed |
| **Auth** | Same scheme; simpler implementation; **but password hashes cannot be carried over** |
| **Storage** | Same paths, same limits, same deny-by-default; different policy language |
| **Realtime** | Deliberately narrowed from 108 listeners to ~6 subscriptions + query invalidation |
| **Reports** | Same outputs; SQL aggregation instead of bounded document scans. The 400-day / 5,000-record caps can be *relaxed*, but **keep them initially** so parity is testable against the current behaviour |
| **Scheduled sweeps** | `onSchedule` → pg_cron; identical semantics |

### 17.3 Requires genuine redevelopment
| Area | Effort | Why |
|---|---|---|
| **All 76 screens** | **Largest single item.** ~41 kLOC of Dart has no automated path to React | Complete rebuild — but against an unchanged API, so the target behaviour is fully specified |
| **Responsive data-dense views** | High | Flutter targeted one form factor. The ledger, payroll and share tables need a genuine phone design (§14.3). **Build `<DataView>` first.** |
| **Offline architecture** | High | Firestore's persistence layer is free and query-aware; the replacement is hand-built. **Offline plate search is the specific hard part.** |
| **Notifications** | Medium-high | FCM→Web Push is a rewrite; **iOS requires PWA installation** — a real capability regression to decide on consciously |
| **Navigation shell** | Medium | Three presentations of one permission-filtered config; go_router's redirect guards become middleware + server checks |
| **Session handling** | Medium | Token store → httpOnly cookies + middleware refresh; net security improvement |
| **File upload UX** | Medium | Compression, camera capture, resumable uploads — all new |
| **Data migration & reconciliation** | Medium-high | Document→relational transform, plus the reconciliation proof (§16.2B) |

### 17.4 Honest assessment of risk
| Risk | Severity | Mitigation |
|---|---|---|
| **A subtle RLS gap silently exposes data** that Firestore rules blocked | **Highest** | The generated permission-matrix parity suite (§16.2C) and RLS negative tests (§16.3). Do not hand-write these. |
| `effective_permissions` performance under RLS | Medium-high | Benchmark in Phase A, before 60 tables depend on it. Request-scoped GUC caching if needed. |
| Offline capability quietly regresses | Medium-high | Playwright offline suite as an exit criterion for every phase, not a Phase J afterthought |
| Password reissue at cutover is operationally painful | Medium | Plan it with the business; the flow already exists and is tested |
| iOS push requires home-screen install | Medium | Decide explicitly; consider SMS fallback for critical notices |
| Scope creep — "improving" business rules mid-migration | **High** | **Rule: no business-rule change in this migration.** Log every improvement idea for after parity is proven. |

---

## 18. What I recommend you decide now

1. **Confirm `113219d` as the source of truth** and authorise fast-forwarding `main` to it, so no future work
   branches from the Phase 6 version again.
2. **Confirm the password-reissue cutover** (§7.4) is operationally acceptable.
3. **Confirm the iOS push trade-off** (§12.2) — PWA install required, or SMS fallback for critical notices.
4. **Confirm the no-business-rule-changes rule** for the duration of the migration.
5. **Approve the phase order** (§15), specifically that B→I follows the original build order.

On your approval I will re-cut the working branch from `113219d` and begin **Phase A only**.

---

## Appendix — evidence and provenance

- Correct version verified by `git ls-remote`: `refs/heads/claude/zealous-pascal-qlt5ru` → `113219d856a8c7f114f763cc21b9920180e37844`.
- Read-only worktree at `/tmp/claude-0/.../scratchpad/phase9` (detached HEAD at `113219d`). Your working tree was not modified.
- Primary sources: `functions/src/index.js` (127 callables), `functions/src/access.js`, `session.js`, `passwords.js`,
  `notify.js`; `lib/core/auth/permissions.dart`; `lib/core/constants/firestore_collections.dart`;
  `lib/routes/app_router.dart`; `firebase/firestore.rules` (757 lines); `firebase/storage.rules` (125 lines);
  and `docs/` (35 files, ~5,150 lines), especially `ROADMAP.md`, `DATA_MODEL.md`, `OFFLINE.md`,
  `NOTIFICATIONS_AND_MONITORING.md`, `REPORTS.md`, `ROLES_AND_PERMISSIONS.md`, `SECURITY.md`.

**Safety confirmation:** the Flutter app is untouched; no Firebase project was contacted, read or modified; no
production data was accessed; no Supabase resource was created; nothing was committed, pushed or deployed.
