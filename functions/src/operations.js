// ===========================================================================
// RamosMAX operations - customers, vehicles, the service catalogue and
// service intakes (Phase 3).
// ===========================================================================
// Same pattern as user_admin.js: the caller is identified from the verified
// ID token, their permissions are computed on the server, every input is
// validated, and each change is written together with its audit entries in
// ONE transaction. The Firestore rules deny all client writes to these
// collections, so these checks cannot be bypassed.
//
// Integrity guarantees (enforced here, not in the app):
//   * a normalised number plate belongs to at most one vehicle;
//   * a customer's primary phone number belongs to at most one customer;
//   * service names are unique (case-insensitive);
//   * a vehicle only references an existing, active customer;
//   * an intake only references an existing, active vehicle and existing,
//     ACTIVE services, and a vehicle has at most one open intake.
// Uniqueness uses reservation documents in `unique_keys` (create-once inside
// the same transaction), which is race-safe where a query is not.
// ===========================================================================

import { createRequire } from 'node:module';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import {
  invalid, precondition, requirePermission, requireName, optionalEmail, optionalText,
  normalizePhone, requireReason, maskPhone,
} from './access.js';
import { parsePlate } from './plates.js';
import { loadActor, actorFrom, requireObject } from './user_admin.js';

const require = createRequire(import.meta.url);
const catalog = require('./access_catalog.json');
export const SERVICE_CATEGORIES = Object.freeze([...catalog.serviceCategories]);
export const VEHICLE_TYPES = Object.freeze([...catalog.vehicleTypes]);

const CUSTOMERS = 'customers';
const VEHICLES = 'vehicles';
const SERVICES = 'services';
export const INTAKES = 'service_intakes';
const UNIQUE = 'unique_keys';
const COUNTERS = 'counters';
const USERS = 'users';
const AUDIT = 'audit_logs';

/** Largest single service price accepted (UGX). Guards against typos. */
export const MAX_PRICE_UGX = 100_000_000;
export const MAX_SERVICES_PER_INTAKE = 20;

export const alreadyExists = (message, reason, extra = {}) => new HttpsError('already-exists', message, { reason, ...extra });
export const notFound = (message, reason = 'not_found') => new HttpsError('not-found', message, { reason });
export const stamp = () => FieldValue.serverTimestamp();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function requireDocId(value, what) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw invalid(`Choose a valid ${what}.`, 'id');
  }
  return value;
}

/** Lower-case word prefixes, so "joh" or "doe" finds "John Doe" with one array-contains query. */
export function searchTokens(...values) {
  const tokens = new Set();
  for (const value of values) {
    for (const word of String(value ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
      for (let i = 1; i <= Math.min(word.length, 15); i++) tokens.add(word.slice(0, i));
    }
  }
  return [...tokens];
}

function optionalPhone(input, field) {
  if (input == null || input === '') return null;
  const phone = normalizePhone(input);
  if (!phone) throw invalid(`${field} is not a valid phone number, e.g. 0772 123 456.`, 'phone');
  return phone;
}

function requireText(input, field, max) {
  const value = optionalText(input, field, max);
  if (!value) throw invalid(`Enter the ${field.toLowerCase()}.`, 'required');
  return value;
}

function requireStatus(input) {
  if (input !== 'active' && input !== 'inactive') throw invalid('Choose active or inactive.', 'status');
  return input;
}

export function audit(tx, db, actor, module, action, recordId, { previousValue = null, newValue = null, reason = null, description = null } = {}) {
  tx.set(db.collection(AUDIT).doc(), {
    userId: actor.uid,
    userRole: actor.data.role,
    action,
    module,
    recordId,
    description,
    reason,
    previousValue,
    newValue,
    source: 'cloud_function',
    timestamp: stamp(),
  });
}

/** Re-reads the caller inside the transaction so a concurrent demotion is honoured. */
export async function freshActor(tx, db, uid, now, ...permissions) {
  const actor = actorFrom(uid, await tx.get(db.collection(USERS).doc(uid)), now);
  requirePermission(actor.perms, ...permissions);
  return actor;
}

export const uniqueRef = (db, kind, value) => db.collection(UNIQUE).doc(`${kind}_${value}`);

export async function nextNumber(tx, db, counter, prefix, width) {
  const ref = db.collection(COUNTERS).doc(counter);
  const snap = await tx.get(ref);
  const n = snap.exists ? Number(snap.get('next')) || 1 : 1;
  return { value: `${prefix}${String(n).padStart(width, '0')}`, commit: () => tx.set(ref, { next: n + 1 }, { merge: true }) };
}

function diff(before, after, fields) {
  const previousValue = {};
  const newValue = {};
  for (const f of fields) {
    if (f in after && (after[f] ?? null) !== (before[f] ?? null)) {
      previousValue[f] = before[f] ?? null;
      newValue[f] = after[f] ?? null;
    }
  }
  return Object.keys(newValue).length ? { previousValue, newValue } : null;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const CUSTOMER_FIELDS = ['fullName', 'phoneNumber', 'alternativePhone', 'email', 'address', 'notes'];

function customerInput(data, { partial }) {
  const out = {};
  if (!partial || 'fullName' in data) out.fullName = requireName(data.fullName);
  if (!partial || 'phoneNumber' in data) out.phoneNumber = optionalPhone(data.phoneNumber, 'Phone number');
  if (!partial || 'alternativePhone' in data) out.alternativePhone = optionalPhone(data.alternativePhone, 'Alternative phone');
  if (!partial || 'email' in data) out.email = optionalEmail(data.email);
  if (!partial || 'address' in data) out.address = optionalText(data.address, 'Address', 200);
  if (!partial || 'notes' in data) out.notes = optionalText(data.notes, 'Notes', 500);
  if (out.phoneNumber && out.phoneNumber === out.alternativePhone) {
    throw invalid('The alternative phone must be different from the main phone.', 'phone');
  }
  return out;
}

/**
 * Reads (inside [tx]) everything needed to create a customer; returns a
 * function that performs the writes. Split so callers can finish all their
 * reads first, as Firestore transactions require.
 */
async function prepareCustomerCreate(tx, db, actor, input) {
  const phoneRef = input.phoneNumber ? uniqueRef(db, 'customer_phone', input.phoneNumber) : null;
  const phoneSnap = phoneRef ? await tx.get(phoneRef) : null;
  if (phoneSnap?.exists) {
    throw alreadyExists('A customer with this phone number already exists.', 'duplicate_phone',
      { customerId: phoneSnap.get('customerId') });
  }
  const number = await nextNumber(tx, db, 'customers', 'RMX-CUS-', 6);
  const ref = db.collection(CUSTOMERS).doc();
  return {
    ref,
    customerNumber: number.value,
    write: () => {
      number.commit();
      tx.set(ref, {
        customerId: ref.id,
        customerNumber: number.value,
        ...input,
        searchTokens: searchTokens(input.fullName),
        status: 'active',
        vehicleCount: 0,
        createdAt: stamp(),
        updatedAt: stamp(),
        createdBy: actor.uid,
        updatedBy: actor.uid,
      });
      if (phoneRef) tx.set(phoneRef, { kind: 'customer_phone', customerId: ref.id });
      audit(tx, db, actor, 'customers', 'customer.created', ref.id, {
        newValue: { customerNumber: number.value, phoneNumber: maskPhone(input.phoneNumber) },
      });
    },
  };
}

export async function createCustomer(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  await loadActor(db, callerUid, now).then((a) => requirePermission(a.perms, 'customers.manage'));
  const input = customerInput(data, { partial: false });
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'customers.manage');
    const created = await prepareCustomerCreate(tx, db, actor, input);
    created.write();
    return { customerId: created.ref.id, customerNumber: created.customerNumber };
  });
}

export async function updateCustomer(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const customerId = requireDocId(data.customerId, 'customer');
  const changes = customerInput(data, { partial: true });
  const status = 'status' in data ? requireStatus(data.status) : null;
  const reason = requireReason(data.reason, { required: status === 'inactive' });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'customers.manage');
    const ref = db.collection(CUSTOMERS).doc(customerId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('That customer could not be found.');
    const before = snap.data();

    const change = diff(before, changes, CUSTOMER_FIELDS);
    const statusChanged = status && status !== before.status;
    if (!change && !statusChanged) throw precondition('Nothing has changed.', 'no_changes');

    // Reads first: phone reservation and the customer's vehicles (for the
    // name copy shown at reception).
    const phoneChanged = change && 'phoneNumber' in change.newValue;
    const newPhoneRef = phoneChanged && changes.phoneNumber ? uniqueRef(db, 'customer_phone', changes.phoneNumber) : null;
    const newPhoneSnap = newPhoneRef ? await tx.get(newPhoneRef) : null;
    if (newPhoneSnap?.exists && newPhoneSnap.get('customerId') !== customerId) {
      throw alreadyExists('Another customer already uses this phone number.', 'duplicate_phone',
        { customerId: newPhoneSnap.get('customerId') });
    }
    const nameChanged = change && 'fullName' in change.newValue;
    const vehicles = nameChanged
      ? await tx.get(db.collection(VEHICLES).where('customerId', '==', customerId).limit(200))
      : null;

    const update = { ...changes, updatedAt: stamp(), updatedBy: actor.uid };
    if (nameChanged) update.searchTokens = searchTokens(changes.fullName);
    if (statusChanged) update.status = status;
    tx.update(ref, update);
    if (phoneChanged) {
      if (before.phoneNumber) tx.delete(uniqueRef(db, 'customer_phone', before.phoneNumber));
      if (newPhoneRef) tx.set(newPhoneRef, { kind: 'customer_phone', customerId });
    }
    for (const v of vehicles?.docs ?? []) {
      tx.update(v.ref, { customerName: changes.fullName, updatedAt: stamp() });
    }

    if (change) {
      const mask = (v) => ({ ...v, ...('phoneNumber' in v ? { phoneNumber: maskPhone(v.phoneNumber) } : {}),
        ...('alternativePhone' in v ? { alternativePhone: maskPhone(v.alternativePhone) } : {}) });
      audit(tx, db, actor, 'customers', 'customer.updated', customerId,
        { previousValue: mask(change.previousValue), newValue: mask(change.newValue), reason });
    }
    if (statusChanged) {
      audit(tx, db, actor, 'customers', 'customer.status_changed', customerId,
        { previousValue: { status: before.status }, newValue: { status }, reason });
    }
    return { customerId };
  });
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

const VEHICLE_FIELDS = ['make', 'model', 'colour', 'year', 'vehicleType', 'notes'];

function requirePlate(input) {
  const plate = parsePlate(input);
  if (!plate) throw invalid('Enter a valid number plate, e.g. UBA 123A.', 'plate');
  return plate;
}

function optionalYear(input, now) {
  if (input == null || input === '') return null;
  const year = Number(input);
  const max = new Date(now).getUTCFullYear() + 1;
  if (!Number.isInteger(year) || year < 1950 || year > max) {
    throw invalid(`Enter a year between 1950 and ${max}.`, 'year');
  }
  return year;
}

function vehicleInput(data, now, { partial }) {
  const out = {};
  if (!partial || 'make' in data) out.make = optionalText(data.make, 'Make', 40);
  if (!partial || 'model' in data) out.model = requireText(data.model, 'Model', 60);
  if (!partial || 'colour' in data) out.colour = requireText(data.colour, 'Colour', 30);
  if (!partial || 'year' in data) out.year = optionalYear(data.year, now);
  if (!partial || 'vehicleType' in data) {
    const type = data.vehicleType ?? null;
    if (type !== null && type !== '' && !VEHICLE_TYPES.includes(type)) throw invalid('Choose a valid vehicle type.', 'vehicle_type');
    out.vehicleType = type || null;
  }
  if (!partial || 'notes' in data) out.notes = optionalText(data.notes, 'Notes', 500);
  return out;
}

/** Reads a customer a vehicle may be linked to. */
async function readLinkableCustomer(tx, db, customerId) {
  const ref = db.collection(CUSTOMERS).doc(requireDocId(customerId, 'customer'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That customer could not be found.', 'customer_missing');
  if (snap.get('status') !== 'active') {
    throw precondition('That customer is inactive. Reactivate them or choose another customer.', 'customer_inactive');
  }
  return snap;
}

export async function createVehicle(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const plate = requirePlate(data.numberPlate);
  const input = vehicleInput(data, now, { partial: false });
  const newCustomer = data.newCustomer != null ? customerInput(requireObject(data.newCustomer), { partial: false }) : null;
  if (newCustomer && data.customerId) throw invalid('Choose an existing customer or a new one, not both.', 'customer');

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'vehicles.manage');
    if (newCustomer) requirePermission(actor.perms, 'customers.manage');

    // --- reads ---
    const plateRef = uniqueRef(db, 'plate', plate.key);
    const plateSnap = await tx.get(plateRef);
    if (plateSnap.exists) {
      throw alreadyExists(`${plate.display} is already registered.`, 'duplicate_plate', { vehicleId: plateSnap.get('vehicleId') });
    }
    let customer = null;
    if (data.customerId) {
      const snap = await readLinkableCustomer(tx, db, data.customerId);
      customer = { id: snap.id, name: snap.get('fullName'), number: snap.get('customerNumber') };
    }
    const created = newCustomer ? await prepareCustomerCreate(tx, db, actor, newCustomer) : null;
    if (created) customer = { id: created.ref.id, name: newCustomer.fullName, number: created.customerNumber };

    // --- writes ---
    created?.write();
    const ref = db.collection(VEHICLES).doc();
    tx.set(ref, {
      vehicleId: ref.id,
      numberPlate: plate.display,
      normalizedNumberPlate: plate.key,
      previousPlates: [],
      ...input,
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? null,
      customerNumber: customer?.number ?? null,
      status: 'active',
      lastIntakeAt: null,
      createdAt: stamp(),
      updatedAt: stamp(),
      createdBy: actor.uid,
      updatedBy: actor.uid,
    });
    tx.set(plateRef, { kind: 'plate', vehicleId: ref.id });
    if (customer) tx.update(db.collection(CUSTOMERS).doc(customer.id), { vehicleCount: FieldValue.increment(1) });
    audit(tx, db, actor, 'vehicles', 'vehicle.created', ref.id, {
      newValue: { numberPlate: plate.display, customerId: customer?.id ?? null },
    });
    return { vehicleId: ref.id, numberPlate: plate.display, customerId: customer?.id ?? null };
  });
}

export async function updateVehicle(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const vehicleId = requireDocId(data.vehicleId, 'vehicle');
  const changes = vehicleInput(data, now, { partial: true });
  const newPlate = 'numberPlate' in data ? requirePlate(data.numberPlate) : null;
  const status = 'status' in data ? requireStatus(data.status) : null;
  const relink = 'customerId' in data || data.newCustomer != null;
  const newCustomer = data.newCustomer != null ? customerInput(requireObject(data.newCustomer), { partial: false }) : null;

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'vehicles.manage');
    if (newCustomer) requirePermission(actor.perms, 'customers.manage');
    const ref = db.collection(VEHICLES).doc(vehicleId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('That vehicle could not be found.');
    const before = snap.data();

    const change = diff(before, changes, VEHICLE_FIELDS);
    const plateChanged = newPlate && newPlate.key !== before.normalizedNumberPlate;
    const plateRespaced = newPlate && !plateChanged && newPlate.display !== before.numberPlate;
    const statusChanged = status && status !== before.status;
    const targetCustomerId = newCustomer ? '(new)' : (data.customerId || null);
    const customerChanged = relink && targetCustomerId !== (before.customerId ?? null);
    if (!change && !plateChanged && !plateRespaced && !statusChanged && !customerChanged) {
      throw precondition('Nothing has changed.', 'no_changes');
    }
    // Identity changes need a reason in the audit trail.
    const reason = requireReason(data.reason, { required: Boolean(plateChanged || customerChanged || status === 'inactive') });

    // --- reads ---
    let newPlateRef = null;
    if (plateChanged) {
      newPlateRef = uniqueRef(db, 'plate', newPlate.key);
      const taken = await tx.get(newPlateRef);
      if (taken.exists) {
        throw alreadyExists(`${newPlate.display} is already registered to another vehicle.`, 'duplicate_plate',
          { vehicleId: taken.get('vehicleId') });
      }
    }
    let customer = null;
    let created = null;
    if (customerChanged && newCustomer) {
      created = await prepareCustomerCreate(tx, db, actor, newCustomer);
      customer = { id: created.ref.id, name: newCustomer.fullName, number: created.customerNumber };
    } else if (customerChanged && targetCustomerId) {
      const c = await readLinkableCustomer(tx, db, targetCustomerId);
      customer = { id: c.id, name: c.get('fullName'), number: c.get('customerNumber') };
    }

    // --- writes ---
    created?.write();
    const update = { ...changes, updatedAt: stamp(), updatedBy: actor.uid };
    if (plateChanged || plateRespaced) {
      update.numberPlate = newPlate.display;
      update.normalizedNumberPlate = newPlate.key;
    }
    if (plateChanged) {
      // Keep the old identity for history and search of old paperwork.
      update.previousPlates = FieldValue.arrayUnion(before.numberPlate);
      tx.delete(uniqueRef(db, 'plate', before.normalizedNumberPlate));
      tx.set(newPlateRef, { kind: 'plate', vehicleId });
    }
    if (customerChanged) {
      Object.assign(update, {
        customerId: customer?.id ?? null, customerName: customer?.name ?? null, customerNumber: customer?.number ?? null,
      });
      if (before.customerId) tx.update(db.collection(CUSTOMERS).doc(before.customerId), { vehicleCount: FieldValue.increment(-1) });
      if (customer) tx.update(db.collection(CUSTOMERS).doc(customer.id), { vehicleCount: FieldValue.increment(1) });
    }
    if (statusChanged) update.status = status;
    tx.update(ref, update);

    if (change) audit(tx, db, actor, 'vehicles', 'vehicle.updated', vehicleId, { ...change, reason });
    if (plateChanged || plateRespaced) {
      audit(tx, db, actor, 'vehicles', 'vehicle.plate_changed', vehicleId, {
        previousValue: { numberPlate: before.numberPlate }, newValue: { numberPlate: newPlate.display }, reason,
      });
    }
    if (customerChanged) {
      audit(tx, db, actor, 'vehicles', 'vehicle.customer_changed', vehicleId, {
        previousValue: { customerId: before.customerId ?? null }, newValue: { customerId: customer?.id ?? null }, reason,
      });
    }
    if (statusChanged) {
      audit(tx, db, actor, 'vehicles', 'vehicle.status_changed', vehicleId, {
        previousValue: { status: before.status }, newValue: { status }, reason,
      });
    }
    return { vehicleId };
  });
}

// ---------------------------------------------------------------------------
// Service catalogue
// ---------------------------------------------------------------------------

const SERVICE_FIELDS = ['name', 'description', 'category', 'priceUgx', 'estimatedDurationMinutes', 'qualifiesForLoyalty'];

/** Whole, non-negative Uganda shillings. Rejects 10000.5, "10,000", negatives. */
export function requirePriceUgx(input) {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0 || input > MAX_PRICE_UGX) {
    throw invalid('Enter the price as a whole number of shillings (UGX), e.g. 10000.', 'price');
  }
  return input;
}

function serviceInput(data, { partial }) {
  const out = {};
  if (!partial || 'name' in data) out.name = requireText(data.name, 'Service name', 60);
  if (!partial || 'description' in data) out.description = optionalText(data.description, 'Description', 300);
  if (!partial || 'category' in data) {
    if (!SERVICE_CATEGORIES.includes(data.category)) throw invalid('Choose a valid category.', 'category');
    out.category = data.category;
  }
  if (!partial || 'priceUgx' in data) out.priceUgx = requirePriceUgx(data.priceUgx);
  if (!partial || 'estimatedDurationMinutes' in data) {
    const d = data.estimatedDurationMinutes;
    if (d != null && (!Number.isInteger(d) || d < 1 || d > 1440)) {
      throw invalid('Enter a duration between 1 and 1440 minutes.', 'duration');
    }
    out.estimatedDurationMinutes = d ?? null;
  }
  if (!partial || 'qualifiesForLoyalty' in data) out.qualifiesForLoyalty = data.qualifiesForLoyalty === true;
  return out;
}

const nameKey = (name) => name.toLowerCase().replace(/\s+/g, ' ').trim();

export async function createService(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const input = serviceInput(data, { partial: false });
  const isActive = data.isActive !== false;

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'services.manage');
    const keyRef = uniqueRef(db, 'service_name', nameKey(input.name));
    const taken = await tx.get(keyRef);
    if (taken.exists) {
      throw alreadyExists(`A service called "${input.name}" already exists.`, 'duplicate_service', { serviceId: taken.get('serviceId') });
    }
    const ref = db.collection(SERVICES).doc();
    tx.set(ref, {
      serviceId: ref.id,
      ...input,
      isActive,
      createdAt: stamp(),
      updatedAt: stamp(),
      createdBy: actor.uid,
      updatedBy: actor.uid,
    });
    tx.set(keyRef, { kind: 'service_name', serviceId: ref.id });
    audit(tx, db, actor, 'services', 'service.created', ref.id, {
      newValue: { name: input.name, category: input.category, priceUgx: input.priceUgx, isActive },
    });
    return { serviceId: ref.id };
  });
}

export async function updateService(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const serviceId = requireDocId(data.serviceId, 'service');
  const changes = serviceInput(data, { partial: true });
  const isActive = 'isActive' in data ? data.isActive === true : null;
  const reason = requireReason(data.reason, { required: false });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'services.manage');
    const ref = db.collection(SERVICES).doc(serviceId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('That service could not be found.');
    const before = snap.data();
    const change = diff(before, changes, SERVICE_FIELDS);
    const activeChanged = isActive !== null && isActive !== before.isActive;
    if (!change && !activeChanged) throw precondition('Nothing has changed.', 'no_changes');

    const renamed = change && 'name' in change.newValue && nameKey(changes.name) !== nameKey(before.name);
    let newKeyRef = null;
    if (renamed) {
      newKeyRef = uniqueRef(db, 'service_name', nameKey(changes.name));
      const taken = await tx.get(newKeyRef);
      if (taken.exists) throw alreadyExists(`A service called "${changes.name}" already exists.`, 'duplicate_service');
    }

    tx.update(ref, { ...changes, ...(activeChanged ? { isActive } : {}), updatedAt: stamp(), updatedBy: actor.uid });
    if (renamed) {
      tx.delete(uniqueRef(db, 'service_name', nameKey(before.name)));
      tx.set(newKeyRef, { kind: 'service_name', serviceId });
    }
    if (change && 'priceUgx' in change.newValue) {
      audit(tx, db, actor, 'services', 'service.price_changed', serviceId, {
        previousValue: { priceUgx: before.priceUgx }, newValue: { priceUgx: changes.priceUgx }, reason,
      });
      delete change.previousValue.priceUgx;
      delete change.newValue.priceUgx;
    }
    if (change && Object.keys(change.newValue).length > 0) {
      audit(tx, db, actor, 'services', 'service.updated', serviceId, { ...change, reason });
    }
    if (activeChanged) {
      audit(tx, db, actor, 'services', isActive ? 'service.activated' : 'service.deactivated', serviceId, {
        previousValue: { isActive: before.isActive }, newValue: { isActive }, reason,
      });
    }
    return { serviceId };
  });
}

// ---------------------------------------------------------------------------
// Service intake - the start of a visit (Phase 4 extends it into the job)
// ---------------------------------------------------------------------------

export function requireServiceIds(input) {
  if (!Array.isArray(input) || input.length === 0) throw invalid('Select at least one service.', 'services');
  const ids = [...new Set(input.map((id) => requireDocId(id, 'service')))];
  if (ids.length > MAX_SERVICES_PER_INTAKE) throw invalid(`Select at most ${MAX_SERVICES_PER_INTAKE} services.`, 'services');
  return ids;
}

/** Reads the chosen services; every one must exist and be active. Price is captured as it is now. */
export async function readSelectedServices(tx, db, ids) {
  const snaps = await Promise.all(ids.map((id) => tx.get(db.collection(SERVICES).doc(id))));
  return snaps.map((s) => {
    if (!s.exists) throw invalid('One of the selected services no longer exists.', 'unknown_service');
    if (s.get('isActive') !== true) throw invalid(`"${s.get('name')}" is not currently offered.`, 'inactive_service');
    return {
      serviceId: s.id,
      name: s.get('name'),
      category: s.get('category'),
      priceUgx: s.get('priceUgx'),
      qualifiesForLoyalty: s.get('qualifiesForLoyalty') === true,
    };
  });
}

// createServiceIntake / updateServiceIntake live in jobs.js (Phase 4): an intake
// is now the job, and it creates and tracks its worker orders.
