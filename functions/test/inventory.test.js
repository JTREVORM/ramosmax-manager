// Inventory: items, suppliers, stock movements, adjustments, purchases and
// low stock (Phase 5) - against the Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as finance from '../src/finance.js';
import * as inv from '../src/inventory.js';
import { emulatorDb, financeHelpers, helpers, rejects, resetAndSeed, rid } from './helpers.js';

const db = emulatorDb('inventory-tests');
const { deps, doc, audits } = helpers(db);
const { balance, txns, assertLedgerConsistent } = financeHelpers(db);

beforeEach(() => resetAndSeed(db));

const item = (actor = 'mgr', extra = {}) => inv.createInventoryItem(deps, actor, {
  name: 'Car Shampoo', category: 'chemicals', unit: 'bottle', minimumStock: 5, reorderLevel: 10, ...extra,
});
const move = (actor, itemId, type, quantity, extra = {}) => inv.recordStockMovement(deps, actor, {
  itemId, type, quantity, reason: 'Recorded in test', requestId: rid(), ...extra,
});
const qty = async (itemId) => (await doc(`inventory_items/${itemId}`)).quantity;
const supplier = (actor = 'mgr', extra = {}) => inv.createSupplier(deps, actor, { name: 'Kampala Auto Supplies', phone: '0772 123 456', ...extra });

/** Every item's quantity equals the sum of its movements. */
async function assertStockConsistent() {
  const moves = (await db.collection('stock_movements').get()).docs.map((d) => d.data());
  for (const d of (await db.collection('inventory_items').get()).docs) {
    const sum = moves.filter((m) => m.itemId === d.id).reduce((s, m) => s + m.quantityChange, 0);
    assert.equal(d.get('quantity'), sum, d.get('name'));
    assert.ok(d.get('quantity') >= 0);
  }
}

describe('items', () => {
  test('generated SKUs per category; opening stock is a movement; quantity starts server-side', async () => {
    const a = await item('mgr', { openingQuantity: 24, lastUnitCostUgx: 15_000, quantity: 999 });
    assert.equal(a.sku, 'RMX-CHEM-001');
    const it = await doc(`inventory_items/${a.itemId}`);
    assert.deepEqual([it.quantity, it.stockStatus, it.unit, it.minimumStock, it.reorderLevel, it.createdBy], [24, 'ok', 'bottle', 5, 10, 'mgr']);
    const [m] = (await db.collection('stock_movements').get()).docs.map((d) => d.data());
    assert.deepEqual([m.type, m.quantityChange, m.quantityBefore, m.quantityAfter, m.movementNumber, m.reason], ['stock_in', 24, 0, 24, 'RMX-STM-000001', 'Opening stock']);
    assert.equal((await item('mgr', { name: 'Tyre Dressing' })).sku, 'RMX-CHEM-002');
    assert.equal((await item('mgr', { name: 'Microfibre Towel', category: 'towels_cloths', unit: 'piece', isConsumable: false })).sku, 'RMX-TOWL-001');
    assert.equal((await item('mgr', { name: 'Wiper Blade', category: 'spare_parts', unit: 'piece', sku: 'wb-19in' })).sku, 'WB-19IN');
    assert.equal((await audits('inventory_item.created')).length, 4);
  });

  test('validation, duplicates and permissions', async () => {
    await item();
    await rejects(item('mgr', { name: 'car  shampoo' }), 'already-exists', 'duplicate_item');
    await rejects(item('mgr', { name: 'X', category: 'food' }), 'invalid-argument', 'category');
    await rejects(item('mgr', { name: 'X', unit: 'gallon' }), 'invalid-argument', 'unit');
    await rejects(item('mgr', { name: 'X', minimumStock: 10, reorderLevel: 5 }), 'invalid-argument', 'levels');
    await rejects(item('mgr', { name: 'X', openingQuantity: -1 }), 'invalid-argument', 'quantity');
    await rejects(item('mgr', { name: 'X', openingQuantity: 1.5 }), 'invalid-argument', 'quantity');
    await rejects(item('mgr', { name: 'X', sku: 'RMX-CHEM-001' }), 'already-exists', 'duplicate_sku');
    for (const uid of ['cash', 'wkr', 'aud', 'sh', 'wkrInv', 'mgrOff']) await rejects(item(uid, { name: 'Y' }), 'permission-denied');
  });

  test('quantity is never editable; details are, with an audit trail', async () => {
    const { itemId } = await item('mgr', { openingQuantity: 20 });
    await rejects(inv.updateInventoryItem(deps, 'mgr', { itemId, quantity: 100 }), 'invalid-argument', 'quantity');
    await inv.updateInventoryItem(deps, 'mgr', { itemId, reorderLevel: 20, name: 'Car Shampoo 5L' });
    const it = await doc(`inventory_items/${itemId}`);
    assert.deepEqual([it.quantity, it.reorderLevel, it.stockStatus, it.name], [20, 20, 'low', 'Car Shampoo 5L']);
    await rejects(inv.updateInventoryItem(deps, 'mgr', { itemId, active: false }), 'invalid-argument', 'reason');
    await inv.updateInventoryItem(deps, 'mgr', { itemId, active: false, reason: 'Discontinued' });
    await rejects(move('mgr', itemId, 'stock_in', 1), 'failed-precondition', 'item_inactive');
    assert.equal((await audits('inventory_item.deactivated')).length, 1);
  });
});

describe('stock movements', () => {
  test('stock-in, usage on a job, stock-out, return: quantities, statuses and movements', async () => {
    const { itemId } = await item('mgr', { openingQuantity: 12 });
    await move('mgr', itemId, 'stock_in', 10, { unitCostUgx: 15_000, reference: 'DN-44' });
    assert.equal((await doc(`inventory_items/${itemId}`)).lastUnitCostUgx, 15_000);
    await move('wkrInv', itemId, 'usage', 2, { workerId: 'wkr', reason: 'Wash bay 1' });
    await move('mgr', itemId, 'stock_out', 1, { reasonCode: 'damaged', reason: 'Bottle split' });
    await move('mgr', itemId, 'return', 1, { reason: 'Wrong type delivered' });
    assert.equal(await qty(itemId), 18);
    const usage = (await db.collection('stock_movements').where('type', '==', 'usage').get()).docs[0].data();
    assert.deepEqual([usage.workerId, usage.workerName, usage.quantityChange, usage.createdBy], ['wkr', 'wkr', -2, 'wkrInv']);
    await rejects(move('mgr', itemId, 'stock_out', 1, { reasonCode: 'lost_it' }), 'invalid-argument', 'reason_code');
    await rejects(move('mgr', itemId, 'usage', 1, { reason: '' }), 'invalid-argument', 'reason');
    await rejects(move('mgr', itemId, 'teleport', 1), 'invalid-argument', 'type');
    for (const q of [0, -2, 1.5, '3']) await rejects(move('mgr', itemId, 'usage', q), 'invalid-argument', 'quantity');
    await assertStockConsistent();
  });

  test('negative stock is refused with the available quantity', async () => {
    const { itemId } = await item('mgr', { openingQuantity: 2 });
    await assert.rejects(move('mgr', itemId, 'usage', 5), (e) => {
      assert.equal(e.details.reason, 'insufficient_stock');
      assert.deepEqual([e.details.availableQuantity, e.details.requestedQuantity], [2, 5]);
      return true;
    });
    assert.equal(await qty(itemId), 2);
    const r = await Promise.allSettled([1, 2, 3].map(() => move('mgr', itemId, 'usage', 1)));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 2, 'concurrent usage never goes below zero');
    assert.equal(await qty(itemId), 0);
    await assertStockConsistent();
  });

  test('low stock and out of stock: status, and a notification to inventory managers when it gets worse', async () => {
    const sent = [];
    const nd = { db, notify: async (uid, type, id) => sent.push([uid, type, id]) };
    const { itemId } = await item('mgr', { openingQuantity: 12 });
    await inv.recordStockMovement(nd, 'mgr', { itemId, type: 'usage', quantity: 1, reason: 'Wash', requestId: rid() });
    assert.equal(sent.length, 0);
    await inv.recordStockMovement(nd, 'mgr', { itemId, type: 'usage', quantity: 2, reason: 'Wash', requestId: rid() });
    assert.equal((await doc(`inventory_items/${itemId}`)).stockStatus, 'low');
    const lowCount = sent.length;
    assert.ok(lowCount >= 2 && sent.every(([, type, id]) => type === 'inventory_low_stock' && id === itemId));
    assert.ok(sent.some(([u]) => u === 'mgr') && !sent.some(([u]) => ['cash', 'wkr', 'aud', 'wkrInv'].includes(u)));
    await inv.recordStockMovement(nd, 'mgr', { itemId, type: 'usage', quantity: 1, reason: 'Wash', requestId: rid() });
    assert.equal(sent.length, lowCount, 'no repeat while still low');
    await inv.recordStockMovement(nd, 'mgr', { itemId, type: 'usage', quantity: 8, reason: 'Wash', requestId: rid() });
    assert.equal((await doc(`inventory_items/${itemId}`)).stockStatus, 'out_of_stock');
    assert.ok(sent.length > lowCount);
    assert.equal(inv.stockStatusFor(11, 5, 10), 'ok');
    assert.equal(inv.stockStatusFor(10, 5, 10), 'low');
    assert.equal(inv.stockStatusFor(0, 5, 10), 'out_of_stock');
  });

  test('high-value stock-outs need inventory.stock.adjust; duplicate requests move stock once', async () => {
    const { itemId } = await item('mgr', { openingQuantity: 50, lastUnitCostUgx: 15_000 });
    await rejects(move('wkrInv', itemId, 'stock_out', 14, { reasonCode: 'expired' }), 'permission-denied', 'approval_required');
    await move('wkrInv', itemId, 'stock_out', 13, { reasonCode: 'expired' }); // 195,000 < 200,000
    const m = await move('mgr', itemId, 'stock_out', 14, { reasonCode: 'wastage' });
    assert.equal((await doc(`stock_movements/${m.movementId}`)).approvedBy, 'mgr');
    const requestId = 'usage-dup-1';
    await move('mgr', itemId, 'usage', 3, { requestId });
    const again = await move('mgr', itemId, 'usage', 3, { requestId });
    assert.equal(again.duplicate, true);
    assert.equal(await qty(itemId), 20);
  });

  test('who records what: no stock changes by cashiers, auditors, shareholders; workers only when granted', async () => {
    const { itemId } = await item('mgr', { openingQuantity: 5 });
    for (const uid of ['cash', 'aud', 'sh', 'wkr']) {
      await rejects(move(uid, itemId, 'usage', 1), 'permission-denied');
      await rejects(move(uid, itemId, 'stock_in', 1), 'permission-denied');
    }
    await rejects(move('wkrInv', itemId, 'stock_in', 1), 'permission-denied'); // may use stock, not add it
    assert.equal(await qty(itemId), 5);
  });

  test('adjustment from a physical count: 20 → 18 records ADJUSTMENT_OUT 2 with reason and audit', async () => {
    const { itemId } = await item('mgr', { openingQuantity: 20 });
    const adj = (actor, countedQuantity, extra = {}) => inv.adjustStock(deps, actor, { itemId, countedQuantity, reason: 'Physical count discrepancy', requestId: rid(), ...extra });
    await rejects(adj('wkrInv', 18), 'permission-denied');
    await rejects(adj('mgr', 20), 'failed-precondition', 'no_difference');
    await rejects(adj('mgr', 18, { reason: '' }), 'invalid-argument', 'reason');
    const r = await adj('mgr', 18);
    assert.equal(r.differenceQuantity, -2);
    const m = await doc(`stock_movements/${r.movementId}`);
    assert.deepEqual([m.type, m.quantity, m.quantityChange, m.systemQuantity, m.countedQuantity, m.approvedBy], ['adjustment_out', 2, -2, 20, 18, 'mgr']);
    await adj('mgr', 25);
    assert.equal(await qty(itemId), 25);
    const [log] = await audits('stock.adjusted');
    assert.equal(log.reason, 'Physical count discrepancy');
    await assertStockConsistent();
  });

  test('reversal: mirror movement, once, never below zero, never a reversal of a reversal', async () => {
    const { itemId } = await item('mgr', { openingQuantity: 10 });
    const used = await move('mgr', itemId, 'usage', 4);
    const r = await inv.reverseStockMovement(deps, 'mgr', { movementId: used.movementId, reason: 'Recorded on the wrong item' });
    assert.equal(await qty(itemId), 10);
    await rejects(inv.reverseStockMovement(deps, 'mgr', { movementId: used.movementId, reason: 'Again' }), 'failed-precondition', 'already_reversed');
    await rejects(inv.reverseStockMovement(deps, 'mgr', { movementId: r.movementId, reason: 'Undo' }), 'failed-precondition', 'is_reversal');
    const added = await move('mgr', itemId, 'stock_in', 5);
    await move('mgr', itemId, 'usage', 12);
    await rejects(inv.reverseStockMovement(deps, 'mgr', { movementId: added.movementId, reason: 'Wrong' }), 'failed-precondition', 'insufficient_stock');
    await rejects(inv.reverseStockMovement(deps, 'wkrInv', { movementId: added.movementId, reason: 'Wrong' }), 'permission-denied');
    assert.equal((await doc(`stock_movements/${used.movementId}`)).status, 'reversed');
    await assertStockConsistent();
  });
});

describe('suppliers', () => {
  test('create, search tokens, duplicates, validation, deactivate with reason; permissions', async () => {
    const s = await supplier();
    assert.equal(s.supplierNumber, 'RMX-SUP-000001');
    const d = await doc(`suppliers/${s.supplierId}`);
    assert.deepEqual([d.phone, d.active], ['+256772123456', true]);
    assert.ok(d.searchTokens.includes('kamp'));
    await rejects(supplier('mgr', { name: 'kampala auto supplies' }), 'already-exists', 'duplicate_supplier');
    await rejects(supplier('mgr', { name: 'B', phone: '12' }), 'invalid-argument', 'phone');
    await rejects(supplier('mgr', { name: 'B', email: 'nope' }), 'invalid-argument', 'email');
    for (const uid of ['cash', 'wkr', 'aud', 'wkrInv']) await rejects(supplier(uid, { name: 'C' }), 'permission-denied');
    await rejects(inv.updateSupplier(deps, 'mgr', { supplierId: s.supplierId, active: false }), 'invalid-argument', 'reason');
    await inv.updateSupplier(deps, 'mgr', { supplierId: s.supplierId, contactPerson: 'Sarah', active: false, reason: 'Stopped trading' });
    assert.deepEqual([(await doc(`suppliers/${s.supplierId}`)).active, (await doc(`suppliers/${s.supplierId}`)).contactPerson], [false, 'Sarah']);
  });
});

describe('purchases', () => {
  async function setup() {
    const { supplierId } = await supplier();
    const { itemId } = await item('mgr', { openingQuantity: 3 });
    const { itemId: wax } = await item('mgr', { name: 'Carnauba Wax', category: 'wax_polish', unit: 'can' });
    await finance.recordOpeningBalance(deps, 'admin', { accountId: 'cash_at_hand', amountUgx: 500_000 });
    return { supplierId, itemId, wax };
  }
  const purchase = (actor, supplierId, items, extra = {}) => inv.createPurchase(deps, actor, {
    supplierId, items, supplierReference: 'INV-7781', requestId: rid(), ...extra,
  });

  test('10 bottles × UGX 15,000: approved, received (stock +10), paid (account −150,000), no expense created', async () => {
    const { supplierId, itemId, wax } = await setup();
    const p = await purchase('mgr', supplierId, [{ itemId, quantity: 10, unitCostUgx: 15_000 }, { itemId: wax, quantity: 2, unitCostUgx: 30_000 }]);
    assert.deepEqual([p.purchaseNumber, p.totalUgx, p.status], ['RMX-PUR-000001', 210_000, 'approved']);
    const r = await inv.receivePurchase(deps, 'mgr', { purchaseId: p.purchaseId, payFromAccountId: 'cash_at_hand', requestId: rid() });
    assert.equal(r.status, 'received');
    assert.deepEqual([await qty(itemId), await qty(wax)], [13, 2]);
    assert.equal(await balance('cash_at_hand'), 290_000);
    const pd = await doc(`inventory_purchases/${p.purchaseId}`);
    assert.deepEqual([pd.status, pd.paymentStatus, pd.receivedBy, pd.paidFromAccountId], ['received', 'paid', 'mgr', 'cash_at_hand']);
    const [t] = await txns({ type: 'inventory_purchase_payment' });
    assert.deepEqual([t.amountUgx, t.purchaseId, t.isRevenue], [210_000, p.purchaseId, false]);
    // Accounting rule: stock acquisition, not an operating expense - no double counting.
    assert.equal((await db.collection('expenses').get()).size, 0);
    const day = (await db.collection('finance_daily_summaries').get()).docs[0].data();
    assert.deepEqual([day.purchasesPaidUgx, day.expensesPaidUgx ?? 0], [210_000, 0]);
    const it = await doc(`inventory_items/${itemId}`);
    assert.deepEqual([it.lastUnitCostUgx, it.preferredSupplierId], [15_000, supplierId]);
    const sup = await doc(`suppliers/${supplierId}`);
    assert.deepEqual([sup.purchaseCount, sup.totalPurchasedUgx], [1, 210_000]);
    await rejects(inv.receivePurchase(deps, 'mgr', { purchaseId: p.purchaseId, requestId: rid() }), 'failed-precondition', 'already_received');
    await rejects(inv.payPurchase(deps, 'mgr', { purchaseId: p.purchaseId, accountId: 'cash_at_hand', requestId: rid() }), 'failed-precondition', 'already_paid');
    for (const a of ['purchase.created', 'purchase.received', 'purchase.paid']) assert.equal((await audits(a)).length, 1, a);
    await assertStockConsistent();
    await assertLedgerConsistent();
  });

  test('approval flow for someone who may only raise purchases; receipt without payment; pay later', async () => {
    const { supplierId, itemId } = await setup();
    const p = await purchase('wkrInv', supplierId, [{ itemId, quantity: 4, unitCostUgx: 10_000 }]);
    assert.equal(p.status, 'pending_approval');
    await rejects(inv.receivePurchase(deps, 'mgr', { purchaseId: p.purchaseId, requestId: rid() }), 'failed-precondition', 'not_approved');
    await rejects(inv.updatePurchaseStatus(deps, 'wkrInv', { purchaseId: p.purchaseId, action: 'approve' }), 'permission-denied');
    await inv.updatePurchaseStatus(deps, 'mgr', { purchaseId: p.purchaseId, action: 'approve' });
    await inv.receivePurchase(deps, 'mgr', { purchaseId: p.purchaseId, requestId: rid() });
    assert.equal(await qty(itemId), 7);
    assert.equal(await balance('cash_at_hand'), 500_000, 'received but unpaid moves no money');
    await rejects(inv.payPurchase(deps, 'wkrInv', { purchaseId: p.purchaseId, accountId: 'cash_at_hand', requestId: rid() }), 'permission-denied');
    const requestId = 'purchase-pay-dup';
    await inv.payPurchase(deps, 'mgr', { purchaseId: p.purchaseId, accountId: 'cash_at_hand', requestId });
    const again = await inv.payPurchase(deps, 'mgr', { purchaseId: p.purchaseId, accountId: 'cash_at_hand', requestId });
    assert.equal(again.duplicate, true);
    assert.equal(await balance('cash_at_hand'), 460_000);
  });

  test('atomic: if the payment fails, nothing is received either', async () => {
    const { supplierId, itemId } = await setup();
    const p = await purchase('mgr', supplierId, [{ itemId, quantity: 100, unitCostUgx: 6_000 }]); // 600,000 > 500,000
    await rejects(inv.receivePurchase(deps, 'mgr', { purchaseId: p.purchaseId, payFromAccountId: 'cash_at_hand', requestId: rid() }),
      'failed-precondition', 'insufficient_funds');
    assert.equal(await qty(itemId), 3);
    assert.equal((await doc(`inventory_purchases/${p.purchaseId}`)).status, 'approved');
    assert.equal((await db.collection('stock_movements').where('purchaseId', '==', p.purchaseId).get()).size, 0);
    // Receiving with payment needs expenses.pay as well.
    await rejects(inv.receivePurchase(deps, 'wkrInv', { purchaseId: p.purchaseId, payFromAccountId: 'cash_at_hand', requestId: rid() }), 'permission-denied');
  });

  test('duplicate purchase and receipt requests; validation; cancellation; purchase stock-in is corrected by a return', async () => {
    const { supplierId, itemId } = await setup();
    const requestId = 'purchase-dup-1';
    const a = await purchase('mgr', supplierId, [{ itemId, quantity: 1, unitCostUgx: 1 }], { requestId });
    const b = await purchase('mgr', supplierId, [{ itemId, quantity: 1, unitCostUgx: 1 }], { requestId });
    assert.equal(b.purchaseId, a.purchaseId);
    assert.equal((await db.collection('inventory_purchases').get()).size, 1);
    await rejects(purchase('mgr', supplierId, []), 'invalid-argument', 'items');
    await rejects(purchase('mgr', supplierId, [{ itemId, quantity: 1, unitCostUgx: 1 }, { itemId, quantity: 2, unitCostUgx: 1 }]), 'invalid-argument', 'items');
    await rejects(purchase('mgr', supplierId, [{ itemId, quantity: 0, unitCostUgx: 1 }]), 'invalid-argument', 'quantity');
    await rejects(purchase('mgr', supplierId, [{ itemId, quantity: 1, unitCostUgx: -1 }]), 'invalid-argument', 'amount');
    await rejects(purchase('mgr', 'nope', [{ itemId, quantity: 1, unitCostUgx: 1 }]), 'invalid-argument', 'supplier');
    await rejects(purchase('cash', supplierId, [{ itemId, quantity: 1, unitCostUgx: 1 }]), 'permission-denied');

    const rq = 'receive-dup-1';
    await inv.receivePurchase(deps, 'mgr', { purchaseId: a.purchaseId, requestId: rq });
    const again = await inv.receivePurchase(deps, 'mgr', { purchaseId: a.purchaseId, requestId: rq });
    assert.equal(again.duplicate, true);
    assert.equal(await qty(itemId), 4);
    const [received] = (await db.collection('stock_movements').where('purchaseId', '==', a.purchaseId).get()).docs;
    await rejects(inv.reverseStockMovement(deps, 'mgr', { movementId: received.id, reason: 'Wrong' }), 'failed-precondition', 'use_return');
    await rejects(inv.updatePurchaseStatus(deps, 'mgr', { purchaseId: a.purchaseId, action: 'cancel', reason: 'Late' }), 'failed-precondition', 'invalid_status');

    const c = await purchase('mgr', supplierId, [{ itemId, quantity: 1, unitCostUgx: 100 }]);
    await rejects(inv.updatePurchaseStatus(deps, 'mgr', { purchaseId: c.purchaseId, action: 'cancel' }), 'invalid-argument', 'reason');
    await inv.updatePurchaseStatus(deps, 'mgr', { purchaseId: c.purchaseId, action: 'cancel', reason: 'Ordered elsewhere' });
    assert.equal((await doc(`inventory_purchases/${c.purchaseId}`)).status, 'cancelled');
    await rejects(inv.receivePurchase(deps, 'mgr', { purchaseId: c.purchaseId, requestId: rid() }), 'failed-precondition', 'not_approved');
  });

  test('a purchase payment reversal (expenses.adjust) returns the money and marks the purchase unpaid', async () => {
    const { supplierId, itemId } = await setup();
    const p = await purchase('mgr', supplierId, [{ itemId, quantity: 2, unitCostUgx: 10_000 }]);
    const paid = await inv.payPurchase(deps, 'mgr', { purchaseId: p.purchaseId, accountId: 'cash_at_hand', requestId: rid() });
    await finance.reverseFinancialTransaction(deps, 'admin', { transactionId: paid.transactionId, reason: 'Supplier refunded' });
    assert.equal(await balance('cash_at_hand'), 500_000);
    assert.equal((await doc(`inventory_purchases/${p.purchaseId}`)).paymentStatus, 'unpaid');
    await assertLedgerConsistent();
  });
});
