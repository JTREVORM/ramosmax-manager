# Security

## Model

The Flutter app is an **untrusted client**. Anyone can decompile it or call Firebase directly with a valid
login. Protection therefore comes from:

1. **Firebase Authentication:** phone number + password (Email/Password provider behind the server-side
   `signInWithPhonePassword` function; see AUTHENTICATION.md). Firebase stores the password hash. RamosMAX never does.
2. **Firestore and Storage Security Rules:** role and permission checks against the caller's own `users`
   document, re-read on every request.
3. **Trusted server code:** Cloud Functions (`functions/`) for anything that must be validated beyond what rules can
   express. Phase 2 moved all **user administration** there: creating users, roles, permissions, temporary
   access, activation, staff links. Later phases add financial posting, number allocation and notification fan-out.
4. **Audit logging:** append-only, attributed to the authenticated user with a server timestamp. The functions write
   the audit entry in the same transaction as the change it describes.

UI checks (hidden menus, `RouteGuard`, `AccessPolicy`) exist for usability only.

## Access-control enforcement

| Threat | Stopped by |
|---|---|
| Modified app writes `role: 'admin'` / permissions / `active` to a profile | Rules: clients may write only `lastLoginAt`, `fcmTokens` and `updatedAt` on their **own** profile. Admins included, so every change must go through the functions. |
| Modified app calls a function claiming to be an admin | Functions take identity from the verified ID token and read role/permissions from Firestore on the server. |
| Self-escalation (own role, permissions, temporary access, status, phone) | Functions refuse any access change where caller = target. |
| Manager promoting someone to Admin, or managing an Admin | Functions: only Admins assign the Admin role or manage Admin accounts. Non-admins manage only lower-ranked roles. |
| Granting a permission you don't have | Functions: grants, temporary grants and lifted denials require the actor to hold the permission. `users.*` and `settings.manage` are grantable only by Admins. |
| Locking everyone out | Functions and CLI refuse to deactivate or demote the last active Admin (checked inside the transaction). `users.*` cannot be denied to an Admin. |
| Expired temporary access still honoured | Rules and functions compare `startsAt`/`expiresAt` with the server clock on every request. The app's clock is never trusted. |
| Stolen or leaked passwords from our data | None to steal: no password, hash or temporary password is ever written to Firestore, audit logs, analytics, Crashlytics or server logs (tests scan Firestore to prove it). Firebase Authentication holds the credential. |
| Password guessing | 5 failed attempts per phone number → 15-minute lock-out (server-side, keyed by a hash of the number), plus Firebase Auth's own rate limits. Recommended: App Check on functions. |
| Finding out which phone numbers have accounts | One answer, "Incorrect phone number or password", for unknown numbers, wrong passwords and password-less accounts. The phone → sign-in identity mapping exists only server-side. |
| Skipping the forced change of a temporary password | `mustChangePassword` makes `isActive()` false in the rules and blocks every privileged function; the router allows only the change screen. The flag is server-only. |
| Someone resetting a password they shouldn't | `resetUserPassword`: `users.passwords.reset` plus rank; non-admins may reset Workers only; never oneself. Audited with reason, never with the password. |
| Changing another user's password directly | Impossible from the client: `changeOwnPassword` acts only on the caller, after verifying the current password. |
| Deactivated user keeps working | `isActive()` in every rule. Deactivation also revokes refresh tokens. The live profile listener signs the app out of the dashboard within seconds. |
| Forged or edited audit entries | Rules: create-only, `userId == auth.uid`, `userRole == role()`, `timestamp == request.time`. No update or delete for anyone. |
| Duplicate vehicles / plates | `unique_keys/plate_{KEY}` reserved in the same transaction as the vehicle. `UGB 123A` = `ugb-123a`. |
| Workers (or anyone without `services.manage`) changing prices | `services` is not client-writable; `createService`/`updateService` require `services.manage`. Tested per role. |
| Intakes referencing inactive/missing services or vehicles | `createServiceIntake` reads every referenced document inside the transaction. |
| Modified app writes a balance, stock quantity, ledger entry, movement or "paid" status | Rules: `financial_accounts`, `financial_transactions`, `finance_daily_summaries`, `bank_deposits`, `reconciliations`, `expenses`, `expense_categories`, `recurring_expenses`, `inventory_items`, `stock_movements`, `suppliers` and `inventory_purchases` are read-only to every client, admins included. Balances and quantities change only in the functions, in the same transaction as the ledger entry or movement that explains them. |
| Double posting (retries, double taps, concurrent requests) | Every money or stock request carries a `requestId` stored once in `unique_keys` (bound to the caller and request kind). Payments keep the Phase 4 key, which also covers the ledger posting. Balances and quantities are read and written inside the transaction, so concurrent requests cannot overdraw an account or take stock below zero (emulator-tested). |
| Hiding money or rewriting history | No deletes. Corrections are reversals or adjustments with a reason and an audit entry. Reconciliations never change a balance. Accounts with money cannot be deactivated; the customer-payment accounts never can. |
| Spending without authority | Creating and approving an expense moves no money. `payExpense`/`payPurchase` need `expenses.pay`. Adjustments and reversals need `finance.adjust`/`expenses.adjust` (Admin by default). High-value stock-outs need `inventory.stock.adjust`. Cashiers, workers and auditors hold none of these. |
| Tampered amounts, types or status fields | Functions accept only whole-UGX integers within limits, known types and choices, and ignore every status, number, balance or approval field sent by the client (tests send them). |
| Leaking internals in errors | Functions return curated messages with a `reason` code. Anything else becomes a generic message, and details are logged server-side only. |

These are verified by `functions/test/rules.test.js`, `user_admin.test.js` and `session.test.js` against the Firebase
emulators, not only by UI tests.

## Firestore rules (`firebase/firestore.rules`)

- Default deny: `match /{document=**} { allow read, write: if false; }`.
- `users`: a user may read their own profile. `users.view` holders (Admin, Manager, Auditor) may read others. A
  user may update only `lastLoginAt`, `fcmTokens` and `updatedAt` on their own document, with explicit guards that role, active and the three permission fields are unchanged.
  Creation, deletion and every administrative field are denied to all clients. Only the Cloud Functions write them.
- `users/{uid}/temporary_grants`: readable by the user (while active) and `users.view` holders. Never client-writable.
- `staff`: readable with `staff.view`, or by the linked person for their own record. Never client-writable (Phase 2).
- `customers`, `vehicles`, `services`, `service_intakes`: readable with `customers.view`, `vehicles.view`,
  `services.view` and `jobs.view` respectively; **never client-writable**. The functions in `operations.js` enforce
  unique plates, valid references, whole-shilling prices and the audit trail. Workers can look up plates and see the
  catalogue, but vehicles carry no customer phone numbers.
- `worker_orders`: readable with `jobs.view`, or by the assigned worker (`jobs.view.own` and
  `workerId == auth.uid`; list queries must filter on it). Status changes go through `updateWorkerOrderStatus`,
  which also checks that the caller is the assignee.
- `invoices`, `discounts`, `payments`, `receipts`, `loyalty_accounts`, `loyalty_transactions`, `loyalty_rewards`,
  `loyalty_events`: read-only to holders of the matching view permission. **No client, admin included, can write a
  total, balance, number, status, point or reward.** The functions in `billing.js` and `loyalty.js` compute them
  in transactions, with idempotency keys for payments and once-only guards for reversals. Emulator tests cover every
  role and unauthenticated access.
- Phase 5: `financial_accounts` and `finance_daily_summaries` (`finance.view`), `financial_transactions`
  (`finance.transactions.view`), `bank_deposits` (+ `finance.deposit`), `reconciliations` (+ `finance.reconcile`),
  `expenses`, `expense_categories`, `recurring_expenses` (`expenses.view`), `inventory_items`, `stock_movements`,
  `suppliers`, `inventory_purchases` (`inventory.view`). All are **read-only to every client**. See FINANCE.md,
  EXPENSES.md and INVENTORY.md.
- Phase 6: `attendance`, `attendance_corrections` (`attendance.view`), `worker_allowances` (`allowances.view`),
  `salary_profiles` (`salary.view`, legacy `staff.salary.view`), `salary_history` (`salary.history.view`), `payroll`
  (`payroll.view` or `reports.payroll.view`, totals only), `payroll_items` (`payroll.view`), `salary_deductions`
  (`payroll.view`, `losses.view`, `deductions.manage`), `loss_incidents` (`losses.view`). A staff member reads **only
  their own** records with the `.own` permissions (`staffUid == auth.uid`; payslips and incidents also need
  `visibleToStaff == true`), so a query for another worker's salary or payroll is refused. All are **read-only to
  every client**: attendance approval, allowance amounts, salaries, payroll totals, deduction balances and loss
  recoveries are written only by the Cloud Functions, which compute every amount themselves and ignore any total a
  client sends. Checks that are cheap (ownership) come before permission checks so rules stay within Firestore's
  1,000-expression limit. See ATTENDANCE.md, ALLOWANCES.md, PAYROLL.md, LOSSES_AND_DEDUCTIONS.md.
- `counters`, `login_throttle`, `unique_keys`: no client access.
- `isActive()` is false while `mustChangePassword` is true, so a temporary password unlocks nothing but the
  password change (which is a Cloud Function).
- Temporary permissions are honoured only while `startsAt ≤ request.time < expiresAt`.
- `audit_logs`: create-only by active users, with `userId == auth.uid`, `userRole == role()` and
  `timestamp == request.time`. No update or delete for anyone. Reading requires `audit.view`.
- `notifications`: recipients may read and mark their own as read. Clients can never create them.
- `settings`: readable by active users. Not writable by clients.
- Every other collection is denied until its phase adds rules.
- There is no `if true` anywhere; a unit test asserts this.

## Storage rules (`firebase/storage.rules`)

Default deny, and nothing is public. Paths are built only via `StoragePaths`:

| Path | Read | Write |
|---|---|---|
| `staff/{id}/profile/*` | active users | admin, manager. Images < 5 MB. |
| `staff/{id}/documents/{category}/*` (national ID, contracts, certificates) | **admin only** | admin. Image/PDF < 10 MB. No delete. |
| `expenses/{id}/receipts/*` | admin, manager, auditor | admin, manager. Create only. |
| `inventory/{id}/documents/*` | admin, manager, auditor | admin, manager. Create only. |
| `business/{category}/*` | admin, manager, auditor, shareholder | admin. Create only. |
| `payroll_uploads/{attendance\|losses\|payroll}/{uploadId}/*` (Phase 6 employee evidence) | admin, manager, auditor — **never** cashiers, workers or shareholders | admin, manager. Image/PDF < 10 MB. Create only; never replaced or deleted. The functions accept only paths under this prefix. |
| `finance_uploads/{deposits\|reconciliations\|expenses\|purchases}/{uploadId}/*` (Phase 5 evidence) | admin, manager, auditor | admin, manager, cashier. Image/PDF < 10 MB. Create only; never replaced or deleted. The functions accept only paths under this prefix. |

Firestore stores file **paths**, not download URLs, because a download URL is a bearer link that bypasses the
rules once shared.

## Sensitive data

Salaries, bank details, national IDs, staff documents, payroll and shareholder data will live in dedicated,
role-restricted collections and paths. Financial transactions (Phase 5) are readable only with
`finance.transactions.view`, and balances only with `finance.view`. The bank list cashiers see
(`settings/payment_accounts`) holds names and masked account numbers only. Workers never read other workers' private data.
Cashiers get no payroll permission. Auditors hold only `.view` permissions.

## What is never logged or sent to Analytics or Crashlytics

Passwords (current, new or temporary), auth tokens, phone numbers, names, bank or account numbers, national ID numbers,
salaries or any amount of money. Enforcement:

- `AnalyticsService` only sends events registered in `AnalyticsEvents` and allow-listed parameter names,
  and drops any value with 4 or more consecutive digits or longer than 40 characters.
- `CrashReportingService` attaches only the UID and role. `AppFailure` is reduced to kind and code before
  reporting.
- Crashlytics is disabled in debug builds.

## Secrets and git

Never committed (see `.gitignore`): `android/key.properties`, `*.jks`/`*.keystore`, Apple `*.p12`/`*.p8`/
provisioning profiles, service-account JSON, `.env*`, `*.pem`/`*.key`.

**Committed on purpose:** `google-services.json`, `GoogleService-Info.plist` and `firebase_options_*.dart`.
These hold Firebase *client identifiers* (API key, app ID, project ID). They are not secrets: they identify
the project to Google and are embedded in every shipped app. Protection comes from the security rules. As
defence in depth, restrict each API key in Google Cloud Console → APIs & Services → Credentials to its Android
package and SHA-1, or its iOS bundle ID (see `SETUP_CHECKLIST.md`).

Recommended additionally for production: **Firebase App Check** (Play Integrity / App Attest), enforced on
Firestore and Storage once all active clients support it.

## Production safeguards

- The production rules are the same file as development. Never edit rules in the console.
- Production admin actions through the CLI require `--confirm-production`. Creating the first production Admin
  also requires typing the project ID (see `ADMIN_PROVISIONING.md`).
- The mobile app contains no service-account key or other secret. Cloud Functions run under Google-managed
  credentials.
- Keep the production service-account key with as few people as possible, and rotate it if exposed.

## Phase 7: shareholders, shares and dividends

- **Client access:** every new collection is read-only to clients. See `firebase/firestore.rules` → *Shareholders,
  shares, ownership and dividends*:
  - `shareholders`, `share_classes`, `shareholdings`, `share_transactions`, `share_contributions`,
    `share_register`, `dividends`, `dividend_allocations`: `allow write: if false`;
  - reads are split by level:

    | Permission | Reads |
    |---|---|
    | `shareholders.view` | profiles |
    | `shares.view` | ledger, holdings, contributions |
    | `dividends.view` | allocations |
    | `shareholders.reports.view` | register totals and dividend headers only |
- **Server-authoritative figures:** ownership percentages, share totals, commitments, contributions, dividend pools,
  allocations and payment status are all calculated by the Cloud Functions. Figures sent by the app are ignored.
- **Shareholder isolation:** the shareholder role can read **none** of these collections. Its own records come from
  `getMyShareholding`, which selects by the caller's uid on the server. Tested in `rules.test.js` and `shares.test.js`.
- **Sensitive data:** phone and identification numbers are masked in audit entries. Notifications carry no name,
  share count or amount.
- **Every mutation:** re-reads the caller inside the transaction (active account, permission), validates the input and
  state, protects against duplicates with `requestId` or state checks, and writes its audit entry in the same
  transaction.
- **Storage rules:** unchanged. Phase 7 stores no documents or photos.

## Phase 8: after-hours operations and cash handovers

- **Client access:** the rules block *After-hours operations and cash handovers* makes `after_hours_access`,
  `after_hours_sessions`, `after_hours_cash`, `cash_handovers` and `cash_discrepancies` read-only to clients
  (`allow write: if false`, the Administrator included).
- **Worker isolation:** a worker reads only documents whose `staffUid` is their own uid (`ownWith('after_hours.request')`).
  Wider reads need `after_hours.view`, or `after_hours.approve` / `cash_handover.approve` /
  `after_hours.discrepancy.review` for the records each one acts on. Tested in `rules.test.js`:
  - the read matrix;
  - own-query isolation;
  - no client writes;
  - no self-granting through a profile edit;
  - an expired grant opens nothing;
  - a denial removes visibility;
  - unauthenticated access is blocked.
- **No escalation through after-hours access:**
  - an authorisation can only carry the fixed allow-list (AFTER_HOURS.md), as temporary grants that expire on their
    own;
  - the authorisation-only permissions cannot be granted any other way;
  - the target must be an active account the supervisor may administer, eligible (permanent `after_hours.request`),
    and not the supervisor themselves.
- **Server-authoritative figures:** the expected cash, differences, session totals and handover state are calculated
  by the Cloud Functions from the payments themselves. Any `expectedCashUgx` or total sent by the app is ignored
  (tested).
- **Every mutation:** re-reads the caller and the authorisation window on the server clock inside a transaction,
  writes its audit entry in the same transaction, and is idempotent by `requestId` (authorise, open, submit, receive,
  resolve) or by state checks (close, cancel, review, revoke).
- **Nothing deleted:** handovers and discrepancies are never deleted or cancelled; resolution adds fields and keeps
  the original figures.
- **Sensitive data:** audit values hold record numbers, amounts and statuses, never phone or identification numbers.
  Notifications carry only a type and record ID.
- **Storage rules:** unchanged. Phase 8 stores no documents or photos.

## Phase 9: final security review

**Rules tightened, never loosened:**

- Client-written audit entries may carry only the nine fields the app writes (`keys().hasOnly(...)`). A modified
  client can no longer forge `source: 'cloud_function'`, a reason or a target.
- `firebase/firestore.rules` has no other change. `firebase/storage.rules` is unchanged.

**Tested as a modified client** (`functions/test/rules.test.js`, Phase 9 block):

- **No direct writes:** 52 server-owned collections refuse create, update and delete from Administrator, Manager,
  Auditor and Cashier clients alike. This covers:
  - money: accounts, ledger, daily summaries, payments, invoices;
  - payroll and salaries;
  - ownership: shares, contributions, dividends;
  - after-hours: expected cash, handovers;
  - reconciliations, settings, counters and reservations.
- **Notifications:** a person reads only their own; queries must filter on the recipient; only `read` / `readAt` may
  change; nobody creates, deletes, or reads another's inbox (Administrators included).
- **Own profile:** only session fields may change (last login, device tokens). Preferences, role, permissions, denials
  and credential flags cannot be written, and nobody may write another person's tokens.
- **Signed-out clients** read nothing, anywhere.

**Storage rules** (`functions/test/storage_rules.test.js`):

- **Tested on the emulator:**
  - signed-out access is denied;
  - unknown paths are denied, even to Administrators;
  - evidence and staff documents can never be deleted.
- **Role-based cases** (who may upload or read which evidence) need the rules' Firestore profile look-up, which this
  environment's Storage emulator cannot evaluate. It denies them, so the rules fail closed. These cases are written
  and skipped with the reason, and must be checked on the deployed development project (PRODUCTION_READINESS.md
  item 41).

**Server-side protections verified:**

- **Callable authorisation:**
  - every one of the 124 signed-in callables re-checks the caller inside its transaction (active, permission, target
    rank);
  - `getBusinessReport` checks the report and each section;
  - `updateNotificationPreferences` only ever touches the caller's own profile and refuses critical categories.
- **Temporary permissions:** they expire by time in the rules and in every function. Revocation is immediate.
  After-hours-only permissions cannot be granted permanently or through the generic grant (Phase 8 tests). The Phase 9
  menus appear only while grants are live.
- **Financial integrity under concurrency** (`functions/test/integrity.test.js`), with simultaneous requests:
  - two payments cannot overpay an invoice;
  - a double-tapped payment is recorded once, and a raced reversal happens once;
  - an expense is approved and paid once;
  - stock never goes below zero, and always equals the sum of its movements;
  - a handover is counted by one receiver only;
  - one session opens per worker;
  - one assignment and one completion per job;
  - the ledger stays consistent throughout.
- **Errors:**
  - server messages written for users are shown as they are;
  - anything else becomes a generic message, so there are no stack traces or paths (tested);
  - a request whose answer was lost is reported as "may already have been saved", never "failed". Retrying is safe
    because money commands carry a `requestId`.
- **Secrets:**
  - the only server secret (`RAMOSMAX_AUTH_API_KEY`) is in Secret Manager;
  - no keystore, key file, `.env` or service-account JSON is tracked;
  - `google-services.json` and `firebase_options_*.dart` are public client configuration.
- **App Check** is not enforced yet (`enforceAppCheck: false`). Recommended after Play Integrity and DeviceCheck are
  registered. Access control does not depend on it.
