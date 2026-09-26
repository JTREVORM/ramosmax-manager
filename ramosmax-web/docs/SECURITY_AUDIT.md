# Security audit

Against the development database built from `supabase/migrations/0001` to
`0052` and the application in `ramosmax-web/`. Every figure below was read
from the database, not from the source.

Scope: RPC exposure, row-level security, privacy, financial integrity,
concurrency, idempotency and credentials. What this audit does **not** cover is
in [§9](#9-what-this-audit-does-not-cover), and no production-readiness claim is
made on the basis of it.

---

## 1 — The shape of the defence

Firestore rules decide reads and writes in one place. PostgreSQL has two, and
the port uses both:

1. **RLS decides what may be read.** Every table in `public` has RLS enabled
   *and forced*, so the policies apply to the table's owner too.
2. **Nothing may be written directly.** `authenticated` holds no INSERT,
   UPDATE, DELETE or TRUNCATE on any table. Every mutation goes through a
   `SECURITY DEFINER` function that re-checks the caller's permission.

| Measured | Value |
|---|---|
| Tables in `public` | 62 |
| With RLS disabled | **0** |
| With RLS not forced | **0** |
| INSERT/UPDATE/DELETE/TRUNCATE grants to `authenticated` | **0** |
| Any grant at all to `anon` | **0** |
| `SECURITY DEFINER` functions | 253 |
| …without a pinned `search_path` | **0** |

A pinned `search_path` on every definer function closes the classic
privilege-escalation route: a function that resolves `users` through the
caller's `search_path` can be made to read a table the caller planted.

## 2 — RPC exposure

| Measured | Value |
|---|---|
| Functions in `app` | 358 |
| Callable by a signed-in session | 184 |
| Callable by `anon` | **0** |

The 184 are an explicit allow-list, written out one signature at a time in
`0014`, `0020`, `0031`, `0038`, `0044`, `0046`, `0048`, `0050`, `0051`,
`0052` and `0053`. `rpc-exposure.test.ts` reads what is actually executable and fails on
anything not on the list. It has caught two real mistakes:

- a helper that became callable because PostgreSQL grants EXECUTE to `PUBLIC`
  on every new function, and
- `app.user_access`, added while writing the account screen, which the test
  refused until it was listed deliberately.

Each later privileges migration revokes from `PUBLIC` and `anon` **only**.
Revoking from `authenticated` as well would strip the explicit grants the
earlier migrations made — that mistake was made once, in an early draft of
`0046`, and caught by the same suite.

Three views are deliberately owner-run (`security_invoker = false`), each with
its permission predicate written into the view body: `payment_accounts`,
`share_register`, `share_register_totals`. An owner-run view is a read that
deliberately steps outside the caller's RLS, so each one states in SQL who it
will answer.

Four tables in `app` are readable by a signed-in session: `roles`,
`permissions`, `permission_groups`, `role_permissions`. These are the static
permission catalogue, the same list already shipped in the client bundle as
`catalogue.generated.ts`. They hold no business data and are never written by
a client.

## 3 — Privacy

Privacy here means: holding a figure does not entitle you to the person behind
it. Each of these is tested by attacking the data four ways — the table
directly, the view, a join from a table you may read, and every RPC that
touches it.

| Rule | Where | Test |
|---|---|---|
| A shareholder must never receive the register | Only `app.my_shareholding` answers a shareholder, and only about themselves | `ownership-privacy.test.ts` |
| Aggregate ownership must not leak identity | `share_register_totals` answers totals to a manager; `share_register` needs the register permission | `ownership-privacy.test.ts` |
| A worker sees their own pay, nobody else's | RLS on `salary_history`, `payroll_items`, `salary_deductions` | `workforce-privacy.test.ts` |
| A worker sees their own jobs, nobody else's | RLS on `worker_orders` | `operations-rls.test.ts` |
| A worker's after-hours float, session and discrepancy are their own | RLS on `after_hours_*` | `after-hours-privacy.test.ts` |
| A report never returns a figure the reader could not have queried | One server-side builder per domain; no second query to disagree with it | `reports-privacy.test.ts` |
| A notice never carries a name, an amount or a reference number | `app.notification_types` is static text, asserted type by type | `notifications.test.ts` |
| A phone number is masked in a list | `app.mask_phone` in the user list; the whole number needs `users.view` | `/users` |
| An audit entry may carry a whole record | Salary-, phone- and credential-shaped fields are left out of the rendered change summary | `/audit` |

## 4 — Financial integrity

| Rule | How |
|---|---|
| The ledger is append-only | `guard_ledger_immutable` refuses UPDATE and DELETE on `financial_transactions`, to everybody including the owner |
| So are payments, receipts, stock movements, the loyalty ledger, reconciliations, dividend allocations, share transactions and attendance history | `guard_payment_immutable`, `guard_stock_movement_immutable`, `guard_loyalty_ledger_immutable`, `guard_reconciliation_immutable`, `guard_dividend_allocation`, `guard_share_transaction`, `guard_attendance_history` — 22 guards over 124 triggers |
| A mistake is corrected by a counter-entry | Every module has a reverse: `reverse_payment`, `reverse_stock_movement`, `reverse_payroll_payment`, `reverse_dividend_payment`, `reverse_share_transaction`, `reverse_loyalty_transaction`, `reverse_allowance_payment` |
| Share capital is never revenue | `app.write_share_contribution` posts to a share-capital category; `finance-invariants.test.ts` asserts revenue is unchanged |
| Cash in custody is never revenue | A handover posts nothing at all to `financial_transactions`; `handovers.test.ts` counts the ledger before and after |
| A dividend is a distribution, never an operating expense | `app.pay_dividend` posts to a distribution category |
| A purchase is not an expense | Purchases post to inventory; `inventory.test.ts` asserts the expense total is unchanged |
| Money is whole shillings | Every `%_ugx` column is `bigint`; `schema.test.ts` asserts it across all 62 tables |
| A discrepancy never deducts from pay by itself | Resolving a shortage writes a loss incident with `deduction_id` null and `recovered_ugx` zero; recovery is a separate, approved step |
| Net pay is never negative | `payroll-calculation.test.ts` |
| Stock never goes negative | `inventory.test.ts` |

## 5 — Separation of duties

| Rule | Enforced by |
|---|---|
| A share movement is approved by somebody other than the person who requested it | `app.decide_share_transaction` |
| A dividend needs an Administrator | `app.update_dividend_status`, policy `dividend_policy.requireAdminApproval` |
| A payroll needs an Administrator after review | `app.update_payroll_status` |
| An expense is reviewed, then approved, then paid — and only paying moves money | `app.update_expense_status`, `app.pay_expense` |
| A handover is counted by somebody other than the person handing it over | `app.require_not_own_handover` |
| A shareholder may not act on their own holding | `app.require_not_own_shareholding` |
| Nobody may hand out access they do not hold | `app.require_can_grant`, `app.require_valid_permissions` |
| The last Administrator cannot be removed or demoted | `app.require_another_active_admin` |
| An after-hours authorisation may never carry administrative or financial permissions | `app.after_hours_grantable()`, a fixed allow-list |

## 6 — Concurrency

Every scenario below was written as two transactions racing on one connection
pool, not as a description.

| Scenario | Outcome | Test |
|---|---|---|
| Two payments with the same request id | One payment, one receipt | `billing-concurrency.test.ts` |
| Two payments with different request ids on one invoice | Both taken, never over-paying | `billing-concurrency.test.ts` |
| Two transfers from one account | Serialised by `SELECT … FOR UPDATE`; the second sees the first | `finance-concurrency.test.ts` |
| Two payrolls for one period | The second is refused | `workforce-concurrency.test.ts` |
| Two transfers of the same shares | Ordered locks on both shareholders; the second is refused | `ownership-concurrency.test.ts` |
| Two authorisations for one person | The second is refused — found as a real hole and fixed by locking the target user | `after-hours-concurrency.test.ts` |
| Two sessions for one person | A partial unique index refuses the second | `after-hours-concurrency.test.ts` |
| Two handovers, two receipts, two resolutions, a payment at the expiry boundary, a revoke mid-payment, a close mid-payment | Eight scenarios in all | `after-hours-concurrency.test.ts` |

Two real concurrency holes were found this way — simultaneous share transfers
and simultaneous after-hours authorisations — and both were fixed by ordered
row locks, not by retry.

## 7 — Idempotency

`app.request_keys` holds a request id and a fingerprint of the payload.
`app.claim_request` takes it, `app.complete_request` records the answer. The
same id with the same payload returns the first answer; the same id with a
*different* payload is refused rather than quietly overwriting. Request ids are
constrained to `^[A-Za-z0-9_-]{8,64}$`.

On the browser side, a mutation whose answer never arrives is never reported as
failed. `ActionForm` says it may already have been saved, because telling
somebody a saved change failed is how a business ends up doing it twice. No
financial mutation is queued offline, ever.

## 8 — Credentials

| | |
|---|---|
| Service-role key | Used only by `serviceDb()` in `src/lib/server/db.ts`, for the notification delivery run and the credential side effects of creating a user or resetting a password. Never reachable from a browser. |
| `POST /api/notifications/deliver` | Requires `NOTIFICATION_CRON_SECRET`; refuses without it |
| Session cookie | `httpOnly`, `SameSite=Lax`, `Secure` |
| Passwords | Never chosen by a human at creation: `app.new_user_credentials()` generates one, it is shown once and never stored in readable form, and the account can do nothing but replace it |
| Password reset | `app.prepare_password_reset` ends every session the person has open; the password itself is never written to the audit trail |
| Push subscriptions | `public.push_subscriptions` has no client grant at all |
| A person's own sessions | `users.sessions_valid_from` invalidates every issued session at once — used by deactivation and by a phone-number change |

## 9 — What this audit does not cover

The following are properties of a hosted Supabase project and cannot be
established against the local PostgreSQL bootstrap. They are the gate in
`docs/SUPABASE_SETUP.md`, and until they are done **no production-readiness
claim should be made**:

1. That PostgREST exposes exactly the 184 allow-listed functions and nothing
   else.
2. That GoTrue sign-in, refresh and `sessions_valid_from` revocation behave as
   the local provider does.
3. That `@supabase/ssr` cookie handling through `proxy.ts` carries the session
   correctly under a real origin and TLS.
4. That PgBouncer in transaction mode preserves the `SET LOCAL` session
   pattern every RLS policy depends on. **This is the one with the highest
   chance of surprising us**: if the pooler reuses a connection mid-session,
   an RLS predicate could read the wrong `auth.uid()`.
5. That the storage buckets behave as `firebase/storage.rules` does. The
   database half is done and tested — the path shapes, the permission to
   attach, and the refusal to replace or remove evidence (`evidence.test.ts`)
   — but no bucket exists yet, so no screen offers an upload.
   `docs/SUPABASE_SETUP.md` §4 states the three buckets and their rules.
6. Penetration testing, dependency CVE scanning and TLS configuration of the
   deployment.
