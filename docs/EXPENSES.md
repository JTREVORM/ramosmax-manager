# Expenses (Phase 5)

The server code is in `functions/src/expenses.js`. The app code is in `lib/features/expenses/`.

## The rule

**Creating, reviewing or approving an expense moves no money.** Only `payExpense` takes the amount out of a financial
account. It does so in one transaction with the `expense_payment` ledger entry, the status change to `paid` and the
audit entry (FINANCE.md). If any step fails, the expense stays `approved` and nothing moves.

```
draft ──submit──► pending_review ──review──► (reviewed) ──approve──► approved ──pay──► paid
                        │                                                │
                        └──reject (reason)──► rejected                   │
draft / pending_review / approved ──cancel (reason)──► cancelled         │
paid ──reverse payment (expenses.adjust, reason)──► approved ◄───────────┘
```

| Status | Brief | Meaning |
|---|---|---|
| `draft` | DRAFT | Being prepared; editable |
| `pending_review` | PENDING_REVIEW | Submitted. First **reviewed** (`reviewedAt`), then approved or rejected |
| `approved` | APPROVED | Approved and **unpaid**; the account is unchanged |
| `rejected` | REJECTED | Refused, with a reason. Final |
| `paid` | PAID | Money left the chosen account |
| `cancelled` | CANCELLED | Withdrawn, with a reason. Allowed before payment |

Review and approval are separate steps. An expense cannot be approved before it has been reviewed (`not_reviewed`),
and cannot be paid unless it is approved (`not_approved`). It can be paid only once (`already_paid`). A retried
payment request with the same `requestId` returns the first result.

A paid expense is corrected by reversing its payment (`reverseFinancialTransaction`, `expenses.adjust`). The money
returns to the account and the expense goes back to `approved`, so it can be paid correctly or cancelled. Nothing is
ever deleted.

## The record

`expenses/{id}`

| Field | Notes |
|---|---|
| `expenseNumber` | Server-allocated: `RMX-EXP-000001` |
| `categoryId`, `categoryName` | Category name is a snapshot |
| `description`, `amountUgx`, `expenseDate` | Amount is whole UGX, 1 to 2,000,000,000. The date may be up to a year ahead (bills) |
| `payee`, `paymentAccountId`, `reference`, `attachmentPath`, `notes` | Payee is the vendor. The account is only a plan until paid. Attachment path is `finance_uploads/expenses/…` |
| `status` | See above |
| `createdBy`/`Name`, `reviewedBy`/`Name`/`At`, `reviewNotes`, `approvedBy`/`Name`/`At` | |
| `rejectedBy`/`At`, `rejectionReason` | |
| `paidBy`/`Name`/`At`, `paidFromAccountId`/`Name`, `paymentReference` | |
| `financialTransactionId`/`Number` | The ledger entry of the payment |
| `cancelledBy`/`At`, `cancelReason`, `paymentReversalReason`/`TransactionId` | |
| `recurringExpenseId`, `dueDate` | Due items created from a recurring expense |
| `createdAt`, `updatedAt`, `updatedBy`, `requestId` | |

## Functions

| Function | Permission | Notes |
|---|---|---|
| `createExpense({…, submit, requestId})` | `expenses.create` | `submit: true` goes straight to `pending_review`. Status, approval and payment fields sent by the client are ignored |
| `updateExpense({expenseId, …, reason?})` | `expenses.create` (+ `expenses.review` to edit someone else's) | Only while `draft`, or `pending_review` and not yet reviewed. Changed fields are audited |
| `updateExpenseStatus({expenseId, action, reason?, notes?})` | `submit`: `expenses.create`; `review`: `expenses.review`; `approve`: `expenses.approve`; `reject`: `expenses.review` or `.approve`; `cancel`: `expenses.cancel` | Reject and cancel need a reason |
| `payExpense({expenseId, accountId, requestId, reference?, paymentDate?})` | `expenses.pay` | The only money movement. Refused above the account balance |
| `createExpenseCategory({name})`, `updateExpenseCategory({categoryId, name?, active?, reason?})` | `expenses.categories.manage` | |
| `createRecurringExpense`, `updateRecurringExpense` | `expenses.recurring.manage` | |

## Categories

The built-in categories (`expenseCategories` in `functions/src/access_catalog.json`, mirrored by
`ExpenseCategory.defaults`) are:

`utilities`, `operations`, `premises`, `repairs`, `financial_charges`, `marketing`, `transport`, `office`, `licences`,
`miscellaneous`

They need no set-up. A document in `expense_categories/{id}` is written only when someone renames or retires one, or
adds a custom category. The ID of a custom category is a slug of its name (`Security Services` → `security_services`).
Names are unique, case-insensitively. A retired (inactive) category cannot be used for new expenses; existing expenses
keep it.

## Recurring expenses

`recurring_expenses/{id}`:

- `name`, `categoryId`/`Name`, `expectedAmountUgx`;
- `frequency`: `weekly`, `monthly`, `quarterly` or `yearly`;
- `nextDueDate` and `anchorDay`;
- `reminderDaysBefore` (0–30, default 3) and `reminderAt`;
- `payee`, `paymentAccountId`, `notes`, `active`;
- `lastGeneratedExpenseId`/`At`.

**They are never paid automatically.** The scheduled function `sweepRecurringExpenses` runs daily at 06:00
Africa/Kampala. For every active item whose `reminderAt` has passed, it:

1. creates one **draft** expense for that due date: the "due item", with `recurringExpenseId`, `dueDate` and
   `createdBy: 'system'`;
2. advances `nextDueDate`. Months keep the anchor day and clamp in short months, so 31 Jan → 28 Feb → 31 Mar;
3. notifies everyone holding `expenses.approve` or `expenses.pay` with a `recurring_expense_due` notification.

Each due date is generated once (`unique_keys/recurring_due_{id}_{date}`), so running the sweep again changes nothing.
Deactivating a recurring expense requires a reason and stops its reminders.

## Permissions

| Permission | Admin | Manager | Cashier | Auditor | Worker | Shareholder |
|---|---|---|---|---|---|---|
| `expenses.view` | ✓ | ✓ | ✓ | ✓ | | |
| `expenses.create` | ✓ | ✓ | ✓ | | | |
| `expenses.review` | ✓ | ✓ | | | | |
| `expenses.approve` | ✓ | ✓ | | | | |
| `expenses.pay` (expenses and supplier purchases) | ✓ | ✓ | | | | |
| `expenses.cancel` | ✓ | ✓ | | | | |
| `expenses.adjust` (reverse expense or purchase payments) | ✓ | | | | | |
| `expenses.categories.manage` | ✓ | ✓ | | | | |
| `expenses.recurring.manage` | ✓ | ✓ | | | | |

Cashiers may record expenses (for example, petty cash) for review. They never review, approve or pay by default.
Auditors are read-only. Workers have no expense access unless granted.

## Screens

`/app/expenses` has these tabs:

- **Expenses**: status filter and search.
- **Pending approval**.
- **Recurring**: the list, add/edit, and an on/off switch that asks for a reason.
- **Categories**: add, rename, retire.
- **Reports**: shown to holders of `reports.financial.view` or `expenses.approve`.

`/app/expenses/new` and `/app/expenses/:id/edit` hold the form. It can attach a receipt photo.

`/app/expenses/:id` shows the details, the history (created, reviewed, approved, paid, rejected, cancelled, payment
reversed) and the actions allowed by the person's permissions. **Pay** asks which account to pay from, shows its
balance and blocks an amount above it.

### Reports

- **Paid out:** the server totals (`finance_daily_summaries`, expense payments less reversals, by payment day),
  optionally for one category.
- **Expenses dated in the period:** totals by status (draft, pending approval, approved/unpaid, paid, rejected,
  cancelled) and by category, plus daily totals. These are calculated from up to 500 records.
- **Large expenses:** expenses of at least `settings/finance.largeExpenseThresholdUgx` (default UGX 500,000).
- **Periods:** today, 7 days, this month and last month. Category filter.

Inventory purchases are **not** expenses and never appear here (see INVENTORY.md).

## Audit actions

- `expense.created`, `expense.updated`, `expense.submitted`, `expense.reviewed`, `expense.approved`, `expense.rejected`,
  `expense.cancelled`, `expense.paid`
- `expense_category.created`, `expense_category.updated`
- `recurring_expense.created`, `recurring_expense.updated`, `recurring_expense.deactivated`, `recurring_expense.due`
- `finance.transaction_reversed`, for reversed payments

## Known limitations

- The person who created an expense may also review and approve it, if they hold those permissions. There is no
  enforced separation of duties.
- A rejected expense is final. Record a new one if needed.
- Attachments can be added when an expense is created, not afterwards.
- Report breakdowns by status and category use the expense records (up to 500 per period). Paid totals always come
  from the server's daily summaries.
