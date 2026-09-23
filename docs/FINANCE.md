# Finance: accounts, ledger, transfers, banking and reconciliation (Phase 5)

The server code is in `functions/src/finance.js`. The app code is in `lib/features/finance/`.

The rule is the same as for billing: **the app never writes a balance, a number or a ledger entry.** It sends what
the person asked for ("move UGX 400,000 from Cash to Bank"). The server re-reads the caller's permissions, validates
the request, moves the money and appends the ledger entry in **one Firestore transaction**. If any step fails, nothing
is written. The Firestore rules deny every client write to these collections.

## Financial accounts

`financial_accounts/{accountId}`

| Field | Notes |
|---|---|
| `accountId`, `name`, `type` | `type`: `cash`, `mobile_money` or `bank` (the brief's CASH / MOBILE_MONEY / BANK) |
| `provider`, `accountNumber` | Bank or network name; account or merchant number |
| `openingBalanceUgx`, `openingBalanceRecorded` | Recorded once per account (see below) |
| `balanceUgx` | **Server-maintained.** Changes only together with a ledger entry |
| `awaitingBankingUgx` | Cash accounts only (see *Cash awaiting banking*) |
| `active`, `isDefault`, `paymentMethod`, `notes` | |
| `transactionCount`, `lastTransactionAt` | |
| `createdAt`, `updatedAt`, `createdBy`, `updatedBy` | |

### Default accounts

| ID | Name | Type | Receives |
|---|---|---|---|
| `cash_at_hand` | Cash at Hand | cash | Cash payments |
| `mtn_merchant` | MTN Merchant | mobile_money | MTN Merchant payments |
| `airtel_merchant` | Airtel Merchant | mobile_money | Airtel Merchant payments |
| `bank_1` | Bank Account 1 | bank | Bank payments (while it is the only bank account) |

The defaults are created **on first use**: by the first posting that touches them, or all at once with
`ensureDefaultFinancialAccounts` (the **Set up** button on the Accounts screen). No migration is needed. Until an
account document exists, the app shows it with a zero balance.

Cash at Hand, MTN Merchant and Airtel Merchant receive customer payments, so they **can never be deactivated**. There is
only ever one cash account.

### Managing accounts (`finance.accounts.manage`, Admin by default)

- `createFinancialAccount({name, type: 'bank' | 'mobile_money', provider?, accountNumber?, notes?, openingBalanceUgx?})`.
  Names are unique (case-insensitive, including the default names). Account numbers are unique per type.
- `updateFinancialAccount({accountId, name?, provider?, accountNumber?, notes?, active?, reason?})`. The type and
  balance can never be changed. Deactivation needs a reason and a **zero balance**, so money can never be hidden in an
  inactive account.
- `recordOpeningBalance({accountId, amountUgx, reason?})`: **once per account**. It posts an `opening_balance` ledger
  entry. To correct it, reverse that entry (which allows recording it again) or post an adjustment.

Every create, change, activation and opening balance is audited.

## The ledger

`financial_transactions/{id}` is **immutable**. Each entry has a server-allocated number (`RMX-TXN-000001`), which is
never reused, and records:

- `type`, `amountUgx`, `sourceAccountId`/`Name` (money out) and `destinationAccountId`/`Name` (money in);
- `entries`: for every account it touched, the signed change and the balance after it (`deltaUgx`, `balanceAfterUgx`);
- `accountIds` (for account statements) and `isRevenue` (true only for customer payments);
- links: `paymentId`, `invoiceId`/`Number`, `expenseId`/`Number`, `purchaseId`/`Number`, `depositId`/`Number`,
  `reconciliationId`;
- `reference`, `description`, `reason`, `approvedBy`, `requestId`, `transactionDate` (the business date);
- `status` (`posted` or `reversed`), `reversedByTransactionId`, `reversalOfTransactionId`, `reversalReason`;
- `createdBy`, `createdByName`, `createdAt` (server time), `businessDay` (EAT).

| Type | Brief | Effect | Posted by |
|---|---|---|---|
| `customer_payment` | CUSTOMER_PAYMENT | + account | `recordPayment` (billing) |
| `expense_payment` | EXPENSE_PAYMENT | − account | `payExpense` |
| `inventory_purchase_payment` | INVENTORY_PURCHASE_PAYMENT | − account | `payPurchase`, `receivePurchase` |
| `account_transfer` | ACCOUNT_TRANSFER | − source, + destination | `transferFunds` |
| `bank_deposit` | BANK_DEPOSIT | − cash/mobile money, + bank | `recordBankDeposit` |
| `adjustment` | ADJUSTMENT | + or − account | `recordAccountAdjustment` |
| `opening_balance` | OPENING_BALANCE | + account | `recordOpeningBalance`, `createFinancialAccount` |
| `reversal` | REVERSAL | the mirror of the original | `reverseFinancialTransaction`, `reversePayment`, `reverseAllowancePayment`, `reversePayrollPayment` |
| `allowance_payment` (Phase 6) | — | − account | `payAllowances` (one entry per batch; ALLOWANCES.md) |
| `payroll_payment` (Phase 6) | — | − account | `payPayroll` (one entry per payroll; PAYROLL.md) |

**Reconciliation guarantee:** for every account, `balanceUgx` equals the sum of `entries[].deltaUgx` over the ledger.
The emulator tests check this after every scenario (`assertLedgerConsistent` in `functions/test/helpers.js`).

**No overdraft.** Any outflow larger than the account's balance is refused with `insufficient_funds`, which includes
`availableUgx`. This applies to transfers, deposits, expense and purchase payments, adjustments and reversals. No
overdraft policy is configured in Phase 5.

### Daily summaries

`finance_daily_summaries/{yyyy-mm-dd}` (EAT business day) is added to in the same transaction as every ledger
entry. It holds:

- `customerPaymentsUgx`, `expensesPaidUgx`, `purchasesPaidUgx`, `transfersUgx`, `depositsUgx`;
- `adjustmentsInUgx`, `adjustmentsOutUgx`, `openingBalancesUgx`;
- Phase 6: `allowancesPaidUgx`, `payrollPaidUgx` (staff pay — outflows, never revenue; shown as "Staff pay" on the
  dashboard and in reports, and subtracted in "Net cash from operations");
- `reversals.{originalType}Ugx`;
- `expensesByCategory.{categoryId}`, `byAccount.{accountId}.inUgx/outUgx`;
- `transactionCount`.

The dashboard's "today" figures and the reports read these server totals. The phone never adds up raw payments to
make a financial decision. A reversal counts on the day it is made (standard ledger practice), so a period's net
income is `customerPayments − reversals.customer_payment`.

## Customer payments (Phase 4 integration)

`recordPayment` (billing.js) now also, **in the same transaction**:

1. resolves the account:
   - cash → `cash_at_hand`;
   - `mtn_merchant` → `mtn_merchant`;
   - `airtel_merchant` → `airtel_merchant`;
   - bank → the `accountId` the cashier chose, or the only active bank account, or `bank_1` if none exists yet.
   With several active bank accounts, a bank payment without `accountId` is refused (`bank_account_required`).
2. checks that the account is active and of the right type;
3. posts a `customer_payment` entry. The payment stores `financialAccountId`, `financialTransactionId` and
   `financialTransactionNumber`.

If the posting fails (for example, an inactive account), the payment, receipt and invoice change are not written
either.

**Idempotency:** the existing Phase 4 key (`unique_keys/payment_request_{id}`) covers the posting too. A retried request
returns the first result and posts nothing. The original payment remains the revenue event; the ledger entry records
where the money went.

`reversePayment` posts a `reversal` out of the same account and marks the original entry `reversed`. It is refused if
the account no longer holds the money (for example, the cash was already banked): record an adjustment or reverse the
deposit first. Payments recorded **before** Phase 5 have no ledger entry and move nothing when reversed. Record the
money held on go-live as opening balances.

The cashier's payment sheet shows a **"Received into bank account"** choice when more than one bank is active. The
list comes from `settings/payment_accounts`, which the server maintains with names and masked numbers only (no
balances). That is why cashiers, who do not hold `finance.view`, can use it.

## Transfers (`finance.transfer`)

`transferFunds({fromAccountId, toAccountId, amountUgx, reason, requestId, transferDate?, reference?, description?})`

- Source and destination must differ, and both must be active.
- The amount is whole UGX, from 1 to 2,000,000,000.
- A reason is required, and the date cannot be in the future.
- Both balances change in one transaction, with one `account_transfer` entry (`isRevenue: false`) and an audit entry.
- `requestId` makes a retried request a no-op that returns the first result (`unique_keys/request_{id}`, bound to the
  caller and the kind of request).
- Concurrent transfers can never overdraw the source; an emulator test runs three at once.

A transfer is **never** income. It appears under "transfers & deposits" and never under customer payments.

## Cash awaiting banking

`financial_accounts/cash_at_hand.awaitingBankingUgx` is the cash collected from customers that has not yet gone to a
bank. It is **part of** the Cash at Hand balance, never additional money.

- It increases with every cash customer payment.
- It decreases when cash goes to a bank account (a bank deposit or a transfer), and with cash payment reversals.
- It increases again if such a deposit or transfer is reversed.
- It is always clamped to `0 … balanceUgx`. If cash is spent on an expense, the waiting amount can never exceed the
  cash actually held.
- An opening float is not takings, so it does not count as awaiting banking.

The **Banking** screen shows the waiting amount, the deposit history and **Record bank deposit** (pre-filled with the
waiting amount).

## Bank deposits (`finance.deposit`)

`recordBankDeposit({sourceAccountId = 'cash_at_hand', bankAccountId, amountUgx, bankReference, requestId, depositDate?, description?, attachmentPath?})`

- It creates `bank_deposits/{id}` with a number `RMX-BNK-000001`, `status: completed`, the ledger entry
  (`bank_deposit`) and the audit entry, in one transaction.
- It refuses:
  - an amount that is not positive;
  - the same source and destination;
  - a destination that is not a bank;
  - a source that is a bank (use a transfer);
  - more than the source's balance;
  - a missing slip or reference number.
- `requestId` stops a double submission from recording a second deposit.
- Deposit slips can be photographed (`finance_uploads/deposits/…`).

Reversing a deposit (`finance.adjust`) marks it `reversed` and restores both balances and the waiting amount.

## Reconciliation (`finance.reconcile`)

`reconcileAccount({accountId, actualBalanceUgx, requestId, reconciliationDate?, notes?, attachmentPath?})` records
`reconciliations/{id}` (`RMX-REC-000001`):

- the system balance, read inside the transaction;
- the counted or statement balance;
- `differenceUgx = actual − system`;
- `status`: `balanced`, `discrepancy` or `adjusted`;
- the notes, the attachment and who reconciled it.

**It never changes the balance.** The app shows the difference live before saving.

A difference is closed only by an explicit, authorised adjustment:
`recordAccountAdjustment({accountId, direction: 'in' | 'out', amountUgx, reason, requestId, reconciliationId?})`,
which requires `finance.adjust` (Admin by default).

- When linked to a reconciliation, the amount and direction must equal the difference exactly (`adjustment_mismatch`
  otherwise).
- The reconciliation then becomes `adjusted`, with the adjustment's transaction ID.
- An outgoing adjustment can never take an account below zero.

## Reversals (`reverseFinancialTransaction({transactionId, reason})`)

| Original | Permission | Also |
|---|---|---|
| transfer, deposit, adjustment, opening balance | `finance.adjust` | Deposit marked `reversed`. Opening balance can be recorded again. |
| expense payment | `expenses.adjust` | Expense returns to `approved` (unpaid), with `paymentReversalReason` |
| stock purchase payment | `expenses.adjust` | Purchase returns to `paymentStatus: unpaid` |
| customer payment | refused (`use_payment_reversal`) | Use **Reverse payment** on the invoice (`payments.reverse`) |
| allowance or payroll payment | refused (`use_pay_reversal`) | Reverse it from the allowance (`allowances.adjust`) or the payroll (`payroll.adjust`), which also undoes what the payment applied |
| a reversal | refused (`is_reversal`) | |

Both entries stay in the ledger. The reversal has its own new number. The original records who reversed it, when and
why. A transaction can be reversed only once.

## Permissions

| Permission | Admin | Manager | Cashier | Auditor | Shareholder | Worker |
|---|---|---|---|---|---|---|
| `finance.view` (balances, dashboard, daily totals) | ✓ | ✓ | | ✓ | ✓ | |
| `finance.transactions.view` (ledger, deposits, reconciliations) | ✓ | ✓ | | ✓ | | |
| `finance.accounts.manage` | ✓ | | | | | |
| `finance.transfer` | ✓ | ✓ | | | | |
| `finance.deposit` | ✓ | ✓ | | | | |
| `finance.reconcile` | ✓ | ✓ | | | | |
| `finance.adjust` | ✓ | | | | | |

Any of these can be granted to a person, including temporarily. Cashiers no longer hold `finance.view` by default
(see ROLES_AND_PERMISSIONS.md). They record payments without seeing business-wide balances.

## Screens and routes

| Route | Screen |
|---|---|
| `/app/finance` | Dashboard: balances per account, total funds, cash awaiting banking, today's income / expenses / transfers, recent transactions, shortcuts |
| `/app/finance/accounts`, `/accounts/:id` | Accounts; account detail with statement, opening balance, reconcile, edit, deactivate |
| `/app/finance/transactions`, `/transactions/:id` | Ledger with type filter; entry detail with account movements and **Reverse** |
| `/app/finance/transfers` | Transfers list and **New transfer** |
| `/app/finance/banking` | Cash awaiting banking, deposits, **Record bank deposit** |
| `/app/finance/reconciliation` | Reconciliation history, **Reconcile an account**, **Record adjustment** |
| `/app/finance/reports` | Today / 7 days / this month / last month from the daily summaries |
| `/app/transactions`, `/app/reconciliation`, `/app/financial-summary` | The same screens as menu entries for Auditors, Cashiers (when granted) and Shareholders |

Every money-moving sheet keeps one `requestId` for its lifetime, so pressing the button again after a lost response is
recorded once. All of them are online-only (see OFFLINE.md).

## Audit actions

| Action | When |
|---|---|
| `financial_account.created` / `.updated` / `.activated` / `.deactivated` / `.opening_balance` | Account set-up |
| `finance.transfer` | A transfer |
| `finance.bank_deposit` | A bank deposit |
| `finance.reconciled` | A reconciliation |
| `finance.adjustment` | An adjustment |
| `finance.transaction_reversed` | A reversal |
| `payment.recorded` / `payment.reversed` | Now include `financialAccountId` and `transactionNumber` |
| `purchase.paid` | A stock purchase payment |

`expense.paid` is described in EXPENSES.md.

## Known limitations

- There is no overdraft policy. Outflows above the balance are always refused.
- Payments recorded before Phase 5 are not in the ledger. Enter go-live balances as opening balances.
- Cash handovers (`cash_handover.*`) are not part of Phase 5. The menu entry still opens "not available yet".
- Reports use EAT business days, with a reversal counted on the day it is made. Period reports are limited to 400 days
  of summaries per query.
- Deposits, transfers and adjustments are recorded and approved by the same authorised person (`approvedBy` = the
  actor). There is no separate second-person approval step.
