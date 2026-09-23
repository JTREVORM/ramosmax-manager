# RamosMAX Automotive Care Management System

Mobile business-management system for **RamosMAX Automotive Care (U) Ltd** — car wash, detailing and
mechanical services in Uganda. Staff sign in with their phone number and password; what each person can see and do is
decided by their role and permissions.

| | |
|---|---|
| Platforms | Android, iOS (Flutter) |
| Backend | Firebase — Auth (phone number + password, via Cloud Functions), Cloud Firestore, Cloud Functions, Storage, Cloud Messaging, Analytics, Crashlytics |
| Android application ID | `com.ramosmax.automotive` (dev build: `com.ramosmax.automotive.dev`) |
| iOS bundle ID | `com.ramosmax.automotive` (debug/dev build: `com.ramosmax.automotive.dev`) |
| Firebase — development | `ramos1-c0862` (test data only) |
| Firebase — production | `ramosmax-prod` (real business data, Firestore in `eur3`) |
| Currency / time zone | UGX (whole shillings) / East Africa Time, UTC+3 |

**Status: Phase 7 — shareholders, shares, ownership and dividends.** Sign-in is phone number + password (no SMS codes). On
top of the Phase 1 foundation (profile-based access control, role-aware navigation, security rules):

- **Phase 2:** authorised administrators manage users, staff links, roles, permissions and temporary access in the
  app, enforced by Cloud Functions and the security rules.
- **Phase 3:** the reception workflow — number-plate search, vehicle and customer registration, the service
  catalogue with prices, and service intake.
- **Phase 4:**
  - jobs (`RMX-JOB-…`) with per-service worker orders, assignment and a worker dashboard;
  - invoices (`RMX-INV-…`), discounts, partial payments, receipts (`RMX-RCP-…`) and credit;
  - vehicle-based loyalty.

  Every amount, number and point is computed server-side.
- **Phase 5:**
  - financial accounts (Cash at Hand, MTN Merchant, Airtel Merchant, banks) with an immutable ledger
    (`RMX-TXN-…`); every customer payment posts to its account in the same transaction;
  - transfers, bank deposits (`RMX-BNK-…`) and cash awaiting banking; reconciliation with explicit adjustments;
    reversals;
  - expenses (`RMX-EXP-…`) with review → approval → payment, categories and recurring-bill reminders;
  - inventory: items with generated SKUs, suppliers, purchases (`RMX-PUR-…`), stock movements (`RMX-STM-…`),
    adjustments, no negative stock, low-stock alerts.

  Balances and quantities change only on the server.
- **Phase 6:**
  - attendance (`RMX-ATT-…`): clock in/out with the server's time, lateness from a configurable reporting time and
    grace period, manager verification, audited corrections; biometric sources prepared in the data model;
  - daily allowances (`RMX-ALL-…`, UGX 5,000 by default, configurable) for approved attendance of eligible staff,
    FULL / DEDUCT / REJECT for late arrivals, approval and payment through the Phase 5 ledger;
  - effective-dated salary profiles and history; payroll (`RMX-PAY-…`) calculated on the server
    (gross − deductions = net, never negative), review → Administrator approval → payment in one transaction → lock,
    with corrections and reversals;
  - loss incidents (`RMX-LOSS-…`) whose approved recoveries are scheduled as salary deductions (`RMX-DED-…`) and
    applied only through paid payrolls; workers see only their own attendance, allowances and payslips.

- **Phase 7:**
  - shareholder profiles (`RMX-SHR-…`) with search by number, name, phone and status; linked shareholders see only
    their own shareholding (My Shareholding);
  - configurable share classes; an immutable ownership ledger (`RMX-SHR-TXN-…`) for issues, transfers, adjustments
    and reversals, with second-person approval; ownership % and ownership on any date, calculated on the server;
  - contributions (shares × value per share, `RMX-SHR-CON-…`) posted to the Phase 5 ledger as share capital, never
    revenue;
  - dividends (`RMX-DIV-…`) from an amount the business approves: record-date eligibility, allocations
    (`RMX-DIV-PAY-…`), Administrator approval, payment as distributions (never operating expenses), guarded
    reversals and cancellation. See SHAREHOLDERS.md, SHARES.md and DIVIDENDS.md.

Later modules (cash handover, after-hours, reports …) appear in the menus but open a "not available
yet" screen. They never show sample data.

## Quick start

Prerequisites: Flutter 3.47+ (Dart 3.13+), Android Studio with the Android SDK, a JDK 17+, and Xcode on
macOS for iOS builds. Node 20+ and the Firebase CLI are needed only for rules deployment and admin tooling.

```bash
git clone <repo> && cd ramosmax_auto_manager
flutter pub get

# Development (test Firebase project)
flutter run --flavor dev -t lib/main_dev.dart

# Tests and static analysis
flutter test
flutter analyze

# Cloud Functions + security-rule tests (Firebase emulators, needs Java 21+)
cd functions && npm install && npm test

# If the system drive is short of space, point the emulator cache and temp files elsewhere first, e.g.
#   export FIREBASE_EMULATORS_PATH=D:\firebase-emulators TEMP=D:\tmp TMP=D:\tmp
```

Before anyone can sign in, the one-time Firebase console steps in
[docs/SETUP_CHECKLIST.md](docs/SETUP_CHECKLIST.md) must be done, the functions deployed and the first
Administrator created, as described in [docs/ADMIN_PROVISIONING.md](docs/ADMIN_PROVISIONING.md).

## Documentation

| Topic | Document |
|---|---|
| Architecture, folder structure, layers | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Development vs production, flavors, run/build commands | [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md) |
| Phone + password sign-in, password policy, sessions, the user profile, SMS-account migration | [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) |
| Roles, permission catalogue, temporary access, anti-escalation rules | [docs/ROLES_AND_PERMISSIONS.md](docs/ROLES_AND_PERMISSIONS.md) |
| In-app user management, staff links, Cloud Functions, audit | [docs/USER_MANAGEMENT.md](docs/USER_MANAGEMENT.md) |
| First Admin, deploying functions, admin CLI | [docs/ADMIN_PROVISIONING.md](docs/ADMIN_PROVISIONING.md) |
| Customers, vehicles, number plates, reception workflow | [docs/CUSTOMERS_AND_VEHICLES.md](docs/CUSTOMERS_AND_VEHICLES.md) |
| Service catalogue, prices, service intake | [docs/SERVICES.md](docs/SERVICES.md) |
| Jobs, worker orders, assignment, status flow, worker dashboard | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| Invoices, discounts, payments, receipts, credit | [docs/BILLING_AND_PAYMENTS.md](docs/BILLING_AND_PAYMENTS.md) |
| Vehicle loyalty: points, rewards, ledger, corrections | [docs/LOYALTY.md](docs/LOYALTY.md) |
| Financial accounts, ledger, transfers, banking, reconciliation, reversals | [docs/FINANCE.md](docs/FINANCE.md) |
| Expenses: workflow, payment, categories, recurring bills, reports | [docs/EXPENSES.md](docs/EXPENSES.md) |
| Inventory: items, suppliers, purchases, stock movements, low stock, accounting treatment | [docs/INVENTORY.md](docs/INVENTORY.md) |
| Attendance: recording, lateness policy, verification, corrections, biometric readiness | [docs/ATTENDANCE.md](docs/ATTENDANCE.md) |
| Daily allowances: eligibility, late policy, approval, payment | [docs/ALLOWANCES.md](docs/ALLOWANCES.md) |
| Salaries and payroll: history, formula, workflow, payment, corrections, visibility | [docs/PAYROLL.md](docs/PAYROLL.md) |
| Loss incidents, recoveries and salary deductions | [docs/LOSSES_AND_DEDUCTIONS.md](docs/LOSSES_AND_DEDUCTIONS.md) |
| Shareholders: profiles, search, statuses, register, self-service | [docs/SHAREHOLDERS.md](docs/SHAREHOLDERS.md) |
| Shares: classes, issues, transfers, adjustments, contributions, ownership, history | [docs/SHARES.md](docs/SHARES.md) |
| Dividends: declaration, record date, allocation, approval, payment, reversal | [docs/DIVIDENDS.md](docs/DIVIDENDS.md) |
| Collections, functions, indexes, search strategy | [docs/DATA_MODEL.md](docs/DATA_MODEL.md) |
| Firestore collections and data conventions, money, dates, audit logs | [docs/FIRESTORE_CONVENTIONS.md](docs/FIRESTORE_CONVENTIONS.md) |
| Security rules, secrets, privacy, storage | [docs/SECURITY.md](docs/SECURITY.md) |
| Offline strategy | [docs/OFFLINE.md](docs/OFFLINE.md) |
| Notifications, Analytics, Crashlytics | [docs/NOTIFICATIONS_AND_MONITORING.md](docs/NOTIFICATIONS_AND_MONITORING.md) |
| Android release / Google Play | [docs/DEPLOYMENT_ANDROID.md](docs/DEPLOYMENT_ANDROID.md) |
| iOS release / App Store | [docs/DEPLOYMENT_IOS.md](docs/DEPLOYMENT_IOS.md) |
| Version numbers | [docs/VERSIONING.md](docs/VERSIONING.md) |
| Outstanding manual setup | [docs/SETUP_CHECKLIST.md](docs/SETUP_CHECKLIST.md) |
| Future phases and business rules | [docs/ROADMAP.md](docs/ROADMAP.md) |

## Golden rules

1. **The app is an untrusted client.** Security is enforced by `firebase/firestore.rules`,
   `firebase/storage.rules` and the Cloud Functions in `functions/`. Hiding a button is never a control.
2. **Development and production never mix.** Each build is compiled against exactly one Firebase
   project and refuses to start under the wrong application ID.
3. **Money is integer UGX.** Use `Money`, never `double`. Financial history is append-only; corrections are
   reversals. Salaries, allowances, deductions and payroll totals are computed only on the server.
4. **No secrets in the repository.** Signing keys, service-account keys and `key.properties` stay out of git.
