// ===========================================================================
// RamosMAX inventory - items, suppliers, stock movements and purchases
// (Phase 5).
// ===========================================================================
// An item's `quantity` changes ONLY here, in the same transaction that
// appends the `stock_movements` entry explaining it (quantityBefore →
// quantityAfter), so every quantity can be rebuilt from its movements. Stock
// can never go negative. Nothing is edited or deleted: a wrong movement is
// reversed, a wrong count is corrected by an adjustment.
//
// Movement types (the brief's names in capitals):
//   stock_in (STOCK_IN)            +  purchase receipt or documented manual stock-in
//   usage (USAGE)                  −  used on a job / by a worker
//   stock_out (STOCK_OUT)          −  damaged, expired, wastage, internal use...
//   return (RETURN)                −  returned to the supplier
//   adjustment_in / adjustment_out ±  physical count differs from the system
//   reversal (REVERSAL)            ∓  mirror of an earlier movement
//
// ACCOUNTING (Phase 5): buying stock is an inventory ACQUISITION, not an
// operating expense. Paying for a purchase posts an
// `inventory_purchase_payment` ledger entry (money out of the account) and no
// expense record, so expense reports never double-count stock. Using stock
// changes quantities only; no cost-of-goods figure is booked.
// ===========================================================================

import { createRequire } from 'node:module';
import { deny, invalid, optionalEmail, optionalText, precondition, normalizePhone, requirePermission, requireReason } from './access.js';
import { INTAKES, alreadyExists, audit, freshActor, notFound, requireDocId, searchTokens, stamp, uniqueRef } from './operations.js';
import { NotificationType, notifySafely, requireObject } from './user_admin.js';
import {
  holdersOf, openLedger, optionalAttachment, readCounter, readRequest, requireAmount, requireBusinessDate, requireChoice,
  requireRequestId, requireText, saveRequest,
} from './finance.js';

const require = createRequire(import.meta.url);
const catalog = require('./access_catalog.json');

export const ITEMS = 'inventory_items';
export const SUPPLIERS = 'suppliers';
export const MOVEMENTS = 'stock_movements';
export const PURCHASES = 'inventory_purchases';

export const CATEGORIES = Object.freeze([...catalog.inventoryCategories]);
export const UNITS = Object.freeze([...catalog.inventoryUnits]);
export const SKU_PREFIX = Object.freeze({
  chemicals: 'CHEM', soaps_shampoo: 'SOAP', wax_polish: 'WAX', towels_cloths: 'TOWL', brushes_tools: 'TOOL',
  cleaning_materials: 'CLEN', spare_parts: 'PART', other: 'MISC',
});
export const STOCK_OUT_REASONS = Object.freeze(['damaged', 'expired', 'wastage', 'internal_use', 'other']);
export const MAX_QUANTITY = 1_000_000;
export const MAX_UNIT_COST_UGX = 100_000_000;
export const MAX_PURCHASE_LINES = 30;

/** Stock-outs worth at least this (at last cost) need inventory.stock.adjust. */
export const DEFAULT_HIGH_VALUE_UGX = 200_000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** OK / LOW / OUT_OF_STOCK. Low means at or below the reorder level (or the minimum, if higher). */
export function stockStatusFor(quantity, minimumStock, reorderLevel) {
  if (quantity <= 0) return 'out_of_stock';
  if (quantity <= Math.max(minimumStock ?? 0, reorderLevel ?? 0)) return 'low';
  return 'ok';
}

export function requireQuantity(input, field = 'quantity', { min = 1 } = {}) {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > MAX_QUANTITY) {
    throw invalid(`Enter the ${field} as a whole number${min > 0 ? ' greater than zero' : ''}.`, 'quantity');
  }
  return input;
}

const nameKey = (name) => name.toLowerCase().replace(/\s+/g, ' ').trim();
const SEVERITY = { ok: 0, low: 1, out_of_stock: 2 };

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

async function readItem(tx, db, id) {
  const ref = db.collection(ITEMS).doc(requireDocId(id, 'item'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That inventory item could not be found.');
  return { ref, item: snap.data() };
}

/**
 * Writes one movement for [item] and returns the item's new state (also
 * applied to [item] in place, so several movements on one item chain).
 */
function writeMovement(tx, db, { ref, item }, { type, change, actor, number, fields = {} }) {
  const before = item.quantity ?? 0;
  const after = before + change;
  if (after < 0) {
    throw precondition(`Only ${before} ${item.unit}(s) of ${item.name} in stock; ${-change} requested.`, 'insufficient_stock',
      { itemId: ref.id, availableQuantity: before, requestedQuantity: -change });
  }
  const statusBefore = item.stockStatus ?? stockStatusFor(before, item.minimumStock, item.reorderLevel);
  const status = stockStatusFor(after, item.minimumStock, item.reorderLevel);
  const movementRef = db.collection(MOVEMENTS).doc();
  tx.set(movementRef, {
    movementId: movementRef.id,
    movementNumber: number,
    itemId: ref.id,
    itemName: item.name,
    sku: item.sku,
    unit: item.unit,
    type,
    quantity: Math.abs(change),
    quantityChange: change,
    quantityBefore: before,
    quantityAfter: after,
    reason: null,
    reasonCode: null,
    reference: null,
    purchaseId: null,
    purchaseNumber: null,
    intakeId: null,
    jobNumber: null,
    workerId: null,
    workerName: null,
    unitCostUgx: null,
    approvedBy: null,
    requestId: null,
    reversalOfMovementId: null,
    ...fields,
    status: 'posted',
    reversedByMovementId: null,
    createdBy: actor.uid,
    createdByName: actor.data.fullName ?? null,
    createdAt: stamp(),
  });
  item.quantity = after;
  item.stockStatus = status;
  return { movementId: movementRef.id, movementNumber: number, quantityAfter: after, becameLow: SEVERITY[status] > SEVERITY[statusBefore] };
}

function itemUpdate(item, actorUid, extra = {}) {
  return { quantity: item.quantity, stockStatus: item.stockStatus, lastMovementAt: stamp(), updatedAt: stamp(), updatedBy: actorUid, ...extra };
}

async function notifyLow(deps, itemIds, now) {
  if (itemIds.length === 0) return;
  const recipients = await holdersOf(deps.db, ['inventory.manage'], now);
  for (const id of itemIds) for (const uid of recipients) await notifySafely(deps, uid, NotificationType.lowStock, id);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const ITEM_FIELDS = ['name', 'category', 'description', 'unit', 'minimumStock', 'reorderLevel', 'isConsumable', 'preferredSupplierId', 'lastUnitCostUgx'];

function itemInput(data, { partial }) {
  const out = {};
  const has = (k) => !partial || k in data;
  if (has('name')) out.name = requireText(data.name, 'Item name', 60);
  if (has('category')) out.category = requireChoice(data.category, CATEGORIES, 'Choose a valid category.', 'category');
  if (has('description')) out.description = optionalText(data.description, 'Description', 300);
  if (has('unit')) out.unit = requireChoice(data.unit, UNITS, 'Choose a valid unit.', 'unit');
  if (has('minimumStock')) out.minimumStock = requireQuantity(data.minimumStock ?? 0, 'minimum stock', { min: 0 });
  if (has('reorderLevel')) out.reorderLevel = requireQuantity(data.reorderLevel ?? 0, 'reorder level', { min: 0 });
  if (has('isConsumable')) out.isConsumable = data.isConsumable !== false;
  if (has('preferredSupplierId')) out.preferredSupplierId = data.preferredSupplierId == null ? null : requireDocId(data.preferredSupplierId, 'supplier');
  if (has('lastUnitCostUgx')) out.lastUnitCostUgx = data.lastUnitCostUgx == null ? null : requireAmount(data.lastUnitCostUgx, { field: 'unit cost', min: 0, max: MAX_UNIT_COST_UGX });
  return out;
}

function requireLevels(item) {
  if (item.reorderLevel < item.minimumStock) {
    throw invalid('The reorder level cannot be below the minimum stock level.', 'levels');
  }
}

async function readSupplierName(tx, db, supplierId) {
  if (!supplierId) return null;
  const snap = await tx.get(db.collection(SUPPLIERS).doc(supplierId));
  if (!snap.exists) throw invalid('Choose a valid supplier.', 'supplier');
  return snap.get('name');
}

export async function createInventoryItem(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const input = itemInput(data, { partial: false });
  requireLevels(input);
  const customSku = data.sku == null || data.sku === '' ? null : String(data.sku).trim().toUpperCase();
  if (customSku && !/^[A-Z0-9][A-Z0-9-]{2,23}$/.test(customSku)) throw invalid('Use 3–24 letters, digits or dashes for the SKU.', 'sku');
  const opening = data.openingQuantity == null ? 0 : requireQuantity(data.openingQuantity, 'opening quantity', { min: 0 });

  const result = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'inventory.manage');
    if (opening > 0) requirePermission(actor.perms, 'inventory.stock.in');
    const nameRef = uniqueRef(db, 'item_name', nameKey(input.name));
    if ((await tx.get(nameRef)).exists) throw alreadyExists(`An item called "${input.name}" already exists.`, 'duplicate_item');
    const supplierName = await readSupplierName(tx, db, input.preferredSupplierId);
    const prefix = SKU_PREFIX[input.category];
    const skuCounter = customSku ? null : await readCounter(tx, db, `sku_${prefix}`, `RMX-${prefix}-`, 3);
    const sku = customSku ?? skuCounter.next();
    const skuRef = uniqueRef(db, 'sku', sku);
    if ((await tx.get(skuRef)).exists) throw alreadyExists(`SKU ${sku} is already in use.`, 'duplicate_sku');
    const movements = opening > 0 ? await readCounter(tx, db, 'stock_movements', 'RMX-STM-', 6) : null;

    const ref = db.collection(ITEMS).doc();
    const item = {
      itemId: ref.id,
      sku,
      ...input,
      nameKey: nameKey(input.name),
      preferredSupplierName: supplierName,
      quantity: 0,
      stockStatus: stockStatusFor(0, input.minimumStock, input.reorderLevel),
      active: true,
      searchTokens: searchTokens(input.name, sku.replace(/-/g, ' ')),
      lastMovementAt: null,
      createdAt: stamp(),
      updatedAt: stamp(),
      createdBy: actor.uid,
      updatedBy: actor.uid,
    };
    let movement = null;
    if (opening > 0) {
      movement = writeMovement(tx, db, { ref, item }, {
        type: 'stock_in', change: opening, actor, number: movements.next(),
        fields: { reason: 'Opening stock', unitCostUgx: input.lastUnitCostUgx ?? null },
      });
      movements.commit();
    }
    skuCounter?.commit();
    tx.set(ref, { ...item, ...(movement ? { lastMovementAt: stamp() } : {}) });
    tx.set(nameRef, { kind: 'item_name', itemId: ref.id });
    tx.set(skuRef, { kind: 'sku', itemId: ref.id });
    audit(tx, db, actor, 'inventory', 'inventory_item.created', ref.id, {
      newValue: { sku, name: input.name, category: input.category, unit: input.unit, openingQuantity: opening },
    });
    return { itemId: ref.id, sku, stockStatus: item.stockStatus };
  });
  return result;
}

/** Details only - quantity is never editable; use a movement or an adjustment. */
export async function updateInventoryItem(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  if ('quantity' in data || 'sku' in data) throw invalid('Quantity and SKU cannot be edited. Record a stock movement or adjustment instead.', 'quantity');
  const changes = itemInput(data, { partial: true });
  const active = 'active' in data ? data.active === true : null;
  const reason = requireReason(data.reason, { required: active === false });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'inventory.manage');
    const { ref, item } = await readItem(tx, db, data.itemId);
    const changed = ITEM_FIELDS.filter((k) => k in changes && (changes[k] ?? null) !== (item[k] ?? null));
    const activeChanged = active !== null && active !== item.active;
    if (changed.length === 0 && !activeChanged) throw precondition('Nothing has changed.', 'no_changes');
    const next = { ...item, ...changes };
    requireLevels(next);
    const renamed = changed.includes('name') && nameKey(changes.name) !== item.nameKey;
    let newNameRef = null;
    if (renamed) {
      newNameRef = uniqueRef(db, 'item_name', nameKey(changes.name));
      if ((await tx.get(newNameRef)).exists) throw alreadyExists(`An item called "${changes.name}" already exists.`, 'duplicate_item');
    }
    const supplierName = changed.includes('preferredSupplierId') ? await readSupplierName(tx, db, changes.preferredSupplierId) : item.preferredSupplierName;
    const update = { ...Object.fromEntries(changed.map((k) => [k, changes[k]])), preferredSupplierName: supplierName ?? null, updatedAt: stamp(), updatedBy: actor.uid };
    update.stockStatus = stockStatusFor(item.quantity ?? 0, next.minimumStock, next.reorderLevel);
    if (renamed) {
      update.nameKey = nameKey(changes.name);
      update.searchTokens = searchTokens(changes.name, item.sku.replace(/-/g, ' '));
      tx.delete(uniqueRef(db, 'item_name', item.nameKey));
      tx.set(newNameRef, { kind: 'item_name', itemId: ref.id });
    }
    if (activeChanged) update.active = active;
    tx.update(ref, update);
    if (changed.length > 0) {
      audit(tx, db, actor, 'inventory', 'inventory_item.updated', ref.id, {
        previousValue: Object.fromEntries(changed.map((k) => [k, item[k] ?? null])),
        newValue: Object.fromEntries(changed.map((k) => [k, changes[k]])),
        reason,
      });
    }
    if (activeChanged) {
      audit(tx, db, actor, 'inventory', active ? 'inventory_item.activated' : 'inventory_item.deactivated', ref.id, {
        previousValue: { active: item.active }, newValue: { active }, reason,
      });
    }
    return { itemId: ref.id, stockStatus: update.stockStatus };
  });
}

// ---------------------------------------------------------------------------
// Stock in / usage / stock out / return
// ---------------------------------------------------------------------------

const MOVEMENT_PERMISSION = { stock_in: 'inventory.stock.in', usage: 'inventory.stock.out', stock_out: 'inventory.stock.out', return: 'inventory.stock.out' };

export async function recordStockMovement(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const type = requireChoice(data.type, Object.keys(MOVEMENT_PERMISSION), 'Choose stock in, usage, stock out or return.', 'type');
  const quantity = requireQuantity(data.quantity);
  const reason = requireReason(data.reason);
  const reference = optionalText(data.reference, 'Reference', 60);
  const requestId = requireRequestId(data.requestId);
  const reasonCode = type === 'stock_out'
    ? requireChoice(data.reasonCode, STOCK_OUT_REASONS, 'Choose why the stock is going out.', 'reason_code') : null;
  const unitCost = type === 'stock_in' && data.unitCostUgx != null
    ? requireAmount(data.unitCostUgx, { field: 'unit cost', min: 0, max: MAX_UNIT_COST_UGX }) : null;
  const intakeId = type === 'usage' && data.intakeId != null ? requireDocId(data.intakeId, 'job') : null;
  const workerId = type === 'usage' && data.workerId != null ? requireDocId(data.workerId, 'worker') : null;

  const result = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, MOVEMENT_PERMISSION[type]);
    const request = await readRequest(tx, db, requestId, actor.uid, 'stock_movement');
    if (request.earlier) return request.earlier;
    const target = await readItem(tx, db, data.itemId);
    const { item } = target;
    if (type === 'stock_in' && item.active !== true) throw precondition(`${item.name} is inactive.`, 'item_inactive');
    let job = null;
    if (intakeId) {
      const snap = await tx.get(db.collection(INTAKES).doc(intakeId));
      if (!snap.exists) throw invalid('Choose a valid job.', 'job');
      job = { intakeId, jobNumber: snap.get('jobNumber') ?? null };
    }
    let worker = null;
    if (workerId) {
      const snap = await tx.get(db.collection('users').doc(workerId));
      if (!snap.exists) throw invalid('Choose a valid worker.', 'worker');
      worker = { workerId, workerName: snap.get('fullName') ?? null };
    }
    let approvedBy = null;
    if (type === 'stock_out') {
      const settings = await tx.get(db.collection('settings').doc('inventory'));
      const threshold = Number.isInteger(settings.get('highValueThresholdUgx')) ? settings.get('highValueThresholdUgx') : DEFAULT_HIGH_VALUE_UGX;
      const value = quantity * (item.lastUnitCostUgx ?? 0);
      if (value >= threshold) {
        if (!actor.perms.has('inventory.stock.adjust')) {
          throw deny(`Stock-outs worth UGX ${threshold.toLocaleString('en-US')} or more need a manager's approval.`, 'approval_required');
        }
        approvedBy = actor.uid;
      }
    }
    const numbers = await readCounter(tx, db, 'stock_movements', 'RMX-STM-', 6);
    const m = writeMovement(tx, db, target, {
      type, change: type === 'stock_in' ? quantity : -quantity, actor, number: numbers.next(),
      fields: { reason, reasonCode, reference, unitCostUgx: unitCost, approvedBy, requestId, ...(job ?? {}), ...(worker ?? {}) },
    });
    numbers.commit();
    tx.update(target.ref, itemUpdate(item, actor.uid, unitCost != null ? { lastUnitCostUgx: unitCost } : {}));
    const out = { movementId: m.movementId, movementNumber: m.movementNumber, quantityAfter: m.quantityAfter, stockStatus: item.stockStatus, becameLow: m.becameLow };
    saveRequest(tx, request.ref, 'stock_movement', actor.uid, out);
    audit(tx, db, actor, 'inventory', `stock.${type}`, target.ref.id, {
      previousValue: { quantity: m.quantityAfter - (type === 'stock_in' ? quantity : -quantity) },
      newValue: { quantity: m.quantityAfter, movementNumber: m.movementNumber, type, reasonCode },
      reason,
    });
    return out;
  });
  if (result.becameLow && !result.duplicate) await notifyLow(deps, [data.itemId], now);
  return result;
}

/** Physical count: records the difference as adjustment_in / adjustment_out. */
export async function adjustStock(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const counted = requireQuantity(data.countedQuantity, 'counted quantity', { min: 0 });
  const reason = requireReason(data.reason);
  const requestId = requireRequestId(data.requestId);

  const result = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'inventory.stock.adjust');
    const request = await readRequest(tx, db, requestId, actor.uid, 'stock_adjustment');
    if (request.earlier) return request.earlier;
    const target = await readItem(tx, db, data.itemId);
    const system = target.item.quantity ?? 0;
    const difference = counted - system;
    if (difference === 0) throw precondition('The count matches the system quantity. No adjustment is needed.', 'no_difference');
    const numbers = await readCounter(tx, db, 'stock_movements', 'RMX-STM-', 6);
    const m = writeMovement(tx, db, target, {
      type: difference > 0 ? 'adjustment_in' : 'adjustment_out', change: difference, actor, number: numbers.next(),
      fields: { reason, approvedBy: actor.uid, requestId, countedQuantity: counted, systemQuantity: system },
    });
    numbers.commit();
    tx.update(target.ref, itemUpdate(target.item, actor.uid, { lastCountedAt: stamp(), lastCountedQuantity: counted }));
    const out = { movementId: m.movementId, movementNumber: m.movementNumber, differenceQuantity: difference, quantityAfter: counted, becameLow: m.becameLow };
    saveRequest(tx, request.ref, 'stock_adjustment', actor.uid, out);
    audit(tx, db, actor, 'inventory', 'stock.adjusted', target.ref.id, {
      previousValue: { quantity: system }, newValue: { quantity: counted, differenceQuantity: difference, movementNumber: m.movementNumber }, reason,
    });
    return out;
  });
  if (result.becameLow && !result.duplicate) await notifyLow(deps, [data.itemId], now);
  return result;
}

/** Posts the mirror of a movement (never below zero). Purchase receipts are corrected with a return. */
export async function reverseStockMovement(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  const result = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'inventory.stock.adjust');
    const mRef = db.collection(MOVEMENTS).doc(requireDocId(data.movementId, 'movement'));
    const snap = await tx.get(mRef);
    if (!snap.exists) throw notFound('That stock movement could not be found.');
    const original = snap.data();
    if (original.type === 'reversal') throw precondition('A reversal cannot itself be reversed.', 'is_reversal');
    if (original.status === 'reversed') throw precondition('This movement has already been reversed.', 'already_reversed');
    if (original.purchaseId) throw precondition('Stock received on a purchase is corrected with a return to the supplier.', 'use_return');
    const target = await readItem(tx, db, original.itemId);
    const numbers = await readCounter(tx, db, 'stock_movements', 'RMX-STM-', 6);
    const m = writeMovement(tx, db, target, {
      type: 'reversal', change: -original.quantityChange, actor, number: numbers.next(),
      fields: { reason, reversalOfMovementId: mRef.id, reversalOfMovementNumber: original.movementNumber, reversalOfType: original.type },
    });
    numbers.commit();
    tx.update(mRef, { status: 'reversed', reversedByMovementId: m.movementId, reversedAt: stamp(), reversedBy: actor.uid, reversalReason: reason });
    tx.update(target.ref, itemUpdate(target.item, actor.uid));
    audit(tx, db, actor, 'inventory', 'stock.reversed', mRef.id, {
      previousValue: { status: 'posted', movementNumber: original.movementNumber, quantityChange: original.quantityChange },
      newValue: { status: 'reversed', reversalMovementNumber: m.movementNumber, quantityAfter: m.quantityAfter },
      reason,
    });
    return { movementId: m.movementId, movementNumber: m.movementNumber, quantityAfter: m.quantityAfter, becameLow: m.becameLow, itemId: target.ref.id };
  });
  if (result.becameLow) await notifyLow(deps, [result.itemId], now);
  return result;
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

const SUPPLIER_FIELDS = ['name', 'contactPerson', 'phone', 'email', 'address', 'notes'];

function supplierInput(data, { partial }) {
  const out = {};
  const has = (k) => !partial || k in data;
  if (has('name')) out.name = requireText(data.name, 'Supplier name', 80);
  if (has('contactPerson')) out.contactPerson = optionalText(data.contactPerson, 'Contact person', 80);
  if (has('phone')) {
    if (data.phone == null || data.phone === '') out.phone = null;
    else {
      out.phone = normalizePhone(data.phone);
      if (!out.phone) throw invalid('Enter a valid phone number, e.g. 0772 123 456.', 'phone');
    }
  }
  if (has('email')) out.email = optionalEmail(data.email);
  if (has('address')) out.address = optionalText(data.address, 'Address', 200);
  if (has('notes')) out.notes = optionalText(data.notes, 'Notes', 500);
  return out;
}

export async function createSupplier(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const input = supplierInput(data, { partial: false });
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'inventory.suppliers.manage');
    const keyRef = uniqueRef(db, 'supplier_name', nameKey(input.name));
    if ((await tx.get(keyRef)).exists) throw alreadyExists(`A supplier called "${input.name}" already exists.`, 'duplicate_supplier');
    const numbers = await readCounter(tx, db, 'suppliers', 'RMX-SUP-', 6);
    const ref = db.collection(SUPPLIERS).doc();
    const number = numbers.next();
    numbers.commit();
    tx.set(ref, {
      supplierId: ref.id, supplierNumber: number, ...input, nameKey: nameKey(input.name), active: true,
      searchTokens: searchTokens(input.name, input.contactPerson), purchaseCount: 0, totalPurchasedUgx: 0,
      createdAt: stamp(), updatedAt: stamp(), createdBy: actor.uid, updatedBy: actor.uid,
    });
    tx.set(keyRef, { kind: 'supplier_name', supplierId: ref.id });
    audit(tx, db, actor, 'inventory', 'supplier.created', ref.id, { newValue: { supplierNumber: number, name: input.name } });
    return { supplierId: ref.id, supplierNumber: number };
  });
}

export async function updateSupplier(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const changes = supplierInput(data, { partial: true });
  const active = 'active' in data ? data.active === true : null;
  const reason = requireReason(data.reason, { required: active === false });
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'inventory.suppliers.manage');
    const ref = db.collection(SUPPLIERS).doc(requireDocId(data.supplierId, 'supplier'));
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('That supplier could not be found.');
    const before = snap.data();
    const changed = SUPPLIER_FIELDS.filter((k) => k in changes && (changes[k] ?? null) !== (before[k] ?? null));
    const activeChanged = active !== null && active !== before.active;
    if (changed.length === 0 && !activeChanged) throw precondition('Nothing has changed.', 'no_changes');
    const renamed = changed.includes('name') && nameKey(changes.name) !== before.nameKey;
    let newKey = null;
    if (renamed) {
      newKey = uniqueRef(db, 'supplier_name', nameKey(changes.name));
      if ((await tx.get(newKey)).exists) throw alreadyExists(`A supplier called "${changes.name}" already exists.`, 'duplicate_supplier');
    }
    const next = { ...before, ...changes };
    const update = { ...Object.fromEntries(changed.map((k) => [k, changes[k]])), updatedAt: stamp(), updatedBy: actor.uid };
    update.searchTokens = searchTokens(next.name, next.contactPerson);
    if (renamed) {
      update.nameKey = nameKey(changes.name);
      tx.delete(uniqueRef(db, 'supplier_name', before.nameKey));
      tx.set(newKey, { kind: 'supplier_name', supplierId: ref.id });
    }
    if (activeChanged) update.active = active;
    tx.update(ref, update);
    audit(tx, db, actor, 'inventory', activeChanged && !active ? 'supplier.deactivated' : 'supplier.updated', ref.id, {
      previousValue: { ...Object.fromEntries(changed.map((k) => [k, before[k] ?? null])), ...(activeChanged ? { active: before.active } : {}) },
      newValue: { ...Object.fromEntries(changed.map((k) => [k, changes[k]])), ...(activeChanged ? { active } : {}) },
      reason,
    });
    return { supplierId: ref.id };
  });
}

// ---------------------------------------------------------------------------
// Purchases: pending_approval → approved → received (stock in); paid separately or on receipt
// ---------------------------------------------------------------------------

async function readPurchase(tx, db, id) {
  const ref = db.collection(PURCHASES).doc(requireDocId(id, 'purchase'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That purchase could not be found.');
  return { ref, purchase: snap.data() };
}

function requireLines(input) {
  if (!Array.isArray(input) || input.length === 0) throw invalid('Add at least one item.', 'items');
  if (input.length > MAX_PURCHASE_LINES) throw invalid(`A purchase can have at most ${MAX_PURCHASE_LINES} lines.`, 'items');
  const lines = input.map((l) => {
    if (l == null || typeof l !== 'object') throw invalid('One of the lines is not valid.', 'items');
    return {
      itemId: requireDocId(l.itemId, 'item'),
      quantity: requireQuantity(l.quantity),
      unitCostUgx: requireAmount(l.unitCostUgx, { field: 'unit cost', min: 0, max: MAX_UNIT_COST_UGX }),
    };
  });
  if (new Set(lines.map((l) => l.itemId)).size !== lines.length) throw invalid('Each item may appear only once.', 'items');
  return lines;
}

export async function createPurchase(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const supplierId = requireDocId(data.supplierId, 'supplier');
  const lines = requireLines(data.items);
  const requestId = requireRequestId(data.requestId);
  const purchaseDate = requireBusinessDate(data.purchaseDate, now, { field: 'purchase date' });
  const supplierReference = optionalText(data.supplierReference, 'Supplier invoice / reference', 60);
  const notes = optionalText(data.notes, 'Notes', 500);
  const attachmentPath = optionalAttachment(data.attachmentPath, 'purchases');

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'inventory.purchase.create');
    const request = await readRequest(tx, db, requestId, actor.uid, 'purchase');
    if (request.earlier) return request.earlier;
    const supplier = await tx.get(db.collection(SUPPLIERS).doc(supplierId));
    if (!supplier.exists || supplier.get('active') !== true) throw invalid('Choose an active supplier.', 'supplier');
    const items = await Promise.all(lines.map((l) => tx.get(db.collection(ITEMS).doc(l.itemId))));
    const numbers = await readCounter(tx, db, 'inventory_purchases', 'RMX-PUR-', 6);
    const priced = lines.map((l, i) => {
      const it = items[i];
      if (!it.exists || it.get('active') !== true) throw invalid('One of the items is missing or inactive.', 'items');
      return { ...l, name: it.get('name'), sku: it.get('sku'), unit: it.get('unit'), lineTotalUgx: l.quantity * l.unitCostUgx };
    });
    const total = priced.reduce((s, l) => s + l.lineTotalUgx, 0);
    requireAmount(total, { field: 'purchase total', min: 0 });
    const autoApprove = actor.perms.has('inventory.purchase.approve');
    const ref = db.collection(PURCHASES).doc();
    const number = numbers.next();
    numbers.commit();
    const status = autoApprove ? 'approved' : 'pending_approval';
    tx.set(ref, {
      purchaseId: ref.id, purchaseNumber: number, supplierId, supplierName: supplier.get('name'),
      purchaseDate, supplierReference, items: priced, itemIds: priced.map((l) => l.itemId), lineCount: priced.length, totalUgx: total,
      status, paymentStatus: total === 0 ? 'paid' : 'unpaid', notes, attachmentPath, requestId,
      approvedBy: autoApprove ? actor.uid : null, approvedAt: autoApprove ? stamp() : null,
      receivedBy: null, receivedAt: null, paidAt: null, paidFromAccountId: null, financialTransactionId: null,
      cancelledBy: null, cancelReason: null,
      createdBy: actor.uid, createdByName: actor.data.fullName ?? null, createdAt: stamp(), updatedAt: stamp(), updatedBy: actor.uid,
    });
    const result = { purchaseId: ref.id, purchaseNumber: number, totalUgx: total, status };
    saveRequest(tx, request.ref, 'purchase', actor.uid, result);
    audit(tx, db, actor, 'inventory', 'purchase.created', ref.id, {
      newValue: { purchaseNumber: number, supplierId, totalUgx: total, lineCount: priced.length, status },
    });
    return result;
  });
}

export async function updatePurchaseStatus(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const action = requireChoice(data.action, ['approve', 'cancel'], 'Choose approve or cancel.', 'action');
  const reason = requireReason(data.reason, { required: action === 'cancel' });
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'inventory.purchase.approve');
    const { ref, purchase } = await readPurchase(tx, db, data.purchaseId);
    if (action === 'approve' && purchase.status !== 'pending_approval') throw precondition('Only a purchase awaiting approval can be approved.', 'invalid_status');
    if (action === 'cancel') {
      if (!['pending_approval', 'approved'].includes(purchase.status)) throw precondition('Received or cancelled purchases cannot be cancelled.', 'invalid_status');
      if (purchase.paymentStatus === 'paid' && purchase.totalUgx > 0) throw precondition('Reverse the payment before cancelling this purchase.', 'paid');
    }
    const update = action === 'approve'
      ? { status: 'approved', approvedBy: actor.uid, approvedAt: stamp() }
      : { status: 'cancelled', cancelledBy: actor.uid, cancelledAt: stamp(), cancelReason: reason };
    tx.update(ref, { ...update, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'inventory', action === 'approve' ? 'purchase.approved' : 'purchase.cancelled', ref.id, {
      previousValue: { status: purchase.status }, newValue: { status: update.status }, reason,
    });
    return { purchaseId: ref.id, status: update.status };
  });
}

function postPurchasePayment(ledger, { ref, purchase, accountId, actor, reference, requestId }) {
  ledger.requireActive(accountId, actor.uid);
  return ledger.post({
    type: 'inventory_purchase_payment', amountUgx: purchase.totalUgx, fromId: accountId, actor,
    fields: {
      purchaseId: ref.id, purchaseNumber: purchase.purchaseNumber, reference: reference ?? purchase.supplierReference ?? null,
      description: `${purchase.purchaseNumber}: stock from ${purchase.supplierName}`, approvedBy: purchase.approvedBy, requestId,
    },
  });
}

/**
 * Confirms delivery: stock_in for every line, once. With [payFromAccountId]
 * the purchase is also paid in the same transaction (needs expenses.pay).
 */
export async function receivePurchase(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const requestId = requireRequestId(data.requestId);
  const payFrom = data.payFromAccountId == null ? null : requireDocId(data.payFromAccountId, 'payment account');
  const reference = optionalText(data.paymentReference, 'Payment reference', 60);

  const result = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'inventory.stock.in');
    if (payFrom) requirePermission(actor.perms, 'expenses.pay');
    const request = await readRequest(tx, db, requestId, actor.uid, 'purchase_receipt');
    if (request.earlier) return request.earlier;
    const { ref, purchase } = await readPurchase(tx, db, data.purchaseId);
    if (purchase.status === 'received') throw precondition('This purchase has already been received.', 'already_received');
    if (purchase.status !== 'approved') throw precondition('Only an approved purchase can be received.', 'not_approved');
    if (payFrom && purchase.paymentStatus === 'paid') throw precondition('This purchase has already been paid.', 'already_paid');
    const targets = await Promise.all(purchase.items.map((l) => readItem(tx, db, l.itemId)));
    const supplierRef = db.collection(SUPPLIERS).doc(purchase.supplierId);
    const supplier = await tx.get(supplierRef);
    const ledger = payFrom && purchase.totalUgx > 0 ? await openLedger(tx, db, [payFrom], now) : null;
    const numbers = await readCounter(tx, db, 'stock_movements', 'RMX-STM-', 6);

    const payment = ledger ? postPurchasePayment(ledger, { ref, purchase, accountId: payFrom, actor, reference, requestId }) : null;
    ledger?.commit(actor.uid);
    const low = [];
    purchase.items.forEach((line, i) => {
      const m = writeMovement(tx, db, targets[i], {
        type: 'stock_in', change: line.quantity, actor, number: numbers.next(),
        fields: {
          reason: `Received on ${purchase.purchaseNumber}`, reference: purchase.supplierReference ?? null,
          purchaseId: ref.id, purchaseNumber: purchase.purchaseNumber, unitCostUgx: line.unitCostUgx, requestId,
        },
      });
      if (m.becameLow) low.push(targets[i].ref.id);
      tx.update(targets[i].ref, itemUpdate(targets[i].item, actor.uid, { lastUnitCostUgx: line.unitCostUgx, preferredSupplierId: targets[i].item.preferredSupplierId ?? purchase.supplierId, preferredSupplierName: targets[i].item.preferredSupplierName ?? purchase.supplierName }));
    });
    numbers.commit();
    tx.update(ref, {
      status: 'received', receivedBy: actor.uid, receivedByName: actor.data.fullName ?? null, receivedAt: stamp(),
      ...(payment ? { paymentStatus: 'paid', paidAt: stamp(), paidBy: actor.uid, paidFromAccountId: payFrom, financialTransactionId: payment.transactionId, financialTransactionNumber: payment.transactionNumber } : {}),
      updatedAt: stamp(), updatedBy: actor.uid,
    });
    if (supplier.exists) {
      tx.update(supplierRef, {
        purchaseCount: (supplier.get('purchaseCount') ?? 0) + 1,
        totalPurchasedUgx: (supplier.get('totalPurchasedUgx') ?? 0) + purchase.totalUgx,
        lastPurchaseAt: stamp(),
      });
    }
    const out = { purchaseId: ref.id, status: 'received', transactionNumber: payment?.transactionNumber ?? null, low };
    saveRequest(tx, request.ref, 'purchase_receipt', actor.uid, out);
    audit(tx, db, actor, 'inventory', 'purchase.received', ref.id, {
      previousValue: { status: 'approved' },
      newValue: { status: 'received', lineCount: purchase.items.length, totalUgx: purchase.totalUgx, paidFromAccountId: payFrom },
    });
    if (payment) {
      audit(tx, db, actor, 'finance', 'purchase.paid', ref.id, {
        newValue: { purchaseNumber: purchase.purchaseNumber, amountUgx: purchase.totalUgx, accountId: payFrom, transactionNumber: payment.transactionNumber },
      });
    }
    return out;
  });
  if (!result.duplicate) await notifyLow(deps, result.low ?? [], now);
  return result;
}

export async function payPurchase(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const requestId = requireRequestId(data.requestId);
  const accountId = requireDocId(data.accountId, 'payment account');
  const reference = optionalText(data.reference, 'Payment reference', 60);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'expenses.pay');
    const request = await readRequest(tx, db, requestId, actor.uid, 'purchase_payment');
    if (request.earlier) return request.earlier;
    const { ref, purchase } = await readPurchase(tx, db, data.purchaseId);
    if (purchase.paymentStatus === 'paid') throw precondition('This purchase has already been paid.', 'already_paid');
    if (!['approved', 'received'].includes(purchase.status)) throw precondition('Only an approved or received purchase can be paid.', 'not_approved');
    const ledger = await openLedger(tx, db, [accountId], now);
    const payment = postPurchasePayment(ledger, { ref, purchase, accountId, actor, reference, requestId });
    ledger.commit(actor.uid);
    tx.update(ref, {
      paymentStatus: 'paid', paidAt: stamp(), paidBy: actor.uid, paidFromAccountId: accountId,
      financialTransactionId: payment.transactionId, financialTransactionNumber: payment.transactionNumber,
      updatedAt: stamp(), updatedBy: actor.uid,
    });
    const out = { purchaseId: ref.id, ...payment, balanceUgx: ledger.balance(accountId) };
    saveRequest(tx, request.ref, 'purchase_payment', actor.uid, out);
    audit(tx, db, actor, 'finance', 'purchase.paid', ref.id, {
      newValue: { purchaseNumber: purchase.purchaseNumber, amountUgx: purchase.totalUgx, accountId, transactionNumber: payment.transactionNumber },
    });
    return out;
  });
}

