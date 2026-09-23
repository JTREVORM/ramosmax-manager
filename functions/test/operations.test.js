// Customers, vehicles, service catalogue and service intake - against the
// Firestore emulator. Run with `npm test`.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { getApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import * as jobs from '../src/jobs.js';
import * as ops from '../src/operations.js';
import { displayPlate, parsePlate, plateKey } from '../src/plates.js';

const PROJECT = 'demo-ramosmax';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run through `npm test` so the Firebase emulators are started.');
initializeApp({ projectId: PROJECT }, 'ops-tests');
const db = getFirestore(getApp('ops-tests'));
const deps = { db };

beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (const [uid, role, extra] of [
    ['admin', 'admin'], ['mgr', 'manager'], ['cash', 'cashier'], ['wkr', 'worker'], ['aud', 'auditor'], ['sh', 'shareholder'],
    ['wkrReg', 'worker', { permissions: ['vehicles.manage'] }],
  ]) {
    await db.doc(`users/${uid}`).set({ uid, role, active: true, phoneNumber: '+256700000000', fullName: uid,
      permissions: [], deniedPermissions: [], temporaryPermissions: {}, ...extra });
  }
});

async function rejects(promise, code, reason) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (reason) assert.equal(e.details?.reason, reason);
    return true;
  });
}
const doc = async (path) => (await db.doc(path).get()).data();
const audits = async (action) => (await db.collection('audit_logs').where('action', '==', action).get()).docs.map((d) => d.data());

const service = (actor, extra = {}) => ops.createService(deps, actor, {
  name: 'Full Wash', category: 'washing', priceUgx: 15000, estimatedDurationMinutes: 45, qualifiesForLoyalty: true, ...extra,
});

describe('number plates', () => {
  test('input variations normalise to one display form and one key', () => {
    for (const input of ['UGB 123A', 'UGB123A', 'ugb 123a', 'UGB-123A', '  ugb  123a ']) {
      assert.deepEqual(parsePlate(input), { display: 'UGB 123A', key: 'UGB123A' }, input);
    }
    assert.equal(displayPlate('ug 1234'), 'UG 1234');
    assert.equal(plateKey('CD 123 45'), 'CD12345');
    for (const bad of ['', 'ABC 123A', '123 UBA', 'UBA 12', 'UBA 12345']) assert.equal(parsePlate(bad), null, bad);
  });
});

describe('customers', () => {
  test('create with only a name; phone normalised; number allocated; audited', async () => {
    const a = await ops.createCustomer(deps, 'cash', { fullName: 'John Doe' });
    const b = await ops.createCustomer(deps, 'cash', { fullName: 'Mary Achieng', phoneNumber: '0772 123 456', email: 'Mary@Example.com' });
    assert.equal(a.customerNumber, 'RMX-CUS-000001');
    assert.equal(b.customerNumber, 'RMX-CUS-000002');
    const m = await doc(`customers/${b.customerId}`);
    assert.equal(m.phoneNumber, '+256772123456');
    assert.equal(m.email, 'mary@example.com');
    assert.equal(m.status, 'active');
    assert.ok(m.searchTokens.includes('mar') && m.searchTokens.includes('achieng'));
    const [created] = await audits('customer.created');
    assert.ok(!JSON.stringify(created).includes('772123456'), 'full phone number not in the audit log');
  });

  test('validation and duplicate phone numbers', async () => {
    await rejects(ops.createCustomer(deps, 'cash', { fullName: '' }), 'invalid-argument', 'name');
    await rejects(ops.createCustomer(deps, 'cash', { fullName: 'Bad Phone', phoneNumber: '12345' }), 'invalid-argument', 'phone');
    await rejects(ops.createCustomer(deps, 'cash', { fullName: 'Bad Mail', email: 'not-an-email' }), 'invalid-argument', 'email');
    const first = await ops.createCustomer(deps, 'cash', { fullName: 'First', phoneNumber: '0772123456' });
    await assert.rejects(ops.createCustomer(deps, 'cash', { fullName: 'Second', phoneNumber: '+256772123456' }), (e) => {
      assert.equal(e.details.reason, 'duplicate_phone');
      assert.equal(e.details.customerId, first.customerId);
      return true;
    });
  });

  test('edit, rename propagates to vehicles, status change needs a reason; all audited', async () => {
    const { customerId } = await ops.createCustomer(deps, 'mgr', { fullName: 'John Doe', phoneNumber: '0772123456' });
    const { vehicleId } = await ops.createVehicle(deps, 'mgr', { numberPlate: 'UGB 123A', model: 'Harrier', colour: 'Black', customerId });
    await ops.updateCustomer(deps, 'mgr', { customerId, fullName: 'John Okello Doe', phoneNumber: '0701 000 111' });
    assert.equal((await doc(`vehicles/${vehicleId}`)).customerName, 'John Okello Doe');
    // The old number is free again; the new one is reserved.
    await ops.createCustomer(deps, 'mgr', { fullName: 'Reuses Old', phoneNumber: '0772123456' });
    await rejects(ops.createCustomer(deps, 'mgr', { fullName: 'Clash', phoneNumber: '0701000111' }), 'already-exists', 'duplicate_phone');

    await rejects(ops.updateCustomer(deps, 'mgr', { customerId, status: 'inactive' }), 'invalid-argument', 'reason');
    await ops.updateCustomer(deps, 'mgr', { customerId, status: 'inactive', reason: 'Moved away' });
    assert.equal((await doc(`customers/${customerId}`)).status, 'inactive');
    assert.equal((await audits('customer.status_changed'))[0].reason, 'Moved away');
    assert.equal((await audits('customer.updated')).length, 1);
    await rejects(ops.updateCustomer(deps, 'mgr', { customerId, fullName: 'John Okello Doe' }), 'failed-precondition', 'no_changes');
  });

  test('who may manage customers', async () => {
    for (const uid of ['wkr', 'aud', 'sh']) {
      await rejects(ops.createCustomer(deps, uid, { fullName: 'Nope' }), 'permission-denied');
    }
    for (const uid of ['admin', 'mgr', 'cash']) assert.ok((await ops.createCustomer(deps, uid, { fullName: `By ${uid}` })).customerId);
  });
});

describe('vehicles', () => {
  test('register with plate, model and colour; duplicates by normalised plate are refused', async () => {
    const v = await ops.createVehicle(deps, 'cash', { numberPlate: 'ugb-123a', model: 'Harrier', colour: 'Black', make: 'Toyota', year: 2015, vehicleType: 'suv' });
    assert.equal(v.numberPlate, 'UGB 123A');
    const saved = await doc(`vehicles/${v.vehicleId}`);
    assert.deepEqual([saved.numberPlate, saved.normalizedNumberPlate, saved.status, saved.customerId], ['UGB 123A', 'UGB123A', 'active', null]);
    for (const variant of ['UGB 123A', 'UGB123A', 'ugb 123a', 'UGB-123A']) {
      await rejects(ops.createVehicle(deps, 'cash', { numberPlate: variant, model: 'X', colour: 'Y' }), 'already-exists', 'duplicate_plate');
    }
    await rejects(ops.createVehicle(deps, 'cash', { numberPlate: 'ABC 123', model: 'X', colour: 'Y' }), 'invalid-argument', 'plate');
    await rejects(ops.createVehicle(deps, 'cash', { numberPlate: 'UAX 456B', colour: 'White' }), 'invalid-argument', 'required');
    await rejects(ops.createVehicle(deps, 'cash', { numberPlate: 'UAX 456B', model: 'Premio' }), 'invalid-argument', 'required');
    await rejects(ops.createVehicle(deps, 'cash', { numberPlate: 'UAX 456B', model: 'Premio', colour: 'White', year: 1800 }), 'invalid-argument', 'year');
    await rejects(ops.createVehicle(deps, 'cash', { numberPlate: 'UAX 456B', model: 'Premio', colour: 'White', vehicleType: 'spaceship' }), 'invalid-argument', 'vehicle_type');
  });

  test('link to an existing customer or create one in the same step; one customer, many vehicles', async () => {
    const { customerId } = await ops.createCustomer(deps, 'cash', { fullName: 'John Doe' });
    await ops.createVehicle(deps, 'cash', { numberPlate: 'UGB 123A', model: 'Harrier', colour: 'Black', customerId });
    await ops.createVehicle(deps, 'cash', { numberPlate: 'UAX 456B', model: 'Premio', colour: 'White', customerId });
    await ops.createVehicle(deps, 'cash', { numberPlate: 'UBD 789C', model: 'Forester', colour: 'Blue', customerId });
    assert.equal((await doc(`customers/${customerId}`)).vehicleCount, 3);
    const owned = await db.collection('vehicles').where('customerId', '==', customerId).get();
    assert.equal(owned.size, 3);

    const withNew = await ops.createVehicle(deps, 'cash', {
      numberPlate: 'UBE 100A', model: 'Vitz', colour: 'Silver', newCustomer: { fullName: 'Jane New', phoneNumber: '0772000111' },
    });
    const v = await doc(`vehicles/${withNew.vehicleId}`);
    assert.equal(v.customerName, 'Jane New');
    assert.equal((await doc(`customers/${v.customerId}`)).phoneNumber, '+256772000111');

    await rejects(ops.createVehicle(deps, 'cash', { numberPlate: 'UBE 200A', model: 'X', colour: 'Y', customerId: 'nope' }), 'not-found', 'customer_missing');
    await ops.updateCustomer(deps, 'cash', { customerId, status: 'inactive', reason: 'Gone' });
    await rejects(ops.createVehicle(deps, 'cash', { numberPlate: 'UBE 300A', model: 'X', colour: 'Y', customerId }), 'failed-precondition', 'customer_inactive');
    // A failed registration leaves nothing behind.
    await rejects(ops.createVehicle(deps, 'cash', { numberPlate: 'UGB 123A', model: 'X', colour: 'Y', newCustomer: { fullName: 'Orphan' } }), 'already-exists');
    assert.equal((await db.collection('customers').where('fullName', '==', 'Orphan').get()).size, 0);
  });

  test('plate change: validated, duplicates refused, reason required, history kept, audited', async () => {
    const a = await ops.createVehicle(deps, 'mgr', { numberPlate: 'UGB 123A', model: 'Harrier', colour: 'Black' });
    await ops.createVehicle(deps, 'mgr', { numberPlate: 'UAX 456B', model: 'Premio', colour: 'White' });
    await rejects(ops.updateVehicle(deps, 'mgr', { vehicleId: a.vehicleId, numberPlate: 'uax456b', reason: 'fix' }), 'already-exists', 'duplicate_plate');
    await rejects(ops.updateVehicle(deps, 'mgr', { vehicleId: a.vehicleId, numberPlate: 'UGC 999A' }), 'invalid-argument', 'reason');
    await ops.updateVehicle(deps, 'mgr', { vehicleId: a.vehicleId, numberPlate: 'ugc999a', reason: 'Registration corrected' });
    const v = await doc(`vehicles/${a.vehicleId}`);
    assert.deepEqual([v.numberPlate, v.normalizedNumberPlate, v.previousPlates], ['UGC 999A', 'UGC999A', ['UGB 123A']]);
    // The old plate can be registered again; the new one is taken.
    assert.ok((await ops.createVehicle(deps, 'mgr', { numberPlate: 'UGB 123A', model: 'Other', colour: 'Red' })).vehicleId);
    await rejects(ops.createVehicle(deps, 'mgr', { numberPlate: 'UGC 999A', model: 'X', colour: 'Y' }), 'already-exists');
    const [audit] = await audits('vehicle.plate_changed');
    assert.deepEqual([audit.previousValue.numberPlate, audit.newValue.numberPlate, audit.reason], ['UGB 123A', 'UGC 999A', 'Registration corrected']);
  });

  test('customer relink and status change are audited; details edit', async () => {
    const c1 = await ops.createCustomer(deps, 'mgr', { fullName: 'Seller' });
    const c2 = await ops.createCustomer(deps, 'mgr', { fullName: 'Buyer' });
    const { vehicleId } = await ops.createVehicle(deps, 'mgr', { numberPlate: 'UGB 123A', model: 'Harrier', colour: 'Black', customerId: c1.customerId });
    await rejects(ops.updateVehicle(deps, 'mgr', { vehicleId, customerId: c2.customerId }), 'invalid-argument', 'reason');
    await ops.updateVehicle(deps, 'mgr', { vehicleId, customerId: c2.customerId, reason: 'Sold' });
    assert.equal((await doc(`vehicles/${vehicleId}`)).customerName, 'Buyer');
    assert.equal((await doc(`customers/${c1.customerId}`)).vehicleCount, 0);
    assert.equal((await doc(`customers/${c2.customerId}`)).vehicleCount, 1);
    assert.equal((await audits('vehicle.customer_changed')).length, 1);

    await ops.updateVehicle(deps, 'mgr', { vehicleId, colour: 'Pearl White', year: 2016 });
    assert.equal((await audits('vehicle.updated'))[0].newValue.colour, 'Pearl White');
    await ops.updateVehicle(deps, 'mgr', { vehicleId, status: 'inactive', reason: 'Written off' });
    assert.equal((await doc(`vehicles/${vehicleId}`)).status, 'inactive');
    assert.equal((await audits('vehicle.status_changed')).length, 1);
  });

  test('who may register vehicles', async () => {
    for (const uid of ['wkr', 'aud', 'sh']) {
      await rejects(ops.createVehicle(deps, uid, { numberPlate: 'UGB 123A', model: 'X', colour: 'Y' }), 'permission-denied');
    }
    assert.ok((await ops.createVehicle(deps, 'wkrReg', { numberPlate: 'UGB 123A', model: 'X', colour: 'Y' })).vehicleId, 'a worker granted vehicles.manage');
    await rejects(ops.createVehicle(deps, 'wkrReg', { numberPlate: 'UGB 124A', model: 'X', colour: 'Y', newCustomer: { fullName: 'New Person' } }), 'permission-denied');
  });
});

describe('service catalogue', () => {
  test('create with category, whole-shilling price, duration and loyalty flag', async () => {
    const { serviceId } = await service('mgr');
    const s = await doc(`services/${serviceId}`);
    assert.deepEqual([s.name, s.category, s.priceUgx, s.estimatedDurationMinutes, s.qualifiesForLoyalty, s.isActive],
      ['Full Wash', 'washing', 15000, 45, true, true]);
    await rejects(service('mgr', { name: 'full   wash' }), 'already-exists', 'duplicate_service');
  });

  test('prices must be whole, non-negative UGX; categories and durations validated', async () => {
    for (const bad of [10000.5, -1, '10,000', '10000', null, 1e12]) {
      await rejects(service('mgr', { name: `P ${bad}`, priceUgx: bad }), 'invalid-argument', 'price');
    }
    assert.ok((await service('mgr', { name: 'Free Check', priceUgx: 0 })).serviceId, 'zero is allowed');
    await rejects(service('mgr', { name: 'Cat', category: 'rocket' }), 'invalid-argument', 'category');
    await rejects(service('mgr', { name: 'Dur', estimatedDurationMinutes: 0 }), 'invalid-argument', 'duration');
    await rejects(service('mgr', { name: 'Dur2', estimatedDurationMinutes: 12.5 }), 'invalid-argument', 'duration');
    await rejects(service('mgr', { name: '' }), 'invalid-argument', 'required');
  });

  test('price change, rename and deactivation are audited', async () => {
    const { serviceId } = await service('mgr');
    await ops.updateService(deps, 'mgr', { serviceId, priceUgx: 18000, reason: 'New price list' });
    const [price] = await audits('service.price_changed');
    assert.deepEqual([price.previousValue.priceUgx, price.newValue.priceUgx], [15000, 18000]);
    await ops.updateService(deps, 'mgr', { serviceId, name: 'Premium Wash', qualifiesForLoyalty: false });
    assert.equal((await audits('service.updated')).length, 1);
    await ops.updateService(deps, 'mgr', { serviceId, isActive: false });
    assert.equal((await doc(`services/${serviceId}`)).isActive, false);
    assert.equal((await audits('service.deactivated')).length, 1);
    await ops.updateService(deps, 'mgr', { serviceId, isActive: true });
    assert.equal((await audits('service.activated')).length, 1);
    // The old name is free again.
    assert.ok((await service('mgr')).serviceId);
  });

  test('only services.manage holders can create services or change prices', async () => {
    const { serviceId } = await service('admin');
    for (const uid of ['cash', 'wkr', 'aud', 'sh']) {
      await rejects(service(uid, { name: `By ${uid}` }), 'permission-denied');
      await rejects(ops.updateService(deps, uid, { serviceId, priceUgx: 1 }), 'permission-denied');
    }
    assert.equal((await doc(`services/${serviceId}`)).priceUgx, 15000);
  });
});

describe('service intake', () => {
  async function setup() {
    const { customerId } = await ops.createCustomer(deps, 'cash', { fullName: 'John Doe' });
    const { vehicleId } = await ops.createVehicle(deps, 'cash', { numberPlate: 'UGB 123A', make: 'Toyota', model: 'Harrier', colour: 'Black', customerId });
    const wash = (await service('admin')).serviceId;
    const interior = (await service('admin', { name: 'Interior Cleaning', category: 'interior', priceUgx: 20000 })).serviceId;
    const polish = (await service('admin', { name: 'Polishing', category: 'polishing', priceUgx: 50000, isActive: false })).serviceId;
    return { customerId, vehicleId, wash, interior, polish };
  }

  test('an intake records the vehicle, customer and a price snapshot of the selected services', async () => {
    const { customerId, vehicleId, wash, interior } = await setup();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId, serviceIds: [wash, interior, wash] });
    const i = await doc(`service_intakes/${intakeId}`);
    assert.deepEqual([i.status, i.numberPlate, i.customerId, i.customerName, i.serviceCount], ['open', 'UGB 123A', customerId, 'John Doe', 2]);
    assert.equal(i.vehicleSummary, 'Toyota · Harrier · Black');
    assert.deepEqual(i.selectedServices.map((s) => [s.name, s.priceUgx]), [['Full Wash', 15000], ['Interior Cleaning', 20000]]);
    assert.equal((await audits('service_intake.created')).length, 1);
    // A later price change does not rewrite the intake.
    await ops.updateService(deps, 'admin', { serviceId: wash, priceUgx: 99000 });
    assert.equal((await doc(`service_intakes/${intakeId}`)).selectedServices[0].priceUgx, 15000);
  });

  test('invalid, inactive or missing services and inactive vehicles are refused', async () => {
    const { vehicleId, wash, polish } = await setup();
    await rejects(jobs.createServiceIntake(deps, 'cash', { vehicleId, serviceIds: [] }), 'invalid-argument', 'services');
    await rejects(jobs.createServiceIntake(deps, 'cash', { vehicleId, serviceIds: [wash, 'ghost'] }), 'invalid-argument', 'unknown_service');
    await rejects(jobs.createServiceIntake(deps, 'cash', { vehicleId, serviceIds: [polish] }), 'invalid-argument', 'inactive_service');
    await rejects(jobs.createServiceIntake(deps, 'cash', { vehicleId: 'ghost', serviceIds: [wash] }), 'not-found', 'vehicle_missing');
    await ops.updateVehicle(deps, 'cash', { vehicleId, status: 'inactive', reason: 'Sold' });
    await rejects(jobs.createServiceIntake(deps, 'cash', { vehicleId, serviceIds: [wash] }), 'failed-precondition', 'vehicle_inactive');
    assert.equal((await db.collection('service_intakes').get()).size, 0);
  });

  test('one open intake per vehicle; cancel with a reason; edit selected services', async () => {
    const { vehicleId, wash, interior } = await setup();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId, serviceIds: [wash] });
    await rejects(jobs.createServiceIntake(deps, 'cash', { vehicleId, serviceIds: [interior] }), 'failed-precondition', 'open_intake_exists');
    await jobs.updateServiceIntake(deps, 'cash', { intakeId, serviceIds: [wash, interior] });
    assert.equal((await doc(`service_intakes/${intakeId}`)).serviceCount, 2);
    await rejects(jobs.updateServiceIntake(deps, 'cash', { intakeId, status: 'cancelled' }), 'invalid-argument', 'reason');
    await jobs.updateServiceIntake(deps, 'cash', { intakeId, status: 'cancelled', reason: 'Customer left' });
    const i = await doc(`service_intakes/${intakeId}`);
    assert.deepEqual([i.status, i.cancelReason], ['cancelled', 'Customer left']);
    await rejects(jobs.updateServiceIntake(deps, 'cash', { intakeId, serviceIds: [wash] }), 'failed-precondition', 'cancelled');
    assert.ok((await jobs.createServiceIntake(deps, 'cash', { vehicleId, serviceIds: [wash] })).intakeId, 'a new visit can start');
    assert.equal((await audits('service_intake.cancelled')).length, 1);
  });

  test('who may start a service', async () => {
    const { vehicleId, wash } = await setup();
    for (const uid of ['wkr', 'aud', 'sh']) {
      await rejects(jobs.createServiceIntake(deps, uid, { vehicleId, serviceIds: [wash] }), 'permission-denied');
    }
    assert.ok((await jobs.createServiceIntake(deps, 'mgr', { vehicleId, serviceIds: [wash] })).intakeId);
  });
});
