// Pure access-model tests (no emulator needed): `npm run test:unit`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';

import {
  effectivePermissions, normalizePhone, requireCanAdminister, requireCanAssignRole, requireCanGrant,
  requireTemporaryWindow, rolePermissions, ALL_PERMISSIONS, maskPhone,
} from '../src/access.js';

const now = Date.UTC(2026, 8, 21, 12);
const H = 3600_000;
const user = (role, extra = {}) => ({ role, active: true, ...extra });

test('admin holds every permission; inactive or expired accounts hold none', () => {
  assert.equal(effectivePermissions(user('admin'), now).size, ALL_PERMISSIONS.length);
  assert.equal(effectivePermissions(user('admin', { active: false }), now).size, 0);
  assert.equal(effectivePermissions(user('admin', { active: 'true' }), now).size, 0);
  assert.equal(effectivePermissions(user('admin', { accessExpiresAt: Timestamp.fromMillis(now) }), now).size, 0);
  assert.equal(effectivePermissions(user('superuser'), now).size, 0);
});

test('grants add, denials remove (even for admins), temporary windows apply only while live', () => {
  const u = user('worker', {
    permissions: ['expenses.view', 'not.a.permission'],
    deniedPermissions: ['jobs.complete'],
    temporaryPermissions: {
      'payments.record': { startsAt: Timestamp.fromMillis(now - H), expiresAt: Timestamp.fromMillis(now + H) },
      'invoices.create': { startsAt: Timestamp.fromMillis(now + H), expiresAt: Timestamp.fromMillis(now + 2 * H) },
      'credit.view': Timestamp.fromMillis(now - 1), // Phase 1 format, expired
      'loyalty.view': Timestamp.fromMillis(now + H), // Phase 1 format, live
    },
  });
  const p = effectivePermissions(u, now);
  assert.ok(p.has('expenses.view'));
  assert.ok(!p.has('not.a.permission'));
  assert.ok(!p.has('jobs.complete'));
  assert.ok(p.has('payments.record'));
  assert.ok(!p.has('invoices.create'), 'scheduled grant not yet effective');
  assert.ok(!p.has('credit.view'), 'expired grant never effective');
  assert.ok(p.has('loyalty.view'));
  assert.ok(!effectivePermissions(u, now + H).has('payments.record'), 'expires exactly at expiresAt');
  assert.ok(!effectivePermissions(user('admin', { deniedPermissions: ['payroll.view'] }), now).has('payroll.view'));
});

test('role hierarchy: admins manage anyone; others only more junior roles', () => {
  assert.doesNotThrow(() => requireCanAdminister(user('admin'), user('admin')));
  assert.doesNotThrow(() => requireCanAdminister(user('manager'), user('worker')));
  assert.throws(() => requireCanAdminister(user('manager'), user('admin')), /Only an Administrator/);
  assert.throws(() => requireCanAdminister(user('manager'), user('auditor')), /more junior/);
  assert.throws(() => requireCanAdminister(user('cashier'), user('worker')), /more junior/);
  assert.throws(() => requireCanAssignRole(user('manager'), 'admin'), /Only an Administrator/);
  assert.throws(() => requireCanAssignRole(user('manager'), 'manager'), /at or above/);
  assert.throws(() => requireCanAssignRole(user('admin'), 'owner'), /valid role/);
});

test('nobody grants what they do not hold; admin-only permissions need an admin', () => {
  const mgr = user('manager');
  const perms = effectivePermissions(mgr, now);
  assert.doesNotThrow(() => requireCanGrant(mgr, perms, 'payments.record'));
  assert.throws(() => requireCanGrant(mgr, perms, 'payroll.approve'), /do not hold/);
  assert.throws(() => requireCanGrant(mgr, perms, 'users.permissions.temporary'), /Only an Administrator/);
  assert.throws(() => requireCanGrant(mgr, perms, 'made.up'), /Unknown permission/);
});

test('temporary window validation', () => {
  assert.deepEqual(requireTemporaryWindow(now, now + 4 * H, now), { startsAt: now, expiresAt: now + 4 * H });
  assert.equal(requireTemporaryWindow(now - 60_000, now + H, now).startsAt, now, 'recent past start clamps to now');
  assert.throws(() => requireTemporaryWindow(now + H, now + H, now), /after the start/);
  assert.throws(() => requireTemporaryWindow(now - H, now + H, now), /past/);
  assert.throws(() => requireTemporaryWindow(now, now + 31 * 24 * H, now), /30 days/);
  assert.throws(() => requireTemporaryWindow('x', now + H, now), /valid start/);
});

test('phone normalisation (Uganda default) and masking', () => {
  assert.equal(normalizePhone('0772 123 456'), '+256772123456');
  assert.equal(normalizePhone('256772123456'), '+256772123456');
  assert.equal(normalizePhone('+254712345678'), '+254712345678');
  assert.equal(normalizePhone('0612345678'), null);
  assert.equal(normalizePhone('+2567721'), null);
  assert.equal(maskPhone('+256772123456'), '+256772•••456');
});

test('auditor role is read-only', () => {
  for (const p of rolePermissions('auditor')) assert.match(p, /\.view(\.own)?$/);
});

test('Phase 5 defaults: least privilege for money and stock', () => {
  const p = (role) => rolePermissions(role);
  // Workers get no financial or inventory authority by default.
  for (const perm of p('worker')) assert.doesNotMatch(perm, /^(finance|expenses|inventory)\./);
  // Cashiers record expenses for review; they never review, approve, pay or see balances.
  assert.ok(p('cashier').has('expenses.create'));
  for (const perm of ['finance.view', 'expenses.review', 'expenses.approve', 'expenses.pay', 'expenses.cancel', 'finance.transfer', 'finance.deposit']) {
    assert.ok(!p('cashier').has(perm), perm);
  }
  // Managers run day-to-day finance; account set-up, adjustments and reversals stay with Admins.
  for (const perm of ['finance.transfer', 'finance.deposit', 'finance.reconcile', 'expenses.pay', 'inventory.stock.adjust', 'inventory.purchase.approve']) {
    assert.ok(p('manager').has(perm), perm);
  }
  for (const perm of ['finance.accounts.manage', 'finance.adjust', 'expenses.adjust']) assert.ok(!p('manager').has(perm), perm);
  // Auditors read the ledger and inventory reports (and remain read-only - see above).
  for (const perm of ['finance.transactions.view', 'inventory.reports.view', 'expenses.view']) assert.ok(p('auditor').has(perm), perm);
  for (const perm of ['finance.transactions.view', 'finance.deposit', 'finance.adjust', 'expenses.review', 'expenses.cancel',
    'expenses.adjust', 'expenses.categories.manage', 'expenses.recurring.manage', 'inventory.suppliers.manage',
    'inventory.purchase.create', 'inventory.purchase.approve', 'inventory.stock.in', 'inventory.stock.out', 'inventory.reports.view']) {
    assert.ok(ALL_PERMISSIONS.includes(perm), perm);
  }
});
