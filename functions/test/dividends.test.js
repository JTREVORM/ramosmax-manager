// Dividends: declaration, record-date eligibility and snapshot, per-share and
// pool allocation, approval, payment through the Phase 5 ledger (never an
// operating expense), duplicate-payment protection, insufficient funds,
// reversal, cancellation and authorisation (Phase 7) - against the emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as dividends from '../src/dividends.js';
import * as finance from '../src/finance.js';
import * as shareholders from '../src/shareholders.js';
import * as shares from '../src/shares.js';
import { eat, emulatorDb, financeHelpers, rejects, resetAndSeed, workforceHelpers } from './helpers.js';

const db = emulatorDb('dividend-tests');
const { deps, doc, all } = workforceHelpers(db);
const { balance, txns, assertLedgerConsistent } = financeHelpers(db);
const audits = async (action) => all('audit_logs', { action });

const NOW = eat(15, 12, 0, 12); // 15 December 2026
const RECORD = eat(31, 12, 0, 10); // 31 October 2026
let seq = 0;
const rid = () => `div-${Date.now()}-${seq++}`;

beforeEach(async () => {
  await resetAndSeed(db);
  const user = (uid, role, extra = {}) => db.doc(`users/${uid}`).set({
    uid, role, active: true, phoneNumber: '+256700000001', fullName: uid, permissions: [], deniedPermissions: [], temporaryPermissions: {}, ...extra,
  });
  await user('divOfficer', 'manager', { permissions: ['dividends.view', 'dividends.create', 'dividends.calculate', 'dividends.declare', 'dividends.approve'] });
  await user('payer', 'cashier', { permissions: ['dividends.pay'] });
  await user('admin2', 'admin');
});

const person = async (fullName) => (await shareholders.createShareholder(deps, 'admin', { fullName, requestId: rid() }, NOW)).shareholderId;
const issue = async (shareholderId, n, effectiveDate) => {
  const r = await shares.issueShares(deps, 'admin', {
    shareholderId, classId: 'ordinary', shares: n, effectiveDate, payment: { source: 'prior_record', amountUgx: n * 10000 },
    reason: 'Paid before the system', requestId: rid(),
  }, NOW);
  await shares.decideShareTransaction(deps, 'admin', { transactionId: r.transactionId, decision: 'approve' }, NOW);
};
const transfer = async (from, to, n, effectiveDate) => {
  const r = await shares.transferShares(deps, 'admin', {
    fromShareholderId: from, toShareholderId: to, classId: 'ordinary', shares: n, effectiveDate, reason: 'Private sale', requestId: rid(),
  }, NOW);
  return shares.decideShareTransaction(deps, 'admin', { transactionId: r.transactionId, decision: 'approve' }, NOW);
};
const fund = (amountUgx, accountId = 'bank_1') => finance.recordOpeningBalance(deps, 'admin', { accountId, amountUgx }, NOW);
/** The daily totals of the test clock's business day. */
const today = () => doc('finance_daily_summaries/2026-12-15');
const create = (extra = {}, actor = 'admin') => dividends.createDividend(deps, actor, {
  financialPeriod: 'FY 2026', recordDate: RECORD, declarationDate: eat(1, 12, 0, 10), calculationMethod: 'pool', totalDistributableUgx: 10_000_000,
  requestId: rid(), ...extra,
}, NOW);
const calc = (dividendId, actor = 'admin', now = NOW) => dividends.calculateDividend(deps, actor, { dividendId }, now);
const act = (dividendId, action, actor = 'admin', extra = {}) => dividends.updateDividendStatus(deps, actor, { dividendId, action, ...extra }, NOW);
const allocs = async (dividendId) => (await all('dividend_allocations', { dividendId })).filter((a) => a.current)
  .reduce((m, a) => ({ ...m, [a.shareholderName]: a }), {});
const pay = (dividendId, allocationIds, extra = {}, actor = 'admin') => dividends.payDividend(deps, actor, {
  dividendId, allocationIds, accountId: 'bank_1', requestId: rid(), ...extra,
}, NOW);

/** John 500, Mary 300, Peter 200 (1,000 shares) by September; after the record date John sells 250 to Mary. */
async function world() {
  await shareholders.createShareClass(deps, 'admin', { code: 'ORDINARY', name: 'Ordinary', valuePerShareUgx: 10000 }, NOW);
  const john = await person('John Okello');
  const mary = await person('Mary Nakato');
  const peter = await person('Peter Mugisha');
  await issue(john, 500, eat(1, 12, 0, 2));
  await issue(mary, 300, eat(1, 12, 0, 2));
  await issue(peter, 200, eat(1, 12, 0, 9));
  await transfer(john, mary, 250, eat(20, 12, 0, 11));
  return { john, mary, peter };
}

async function approved(extra = {}) {
  const ids = await world();
  const { dividendId } = await create(extra);
  await calc(dividendId);
  await act(dividendId, 'declare', 'divOfficer');
  await act(dividendId, 'approve', 'admin');
  return { ...ids, dividendId };
}

describe('declaration', () => {
  test('a draft gets a server number; client-supplied allocations and totals are ignored', async () => {
    await world();
    const r = await create({ allocations: [{ shareholderId: 'x', netUgx: 9_999_999 }], allocatedUgx: 1, paidUgx: 1, status: 'approved' });
    assert.equal(r.dividendNumber, 'RMX-DIV-000001');
    const d = await doc(`dividends/${r.dividendId}`);
    assert.deepEqual([d.status, d.totalDistributableUgx, d.allocatedUgx, d.paidUgx, d.recordLocked], ['draft', 10_000_000, 0, 0, false]);
    assert.equal((await all('dividend_allocations')).length, 0);
    assert.equal((await audits('dividend.created')).length, 1);
  });

  test('a retried creation is recorded once; invalid input is refused', async () => {
    await world();
    const requestId = rid();
    const a = await create({ requestId });
    assert.equal((await create({ requestId })).dividendId, a.dividendId);
    assert.equal((await all('dividends')).length, 1);
    await rejects(create({ totalDistributableUgx: -1 }), 'invalid-argument', 'amount');
    await rejects(create({ totalDistributableUgx: 0 }), 'invalid-argument', 'amount');
    await rejects(create({ calculationMethod: 'per_share' }), 'invalid-argument', 'amount');
    await rejects(create({ calculationMethod: 'profit_share' }), 'invalid-argument', 'method');
    await rejects(create({ paymentDate: eat(1, 12, 0, 10) }), 'invalid-argument', 'payment_date');
    await rejects(create({ financialPeriod: '' }), 'invalid-argument', 'required');
  });

  test('only dividends.create may create; managers (reports only), auditors, cashiers, workers and shareholders cannot', async () => {
    await world();
    for (const uid of ['mgr', 'aud', 'cash', 'wkr', 'sh', 'payer']) await rejects(create({}, uid), 'permission-denied');
    assert.ok((await create({}, 'divOfficer')).dividendId);
  });
});

describe('record date, eligibility and allocation', () => {
  test('allocations use ownership at the end of the record date, not today: pool 10,000,000 over 1,000 shares = 10,000 a share', async () => {
    const { john, mary, peter } = await world();
    // Today: John 250, Mary 550 - but on 31 October John held 500.
    assert.equal((await doc(`shareholders/${john}`)).totalShares, 250);
    const { dividendId } = await create();
    const r = await calc(dividendId);
    assert.deepEqual([r.eligibleShares, r.allocationCount, r.dividendPerShareUgx, r.allocatedUgx, r.unallocatedUgx], [1000, 3, 10000, 10_000_000, 0]);
    const a = await allocs(dividendId);
    assert.deepEqual([a['John Okello'].sharesAtRecordDate, a['John Okello'].grossUgx, a['John Okello'].netUgx, a['John Okello'].deductionsUgx], [500, 5_000_000, 5_000_000, 0]);
    assert.deepEqual([a['Mary Nakato'].sharesAtRecordDate, a['Mary Nakato'].netUgx], [300, 3_000_000]);
    assert.deepEqual([a['Peter Mugisha'].sharesAtRecordDate, a['Peter Mugisha'].ownershipPercentAtRecordDate], [200, 20]);
    assert.ok(a['John Okello'].allocationNumber.startsWith('RMX-DIV-PAY-'));
    const d = await doc(`dividends/${dividendId}`);
    assert.deepEqual([d.recordLocked, d.snapshot.asOf, d.snapshot.totalShares, d.eligibleShareholderCount], [true, '2026-10-31', 1000, 3]);
    void mary; void peter;
  });

  test('eligibility follows the record date: someone who bought after it gets nothing; someone who sold after it keeps the entitlement', async () => {
    const { john } = await world();
    const late = await person('Late Buyer');
    await transfer(john, late, 50, eat(1, 12, 0, 12));
    const { dividendId } = await create();
    await calc(dividendId);
    const a = await allocs(dividendId);
    assert.equal(a['Late Buyer'], undefined);
    assert.equal(a['John Okello'].sharesAtRecordDate, 500);
  });

  test('a record date in the future cannot be calculated yet', async () => {
    await world();
    const { dividendId } = await create({ recordDate: eat(31, 12, 0, 12) });
    await rejects(calc(dividendId), 'failed-precondition', 'record_date_future');
  });

  test('pool rounding: 1,000 over three equal holders is 333 each; the shilling left over is reported, never invented', async () => {
    await shareholders.createShareClass(deps, 'admin', { code: 'ORDINARY', name: 'Ordinary', valuePerShareUgx: 10000 }, NOW);
    for (const n of ['A One', 'B Two', 'C Three']) await issue(await person(n), 1, eat(1, 12, 0, 2));
    const { dividendId } = await create({ totalDistributableUgx: 1000 });
    const r = await calc(dividendId);
    assert.deepEqual([r.allocatedUgx, r.unallocatedUgx], [999, 1]);
    assert.deepEqual(Object.values(await allocs(dividendId)).map((a) => a.netUgx), [333, 333, 333]);
  });

  test('per-share method: dividend per share × eligible shares', async () => {
    await world();
    const { dividendId } = await create({ calculationMethod: 'per_share', dividendPerShareUgx: 2500, totalDistributableUgx: undefined });
    const r = await calc(dividendId);
    assert.deepEqual([r.allocatedUgx, r.dividendPerShareUgx], [2_500_000, 2500]);
    assert.equal((await allocs(dividendId))['John Okello'].netUgx, 1_250_000);
    assert.equal((await doc(`dividends/${dividendId}`)).totalDistributableUgx, 2_500_000);
  });

  test('a class filter counts only that class; nobody eligible is refused', async () => {
    await world();
    await shareholders.createShareClass(deps, 'admin', { code: 'PREFERENCE', name: 'Preference', valuePerShareUgx: 50000 }, NOW);
    const { dividendId } = await create({ classId: 'preference' });
    await rejects(calc(dividendId), 'failed-precondition', 'no_eligible_shares');
  });

  test('once calculated, ownership up to the record date is frozen: backdated share entries are refused until cancelled', async () => {
    const { john, mary } = await world();
    const { dividendId } = await create();
    await calc(dividendId);
    await rejects(shares.transferShares(deps, 'admin', {
      fromShareholderId: mary, toShareholderId: john, classId: 'ordinary', shares: 10, effectiveDate: eat(30, 12, 0, 10), reason: 'Backdated', requestId: rid(),
    }, NOW), 'failed-precondition', 'record_date_locked');
    await transfer(mary, john, 10, eat(1, 12, 0, 11)); // after the record date: fine
    await dividends.cancelDividend(deps, 'admin', { dividendId, reason: 'Board withdrew the resolution' }, NOW);
    await transfer(mary, john, 10, eat(30, 12, 0, 10));
  });

  test('recalculating supersedes the earlier allocations (kept, never deleted); editing a draft discards the calculation', async () => {
    await world();
    const { dividendId } = await create();
    await calc(dividendId);
    await calc(dividendId);
    const every = await all('dividend_allocations', { dividendId });
    assert.equal(every.length, 6);
    assert.equal(every.filter((a) => a.current).length, 3);
    await dividends.updateDividend(deps, 'divOfficer', {
      dividendId, financialPeriod: 'FY 2026', recordDate: RECORD, declarationDate: eat(1, 12, 0, 10), calculationMethod: 'pool', totalDistributableUgx: 8_000_000,
    }, NOW);
    const d = await doc(`dividends/${dividendId}`);
    assert.deepEqual([d.totalDistributableUgx, d.calculatedAt, d.recordLocked], [8_000_000, null, false]);
    assert.equal((await all('dividend_allocations', { dividendId })).filter((a) => a.current).length, 0);
    await rejects(act(dividendId, 'declare', 'divOfficer'), 'failed-precondition', 'not_calculated');
  });
});

describe('declaration and approval', () => {
  test('draft → declared → approved; approval needs an Administrator by default and is audited', async () => {
    await world();
    const { dividendId } = await create({}, 'divOfficer');
    await calc(dividendId, 'divOfficer');
    await rejects(act(dividendId, 'approve', 'admin'), 'failed-precondition', 'invalid_status');
    await act(dividendId, 'declare', 'divOfficer');
    await rejects(act(dividendId, 'approve', 'divOfficer'), 'permission-denied', 'admin_approval_required');
    await rejects(act(dividendId, 'approve', 'mgr'), 'permission-denied');
    await rejects(act(dividendId, 'approve', 'aud'), 'permission-denied');
    await act(dividendId, 'approve', 'admin');
    const d = await doc(`dividends/${dividendId}`);
    assert.deepEqual([d.status, d.approvedBy, d.declaredBy], ['approved', 'admin', 'divOfficer']);
    assert.ok(Object.values(await allocs(dividendId)).every((a) => a.dividendStatus === 'approved'));
    for (const a of ['dividend.calculated', 'dividend.declared', 'dividend.approved']) assert.equal((await audits(a)).length, 1, a);
    await rejects(act(dividendId, 'approve', 'admin'), 'failed-precondition', 'already_approved');
  });

  test('with admin approval off, a non-admin still cannot approve what they declared, or a dividend that pays them', async () => {
    const { john } = await world();
    await shareholders.updateShareholdingPolicy(deps, 'admin', { policy: 'dividend', changes: { requireAdminApproval: false }, reason: 'Board delegated' }, NOW);
    const { dividendId } = await create();
    await calc(dividendId);
    await act(dividendId, 'declare', 'divOfficer');
    await rejects(act(dividendId, 'approve', 'divOfficer'), 'permission-denied', 'self_approval');
    await act(dividendId, 'return', 'divOfficer', { reason: 'Recheck period' });
    await act(dividendId, 'declare', 'admin');
    await shareholders.linkShareholderAccount(deps, 'admin', { shareholderId: john, uid: 'divOfficer' }, NOW);
    await rejects(act(dividendId, 'approve', 'divOfficer'), 'permission-denied', 'own_shareholding');
  });
});

describe('payment', () => {
  test('paying reduces the account through the ledger as a distribution - not revenue, not an operating expense', async () => {
    const { dividendId } = await approved();
    await fund(20_000_000);
    const a = await allocs(dividendId);
    const r = await pay(dividendId, [a['John Okello'].allocationId]);
    assert.deepEqual([r.status, r.amountUgx, r.balanceUgx], ['partially_paid', 5_000_000, 15_000_000]);
    assert.equal(await balance('bank_1'), 15_000_000);
    const [t] = await txns({ type: 'dividend_payment' });
    assert.deepEqual([t.amountUgx, t.isRevenue, t.sourceAccountId, t.allocationNumber, t.dividendNumber], [5_000_000, false, 'bank_1', a['John Okello'].allocationNumber, 'RMX-DIV-000001']);
    const day = await today();
    assert.equal(day.dividendsPaidUgx, 5_000_000);
    assert.equal(day.expensesPaidUgx, undefined, 'dividends are not operating expenses');
    assert.equal(day.customerPaymentsUgx, undefined);
    const paid = await doc(`dividend_allocations/${a['John Okello'].allocationId}`);
    assert.deepEqual([paid.paymentStatus, paid.financialTransactionId, paid.accountId], ['paid', t.transactionId, 'bank_1']);
    assert.equal((await doc(`shareholders/${paid.shareholderId}`)).dividendsPaidUgx, 5_000_000);
    const d = await doc(`dividends/${dividendId}`);
    assert.deepEqual([d.status, d.paidUgx, d.outstandingUgx, d.paidCount], ['partially_paid', 5_000_000, 5_000_000, 1]);
    await pay(dividendId, [a['Mary Nakato'].allocationId, a['Peter Mugisha'].allocationId], {}, 'payer');
    assert.deepEqual([(await doc(`dividends/${dividendId}`)).status, await balance('bank_1')], ['paid', 10_000_000]);
    await assertLedgerConsistent();
  });

  test('duplicate payment: a retry is recorded once; paying a paid allocation again is refused', async () => {
    const { dividendId } = await approved();
    await fund(20_000_000);
    const a = await allocs(dividendId);
    const requestId = rid();
    await pay(dividendId, [a['John Okello'].allocationId], { requestId });
    assert.equal((await pay(dividendId, [a['John Okello'].allocationId], { requestId })).duplicate, true);
    await rejects(pay(dividendId, [a['John Okello'].allocationId]), 'failed-precondition', 'already_paid');
    assert.equal((await txns({ type: 'dividend_payment' })).length, 1);
    assert.equal(await balance('bank_1'), 15_000_000);
  });

  test('insufficient funds: refused, nothing is paid or posted', async () => {
    const { dividendId } = await approved();
    await fund(6_000_000);
    const a = await allocs(dividendId);
    await rejects(pay(dividendId, [a['John Okello'].allocationId, a['Mary Nakato'].allocationId]), 'failed-precondition', 'insufficient_funds');
    assert.equal(await balance('bank_1'), 6_000_000);
    assert.equal((await doc(`dividend_allocations/${a['John Okello'].allocationId}`)).paymentStatus, 'unpaid');
    assert.equal((await txns({ type: 'dividend_payment' })).length, 0);
  });

  test('only an approved dividend is paid, only by dividends.pay holders, never allocations of another dividend', async () => {
    await world();
    await fund(20_000_000);
    const { dividendId } = await create();
    await calc(dividendId);
    const a = await allocs(dividendId);
    await rejects(pay(dividendId, [a['John Okello'].allocationId]), 'failed-precondition', 'not_approved');
    await act(dividendId, 'declare');
    await act(dividendId, 'approve');
    for (const uid of ['mgr', 'cash', 'aud', 'wkr', 'sh', 'divOfficer']) await rejects(pay(dividendId, [a['John Okello'].allocationId], {}, uid), 'permission-denied');
    const other = await create();
    await calc(other.dividendId);
    await rejects(pay(other.dividendId, [a['John Okello'].allocationId]), 'failed-precondition', 'not_approved');
    await act(other.dividendId, 'declare');
    await act(other.dividendId, 'approve');
    await rejects(pay(other.dividendId, [a['John Okello'].allocationId]), 'not-found', 'allocation_not_found');
  });

  test('a dividend payment cannot be reversed through the generic finance reversal', async () => {
    const { dividendId } = await approved();
    await fund(20_000_000);
    const a = await allocs(dividendId);
    await pay(dividendId, [a['John Okello'].allocationId]);
    const [t] = await txns({ type: 'dividend_payment' });
    await rejects(finance.reverseFinancialTransaction(deps, 'admin', { transactionId: t.transactionId, reason: 'Generic' }, NOW), 'failed-precondition', 'use_ownership_reversal');
  });
});

describe('reversal and cancellation', () => {
  test('reversing a payment returns the money, keeps the original entry (marked reversed) and re-opens the allocation', async () => {
    const { dividendId } = await approved();
    await fund(20_000_000);
    const a = await allocs(dividendId);
    await pay(dividendId, [a['John Okello'].allocationId, a['Mary Nakato'].allocationId]);
    const id = a['John Okello'].allocationId;
    await rejects(dividends.reverseDividendPayment(deps, 'admin', { allocationId: id }, NOW), 'invalid-argument', 'reason');
    await rejects(dividends.reverseDividendPayment(deps, 'payer', { allocationId: id, reason: 'Wrong account' }, NOW), 'permission-denied');
    const r = await dividends.reverseDividendPayment(deps, 'admin', { allocationId: id, reason: 'Paid to the wrong bank account' }, NOW);
    assert.equal(r.dividendStatus, 'partially_paid');
    assert.equal(await balance('bank_1'), 17_000_000);
    const alloc = await doc(`dividend_allocations/${id}`);
    assert.deepEqual([alloc.paymentStatus, alloc.reversals.length, alloc.reversals[0].reason], ['unpaid', 1, 'Paid to the wrong bank account']);
    const original = (await txns({ type: 'dividend_payment' })).find((t) => t.allocationId === id);
    assert.equal(original.status, 'reversed');
    const d = await doc(`dividends/${dividendId}`);
    assert.deepEqual([d.paidUgx, d.paidCount, d.outstandingUgx], [3_000_000, 1, 7_000_000]);
    assert.equal((await today()).reversals.dividend_paymentUgx, 5_000_000);
    await rejects(dividends.reverseDividendPayment(deps, 'admin', { allocationId: id, reason: 'Again' }, NOW), 'failed-precondition', 'not_paid');
    // It can be paid again, correctly.
    await pay(dividendId, [id]);
    assert.equal((await doc(`dividend_allocations/${id}`)).paymentStatus, 'paid');
    assert.equal((await audits('dividend.payment_reversed')).length, 1);
    await assertLedgerConsistent();
  });

  test('a dividend with payments cannot be cancelled until they are reversed; cancelled dividends keep their allocations', async () => {
    const { dividendId } = await approved();
    await fund(20_000_000);
    const a = await allocs(dividendId);
    await pay(dividendId, [a['Peter Mugisha'].allocationId]);
    await rejects(dividends.cancelDividend(deps, 'admin', { dividendId, reason: 'Withdrawn' }, NOW), 'failed-precondition', 'reverse_payments_first');
    await dividends.reverseDividendPayment(deps, 'admin', { allocationId: a['Peter Mugisha'].allocationId, reason: 'Withdrawn' }, NOW);
    assert.equal((await doc(`dividends/${dividendId}`)).status, 'approved');
    await rejects(dividends.cancelDividend(deps, 'admin', { dividendId }, NOW), 'invalid-argument', 'reason');
    await rejects(dividends.cancelDividend(deps, 'divOfficer', { dividendId, reason: 'Withdrawn' }, NOW), 'permission-denied');
    await dividends.cancelDividend(deps, 'admin', { dividendId, reason: 'Board withdrew the resolution' }, NOW);
    const d = await doc(`dividends/${dividendId}`);
    assert.deepEqual([d.status, d.recordLocked, d.cancelReason], ['cancelled', false, 'Board withdrew the resolution']);
    assert.equal(Object.values(await allocs(dividendId)).every((x) => x.dividendStatus === 'cancelled'), true);
    await rejects(pay(dividendId, [a['John Okello'].allocationId]), 'failed-precondition', 'not_approved');
    assert.equal(await balance('bank_1'), 20_000_000);
  });

  test('pure helpers: allocate and statusAfterPayments', () => {
    const r = dividends.allocate({ method: 'pool', poolUgx: 10_000_000, holders: [{ shareholderId: 'a', shares: 100 }, { shareholderId: 'b', shares: 900 }] });
    assert.deepEqual(r.lines.map((l) => l.netUgx), [1_000_000, 9_000_000]);
    assert.equal(r.dividendPerShareUgx, 10000);
    assert.throws(() => dividends.allocate({ method: 'pool', poolUgx: 1, holders: [] }), /eligible/);
    assert.deepEqual([dividends.statusAfterPayments(0, 3), dividends.statusAfterPayments(1, 3), dividends.statusAfterPayments(3, 3)], ['approved', 'partially_paid', 'paid']);
  });
});

describe('shareholder self-service', () => {
  test('a linked shareholder sees their approved dividends only; drafts and other shareholders stay hidden', async () => {
    const { mary } = await world();
    await shareholders.linkShareholderAccount(deps, 'admin', { shareholderId: mary, uid: 'sh' }, NOW);
    const { dividendId } = await create();
    await calc(dividendId);
    assert.deepEqual((await shareholders.getMyShareholding(deps, 'sh', {}, NOW)).dividends, []);
    await act(dividendId, 'declare');
    await act(dividendId, 'approve');
    await fund(20_000_000);
    const a = await allocs(dividendId);
    await pay(dividendId, [a['Mary Nakato'].allocationId]);
    const mine = await shareholders.getMyShareholding(deps, 'sh', {}, NOW);
    assert.equal(mine.dividends.length, 1);
    assert.deepEqual([mine.dividends[0].netUgx, mine.dividends[0].paymentStatus, mine.dividends[0].sharesAtRecordDate], [3_000_000, 'paid', 300]);
    assert.equal(mine.shareholder.dividendsPaidUgx, 3_000_000);
    assert.ok(!JSON.stringify(mine).includes('John') && !JSON.stringify(mine).includes('Peter'));
  });
});
