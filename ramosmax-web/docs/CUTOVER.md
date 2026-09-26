# Cutover plan — prepared, not executed

**Nothing in this document has been run.** No production Firebase project has
been touched, no production data has been read or copied, and no production
deployment exists. This is the plan to be approved before any of it happens,
and the person who approves it is the business owner, not the person holding
the terminal.

Do not begin at step 1 until every box in `docs/GO_LIVE.md` is ticked.

---

## 0. What is being moved

| | From | To |
|---|---|---|
| Database | Cloud Firestore | Supabase (PostgreSQL 16) |
| Sign-in | Firebase Auth (phone) | Supabase Auth (GoTrue) |
| Server logic | Cloud Functions | `SECURITY DEFINER` functions in `app` |
| Files | Firebase Storage | Supabase Storage |
| Client | Flutter (Android, iOS) | Next.js in a browser, installable as a PWA |

The Flutter application stays exactly as it is until the business says
otherwise. It is the reference, it is the fallback, and it is what people go
back to if step 7 says to.

## 1. Freeze

1. Announce the window: a Sunday evening is the obvious choice, after the last
   job is invoiced and the day's cash is handed over.
2. **Every open after-hours session must be closed and every handover
   received.** A session that is open at the moment of the export is money in
   somebody's pocket with no record either side of the cut.
3. Turn off new sign-ins in the Flutter app (deactivate nothing — just stop
   the work).
4. Take a **full Firestore export** to a Cloud Storage bucket. This is the
   rollback, and it is taken before anything else happens.
5. Note the export's timestamp. Everything after it is re-entered by hand, not
   migrated.

## 2. Migrate

Migration is one-way, one-shot and reversible only by step 7.

```
firestore export  →  JSON  →  a load script  →  Supabase
```

Order matters, because every foreign key does:

1. `users`, `temporary_grants` — and every user gets a **new credential**.
   Firebase password hashes do not move to GoTrue, and nobody's password
   should. Everyone signs in with a temporary password and changes it.
2. `settings` — the policies, first, because the rest reads them.
3. `customers`, `vehicles`, `services`, `expense_categories`,
   `financial_accounts`, `suppliers`, `inventory_items`, `shareholders`,
   `share_classes`.
4. `service_intakes`, `worker_orders`, `invoices`, `invoice_items`,
   `discounts`, `payments`, `receipts`.
5. `financial_transactions` and `financial_transaction_entries` — **as
   history, not as postings**. The load writes rows directly with full
   privileges; it must never call `app.post_transaction`, which would
   double-count everything.
6. `expenses`, `bank_deposits`, `reconciliations`, `inventory_purchases`,
   `stock_movements`.
7. `attendance`, `worker_allowances`, `salary_history`, `payroll`,
   `payroll_items`, `loss_incidents`, `salary_deductions`.
8. `share_transactions`, `share_contributions`, `dividends`,
   `dividend_allocations` — then `select app.rebuild_ownership()`, which
   derives every holding from the ledger rather than trusting a copied
   balance.
9. `after_hours_*`, `cash_handovers`, `cash_discrepancies`.
10. `audit_logs` — last, and appended to, never replacing what the load itself
    wrote.
11. Every sequence and counter set past the highest imported number, or the
    first new `RMX-INV` collides with an old one.

Files are copied bucket to bucket with their paths unchanged, so every
`attachment_path` still resolves.

## 3. Reconcile before anybody is let in

The migration is not finished when it stops; it is finished when these agree.
Each is a number from Firestore and the same number from Supabase.

| # | Check |
|---|---|
| 1 | Row count, table by table, against the export's document count |
| 2 | Sum of every account balance, to the shilling |
| 3 | Sum of `financial_transactions` by category, to the shilling |
| 4 | Total outstanding on unpaid invoices |
| 5 | Loyalty points per vehicle |
| 6 | Shares per shareholder, and total shares per class |
| 7 | Every unpaid dividend allocation |
| 8 | Stock on hand per item |
| 9 | Salary in force per employee |
| 10 | Every account that may sign in, and the role it holds |

A difference of one shilling stops the cutover. There is no acceptable
rounding: both systems hold whole shillings.

## 4. Deploy

1. Deploy the web application to its production URL.
2. Set every environment variable from `.env.example`, with **production**
   values and a service-role key that exists only there.
3. Register the scheduler that calls `POST /api/notifications/deliver`.
4. Verify HTTPS, the PWA manifest and the service worker on a real phone on
   a Ugandan network — not on office Wi-Fi.

## 5. Let people in

1. Give each person their temporary password **in person**. Not over
   WhatsApp, not by SMS.
2. Watch the first real job end to end: intake → work → invoice → payment →
   receipt → the ledger.
3. Watch the first real handover, counted by a manager.
4. Keep the Flutter app installed on every phone for the whole of week one.

## 6. Run both for one week

For seven days, the Flutter app stays available **read-only in practice**:
nobody is told to use it, and if anybody does, that day is reconciled by hand
the next morning. At the end of the week, reconcile §3 again against the live
Supabase data.

## 7. Roll back — the only way

If §3 disagrees, or if anything in §5 goes wrong, roll back. There is one way
and it is decided in advance:

1. Stop the web application (take the deployment down; do not leave it half
   up).
2. Tell everybody to use the Flutter app, which has not been touched.
3. Re-enter anything recorded in the web application by hand, from the audit
   trail.
4. Do not try to migrate back. The Firestore export from §1 is the truth, and
   the Flutter app is still pointing at the live project.

The rollback stays available until the business says in writing that it does
not need it.

## 8. What must never be part of a cutover

- Copying a password hash.
- Skipping the reconciliation because the row counts matched.
- Posting imported history through `app.post_transaction`.
- Leaving an after-hours session open across the cut.
- Deleting the Firebase project. Not on the day, not in week one, not until
  the business decides — and that decision is theirs, in writing.
