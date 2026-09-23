# Inventory (Phase 5)

The server code is in `functions/src/inventory.js`. The app code is in `lib/features/inventory/`.

An item's `quantity` changes **only** on the server, in the same transaction that appends the `stock_movements` entry
explaining it (`quantityBefore → quantityAfter`). Every quantity can therefore be rebuilt from its movements; the
emulator tests check this after every scenario. The app never writes a quantity, and the Firestore rules deny it.

**Stock can never go negative.** A movement that would take an item below zero is refused with `insufficient_stock`,
which includes `availableQuantity` and `requestedQuantity`. The app warns before sending ("Only 2 bottles available").
Concurrent movements are safe: an emulator test runs three usages at once against two units in stock, and exactly two
succeed.

## Items

`inventory_items/{id}`

| Field | Notes |
|---|---|
| `sku` | Generated per category: `RMX-CHEM-001`, `RMX-TOWL-001` … (server counter `sku_{PREFIX}`), or a custom 3–24 character code. Unique |
| `name` | Unique, case-insensitive |
| `category` | `chemicals`, `soaps_shampoo`, `wax_polish`, `towels_cloths`, `brushes_tools`, `cleaning_materials`, `spare_parts`, `other` (`inventoryCategories` in access_catalog.json) |
| `unit` | `piece`, `bottle`, `litre`, `kg`, `pack`, `box`, `roll`, `pair`, `set`, `can`, `other` |
| `isConsumable` | Off for reusable tools and equipment. Not every item is a consumable |
| `quantity` | Whole units. **Server-maintained** |
| `minimumStock`, `reorderLevel` | The reorder level cannot be below the minimum |
| `stockStatus` | `ok`, `low` or `out_of_stock` (the brief's OK / LOW / OUT_OF_STOCK). Server-computed |
| `preferredSupplierId`/`Name`, `lastUnitCostUgx`, `description`, `active` | |
| `searchTokens`, `lastMovementAt`, `lastCountedAt`/`Quantity` | |
| `createdBy`, `updatedBy`, `createdAt`, `updatedAt` | |

**Stock status:** `out_of_stock` when the quantity is 0. `low` when the quantity is at or below
`max(minimumStock, reorderLevel)`. Otherwise `ok`.

`createInventoryItem` requires `inventory.manage`. An `openingQuantity` above 0 also needs `inventory.stock.in`, and is
recorded as a `stock_in` movement with the reason "Opening stock". `updateInventoryItem` changes details only;
sending `quantity` or `sku` is refused. Deactivating an item needs a reason, and an inactive item cannot receive stock.

## Movements

`stock_movements/{id}` is **immutable**. Each movement has a number (`RMX-STM-000001`) and records:

- the item and its SKU, `type`, `quantity`, `quantityChange` (signed), `quantityBefore` and `quantityAfter`;
- `reason`, `reasonCode`, `reference`;
- `purchaseId`/`Number`, `intakeId`/`jobNumber` (related job), `workerId`/`Name` (who used it);
- `unitCostUgx`, `approvedBy`, `requestId`;
- `status`, reversal links, `createdBy`/`Name` and `createdAt`.

| Type | Brief | Change | How | Permission |
|---|---|---|---|---|
| `stock_in` | STOCK_IN | + | `recordStockMovement` (documented, with a reason), a purchase receipt, or opening stock | `inventory.stock.in` |
| `usage` | USAGE | − | `recordStockMovement`, optionally with a job and a worker | `inventory.stock.out` |
| `stock_out` | STOCK_OUT | − | `recordStockMovement` with `reasonCode` `damaged`, `expired`, `wastage`, `internal_use` or `other` | `inventory.stock.out` |
| `return` | RETURN | − | Returned to the supplier | `inventory.stock.out` |
| `adjustment_in` / `adjustment_out` | ADJUSTMENT_IN / OUT | ± | `adjustStock` (physical count) | `inventory.stock.adjust` |
| `reversal` | REVERSAL | ∓ | `reverseStockMovement` | `inventory.stock.adjust` |

- Every movement needs a reason, and every money-free movement request carries a `requestId`, so it is recorded once.
- **High-value stock-outs:** a stock-out worth at least `settings/inventory.highValueThresholdUgx` (default UGX
  200,000, valued at the last unit cost) is refused without `inventory.stock.adjust` (`approval_required`). The
  approver is recorded.
- **Adjustments** never overwrite a quantity. The person enters the physical count, and the server records the
  difference as `adjustment_in` or `adjustment_out`, with the system and counted quantities, the reason and the
  approver. For example: system 20, counted 18 → `adjustment_out` 2. A count that matches is refused
  (`no_difference`).
- **Reversals** post the mirror movement once, never below zero. Stock received on a purchase is not reversed
  (`use_return`); record a return to the supplier instead.

## Suppliers

`suppliers/{id}`:

- `supplierNumber` (`RMX-SUP-000001`) and `name` (unique);
- `contactPerson`, `phone` (normalised to E.164), `email`, `address`, `notes`, `active`;
- `searchTokens`;
- `purchaseCount`, `totalPurchasedUgx`, `lastPurchaseAt`: updated when a purchase is received.

`createSupplier` and `updateSupplier` require `inventory.suppliers.manage`. Deactivation needs a reason. The supplier
screen shows the supplier's purchase history.

## Purchases

`inventory_purchases/{id}` (`RMX-PUR-000001`):

- the supplier, `purchaseDate`, `supplierReference`;
- `items`: `[{itemId, name, sku, unit, quantity, unitCostUgx, lineTotalUgx}]` (up to 30 lines, each item once);
- `totalUgx`, `status`, `paymentStatus`;
- the approver, receiver and payer with their times, `financialTransactionId`, `attachmentPath` and notes.

Purchases use `RMX-PUR-`, not the brief's `RMX-INV-`, because `RMX-INV-` already numbers customer invoices (Phase 4).

```
pending_approval ──approve──► approved ──receive──► received
        └────────cancel (reason, unpaid only)────────┘ (before receipt)
payment: unpaid ──pay──► paid        (separately, or together with the receipt)
```

1. **`createPurchase`** (`inventory.purchase.create`) records the request. The server prices every line from the
   quantities and unit costs it receives and computes the total. It is `approved` at once if the creator holds
   `inventory.purchase.approve`, otherwise `pending_approval`.
2. **`updatePurchaseStatus`** (`inventory.purchase.approve`) approves or cancels it. Cancelling needs a reason, and a
   purchase cannot be cancelled once it is received or paid.
3. **`receivePurchase`** (`inventory.stock.in`) is the confirmed stock receipt. It posts one `stock_in` movement per
   line (for example, "10 bottles × UGX 15,000" → +10), updates each item's last cost, and updates the supplier's
   totals. It happens **once** (`already_received`).
   - With `payFromAccountId` (which also needs `expenses.pay`), the purchase is paid **in the same transaction**. If
     the payment fails, for example because of insufficient funds, nothing is received either.
4. **`payPurchase`** (`expenses.pay`) pays an approved or received purchase later. It happens once
   (`already_paid`), and a retried request is recorded once.

## Accounting treatment (Phase 5)

**An inventory purchase is a stock acquisition, not an operating expense.**

- Paying for a purchase posts an `inventory_purchase_payment` ledger entry, which takes money out of the account, and
  **no expense record**. Expense reports and `expensesPaidUgx` never include stock. Stock payments are reported
  separately (`purchasesPaidUgx`, "Stock purchases paid").
- Using or writing off stock changes **quantities only**. Phase 5 books no cost-of-goods or consumption expense.
- Nothing is counted twice: a UGX 150,000 purchase reduces the account once, adds stock once, and creates no expense.

If the business decides that stock purchases should count as expenses, that must be a deliberate, documented change
to this model. It is not configurable in Phase 5.

**Valuation:** the dashboard's "Indicative stock value" is Σ quantity × last purchase cost for items that have a
cost. It is **labelled as not an accounting valuation**, and items in stock without a cost are listed as excluded.
FIFO or weighted-average costing is not implemented.

## Low stock

- The **Low stock** tab lists active items that are `low` or `out_of_stock` (query on `stockStatus`, index
  `stockStatus` + `name`).
- The dashboard counts low and out-of-stock items. The management dashboard shows a "Low / out of stock" tile.
- When a movement makes an item worse (ok → low, or low/ok → out of stock), everyone holding `inventory.manage` gets
  an `inventory_low_stock` notification through the existing notification path. Further movements while it stays low
  send nothing more.

## Permissions

The brief's `inventory.items.manage` is the existing `inventory.manage`, and its `inventory.reports` is
`inventory.reports.view` (read permissions end in `.view`, which keeps the auditor role structurally read-only).

| Permission | Admin | Manager | Auditor | Cashier | Worker |
|---|---|---|---|---|---|
| `inventory.view` | ✓ | ✓ | ✓ | | |
| `inventory.manage` (items) | ✓ | ✓ | | | |
| `inventory.suppliers.manage` | ✓ | ✓ | | | |
| `inventory.purchase.create` / `.approve` | ✓ | ✓ | | | |
| `inventory.stock.in` / `.out` | ✓ | ✓ | | | |
| `inventory.stock.adjust` | ✓ | ✓ | | | |
| `inventory.reports.view` | ✓ | ✓ | ✓ | | |

Workers have no stock access by default. A manager can grant `inventory.view` + `inventory.stock.out`, permanently or
temporarily, to a worker who should record their own usage.

## Screens

`/app/inventory` has these tabs:

- **Dashboard**: counts, the indicative value, recent movements, **New item** and **New purchase**.
- **Items**: search by name, SKU or category, and a category filter.
- **Low stock**.
- **Suppliers**: search and add.
- **Purchases**: status filter.
- **Movements**: type filter.
- **Adjustments**.

Other routes:

| Route | Screen |
|---|---|
| `/app/inventory/items/new`, `/items/:id/edit` | Item form |
| `/app/inventory/items/:id` | Stock, levels, **Use / stock out**, **Stock in**, **Count / adjust**, movement history with **Reverse** |
| `/app/inventory/suppliers/:id` | Supplier details and purchase history |
| `/app/inventory/purchases/new`, `/purchases/:id` | New purchase; approve, receive (optionally with payment), pay, cancel |

## Audit actions

- `inventory_item.created`, `inventory_item.updated`, `inventory_item.activated`, `inventory_item.deactivated`
- `stock.stock_in`, `stock.usage`, `stock.stock_out`, `stock.return`, `stock.adjusted`, `stock.reversed`
- `supplier.created`, `supplier.updated`, `supplier.deactivated`
- `purchase.created`, `purchase.approved`, `purchase.cancelled`, `purchase.received`, `purchase.paid`

## Known limitations

- Quantities are whole units. Record liquids per container (bottle, can, litre), not in millilitres.
- There is no costing method (FIFO or average). The stock value is indicative only.
- A received purchase is corrected with a return movement. There is no "unreceive".
- Usage is not deducted automatically when a job completes. It is recorded by a person, optionally linked to the job.
