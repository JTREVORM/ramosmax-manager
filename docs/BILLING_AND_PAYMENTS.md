# Billing: invoices, discounts, payments, receipts and credit (Phase 4)

The server code is in `functions/src/billing.js`. The app code is in `lib/features/billing/`.

The app **never** writes a total, balance, number, status, point or reward. It sends only what the person asked
for, such as "pay UGX 10,000 by MTN" or "10% discount, promotional". The server:

- re-reads the caller's permissions;
- validates the request;
- computes every amount;
- writes the records, counters and audit entries in **one transaction**, reading everything before writing.

The Firestore rules deny every client write to these collections.

## Amounts

All amounts are whole UGX integers in fields ending in `Ugx`. They are never floating point, and never negative.

```
subtotalUgx    = sum of the completed services' price snapshots (from the job)
discountUgx    = one discount per invoice, 0 ≤ discount ≤ subtotal
totalUgx       = subtotalUgx − discountUgx
paidUgx        = sum of active (not reversed) payments, ≤ totalUgx
outstandingUgx = totalUgx − paidUgx
```

Percentages round half-up to the shilling: `floor((amount × percent + 50) / 100)`. The app's previews use the same
formula (`Money.percentage`). A unit test checks that the two agree.

## Invoices

`createInvoice({intakeId})` requires `invoices.create` (Manager, Cashier, Admin). It is allowed only for a
**completed** job that has no invoice yet (otherwise `already_invoiced`, which includes the existing invoice's ID).
The invoice gets one line per completed order, priced from the job's price snapshot. Cancelled services are left
off, and later catalogue price changes never affect it. The job records `invoiceId` and `invoiceNumber`.
Concurrent attempts create exactly one invoice.

`paymentStatus` is computed by the server:

| Status | When |
|---|---|
| `unpaid` | nothing paid |
| `partially_paid` | something paid, balance remains |
| `credit` | balance remains and it was put on credit |
| `paid` | outstanding is 0 |
| `cancelled` | the invoice was cancelled |

`cancelInvoice({invoiceId, reason})` requires `invoices.void` (Manager, Admin). It needs a reason and is allowed
only when no active payment exists (reverse the payments first). The invoice is kept and marked cancelled, the
discount record is marked cancelled, and the job's `invoiceId` is cleared so the job can be invoiced again. A
loyalty reward used on the invoice is given back (see LOYALTY.md).

## Discounts

`applyInvoiceDiscount({invoiceId, discountType, discountValue, reasonCode, description?})`

- **Type:** `percentage` (1–100) or `fixed` (whole UGX, at most the subtotal).
- **Reason codes:** `manager_approval`, `promotional`, `service_issue`, `other`. `other` requires a description.
  `loyalty_reward` is set only by the loyalty flow.
- **One discount per invoice**, and only **before any payment** (`payments_exist`). To change it, cancel and
  re-invoice.
- **Stored** on the invoice (`discount`) and as a record in `discounts/{id}`: `discountType`, `discountValue`,
  `discountAmount`, `reasonCode`, `reason`, `description`, `approvedBy`, `createdBy`, `createdAt`.
- **Permissions:**

  | Role | Discounts |
  |---|---|
  | Manager / Admin | Apply and approve (`discounts.apply` + `discounts.approve`); `approvedBy` is recorded. |
  | Cashier | Only if `discounts.apply` is **granted** (it is no longer a Cashier default). Up to 25% of the subtotal; more is refused with `approval_required`. |
  | Worker | None. |
  | Auditor | Read-only. |

The app shows a live preview and disables **Apply** until a reason is given. It also warns a cashier when the
discount would need a manager.

## Payments

`recordPayment({invoiceId, amountUgx, method, reference?, requestId, notes?})` requires `payments.record`
(Manager, Cashier, Admin).

- **Methods, and the account each posts to (Phase 5):** `cash` → `cash_at_hand`, `mtn_merchant` →
  `mtn_merchant`, `airtel_merchant` → `airtel_merchant`, `bank` → the chosen bank account (`accountId`), or the only
  active bank account. The payment and its `customer_payment` ledger entry are written **in the same transaction**;
  the payment stores `financialAccountId` and `financialTransactionId`. If the posting fails, nothing is recorded.
  See FINANCE.md.
- **Reference:** a transaction reference is required for every method except cash.
- **Amount:** from 1 to the outstanding balance. Partial payments are allowed. Overpayment is refused
  (`overpayment`, which includes `outstandingUgx`); for cash, the cashier gives change.
- **Idempotency:** `requestId` is generated once per payment attempt in the app. A retry with the same ID (for
  example after a lost response or a double tap) returns the first result instead of charging again
  (`unique_keys/payment_request_{id}`).
- **Concurrency:** payments made at the same moment can never exceed the balance. An emulator test runs four
  concurrent UGX 5,000 payments against a UGX 15,000 invoice; exactly three succeed.
- **Receipt:** every payment issues a receipt `RMX-RCP-…` in the same transaction.
- **Loyalty:** the payment that makes the invoice fully paid also earns its loyalty points (LOYALTY.md).

`reversePayment({paymentId, reason})` requires `payments.reverse`, which only Admin holds by default (it can be
granted). It needs a reason and can be done once. The payment and its receipt are kept and marked `reversed`, the
balance returns to the invoice, and any loyalty points the invoice earned are taken back. Since Phase 5 the money
is also taken back out of the account it was posted to (a `reversal` ledger entry). This is refused if that account no
longer holds it, for example if the cash was already banked.

## Receipts

`receipts/{id}` is a full snapshot:

- business name, receipt, invoice and job numbers;
- plate, vehicle and customer;
- lines and subtotal, discount (with its label) and total;
- this payment and its method and reference;
- total paid and balance after the payment;
- loyalty points earned and the new balance;
- cashier and time.

The receipt screen shows it branded, with **Share / print**. Sharing uses the system share sheet
(`share_plus`, plain text), which reaches WhatsApp, SMS, email or a printing app. There is no printer
integration.

## Credit and receivables

`markInvoiceCredit({invoiceId, reason})` requires `credit.manage` (Manager, Cashier, Admin). It records that the
customer left owing the balance: `onCredit`, `creditReason`, `creditMarkedAt` and `creditMarkedBy`. **Credit is
money owed, not cash received.** Payments against a credit invoice work normally; once it is fully paid it
becomes `paid`.

The **Credit** screen (`credit.view`) shows:

- total outstanding and the number of invoices;
- totals by debt age: today, this week, this month, older;
- filters by age and status, and search by customer, plate or invoice;
- each invoice's balance and how long it has been owed.

The payment history is on each invoice.

## Audit

| Action | Audited as |
|---|---|
| Invoice created, cancelled, marked as credit | `invoice.created`, `invoice.cancelled`, `invoice.marked_credit` |
| Discount | `discount.applied`, `discount.loyalty_reward_applied` |
| Payment | `payment.recorded`, `payment.reversed` |

Every entry records the actor, previous and new values, and the reason, in the same transaction as the change.

## Screens and routes

| Route | Screen |
|---|---|
| `/app/invoices` | Invoices: status filter and search |
| `/app/invoices/:id` | Invoice detail: lines, totals, discount, loyalty offer, payments, and actions allowed by permission |
| `/app/payments` | Payments by period and method, with totals |
| `/app/receipts`, `/app/receipts/:id` | Receipts, and a receipt with share |
| `/app/credit` | Receivables |

All of these are online-only for writes. Offline, the screens show cached data and actions say to reconnect.
