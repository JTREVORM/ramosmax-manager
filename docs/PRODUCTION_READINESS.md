# Production readiness (Phase 9)

This is the final checklist between the repository and real business data. Automated tests passing is **not** the
same as production-ready: the items marked *blocker* below must be done first.

See also:

- [SETUP_CHECKLIST.md](SETUP_CHECKLIST.md): console steps;
- [ADMIN_PROVISIONING.md](ADMIN_PROVISIONING.md): the first Administrator and deploying;
- [DEPLOYMENT_ANDROID.md](DEPLOYMENT_ANDROID.md) and [DEPLOYMENT_IOS.md](DEPLOYMENT_IOS.md): releases;
- [SECURITY.md](SECURITY.md), [REPORTS.md](REPORTS.md), [NOTIFICATIONS_AND_MONITORING.md](NOTIFICATIONS_AND_MONITORING.md).

## 1. Architecture in one page

| Layer | What | Where |
|---|---|---|
| App | Flutter (Android, iOS), Riverpod, go_router, Material 3 | `lib/` |
| Identity | Firebase Auth. Phone number + password, checked by the `signInWithPhonePassword` function | `functions/src/session.js` |
| Access | Roles and permissions: the profile (`users/{uid}`), the access catalogue and the security rules, kept in sync by a drift test | `lib/core/auth`, `functions/src/access_catalog.json`, `firebase/firestore.rules` |
| Business logic | Cloud Functions. Every money, stock, payroll, ownership and access change runs in a Firestore transaction, re-checks the caller, is idempotent (`requestId`) and writes its audit entry | `functions/src/*.js` |
| Ledger | One immutable ledger (`financial_transactions`), account balances and daily summaries written in the same transaction | `functions/src/finance.js` |
| Data | Firestore (`eur3`). Clients can read what their permissions allow and write almost nothing | `firebase/firestore.rules` |
| Files | Cloud Storage: evidence and staff documents, role-checked against the Firestore profile | `firebase/storage.rules` |
| Notifications | In-app records plus FCM push. Generic text, preferences, de-duplication | `functions/src/notify.js` |
| Monitoring | Crashlytics (pseudonymous user ID and role only), Analytics (action keys only) | `lib/core/services/` |

## 2. Environments

| | Development | Production |
|---|---|---|
| Firebase project | `ramos1-c0862` (test data only) | `ramosmax-prod` (real business data) |
| Android application ID | `com.ramosmax.automotive.dev` | `com.ramosmax.automotive` (permanent once published) |
| Entrypoint / flavor | `lib/main_dev.dart`, `--flavor dev` | `lib/main_prod.dart`, `--flavor prod` |
| Visible marker | Gold "DEVELOPMENT · TEST DATA" badge (compact on small phones) | None |

**Separation is enforced, not just configured.** At start-up `bootstrap.dart` refuses to run when:

- the Firebase project compiled in does not match the flavor (`Firebase project mismatch`); or
- the package name does not match the flavor's application ID.

A production build can therefore never talk to the development project, and the reverse. Each flavor has its own
`google-services.json` and `firebase_options_*.dart`.

Those two files are client configuration, **not secrets**. Still, restrict their API keys in Google Cloud Console to
the package name and SHA fingerprints (SETUP_CHECKLIST.md).

## 3. Deploying (not done in this repository's sessions)

**Prerequisites for each project:**

- the Blaze plan with a **budget alert**;
- the Email/Password provider enabled;
- the `RAMOSMAX_AUTH_API_KEY` secret (Secret Manager) and the Service Account Token Creator role (ADMIN_PROVISIONING.md
  §1);
- the Storage bucket created.

**Order**, first `--project development`, then after testing `--project production`:

```bash
firebase deploy --project <development|production> --only firestore:rules,firestore:indexes
firebase deploy --project <development|production> --only storage          # accept "let Storage rules read Firestore"
firebase deploy --project <development|production> --only functions
```

1. **Rules and indexes first.** The rules only tighten, so older app builds keep working. Index builds can take
   minutes; queries that need an index fail until it is ready.
2. **Functions** (Node 22, region `europe-west1`, at most 10 instances each).
3. **The app** last.

**Rollback:**

| Part | How |
|---|---|
| Functions | Redeploy the previous commit (`git checkout <sha> -- functions && firebase deploy --only functions`) |
| Rules | Redeploy the previous rules file the same way |
| Indexes | Never delete an index during a rollback. An unused index is harmless |
| Data | Never "rolled back" by hand: the ledger is corrected by reversals and adjustments, which keeps history |

### Cloud Functions

- **125 callables:**
  - 124 require a signed-in, active caller;
  - `signInWithPhonePassword` is open, limited per phone number and by Firebase Auth.
- **Unexpected errors** are logged server-side (code and message only, never request data) and reach the app as
  "Something went wrong".
- **Scheduled**, both in `Africa/Kampala` time, both retry-safe. Each step either uses a transaction with a status
  check or a once-only reservation, and the notifier drops a repeat within 10 minutes:

  | Function | Schedule | Does |
  |---|---|---|
  | `sweepRecurringExpenses` | Every day 06:00 | Creates the due draft expense once per due date (`unique_keys/recurring_due_…`), then notifies approvers |
  | `sweepTemporaryGrants` | Every 15 minutes | Expires temporary grants (tidy-up only; enforcement never waits for it). The after-hours sweep in the same run expires authorisations, sends the one "ending soon" notice, and sends one reminder for a cash handover still open after 2 hours |

  Low-stock alerts are sent when a movement makes an item low, not on a schedule.

### Indexes

`firebase/firestore.indexes.json` holds **65 composite indexes**, none duplicated (checked in Phase 9). Every query in
the app and the functions uses either one of them or a single-field index Firestore creates automatically. Phase 9
needed none: reports use single-field range queries or existing composites, and the notification inbox uses
`(recipientId, createdAt desc)`. Deploy them with the rules (above).

## 4. Backup and recovery

- **Nothing is configured yet.** No scheduled export and no point-in-time recovery (PITR) are set up in either
  project. Treat this as a **production blocker**.
- **Recommended**, done by an owner of `ramosmax-prod` in Google Cloud Console:
  - Firestore **PITR** (7-day window);
  - a **daily scheduled export** (`gcloud firestore export gs://<backup-bucket>`) to a bucket in a different project or
    with retention lock;
  - keeping the Storage bucket (evidence and staff documents) under object versioning or a daily copy.
- **What matters most** in a restore:

  | Area | Collections |
  |---|---|
  | Ledger | `financial_transactions`, `financial_accounts`, `finance_daily_summaries` |
  | Sales | `payments`, `receipts`, `invoices` |
  | Payroll | `payroll`, `payroll_items`, `salary_history`, `salary_deductions` |
  | Ownership | `share_transactions`, `shareholdings`, `share_contributions`, `dividends`, `dividend_allocations` |
  | Audit and access | `audit_logs`, `users`, `unique_keys` (reservations), `counters` (numbering) |
- **How to restore:**
  - restore into a **new** project or database first, verify with the reports, then switch;
  - never import over live data, because counters and reservations must stay consistent with the records;
  - after any restore, run the ledger check (balance = sum of entries; `assertLedgerConsistent` in
    `functions/test/helpers.js` shows the rule) before taking payments.
- **Project separation:** development never holds real data. Never copy production data into development without
  removing personal data first.

## 5. Release builds

| Build | Command | Status |
|---|---|---|
| Android development APK | `flutter build apk --flavor dev -t lib/main_dev.dart` | Configured. Not built in Phase 9 (no need to validate) |
| Android production AAB | `flutter build appbundle --flavor prod -t lib/main_prod.dart` | Configured, but **publishable only with the upload key** (`android/key.properties`, git-ignored; without it the release build falls back to the debug key and must not be uploaded) |
| iOS | Xcode on a Mac | Needs a Mac, an Apple Developer account and an APNs key (DEPLOYMENT_IOS.md). **Not done** |

Also configured:

- the app name per flavor (`RamosMAX Dev` / `RamosMAX`);
- the launcher icon and splash from `assets/branding`;
- minSdk 23;
- release minify and shrink;
- Crashlytics mapping upload for release builds.

No signing keys or passwords are in the repository (`android/key.properties.example` is a template).

## 6. Manual test checklist (before real data)

Key to the columns:

- **E**: can be checked on the emulators or a development build;
- **D**: physical Android device;
- **F**: deployed Firebase (development project);
- **P**: real FCM push;
- **A**: production-like accounts of every role.

Tick each item in **development** first, then repeat the starred ones (★) on production with test records you then
reverse.

| # | Test | Needs |
|---|---|---|
| 1 | Admin signs in (phone + password), sees every menu | D F A |
| 2 | Manager signs in, sees the manager menu, cannot open User Management actions it lacks | D F A |
| 3 | Auditor signs in, reads everything permitted, every write button absent, direct writes refused | D F A |
| 4 | Cashier signs in: New Service, Invoices, Payments, Reports (operations, credit, expenses) only | D F A |
| 5 | Worker signs in: My Jobs, attendance, My pay, My After-Hours only | D F A |
| 6 | Shareholder signs in: My Shareholding shows own records only; Business Performance opens | D F A |
| 7 | Temporary password → forced change; self-service change; Admin reset → user gets the "password reset" notice | D F P |
| 8 | ★ Plate search → new customer and vehicle → duplicate plate refused | D F |
| 9 | ★ Service intake with several services | D F |
| 10 | Job assignment and reassignment (both workers notified) | D F P |
| 11 | Worker accepts, starts, pauses, completes; the creator gets "ready to invoice" | D F P |
| 12 | ★ Invoice, discount with reason | D F |
| 13 | ★ Cash payment → receipt → Cash at Hand rises once | D F |
| 14 | ★ MTN payment with reference | D F |
| 15 | ★ Airtel payment with reference | D F |
| 16 | ★ Bank payment (choose account if several) | D F |
| 17 | ★ Partial payment then balance; overpayment refused | D F |
| 18 | Credit (on account) appears in Outstanding with age | D F |
| 19 | Loyalty reward unlocked and redeemed | D F P |
| 20 | Expense: record → submit (reviewers notified) → review → approve (author notified) → pay (balance falls once) | D F P |
| 21 | Inventory: item, purchase, receive, usage, adjustment, low-stock alert | D F P |
| 22 | Attendance: clock in (server time), late rule, verification, correction (staff notified) | D F P |
| 23 | Allowances: calculate, approve, pay | D F |
| 24 | Payroll: prepare, review, Admin approval, pay (staff notified), lock | D F P |
| 25 | Loss incident → approval → recovery scheduled → deducted only through payroll | D F |
| 26 | Share issue with contribution (ledger in, not revenue), second-person approval | D F |
| 27 | Share transfer; over-transfer refused | D F |
| 28 | Dividend: declare, calculate at record date, Admin approval, pay, reversal | D F |
| 29 | After-hours authorisation (worker notified; menus appear), revoke | D F P |
| 30 | After-hours operation: session, job, invoice, cash + mobile money payment; bank refused | D F |
| 31 | Cash handover: close → submit → receive (equal) | D F P |
| 32 | Discrepancy: short count → review → resolve (optional loss report); worker notified | D F P |
| 33 | Notification delivery: push arrives on a locked phone with generic text; tapping opens the record; muting a category stops push but keeps the inbox entry | D F P |
| 34 | Reports: each report for each role; export CSV opens in a spreadsheet; figures match the Finance screens | D F A |
| 35 | Offline: cached screens readable; every write says it needs a connection; nothing is queued | D |
| 36 | Reconnect: data refreshes; access changes apply at once | D F |
| 37 | Permission expiry: temporary grant and after-hours authorisation stop at their end time without the app restarting | D F |
| 38 | Security isolation: worker/shareholder cannot see others' records (try deep links) | D F A |
| 39 | Audit Logs show the actions above with actor, record and reason | D F |
| 40 | App killed during a payment; reopen, retry the same payment → recorded once ("may already have been saved") | D F |
| 41 | Storage: role-based uploads and reads of evidence and staff documents, in line with SECURITY.md. The emulator here cannot evaluate the Firestore look-ups in the Storage rules, so this must be checked on the deployed project | D F |

## 7. Known limitations (genuine)

- **Storage rules:**
  - the profile-independent rules are emulator-tested (signed-out access, unknown paths, no deletion of evidence);
  - the role-based ones need the deployed project to test (item 41 above).
- **App Check** is not enforced on the functions (`enforceAppCheck: false`). Every function still authenticates and
  authorises the caller, so this is a hardening step, not a gap in access control. It is recommended once Play
  Integrity and DeviceCheck are registered.
- **Shared handsets:** a device's FCM token is removed at sign-out. If the app is uninstalled without signing out, the
  old token is removed only when FCM reports it unregistered on the next send.
- **Reports:**
  - read at most 5,000 records per query and cover at most 400 days per run (the screen says when a limit was hit);
  - long histories need several runs or an export.
- **Stock value** in reports is indicative (quantity × last cost), not an audited valuation.
- **Profit and tax** are not calculated (by design; accounting and legal decision).
- **iOS** has never been built: it needs a Mac.

## 8. Production blockers

| Kind | Blocker |
|---|---|
| Code issues | None known after the Phase 9 review and test runs |
| Firebase deployment | Deploy rules, indexes, storage rules and functions to **both** projects (not done in these sessions); create the Storage bucket; create the `RAMOSMAX_AUTH_API_KEY` secret |
| Configuration | Blaze plan and budget alerts; API key restrictions; SHA fingerprints and Play Integrity; APNs key for iOS; **Firestore backups (PITR and scheduled export) are not configured** |
| Manual testing | The checklist above, including real FCM delivery and the Storage role checks (item 41) |
| Business decisions | Confirm the company contact details and supply the TIN (`lib/core/branding/brand.dart`); decide the after-hours policy (methods, hours, float), payroll policy values and share and dividend approval settings; create the real accounts and roles |
| Legal / accounting | Review of payroll deductions, dividend declarations (legal distributable amounts, withholding tax: none applied today), share records against the company register, and data-protection obligations for staff and customer data |
