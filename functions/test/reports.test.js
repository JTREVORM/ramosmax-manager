// Reports (Phase 9): permissions per report and per section, accounting
// separation (revenue vs owners' money vs transfers), reversals counted once,
// after-hours payments never duplicated, customer privacy, period validation
// - against the Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as ah from '../src/after_hours.js';
import * as billing from '../src/billing.js';
import * as finance from '../src/finance.js';
import { REPORTS, getBusinessReport, requirePeriod } from '../src/reports.js';
import { emulatorDb, helpers, rejects, resetAndSeed, rid } from './helpers.js';

const db = emulatorDb('reports-tests');
const { deps, world, invoicedJob } = helpers(db);
const NOW = Date.now();
const TODAY = finance.dayKey(NOW);
const report = (uid, name, extra = {}) => getBusinessReport(deps, uid, { report: name, from: TODAY, to: TODAY, ...extra }, NOW);
const section = (r, key) => r.sections.find((s) => s.key === key);
const fig = (r, sectionKey, key) => section(r, sectionKey)?.figures.find((f) => f.key === key)?.value;
const table = (r, sectionKey, key) => section(r, sectionKey)?.tables.find((t) => t.key === key);

beforeEach(() => resetAndSeed(db));

/** Invoices of 15,000 and 10,000; cash 15,000 and MTN 4,000 paid; the cash payment reversed. */
async function sales() {
  const w = await world();
  const a = await invoicedJob(w.vehicleId, [w.wash]);
  const b = await invoicedJob(w.vehicleId, [w.tyre]);
  const cash = await billing.recordPayment(deps, 'cash', { invoiceId: a.invoiceId, amountUgx: 15000, method: 'cash', requestId: rid() }, NOW);
  await billing.recordPayment(deps, 'cash', { invoiceId: b.invoiceId, amountUgx: 4000, method: 'mtn_merchant', reference: 'MTN123', requestId: rid() }, NOW);
  await billing.reversePayment(deps, 'admin', { paymentId: cash.paymentId, reason: 'Wrong invoice' }, NOW);
  return { w, a, b };
}

/** Owners' money and internal moves that must never look like revenue. */
async function nonRevenue() {
  await finance.recordOpeningBalance(deps, 'admin', { accountId: 'mtn_merchant', amountUgx: 200_000 });
  await db.runTransaction(async (tx) => {
    const l = await finance.openLedger(tx, db, ['cash_at_hand'], NOW);
    l.post({ type: 'share_capital_contribution', amountUgx: 1_000_000, toId: 'cash_at_hand', actor: { uid: 'admin', data: { fullName: 'admin' } } });
    l.commit('admin');
  });
  await finance.transferFunds(deps, 'admin', { fromAccountId: 'mtn_merchant', toAccountId: 'cash_at_hand', amountUgx: 50_000, reason: 'Float', requestId: rid() }, NOW);
}

describe('who may run which report', () => {
  test('workers get no report; the matrix follows the permissions', async () => {
    for (const name of Object.keys(REPORTS)) await rejects(report('wkr', name), 'permission-denied', 'report_forbidden');
    // Cashier: operational summary, credit and expenses - no money-in-and-out, no payroll, no ownership.
    assert.ok(await report('cash', 'executive'));
    assert.ok(await report('cash', 'outstanding'));
    for (const name of ['financial', 'revenue', 'payment_methods', 'workforce', 'shareholders', 'after_hours']) {
      await rejects(report('cash', name), 'permission-denied', 'report_forbidden');
    }
    // Shareholder: financial summaries (reports.financial.view) only.
    for (const name of ['executive', 'financial', 'revenue', 'payment_methods']) assert.ok(await report('sh', name));
    for (const name of ['outstanding', 'workforce', 'expenses', 'after_hours', 'inventory']) {
      await rejects(report('sh', name), 'permission-denied', 'report_forbidden');
    }
    // Inactive accounts get nothing.
    await rejects(report('wkrOff', 'executive'), 'permission-denied');
    for (const uid of ['admin', 'mgr', 'aud']) assert.ok(await report(uid, 'executive'), uid);
  });

  test('sections are filtered by permission inside a report', async () => {
    const keys = async (uid) => (await report(uid, 'executive')).sections.map((s) => s.key);
    assert.deepEqual(await keys('cash'), ['operations']);
    // A shareholder holds finance.view by role (Financial Summary): balances, no workforce or stock.
    assert.deepEqual(await keys('sh'), ['operations', 'revenue', 'finance']);
    const mgr = await keys('mgr');
    assert.ok(['operations', 'revenue', 'finance', 'workforce', 'inventory', 'ownership', 'after_hours'].every((k) => mgr.includes(k)), mgr.join());
    // The manager sees register-level ownership only (no contributions table).
    const own = (await report('mgr', 'shareholders')).sections[0];
    assert.equal(own.tables.find((t) => t.key === 'contributions'), undefined);
    assert.ok((await report('admin', 'shareholders')).sections[0].tables.find((t) => t.key === 'contributions'));
    // Payroll totals need payroll.view: a manager has it, a cashier has no workforce report at all.
    assert.ok(table(await report('mgr', 'workforce'), 'workforce', 'payroll'));
  });
});

describe('accounting separation', () => {
  test('revenue = customer payments net of reversals; capital, transfers and opening balances are listed apart', async () => {
    await sales();
    await nonRevenue();
    const r = await report('admin', 'revenue');
    assert.equal(fig(r, 'revenue', 'payments_gross'), 19000);
    assert.equal(fig(r, 'revenue', 'payment_reversals'), 15000);
    assert.equal(fig(r, 'revenue', 'operating_revenue'), 4000);
    assert.equal(fig(r, 'revenue', 'invoiced'), 25000);
    assert.equal(fig(r, 'revenue', 'credit_outstanding'), 21000);
    const apart = Object.fromEntries(table(r, 'revenue', 'not_revenue').rows.map((x) => [x.item.split(' ')[0], x.amountUgx]));
    assert.equal(apart.Share, 1_000_000);
    assert.equal(apart.Transfers, 50_000);
    assert.equal(apart.Opening, 200_000);
    const e = await report('admin', 'executive');
    assert.equal(fig(e, 'revenue', 'operating_revenue'), 4000, 'share capital is never revenue');
  });

  test('payment methods: a reversed payment is counted once and excluded from net', async () => {
    await sales();
    const r = await report('mgr', 'payment_methods');
    const rows = Object.fromEntries(table(r, 'payment_methods', 'by_method').rows.map((x) => [x.method, x]));
    assert.deepEqual([rows.Cash.count, rows.Cash.grossUgx, rows.Cash.reversedUgx, rows.Cash.netUgx], [1, 15000, 15000, 0]);
    assert.deepEqual([rows['MTN Merchant'].count, rows['MTN Merchant'].netUgx], [1, 4000]);
    assert.deepEqual([fig(r, 'payment_methods', 'gross'), fig(r, 'payment_methods', 'net')], [19000, 4000]);
  });

  test('money in and out: day rows from the ledger summaries add up to the totals', async () => {
    await sales();
    await nonRevenue();
    const r = await report('aud', 'financial');
    const day = table(r, 'financial', 'daily').rows;
    assert.equal(day.length, 1);
    assert.deepEqual([day[0].salesUgx, day[0].reversedUgx, day[0].capitalUgx, day[0].transfersUgx], [19000, 15000, 1_000_000, 50_000]);
    assert.equal(fig(r, 'financial', 'sales'), 4000);
  });

  test('after-hours payments are revenue once; a handover adds nothing', async () => {
    const w = await world();
    const inv = await invoicedJob(w.vehicleId, [w.wash]);
    const H = 3600_000;
    await ah.authorizeAfterHours(deps, 'mgr', { staffUid: 'wkr', startsAt: NOW, expiresAt: NOW + 4 * H, reason: 'Evening cover', requestId: rid() }, NOW);
    const s = await ah.openAfterHoursSession(deps, 'wkr', { requestId: rid() }, NOW);
    await billing.recordPayment(deps, 'wkr', { invoiceId: inv.invoiceId, amountUgx: 15000, method: 'cash', requestId: rid() }, NOW);
    const closed = await ah.closeAfterHoursSession(deps, 'wkr', { sessionId: s.sessionId }, NOW);
    await ah.receiveCashHandover(deps, 'mgr', { handoverId: closed.handoverId, actualAmountUgx: 14000, explanation: 'Short by 1,000', requestId: rid() }, NOW);
    const e = await report('mgr', 'executive');
    assert.equal(fig(e, 'revenue', 'operating_revenue'), 15000);
    assert.equal(fig(e, 'revenue', 'after_hours_payments'), 15000);
    const a = await report('mgr', 'after_hours');
    assert.deepEqual([fig(a, 'after_hours', 'expected'), fig(a, 'after_hours', 'received'), fig(a, 'after_hours', 'shortages'),
      fig(a, 'after_hours', 'discrepancies_open')], [15000, 14000, 1000, 1]);
  });
});

describe('outstanding and privacy', () => {
  test('remaining amounts, age and payment history; customer names only with customers.view', async () => {
    const { b } = await sales();
    const r = await report('mgr', 'outstanding');
    const row = table(r, 'outstanding', 'invoices').rows.find((x) => x.invoice === b.invoiceNumber);
    assert.deepEqual([row.totalUgx, row.paidUgx, row.outstandingUgx, row.payments, row.ageDays], [10000, 4000, 6000, 1, 0]);
    assert.equal(row.customer, 'John Doe');
    await db.doc('users/creditOnly').set({ uid: 'creditOnly', role: 'worker', active: true, phoneNumber: '+256700000009', fullName: 'Credit clerk',
      permissions: ['credit.view'], deniedPermissions: [], temporaryPermissions: {} });
    const limited = await report('creditOnly', 'outstanding');
    const t = table(limited, 'outstanding', 'invoices');
    assert.ok(!t.columns.some((c) => c.key === 'customer'));
    assert.ok(t.rows.every((x) => !('customer' in x)));
  });
});

describe('period', () => {
  test('valid EAT days, in order, not in the future, at most 400 days', () => {
    assert.deepEqual(requirePeriod('2026-09-01', '2026-09-30', Date.parse('2026-10-01T09:00:00+03:00')).days, 30);
    for (const [from, to] of [['2026-9-1', '2026-09-30'], ['2026-02-30', '2026-03-01'], ['2026-09-30', '2026-09-01'], ['2020-01-01', '2026-09-01']]) {
      assert.throws(() => requirePeriod(from, to, Date.parse('2026-10-01T09:00:00+03:00')), (e) => e.code === 'invalid-argument', `${from}..${to}`);
    }
    assert.throws(() => requirePeriod('2026-10-02', '2026-10-02', Date.parse('2026-10-01T09:00:00+03:00')), (e) => e.code === 'invalid-argument');
  });

  test('unknown reports are refused', async () => {
    await rejects(getBusinessReport(deps, 'admin', { report: 'everything', from: TODAY, to: TODAY }, NOW), 'invalid-argument', 'report');
    await rejects(getBusinessReport(deps, 'admin', { report: 'executive' }, NOW), 'invalid-argument', 'period');
  });
});
