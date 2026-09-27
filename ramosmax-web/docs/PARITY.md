# Phase 1–9 parity

What the Flutter/Firebase implementation at the repository root does, and where
the Next.js/Supabase port does the same thing.

The reference is authoritative. Where this port differs, the difference is
listed in [§11](#11-deliberate-differences) with the reason; nothing has been
dropped silently, and nothing is listed as done that is not proved by a test.

| | |
|---|---|
| Reference | Flutter + Firebase, phases 1–9, repository root (unchanged) |
| Port | Next.js 16 App Router + TypeScript + Tailwind v4 + Supabase, `ramosmax-web/` |
| Migrations | 53 |
| Tables in `public` | 62 |
| Functions in `app` | 358, of which 184 may be called by a signed-in browser session |
| Permissions × roles | 127 × 6 |
| Screens | 73 |
| Database tests | 1,647 across 50 files |

How to read the Proof column: `x.test.ts` is `src/test/db/`, `scripts/x.mjs` is
an end-to-end run against the built application in a real browser.

---

## 1 — Foundation

| Reference capability | In the port | Proof |
|---|---|---|
| Environments (dev/prod separation) | `.env.example`, `backend()` in `src/lib/server/db.ts`; with no Supabase URL the app talks to PostgreSQL directly and calls the same functions | `docs/SUPABASE_SETUP.md`, `scripts/check-supabase.mjs` |
| Phone sign-in | `/login`, `app.sign_in_identity_for_phone`, phone normalised to a single stored form | `auth-functions.test.ts`, `scripts/check-auth-e2e.mjs` |
| Profiles | `public.users` with name, email, position, department, specialisation, staff link | `user-admin.test.ts`, `parity-gaps.test.ts` |
| Roles and permissions | `app.roles`, `app.permissions`, `app.role_permissions`, generated from the reference by `npm run gen:permissions` | `permission-parity.test.ts` (127 keys × 6 roles compared key by key) |
| Security rules | RLS on every table, forced; `authenticated` holds SELECT only; every mutation is a `SECURITY DEFINER` function behind an explicit EXECUTE allow-list | `rls.test.ts`, `rpc-exposure.test.ts`, `schema.test.ts` |
| Service catalogue | `/services`, `app.create_service`, `app.update_service`, whole-UGX prices | `operations-rules.test.ts` |
| Navigation shell | `src/lib/navigation/nav-config.ts`, six role menus, drawer on a phone | `scripts/check-responsive.mjs` |
| Branding | `src/app/globals.css` tokens, light and dark | `scripts/check-accessibility.mjs` (contrast at AA) |

## 2 — Authentication, users and roles

| Reference capability | In the port | Proof |
|---|---|---|
| In-app user management | `/users`, `/users/[userId]` | `user-admin.test.ts`, `scripts/check-auth-e2e.mjs` |
| Every access change through a server function | `create_user`, `set_user_role`, `set_user_active`, `set_user_permissions`, `update_user_profile`, `change_user_phone`, `link_staff` | `user-admin.test.ts`, `parity-gaps.test.ts`, `rpc-parity.test.ts` |
| Staff records and staff IDs | `users.staff_id`, one person per ID, `app.link_staff` | `parity-gaps.test.ts` |
| Permission editor | The Extra access panel: grants and denials on top of the role | `user-admin.test.ts` |
| Temporary permissions with a start and an end | `public.temporary_grants`, `app.grant_temporary_permission`, `app.revoke_temporary_permission`; every check is a direct time comparison, never a swept flag | `after-hours-auth.test.ts`, `parity-gaps.test.ts` (a grant moved into the past stops counting with nothing having run) |
| Last-Admin protection | `app.require_another_active_admin` on role change and deactivation | `user-admin.test.ts` |
| Nobody may hand out access they do not hold | `app.require_can_grant`, `app.require_valid_permissions`, `ADMIN_ONLY_PERMISSIONS`, `AUTHORIZATION_ONLY_PERMISSIONS` | `user-admin.test.ts`, `after-hours-auth.test.ts` |
| Password reset, must-change-password | `app.prepare_password_reset`, `users.must_change_password`; a temporary password permits nothing but replacing it | `auth-functions.test.ts` |
| Audit history | `public.audit_logs`, append-only, `/audit` | `rls.test.ts` (no update, no delete, by anybody) |
| Staff profile photo, tied to the staff ID | `app.set_profile_photo`; `app.link_staff` clears it, so a photo never follows somebody onto a staff record that is not theirs | `evidence.test.ts` |

## 3 — Customers, vehicles and services

| Reference capability | In the port | Proof |
|---|---|---|
| Plate-first search and registration | `/vehicles`, `normalized_number_plate` unique, plate-first lookup | `operations-rules.test.ts`, `operations-constraints.test.ts` |
| Customers, customer ↔ vehicle links | `/customers`, `app.set_vehicle_customer` | `operations-rules.test.ts` |
| Plate changes keep history | `app.change_vehicle_plate` with a reason, previous plates retained | `operations-rules.test.ts` |
| Service catalogue, whole UGX | `public.services`, `price_ugx bigint` | `schema.test.ts` (every `%_ugx` column is bigint) |
| Service intake | `app.create_service_intake`, `app.update_service_intake`, `RMX-JOB` | `operations-workflow.test.ts`, `parity-gaps.test.ts` |
| Worker isolation | A worker sees their own orders and nothing else | `operations-rls.test.ts` |

## 4 — Operations, billing and loyalty

| Reference capability | In the port | Proof |
|---|---|---|
| Jobs with `RMX-JOB` numbers | `app.create_service_intake` | `operations-workflow.test.ts` |
| Per-service worker orders, controlled status flow | `public.worker_orders`, `app.update_worker_order_status`, guarded by `app.require_open_order` | `operations-workflow.test.ts` |
| Assignment and reassignment with history | `app.assign_worker_order`, `app.reassign_worker_order` | `operations-workflow.test.ts` |
| Worker dashboard | `/my-jobs` | `scripts/check-operations-e2e.mjs` |
| Invoices (`RMX-INV`) | `app.create_invoice`, priced from the job, never from the browser | `billing-rules.test.ts`, `billing-invariants.test.ts` |
| Discounts with reasons and approval | `app.apply_invoice_discount` | `billing-rules.test.ts` |
| Partial payments with idempotency | `app.record_payment` + `app.request_keys` with a payload fingerprint | `billing-concurrency.test.ts` (the same request id twice pays once) |
| Receipts (`RMX-RCP`), share | `public.receipts`, written by `app.record_payment` in the same transaction as the payment; `/receipts/[receiptNumber]` | `scripts/check-billing-e2e.mjs` |
| Credit and receivables | `/credit`, days owed computed in the database | `billing-rules.test.ts` |
| Loyalty on the vehicle: +20 a wash, 25% at 200 | `app.award_invoice_loyalty`, `app.apply_loyalty_reward`, immutable ledger | `billing-rules.test.ts`, `billing-invariants.test.ts` |
| Loyalty corrections | `app.adjust_loyalty_points`, `app.reverse_loyalty_transaction` | `billing-rules.test.ts` |

## 5 — Finance, expenses and inventory

| Reference capability | In the port | Proof |
|---|---|---|
| Accounts: Cash at Hand, MTN, Airtel, banks | `public.financial_accounts`, the `payment_accounts` owner-run view | `finance-invariants.test.ts`, `rls.test.ts` |
| Immutable ledger (`RMX-TXN`) | `public.financial_transactions`, append-only, reversal only | `finance-invariants.test.ts` (no update, no delete, by anybody) |
| Every customer payment posts atomically | `app.record_payment` posts payment and ledger entry in one transaction | `billing-concurrency.test.ts`, `finance-concurrency.test.ts` |
| Transfers, bank deposits (`RMX-BNK`), cash awaiting banking | `app.transfer_funds`, `app.record_bank_deposit` | `finance-invariants.test.ts` |
| Reconciliation (`RMX-REC`) with explicit adjustments | `app.reconcile_account` | `finance-invariants.test.ts` |
| Expenses (`RMX-EXP`): review → approve → pay | `app.create_expense`, `app.update_expense_status` (review, then approval), `app.pay_expense`; only paying moves money | `expenses.test.ts` |
| Categories, recurring reminders | `/expenses/categories`, `/expenses/recurring` | `expenses.test.ts` |
| Items, suppliers (`RMX-SUP`), purchases (`RMX-PUR`), movements (`RMX-STM`) | `/inventory/**` | `inventory.test.ts` |
| Stock never negative; a purchase is not an expense | Refused in `app.move_stock`/`app.record_stock_movement`; a purchase posts to inventory through `app.post_purchase_payment`, never to expense | `inventory.test.ts` |
| Low-stock alerts | `reorder_level`, the inventory report and a notice | `inventory.test.ts`, `notifications.test.ts` |
| Evidence on a deposit, a reconciliation, an expense, a purchase | `attachment_path` + `app.attach_evidence`, validating the same path shape as `finance.js optionalAttachment`; never replaced, never removed | `evidence.test.ts` |

## 6 — Attendance, allowances, payroll and losses

| Reference capability | In the port | Proof |
|---|---|---|
| Attendance (`RMX-ATT`), lateness from policy, server-side | `app.record_attendance` compares against `settings/payroll_policy` on the database clock | `attendance.test.ts`, `workforce-eat.test.ts` |
| Verification and audited corrections | `app.verify_attendance`, `app.correct_attendance` | `attendance.test.ts` |
| Allowances (`RMX-ALL`), FULL / DEDUCT / REJECT | `app.calculate_allowances` reads the policy; the rule is never re-decided in TypeScript | `allowances.test.ts` |
| Paid through the Phase 5 ledger | `app.pay_allowances` → `app.post_transaction` | `allowances.test.ts` |
| Effective-dated salary history | `public.salary_history`, no overlap | `payroll-calculation.test.ts` |
| Payroll (`RMX-PAY`), server-side gross/deductions/net | `app.calculate_payroll` | `payroll-calculation.test.ts` |
| review → Admin approval → one transaction → lock | `app.update_payroll_status` (review, then Administrator approval), `app.pay_payroll`, `app.lock_payroll` | `payroll-lifecycle.test.ts` |
| Corrections and reversals; net never negative | `app.correct_payroll`, `app.reverse_payroll_payment`; a deduction can never take net below zero | `payroll-calculation.test.ts` |
| Losses (`RMX-LOSS`), approved recovery as a deduction (`RMX-DED`) | `app.create_loss_incident`, `app.review_loss_incident`, `app.decide_loss_incident`, `app.schedule_loss_recovery` — recovery is always a separate, approved step | `losses.test.ts` |
| Worker isolation | A worker sees their own attendance and pay, nobody else's | `workforce-privacy.test.ts` |
| East Africa Time is the business day | `app.eat_day()`, `app.eat_day_start()`, `app.iso_weekday()` | `workforce-eat.test.ts` |
| Evidence on attendance and on a loss | `attachment_path` + `app.attach_evidence`, validating the same path shape as `workforce.js optionalUpload`, into the payroll bucket and never the finance one | `evidence.test.ts` |

## 7 — Shareholders, shares and dividends

| Reference capability | In the port | Proof |
|---|---|---|
| Shareholder profiles (`RMX-SHR`), search, statuses | `/shareholders`, `app.create_shareholder` | `shareholders.test.ts` |
| Self-service for a linked shareholder | `/my-shares`, `app.my_shareholding` — a shareholder never receives the register | `ownership-privacy.test.ts` |
| Configurable share classes with historical snapshots | `app.create_share_class`, `app.update_share_class`; a transaction keeps the class as it stood | `shares.test.ts` |
| Immutable ownership ledger (`RMX-SHR-TXN`) | `public.share_transactions`, append-only; ownership is DERIVED by `app.rebuild_ownership()`, never stored as a mutable balance | `ownership-history.test.ts` |
| Issues, transfers, adjustments, reversals | `app.submit_share_transaction` (issue, transfer, adjustment), `app.transfer_shares`, `app.reverse_share_transaction`, applied by `app.post_share_transaction` | `shares.test.ts` |
| Second-person approval | `app.decide_share_transaction` — never the person who requested it | `shares.test.ts` |
| Contributions (`RMX-SHR-CON`) posted as share capital, never revenue | `app.write_share_contribution` → `app.post_transaction` with a share-capital category | `ownership-history.test.ts`, `finance-invariants.test.ts` |
| Ownership % and ownership on any date, server-side | `app.ownership_as_of(date)`, `app.ownership_percent()` | `ownership-history.test.ts` |
| Dividends (`RMX-DIV`): declare → calculate → approve → pay | `app.create_dividend`, `app.calculate_dividend`, `app.update_dividend_status` (Administrator approval), `app.pay_dividend` | `dividends.test.ts` |
| Record-date eligibility, frozen allocations (`RMX-DIV-PAY`) | Allocations are written once and never recalculated after approval | `dividends.test.ts` |
| Whole-shilling arithmetic, server-authoritative | `dividend_per_share_ugx bigint` alongside `per_share_rate numeric(20,4)`; the remainder is allocated, never lost | `dividends.test.ts` |
| Paid as a distribution, never an operating expense | `app.pay_dividend` posts to a distribution category in one transaction | `dividends.test.ts` |
| Guarded reversal and cancellation | `app.reverse_dividend_payment` writes a counter-entry and `app.cancel_dividend` never removes one; nothing is deleted | `dividends.test.ts` |
| A manager may see totals without seeing who | The `share_register` / `share_register_totals` owner-run views; direct table, view, join and RPC bypass are all refused | `ownership-privacy.test.ts` |

## 8 — After-hours and cash handovers

| Reference capability | In the port | Proof |
|---|---|---|
| Authorisations (`RMX-AH`) from a fixed allow-list | `app.after_hours_grantable()`; never permanent, never administrative or financial | `after-hours-auth.test.ts` |
| Carried by Phase 2 temporary permissions | `app.authorize_after_hours` writes `temporary_grants` rows | `after-hours-auth.test.ts` |
| Expiry without a scheduler | Every check is a direct time comparison; a window moved into the past stops working while the record still reads active | `after-hours-auth.test.ts` |
| Sessions (`RMX-AHS`) tag jobs, invoices and payments | `app.open_after_hours_session`, triggers `tag_after_hours` and `tag_completed_order` on the ordinary flows | `after-hours-sessions.test.ts` |
| Policy-limited payment methods | `app.after_hours_methods()` checked inside `app.record_payment` | `after-hours-payments.test.ts`, `after-hours-policy.test.ts` |
| Cash custody sub-ledger (`RMX-AHC`), distinct from revenue | `public.after_hours_cash`; a handover posts NOTHING to `financial_transactions` | `handovers.test.ts` (ledger count and account snapshot unchanged) |
| Server-calculated, frozen expected cash | `app.expected_from_payments` at submission; the figure never moves afterwards | `handovers.test.ts` |
| Handovers (`RMX-HO`) counted by a manager | `app.receive_cash_handover`; `app.require_not_own_handover` — never the person handing over | `handovers.test.ts` |
| Discrepancies (`RMX-AHD`) reviewed, resolved or waived | `app.review_cash_discrepancy`, `app.resolve_cash_discrepancy` | `discrepancies.test.ts` |
| A shortage may be reported as a Phase 6 loss — never an automatic deduction | Resolving writes a loss incident with `deduction_id` null and `recovered_ugx` zero, and no `salary_deductions` row | `discrepancies.test.ts` |
| Ending and overdue reminders | `app.sweep_after_hours()` writes notices only | `notifications.test.ts` |
| Concurrency | Eight scenarios: two authorisations, two sessions, two handovers, two receipts, two resolutions, a payment at the boundary, a revoke mid-payment, a close mid-payment | `after-hours-concurrency.test.ts` |
| Privacy | Another worker's session, float and discrepancy are invisible | `after-hours-privacy.test.ts` |

## 9 — Hardening, notifications, reports and production readiness

| Reference capability | In the port | Proof |
|---|---|---|
| Notification catalogue with safe payloads | `app.notification_types`, ~40 rows; no name, no amount, no reference number in any of them | `notifications.test.ts` (asserted for every type) |
| De-duplication | `notifications.dedupe_key` unique; a repeat inside the window returns `duplicate` | `notifications.test.ts` |
| Preferences with always-on critical notices | `users.notification_preferences`, `app.set_notification_preferences`; a critical category cannot be muted | `notifications.test.ts` |
| Delivery records and token clean-up | `app.record_push`, `app.drop_push_subscription` on a dead endpoint | `notifications.test.ts` |
| In-app inbox | `/notifications`, `app.my_notifications`, `app.unread_notification_count` | `scripts/check-reports-e2e.mjs` |
| Web Push | VAPID keys, `public/sw.js`, `POST /api/notifications/deliver` behind `NOTIFICATION_CRON_SECRET` | `docs/SUPABASE_SETUP.md` |
| Ten report domains, server-calculated | `app.business_report(text, date, date)` and the ten `app.report_*` builders | `reports.test.ts` |
| Permission-filtered | A cashier's report omits what a cashier may not see; there is no second query that could disagree | `reports-privacy.test.ts` |
| Bounded records with `truncated` | `app.report_max_rows()` = 5,000, `app.report_max_days()` = 400; totals are aggregated over the whole period so a truncated report still adds up | `reports.test.ts` |
| CSV export | `GET /api/reports/csv`, BOM for Excel, `=`/`+`/`-`/`@` defused, whole shillings | `scripts/check-reports-e2e.mjs` |
| Audit Logs and Settings screens | `/audit`, `/settings` | `scripts/check-accessibility.mjs`, `scripts/check-responsive.mjs` |
| Modified-client rules tests | Every server-owned table is written to directly, as each role, and refused | `rls.test.ts`, `operations-rls.test.ts` |
| Concurrency and idempotency | Same-request-id replay, simultaneous mutation, ordered locking | `billing-concurrency.test.ts`, `finance-concurrency.test.ts`, `workforce-concurrency.test.ts`, `ownership-concurrency.test.ts`, `after-hours-concurrency.test.ts` |
| "Unconfirmed" handling of a lost answer | `ActionForm` never reports a timed-out mutation as failed; it says it may already have been saved | `src/lib/online.ts`, `action-form` unit tests |
| Bounded queries | Every list function has a server-side limit | `reports.test.ts`, `rpc-parity*.test.ts` |
| Small-phone layout | 390px first, no horizontal scroll anywhere, 44px touch targets | `scripts/check-responsive.mjs` |
| Production-readiness documentation | `docs/SUPABASE_SETUP.md`, `docs/SECURITY_AUDIT.md`, `docs/CUTOVER.md`, `docs/GO_LIVE.md` | — |

## 10 — Callable-by-callable

The reference exposes 127 callables in `functions/src/index.js`. Each was
compared against this port one at a time.

| | Count |
|---|---|
| Ported with the same behaviour and the same refusals | 122 |
| Ported under a different name | 1 — `resetUserPassword` → `app.prepare_password_reset`, because the credential side effect belongs to the auth provider and not to SQL |
| Found missing by the review and added in `0049` | 4 — `update_user_profile`, `change_user_phone`, `link_staff`, `update_service_intake` |
| Dropped | 0 |

Names are not identical and were never meant to be: the reference's callables
are camelCase Cloud Functions, these are snake_case SQL functions, and several
lifecycle steps that the reference exposes separately are one function here
with the step as an argument — `approveDividend` and `rejectDividend` are both
`app.update_dividend_status`, `reviewExpense` and `approveExpense` are both
`app.update_expense_status`. Each step still enforces its own rule and its own
approver; only the entry point is shared.

`rpc-parity.test.ts`, `rpc-parity-e/f/g/h.test.ts` call every one of them and
assert the refusals, not merely that they run.

## 11 — Deliberate differences

Each of these is a difference from the reference that was made on purpose. No
other behavioural difference is known.

| # | Reference | Port | Why |
|---|---|---|---|
| 1 | Firestore rules + Cloud Functions | RLS + `SECURITY DEFINER` functions behind an EXECUTE allow-list | The nearest equivalent on PostgreSQL. `authenticated` holds SELECT only, so a stolen anon key reads what RLS allows and writes nothing. |
| 2 | A report's list and its totals are both capped | Only the lists are capped; totals are aggregated over the whole period in the database | A capped total is a wrong total. A truncated report now still adds up, and says so. |
| 3 | Offline queue for some writes | No financial mutation is ever queued. Reads may come from cache | The standing instruction: business and financial mutations must never be queued offline. |
| 4 | Scheduled functions sweep expiries | Expiry is a direct time comparison at every check; the sweep only writes reminders | A window must close on time whether or not anything is running. |
| 5 | `sharesAfter` stored on each transaction line | Derived by `app.share_transaction_lines(uuid)` | The guard that keeps the ledger immutable refuses a post-apply write, and a derived figure cannot drift from the ledger. |
| 6 | `dividendPerShare` as a decimal | `dividend_per_share_ugx bigint` plus `per_share_rate numeric(20,4)` | Every `%_ugx` in this database is a whole shilling. The rate is kept beside it for the arithmetic. |
| 7 | The evidence path is passed to the function that creates the record | It is a separate call, `app.attach_evidence`, made after the upload finishes | A failed upload can then never take the record down with it. The path shape, the permission and "never replaced, never removed" are unchanged. |

## 12 — Not verified here

Everything above is proved against PostgreSQL 16 with the Supabase platform
objects emulated by `supabase/local/00_platform_bootstrap.sql`. The following
cannot be proved without a hosted Supabase project, and are listed in
`docs/SUPABASE_SETUP.md` as the gate before any production claim:

1. PostgREST exposure of `app` functions matching the EXECUTE allow-list.
2. GoTrue sign-in, session refresh and `sessions_valid_from` revocation.
3. `@supabase/ssr` cookie handling through `proxy.ts`.
4. PgBouncer in transaction mode against the `SET LOCAL` session pattern.
5. A scheduler calling `POST /api/notifications/deliver`.
6. Storage buckets for evidence, and the upload itself.

**No production-readiness claim is made on the basis of the local bootstrap.**
