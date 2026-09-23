# Data model

The Firestore collections in use after Phase 6. Conventions (timestamps, money, IDs) are in
[FIRESTORE_CONVENTIONS.md](FIRESTORE_CONVENTIONS.md).

```
Customer ──< Vehicle ──< Job (service_intakes) ──< Worker order (one per service) ──> Worker
   (0..1 per vehicle)  │     (0..1 open per vehicle)
                       │            └──(completed)──> Invoice ──< Payment ──1 Receipt
                       │                                 └──0..1 Discount (manual or loyalty reward)
                       └──1 Loyalty account ──< Loyalty transactions (ledger)
                                            └──< Loyalty rewards   └──> Loyalty events
```

Phase 5 (finance, expenses, inventory):

```
Payment ──1 Financial transaction (customer_payment) ──> Financial account ──< Daily summary (per EAT day)
Expense ──(paid)──1 Financial transaction (expense_payment)
Recurring expense ──(due)──> draft Expense
Bank deposit ──1 Financial transaction (bank_deposit);  Reconciliation ──0..1 Financial transaction (adjustment)
Supplier ──< Inventory purchase ──(received)──< Stock movement (stock_in) >── Inventory item
                                └─(paid)──1 Financial transaction (inventory_purchase_payment)
```

Phase 6 (attendance, allowances, salary, payroll, losses):

```
Staff member (users/{uid}) ──< Attendance (one per EAT day) ──< Attendance corrections
                           │         └──0..1 Allowance ──(paid directly)──1 Financial transaction (allowance_payment, per batch)
                           ├──1 Salary profile (latest) ──< Salary history (versions, effective-dated)
                           ├──< Loss incident ──0..1 Salary deduction (loss_recovery)
                           └──< Salary deduction (authorised / other)
Payroll (one per period) ──< Payroll items (one per employee per version) ──> allowances, deduction lines
        └──(paid)──1 Financial transaction (payroll_payment, whole payroll)
```

Details: OPERATIONS.md (jobs, worker orders), BILLING_AND_PAYMENTS.md, LOYALTY.md, FINANCE.md, EXPENSES.md,
INVENTORY.md, ATTENDANCE.md, ALLOWANCES.md, PAYROLL.md, LOSSES_AND_DEDUCTIONS.md.

Every Phase 6 record is keyed to the staff member's sign-in uid (`staffUid`) and carries their staff ID and name as
they were at the time; a worker's own records are exactly those with their uid.

| Collection | Written by | Read by (rules) | Detail |
|---|---|---|---|
| `users/{uid}` (+ `temporary_grants`) | functions (+ own session fields) | self, `users.view` | AUTHENTICATION.md, USER_MANAGEMENT.md |
| `staff/{staffId}` | functions | `staff.view`, linked person | USER_MANAGEMENT.md |
| `customers/{customerId}` | functions | `customers.view` | CUSTOMERS_AND_VEHICLES.md |
| `vehicles/{vehicleId}` | functions | `vehicles.view` | CUSTOMERS_AND_VEHICLES.md |
| `services/{serviceId}` | functions | `services.view` | SERVICES.md |
| `service_intakes/{intakeId}` (the job) | functions | `jobs.view` | SERVICES.md, OPERATIONS.md |
| `worker_orders/{id}` | functions | `jobs.view`, or the assigned worker (`jobs.view.own`) | OPERATIONS.md |
| `invoices/{id}` | functions | `invoices.view` | BILLING_AND_PAYMENTS.md |
| `discounts/{id}` | functions | `invoices.view` | BILLING_AND_PAYMENTS.md |
| `payments/{id}` | functions | `payments.view` | BILLING_AND_PAYMENTS.md |
| `receipts/{id}` | functions | `payments.view` or `invoices.view` | BILLING_AND_PAYMENTS.md |
| `loyalty_accounts/{vehicleId}` | functions | `loyalty.view` | LOYALTY.md |
| `loyalty_transactions/{id}` | functions | `loyalty.view` | LOYALTY.md (immutable ledger) |
| `loyalty_rewards/{id}` | functions | `loyalty.view` | LOYALTY.md |
| `loyalty_events/{id}` | functions | `loyalty.view` | LOYALTY.md (future customer messages) |
| `financial_accounts/{id}` | functions | `finance.view` | FINANCE.md (balances server-maintained) |
| `financial_transactions/{id}` | functions | `finance.transactions.view` | FINANCE.md (immutable ledger) |
| `finance_daily_summaries/{yyyy-mm-dd}` | functions | `finance.view` | FINANCE.md (server totals per EAT day) |
| `bank_deposits/{id}` | functions | `finance.transactions.view` or `finance.deposit` | FINANCE.md |
| `reconciliations/{id}` | functions | `finance.transactions.view` or `finance.reconcile` | FINANCE.md |
| `expenses/{id}` | functions | `expenses.view` | EXPENSES.md |
| `expense_categories/{id}` | functions | `expenses.view` | EXPENSES.md (only edited or custom categories are stored) |
| `recurring_expenses/{id}` | functions | `expenses.view` | EXPENSES.md |
| `inventory_items/{id}` | functions | `inventory.view` | INVENTORY.md (quantities server-maintained) |
| `stock_movements/{id}` | functions | `inventory.view` | INVENTORY.md (immutable) |
| `suppliers/{id}` | functions | `inventory.view` | INVENTORY.md |
| `inventory_purchases/{id}` | functions | `inventory.view` | INVENTORY.md |
| `attendance/{staffUid}_{yyyy-mm-dd}` | functions | `attendance.view`, or own (`attendance.view.own`) | ATTENDANCE.md (one per person per day; policy snapshot on each record) |
| `attendance_corrections/{id}` | functions | `attendance.view`, or own | ATTENDANCE.md (original + corrected values, reason, who; append-only) |
| `worker_allowances/{id}` | functions | `allowances.view`, or own (`allowances.view.own`) | ALLOWANCES.md |
| `salary_profiles/{staffUid}` | functions | `salary.view` (or legacy `staff.salary.view`), or own (`payroll.view.own`) | PAYROLL.md (latest version, for display) |
| `salary_history/{staffUid}_v{n}` | functions | `salary.history.view`, or own | PAYROLL.md (every version; never edited) |
| `payroll/{id}` | functions | `payroll.view` or `reports.payroll.view` (totals only) | PAYROLL.md |
| `payroll_items/{payrollId}_v{n}_{staffUid}` | functions | `payroll.view`, or own once paid (`payroll.view.own` + `visibleToStaff`) | PAYROLL.md (payslips; superseded versions kept) |
| `salary_deductions/{id}` | functions | `payroll.view`, `losses.view`, `deductions.manage`, or own | LOSSES_AND_DEDUCTIONS.md |
| `loss_incidents/{id}` | functions | `losses.view`, or own once decided (`visibleToStaff`) | LOSSES_AND_DEDUCTIONS.md |
| `audit_logs/{id}` | functions, app (own sign-out) | `audit.view` | FIRESTORE_CONVENTIONS.md |
| `notifications/{id}` | functions | recipient | NOTIFICATIONS_AND_MONITORING.md |
| `settings/{id}` | server only (Admin SDK) | active users | `settings/loyalty`: loyalty rules. `settings/payment_accounts`: active banks for bank payments (names and masked numbers, no balances). Optional: `settings/finance.largeExpenseThresholdUgx`, `settings/inventory.highValueThresholdUgx`. Phase 6: `settings/payroll_policy` (reporting time, grace period, working days, daily allowance, late policy, deduction limit, payroll approval rule; written only by `updatePayrollPolicy`) |
| `counters/{name}` | functions | nobody | `staff`, `customers`, `jobs`, `invoices`, `receipts`. Phase 5: `financial_transactions` (`RMX-TXN-`), `bank_deposits` (`RMX-BNK-`), `reconciliations` (`RMX-REC-`), `expenses` (`RMX-EXP-`), `suppliers` (`RMX-SUP-`), `inventory_purchases` (`RMX-PUR-`), `stock_movements` (`RMX-STM-`), `sku_{PREFIX}` (`RMX-CHEM-001` …). Phase 6: `attendance` (`RMX-ATT-`), `worker_allowances` (`RMX-ALL-`), `payroll` (`RMX-PAY-`; items `RMX-PAY-000001-001`), `loss_incidents` (`RMX-LOSS-`), `salary_deductions` (`RMX-DED-`) |
| `unique_keys/{kind_value}` | functions | nobody | Uniqueness reservations: `plate_{KEY}`, `customer_phone_{E164}`, `service_name_{lowercase}`, `item_name_{lowercase}`, `sku_{SKU}`, `supplier_name_{lowercase}`. Once-only guards: `payment_request_{id}` (payment idempotency, which also covers the payment's ledger posting), `request_{id}` (Phase 5 idempotency, bound to the caller and the kind of request), `loyalty_reversal_{txId}`, `recurring_due_{id}_{date}`. Phase 6: `payroll_{frequency}_{periodKey}` (one payroll per period; released when it is cancelled) |
| `login_throttle/{hash}` | functions | nobody | Sign-in lock-out counters |

No client can write any of these collections. Every create/update is a callable Cloud Function
(`functions/src/operations.js`, `jobs.js`, `billing.js`, `loyalty.js`, `finance.js`, `expenses.js`, `inventory.js`,
and for Phase 6 `workforce.js`, `attendance.js`, `allowances.js`, `payroll.js`, `losses.js`). Each one:

1. authorises the caller from their Firestore profile, re-read inside the transaction;
2. validates every field (names, E.164 phones, emails, plates, required model/colour, years, vehicle types,
   categories, whole-shilling prices, durations, reasons);
3. enforces integrity: unique plates, customer phones and service names, existing and active references, and one
   open intake per vehicle;
4. writes the change **and its audit entries in one transaction**.

| Function | Permission | Audited as |
|---|---|---|
| `createCustomer` | `customers.manage` | `customer.created` |
| `updateCustomer` | `customers.manage` | `customer.updated`, `customer.status_changed` |
| `createVehicle` (optionally with `newCustomer`) | `vehicles.manage` (+ `customers.manage`) | `vehicle.created` (+ `customer.created`) |
| `updateVehicle` | `vehicles.manage` | `vehicle.updated`, `vehicle.plate_changed`, `vehicle.customer_changed`, `vehicle.status_changed` |
| `createService` | `services.manage` | `service.created` |
| `updateService` | `services.manage` | `service.updated`, `service.price_changed`, `service.activated` / `service.deactivated` |
| `createServiceIntake` | `jobs.create` | `service_intake.created` (allocates `RMX-JOB-`, creates worker orders) |
| `updateServiceIntake` | `jobs.create` | `service_intake.updated`, `service_intake.cancelled` |
| `assignWorkerOrder` / `reassignWorkerOrder` | `jobs.assign` | `work_order.assigned` / `work_order.reassigned` |
| `cancelWorkerOrder` | `jobs.manage` | `work_order.cancelled` |
| `updateWorkerOrderStatus` | `jobs.complete` + assigned worker | `work_order.accepted` / `.started` / `.paused` / `.resumed` / `.completed` |
| `createInvoice` | `invoices.create` | `invoice.created` |
| `applyInvoiceDiscount` | `discounts.apply` (+ `discounts.approve` above 25%) | `discount.applied` |
| `applyLoyaltyReward` | `loyalty.redeem` | `discount.loyalty_reward_applied`, `loyalty.reward_redeemed`, `loyalty.points_redeemed` |
| `recordPayment` | `payments.record` | `payment.recorded` (+ `loyalty.points_earned`, `loyalty.reward_unlocked`) |
| `reversePayment` | `payments.reverse` | `payment.reversed` (+ `loyalty.points_reversal`) |
| `markInvoiceCredit` | `credit.manage` | `invoice.marked_credit` |
| `cancelInvoice` | `invoices.void` | `invoice.cancelled` (+ loyalty reversal) |
| `adjustLoyaltyPoints` | `loyalty.adjust` | `loyalty.points_adjustment` |
| `reverseLoyaltyTransaction` | `loyalty.adjust` | `loyalty.points_reversal` |
| `ensureDefaultFinancialAccounts`, `createFinancialAccount`, `updateFinancialAccount`, `recordOpeningBalance` | `finance.accounts.manage` | `financial_account.*` |
| `transferFunds` | `finance.transfer` | `finance.transfer` |
| `recordBankDeposit` | `finance.deposit` | `finance.bank_deposit` |
| `reconcileAccount` | `finance.reconcile` | `finance.reconciled` |
| `recordAccountAdjustment` | `finance.adjust` | `finance.adjustment` |
| `reverseFinancialTransaction` | `finance.adjust` (transfers, deposits, adjustments, opening balances); `expenses.adjust` (expense and purchase payments) | `finance.transaction_reversed` |
| `createExpense`, `updateExpense` | `expenses.create` | `expense.created`, `expense.updated` |
| `updateExpenseStatus` | per action: `expenses.create` / `.review` / `.approve` / `.cancel` | `expense.submitted` / `.reviewed` / `.approved` / `.rejected` / `.cancelled` |
| `payExpense` | `expenses.pay` | `expense.paid` |
| `createExpenseCategory`, `updateExpenseCategory` | `expenses.categories.manage` | `expense_category.*` |
| `createRecurringExpense`, `updateRecurringExpense` | `expenses.recurring.manage` | `recurring_expense.*` |
| `sweepRecurringExpenses` (scheduled, daily 06:00 EAT) | server | `recurring_expense.due` |
| `createInventoryItem`, `updateInventoryItem` | `inventory.manage` (+ `inventory.stock.in` for opening stock) | `inventory_item.*` |
| `recordStockMovement` | `inventory.stock.in` or `inventory.stock.out` (+ `inventory.stock.adjust` for high-value stock-outs) | `stock.stock_in` / `.usage` / `.stock_out` / `.return` |
| `adjustStock`, `reverseStockMovement` | `inventory.stock.adjust` | `stock.adjusted`, `stock.reversed` |
| `createSupplier`, `updateSupplier` | `inventory.suppliers.manage` | `supplier.*` |
| `createPurchase` | `inventory.purchase.create` | `purchase.created` |
| `updatePurchaseStatus` | `inventory.purchase.approve` | `purchase.approved`, `purchase.cancelled` |
| `receivePurchase` | `inventory.stock.in` (+ `expenses.pay` to pay at the same time) | `purchase.received` (+ `purchase.paid`) |
| `payPurchase` | `expenses.pay` | `purchase.paid` |
| `updatePayrollPolicy` | `settings.manage` | `payroll_policy.updated` |
| `recordAttendance` | `attendance.mark` (self, server time) or `attendance.record` (others) | `attendance.recorded` |
| `clockOut` | `attendance.mark` (self) or `attendance.record` | `attendance.clocked_out` |
| `verifyAttendance` | `attendance.approve` (approve); `attendance.review` or `.approve` (reject) | `attendance.approved`, `attendance.rejected` |
| `correctAttendance` | `attendance.correct` | `attendance.corrected` (+ `allowance.cancelled`) |
| `calculateAllowances` | `allowances.calculate` | `allowance.calculated` |
| `reviewAllowance` | `allowances.approve` (final) or `allowances.adjust` (proposal) | `allowance.approved`, `.rejected`, `.adjusted` |
| `payAllowances` | `allowances.pay` | `allowance.paid` |
| `reverseAllowancePayment`, `cancelAllowance` | `allowances.adjust` | `allowance.payment_reversed`, `allowance.cancelled` |
| `setSalaryProfile` | `salary.manage` | `salary.created`, `.changed`, `.deactivated`, `.activated` |
| `createPayroll`, `preparePayroll` | `payroll.prepare` (legacy `payroll.process`) | `payroll.created`, `payroll.prepared` |
| `updatePayrollStatus` | submit: `payroll.prepare`; review/return: `payroll.review`; approve: `payroll.approve` | `payroll.submitted`, `.reviewed`, `.returned`, `.approved` |
| `payPayroll` | `payroll.pay` | `payroll.paid`, `deduction.applied`, `loss.recovered` |
| `lockPayroll` | `payroll.approve` | `payroll.locked` |
| `correctPayroll`, `addPayrollEarning`, `removePayrollEarning`, `reversePayrollPayment`, `cancelPayroll` | `payroll.adjust` | `payroll.corrected`, `.earning_added`, `.earning_removed`, `.payment_reversed`, `.cancelled` |
| `createLossIncident` | `losses.create` | `loss.created` |
| `reviewLossIncident` | `losses.review` | `loss.reviewed` |
| `decideLossIncident` | `losses.approve` | `loss.approved`, `loss.rejected` |
| `scheduleLossRecovery` | `losses.schedule` | `loss.recovery_scheduled`, `deduction.created` |
| `cancelLossIncident` | `losses.adjust` | `loss.cancelled` |
| `createSalaryDeduction` | `deductions.manage` | `deduction.created` |
| `decideSalaryDeduction` | `payroll.approve` | `deduction.approved`, `deduction.rejected` |
| `cancelSalaryDeduction` | `deductions.manage` (or `losses.adjust` for a loss recovery) | `deduction.cancelled` |

Audit entries hold the actor, action, record ID, before/after values of changed fields and the reason. Phone numbers
are masked (`+256772•••456`).

## Indexes

Declared in `firebase/firestore.indexes.json`. Single-field queries (plate prefix on `normalizedNumberPlate`,
`customerId`, `phoneNumber`, `alternativePhone`, `customerNumber`, `searchTokens array-contains`, `services.name`)
use Firestore's automatic indexes.

| Collection | Fields | Used for |
|---|---|---|
| `customers` | `status` ↑, `createdAt` ↓ | Customer list filtered by Active/Inactive |
| `service_intakes` | `vehicleId` ↑, `status` ↑ | "Already has a service in progress" check |
| `service_intakes` | `vehicleId` ↑, `createdAt` ↓ | Vehicle service activity |
| `service_intakes` | `customerId` ↑, `createdAt` ↓ | Customer history |
| `service_intakes` | `status` ↑, `createdAt` ↓ | Jobs list filtered by status; dashboard counts |
| `worker_orders` | `workerId` ↑, `createdAt` ↓ | My Jobs (the rules require the `workerId` filter) |
| `worker_orders` | `status` ↑, `createdAt` ↓ | Orders by status (reporting) |
| `invoices` | `paymentStatus` ↑, `createdAt` ↓ | Invoice filters; receivables (`paymentStatus in [...]`) |
| `invoices` | `vehicleId` ↑, `createdAt` ↓ | Vehicle invoices |
| `invoices` | `customerId` ↑, `createdAt` ↓ | Customer invoices |
| `payments` | `invoiceId` ↑, `receivedAt` ↑ | Invoice payment history |
| `payments` | `method` ↑, `receivedAt` ↓ | Payments by method and period |
| `receipts` | `invoiceId` ↑, `issuedAt` ↑ | Receipts of an invoice |
| `loyalty_transactions` | `vehicleId` ↑, `createdAt` ↓ | Vehicle loyalty ledger |
| `loyalty_rewards` | `vehicleId` ↑, `status` ↑ | Available reward for a vehicle (also read inside transactions) |
| `financial_transactions` | `type` ↑, `createdAt` ↓ | Ledger filtered by type (Transactions, Transfers screens) |
| `financial_transactions` | `accountIds` (array-contains), `createdAt` ↓ | Account statement |
| `reconciliations` | `accountId` ↑, `createdAt` ↓ | Reconciliation history of one account |
| `expenses` | `status` ↑, `createdAt` ↓ | Expense list by status, Pending approval, dashboard count |
| `recurring_expenses` | `active` ↑, `reminderAt` ↑ | The daily recurring-expense sweep (server) |
| `inventory_items` | `stockStatus` ↑, `name` ↑ | Low-stock list (`stockStatus in [low, out_of_stock]`) |
| `stock_movements` | `itemId` ↑, `createdAt` ↓ | Item movement history |
| `stock_movements` | `type` ↑, `createdAt` ↓ | Movements and Adjustments filtered by type |
| `inventory_purchases` | `supplierId` ↑, `createdAt` ↓ | Supplier purchase history |
| `inventory_purchases` | `status` ↑, `createdAt` ↓ | Purchases filtered by status |
| `attendance` | `staffUid` ↑, `date` ↓ | A person's attendance (the rules require the `staffUid` filter for workers) |
| `attendance` | `verificationStatus` ↑, `date` ↓ | Verification queue |
| `attendance` | `dayKey` ↑, `staffName` ↑ | Day view |
| `attendance_corrections` | `attendanceId` ↑, `createdAt` ↓ / `staffUid` ↑, `createdAt` ↓ | Correction history |
| `worker_allowances` | `status` ↑, `date` ↑ / ↓ | Payroll preparation (approved in the period, server) / lists by status |
| `worker_allowances` | `staffUid` ↑, `date` ↓ | A person's allowances |
| `salary_history` | `staffUid` ↑, `effectiveFrom` ↓ | Version history |
| `payroll` | `status` ↑, `periodStart` ↓ | Payroll by status |
| `payroll_items` | `payrollId` ↑, `current` ↑, `staffName` ↑ | A payroll's current items |
| `payroll_items` | `staffUid` ↑, `visibleToStaff` ↑, `periodStart` ↓ | My payslips (the rules require both filters) |
| `payroll_items` | `current` ↑, `allowanceIds` (array-contains) / `current` ↑, `paymentStatus` ↑ | "Already in a payroll" checks (server) |
| `salary_deductions` | `staffUid` ↑, `createdAt` ↓ / `status` ↑, `createdAt` ↓ | Deductions per person / by status |
| `loss_incidents` | `status` ↑, `createdAt` ↓ / `staffUid` ↑, `visibleToStaff` ↑, `createdAt` ↓ | Incidents by status / my incidents |

Phase 5 single-field indexes serve `financial_transactions.createdAt`, `bank_deposits.createdAt`,
`reconciliations.createdAt`, `finance_daily_summaries.dayStart` (period reports), `expenses.expenseDate` (reports),
`expenses.amountUgx` (large expenses), `recurring_expenses.nextDueDate`, `inventory_items.name`, `suppliers.name`,
`stock_movements.createdAt` and `inventory_purchases.createdAt`. The queries made inside transactions on
`financial_accounts` (`type == bank && active == true`) and `users` (`active == true`) use equality filters only.

Single-field indexes also serve `worker_orders.serviceIntakeId`, `payments.receivedAt`, `receipts.issuedAt` and
`loyalty_accounts.pointsBalance`.

## Search strategy

- **Plates:** `normalizedNumberPlate >= key && < key+''`, ordered by plate, limit 10. Exact match and prefix
  in one query; searches start 350 ms after typing stops, and stale responses are discarded. The collection is never
  downloaded to the phone.
- **Customers:** see CUSTOMERS_AND_VEHICLES.md. Name search uses word-prefix tokens with a limit of 30.
- **Services:** the catalogue is small reference data, loaded once, kept in the offline cache and filtered on the
  device.
