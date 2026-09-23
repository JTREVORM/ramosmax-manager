// Shareholders, share classes, share issues / transfers / adjustments /
// reversals, contributions through the Phase 5 ledger, ownership (current and
// historical), approvals, idempotency and authorisation (Phase 7) - against
// the Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as finance from '../src/finance.js';
import * as shareholders from '../src/shareholders.js';
import * as shares from '../src/shares.js';
import { eat, emulatorDb, financeHelpers, rejects, resetAndSeed, workforceHelpers } from './helpers.js';

const db = emulatorDb('shares-tests');
const { deps, doc, all } = workforceHelpers(db);
const { balance, txns, assertLedgerConsistent } = financeHelpers(db);
/** The daily totals of the test clock's business day. */
const today = () => doc('finance_daily_summaries/2026-12-15');
const audits = async (action) => all('audit_logs', { action });

const NOW = eat(15, 12, 0, 12); // 15 December 2026
let seq = 0;
const rid = () => `shr-${Date.now()}-${seq++}`;

beforeEach(async () => {
  await resetAndSeed(db);
  const user = (uid, role, extra = {}) => db.doc(`users/${uid}`).set({
    uid, role, active: true, phoneNumber: '+256700000001', fullName: uid, permissions: [], deniedPermissions: [], temporaryPermissions: {}, ...extra,
  });
  // A manager given the share-office permissions, and a second approver.
  await user('officer', 'manager', { permissions: ['shareholders.view', 'shareholders.create', 'shareholders.update', 'shares.view', 'shares.issue',
    'shares.transfer', 'shares.adjust', 'shares.approve'] });
  await user('approver', 'manager', { permissions: ['shares.view', 'shares.approve'] });
  await user('sh2', 'shareholder');
});

const person = (fullName, extra = {}, actor = 'admin') =>
  shareholders.createShareholder(deps, actor, { fullName, joinDate: eat(1, 12, 0, 1), requestId: rid(), ...extra }, NOW);
const ordinary = (valuePerShareUgx = 10000) =>
  shareholders.createShareClass(deps, 'admin', { code: 'ORDINARY', name: 'Ordinary shares', valuePerShareUgx }, NOW);
const policy = (changes) => shareholders.updateShareholdingPolicy(deps, 'admin', { policy: 'share', changes, reason: 'Board resolution 2026/04' }, NOW);
const cashPay = (amountUgx, accountId = 'cash_at_hand') => ({ source: 'account', amountUgx, accountId });
const issue = (shareholderId, n, extra = {}, actor = 'admin', now = NOW) => shares.issueShares(deps, actor, {
  shareholderId, classId: 'ordinary', shares: n, payment: cashPay(n * 10000), requestId: rid(), ...extra,
}, now);
const approve = (transactionId, actor = 'admin', extra = {}) =>
  shares.decideShareTransaction(deps, actor, { transactionId, decision: 'approve', ...extra }, NOW);
/** Issue + approve. */
const holdingOf = async (id, n, extra = {}, now = NOW) => {
  const r = await issue(id, n, extra, 'admin', now);
  if (r.status === 'pending_approval') await approve(r.transactionId);
  return r;
};
const transfer = (fromShareholderId, toShareholderId, n, extra = {}, actor = 'admin', now = NOW) => shares.transferShares(deps, actor, {
  fromShareholderId, toShareholderId, classId: 'ordinary', shares: n, reason: 'Sale between shareholders, agreement AG-7', requestId: rid(), ...extra,
}, now);
const sh = (id) => doc(`shareholders/${id}`);

/** John 100, Mary 50, Peter 50 - the brief's ownership example. */
async function example() {
  await ordinary();
  const john = (await person('John Okello', { phoneNumber: '0772 100 001' })).shareholderId;
  const mary = (await person('Mary Nakato', { phoneNumber: '0772 100 002' })).shareholderId;
  const peter = (await person('Peter Mugisha')).shareholderId;
  await holdingOf(john, 100);
  await holdingOf(mary, 50);
  await holdingOf(peter, 50);
  return { john, mary, peter };
}

describe('shareholder profiles', () => {
  test('created with a server number, active status, search tokens and an audit entry', async () => {
    const r = await person('John Okello', { phoneNumber: '0772 100 001', email: 'John@Example.com', idType: 'national_id', idNumber: 'cm 9001 23' });
    assert.equal(r.shareholderNumber, 'RMX-SHR-000001');
    const s = await sh(r.shareholderId);
    assert.deepEqual([s.status, s.phoneNumber, s.email, s.idNumber, s.totalShares, s.ownershipPercent], ['active', '+256772100001', 'john@example.com', 'CM900123', 0, 0]);
    assert.ok(s.searchTokens.includes('jo') && s.searchTokens.includes('okel'));
    assert.equal((await person('Mary Nakato')).shareholderNumber, 'RMX-SHR-000002');
    const a = (await audits('shareholder.created')).find((x) => x.recordId === r.shareholderId);
    assert.ok(a.newValue.phoneNumber.includes('•••') && a.newValue.idNumber.startsWith('••'), 'contact details are masked in the audit trail');
    const reg = await doc('share_register/current');
    assert.deepEqual([reg.shareholderCount, reg.statusCounts.active], [2, 2]);
  });

  test('duplicates: same phone or identification refused; a retried request is recorded once', async () => {
    await person('John Okello', { phoneNumber: '0772 100 001', idType: 'passport', idNumber: 'B1234567' });
    await rejects(person('J. Okello', { phoneNumber: '+256772100001' }), 'already-exists', 'duplicate_phone');
    await rejects(person('Other', { idType: 'passport', idNumber: 'b1234567' }), 'already-exists', 'duplicate_identification');
    const requestId = rid();
    const a = await shareholders.createShareholder(deps, 'admin', { fullName: 'Retry Person', requestId }, NOW);
    const b = await shareholders.createShareholder(deps, 'admin', { fullName: 'Retry Person', requestId }, NOW);
    assert.equal(b.shareholderId, a.shareholderId);
    assert.equal(b.duplicate, true);
    assert.equal((await all('shareholders')).length, 2);
  });

  test('invalid input is refused', async () => {
    await rejects(person('J'), 'invalid-argument', 'name');
    await rejects(person('Jane Doe', { phoneNumber: '12' }), 'invalid-argument', 'phone');
    await rejects(person('Jane Doe', { idType: 'passport' }), 'invalid-argument', 'identification');
    await rejects(person('Jane Doe', { joinDate: eat(1, 12, 0, 1, 2027) }), 'invalid-argument', 'date');
  });

  test('only shareholders.create may add; workers, cashiers, auditors, shareholders and plain managers cannot', async () => {
    for (const uid of ['wkr', 'cash', 'aud', 'sh', 'mgr']) await rejects(person(`Someone ${uid}`, {}, uid), 'permission-denied');
    await rejects(person('Inactive Admin', {}, 'mgrOff'), 'permission-denied');
    assert.equal((await person('Officer Added', {}, 'officer')).shareholderNumber, 'RMX-SHR-000001');
  });

  test('update changes the profile (renames flow to holdings and the register); unchanged is refused', async () => {
    const { john } = await example();
    await shareholders.updateShareholder(deps, 'officer', { shareholderId: john, fullName: 'John B. Okello', address: 'Plot 4, Ntinda' }, NOW);
    const s = await sh(john);
    assert.equal(s.fullName, 'John B. Okello');
    assert.ok(s.searchTokens.includes('okello'));
    assert.equal((await doc(`shareholdings/${john}_ordinary`)).shareholderName, 'John B. Okello');
    assert.equal((await doc('share_register/current')).holders[0].shareholderName, 'John B. Okello');
    await rejects(shareholders.updateShareholder(deps, 'officer', { shareholderId: john, address: 'Plot 4, Ntinda' }, NOW), 'failed-precondition', 'no_changes');
    await rejects(shareholders.updateShareholder(deps, 'aud', { shareholderId: john, address: 'X' }, NOW), 'permission-denied');
    assert.equal((await audits('shareholder.updated')).length, 1);
  });

  test('status changes need a reason; EXITED only with no shares; history is never deleted', async () => {
    const { john } = await example();
    const peterless = (await person('Grace Atim')).shareholderId;
    await rejects(shareholders.setShareholderStatus(deps, 'admin', { shareholderId: john, status: 'suspended' }, NOW), 'invalid-argument', 'reason');
    await shareholders.setShareholderStatus(deps, 'admin', { shareholderId: john, status: 'suspended', reason: 'Dispute under review' }, NOW);
    assert.equal((await sh(john)).status, 'suspended');
    await rejects(shareholders.setShareholderStatus(deps, 'admin', { shareholderId: john, status: 'exited', reason: 'Left' }, NOW), 'failed-precondition', 'holds_shares');
    await shareholders.setShareholderStatus(deps, 'admin', { shareholderId: peterless, status: 'exited', reason: 'Never took up shares' }, NOW);
    assert.equal((await sh(peterless)).status, 'exited');
    await rejects(shareholders.setShareholderStatus(deps, 'officer', { shareholderId: john, status: 'active', reason: 'x y z' }, NOW), 'permission-denied');
    const reg = await doc('share_register/current');
    assert.deepEqual([reg.shareholderCount, reg.statusCounts.active, reg.statusCounts.suspended, reg.statusCounts.exited], [4, 2, 1, 1]);
    assert.equal((await all('shareholders')).length, 4);
  });
});

describe('share classes', () => {
  test('created with a code and value; duplicates, bad codes and bad values refused; value changes need a reason', async () => {
    await ordinary();
    const c = await doc('share_classes/ordinary');
    assert.deepEqual([c.code, c.valuePerShareUgx, c.active, c.issuedShares], ['ORDINARY', 10000, true, 0]);
    await rejects(ordinary(), 'already-exists', 'duplicate_class');
    await rejects(shareholders.createShareClass(deps, 'admin', { code: 'x', name: 'X', valuePerShareUgx: 1 }, NOW), 'invalid-argument', 'class_code');
    for (const v of [0, -10, 1.5, '1000']) {
      await rejects(shareholders.createShareClass(deps, 'admin', { code: 'PREFERENCE', name: 'Pref', valuePerShareUgx: v }, NOW), 'invalid-argument', 'amount');
    }
    await rejects(shareholders.updateShareClass(deps, 'admin', { classId: 'ordinary', valuePerShareUgx: 12000 }, NOW), 'invalid-argument', 'reason');
    await shareholders.updateShareClass(deps, 'admin', { classId: 'ordinary', valuePerShareUgx: 12000, reason: 'New issue price, resolution 12' }, NOW);
    assert.equal((await doc('share_classes/ordinary')).valuePerShareUgx, 12000);
    await rejects(shareholders.createShareClass(deps, 'mgr', { code: 'OTHER', name: 'Other', valuePerShareUgx: 1 }, NOW), 'permission-denied');
  });

  test('an inactive class cannot receive new shares', async () => {
    await ordinary();
    const { shareholderId } = await person('John Okello');
    await shareholders.updateShareClass(deps, 'admin', { classId: 'ordinary', active: false, reason: 'Closed' }, NOW);
    await rejects(issue(shareholderId, 10), 'failed-precondition', 'share_class_inactive');
  });
});

describe('issuing shares and contributions', () => {
  test('contribution = shares × value per share, calculated on the server (client totals ignored); pending until approved', async () => {
    await ordinary();
    const { shareholderId } = await person('John Okello');
    const r = await shares.issueShares(deps, 'officer', {
      shareholderId, classId: 'ordinary', shares: 100, valuePerShareUgx: 1, contributionUgx: 1, committedUgx: 1, ownershipPercent: 99,
      payment: cashPay(1_000_000), requestId: rid(),
    }, NOW);
    assert.equal(r.status, 'pending_approval');
    assert.equal(r.committedUgx, 1_000_000);
    const t = await doc(`share_transactions/${r.transactionId}`);
    assert.deepEqual([t.transactionNumber, t.valuePerShareUgx, t.committedUgx, t.applied], ['RMX-SHR-TXN-000001', 10000, 1_000_000, false]);
    assert.equal((await sh(shareholderId)).totalShares, 0, 'nothing changes until approved');
    assert.equal(await balance('cash_at_hand'), 0, 'no money is posted until approved');
    assert.equal((await doc('share_register/current')).pendingApprovals, 1);

    await approve(r.transactionId, 'approver');
    const s = await sh(shareholderId);
    assert.deepEqual([s.totalShares, s.ownershipPercent, s.committedUgx, s.paidUgx, s.outstandingUgx], [100, 100, 1_000_000, 1_000_000, 0]);
    const posted = await doc(`share_transactions/${r.transactionId}`);
    assert.deepEqual([posted.status, posted.paymentStatus, posted.lines[0].sharesAfter, posted.approvedBy], ['posted', 'paid', 100, 'approver']);
    assert.equal((await doc('share_register/current')).pendingApprovals, 0);
    assert.equal((await doc('share_classes/ordinary')).issuedShares, 100);
    assert.equal((await audits('shares.requested')).length, 1);
    assert.equal((await audits('shares.issued')).length, 1);
    assert.equal((await audits('share_contribution.recorded')).length, 1);
  });

  test('cash contribution: Cash at Hand rises, as share capital - never revenue', async () => {
    const { john } = await example();
    assert.equal(await balance('cash_at_hand'), 2_000_000);
    const [t] = await txns({ shareholderId: john });
    assert.deepEqual([t.type, t.amountUgx, t.isRevenue, t.destinationAccountId], ['share_capital_contribution', 1_000_000, false, 'cash_at_hand']);
    const day = await today();
    assert.equal(day.shareCapitalInUgx, 2_000_000);
    assert.equal(day.customerPaymentsUgx, undefined, 'contributions are not customer revenue');
    assert.equal(day.expensesPaidUgx, undefined);
    const c = await all('share_contributions', { shareholderId: john });
    assert.deepEqual([c.length, c[0].contributionNumber.startsWith('RMX-SHR-CON-'), c[0].source, c[0].accountId], [1, true, 'account', 'cash_at_hand']);
    await assertLedgerConsistent();
  });

  test('MTN, Airtel and bank contributions post to their own accounts', async () => {
    await ordinary();
    for (const [name, accountId] of [['M One', 'mtn_merchant'], ['A Two', 'airtel_merchant'], ['B Three', 'bank_1']]) {
      const { shareholderId } = await person(name);
      await holdingOf(shareholderId, 10, { payment: cashPay(100_000, accountId) });
      assert.equal(await balance(accountId), 100_000, accountId);
    }
    assert.equal((await today()).shareCapitalInUgx, 300_000);
    await assertLedgerConsistent();
  });

  test('money paid before RamosMAX (prior record) counts as paid without touching any balance; needs a reason', async () => {
    await ordinary();
    const { shareholderId } = await person('Founder One');
    await rejects(issue(shareholderId, 100, { payment: { source: 'prior_record', amountUgx: 1_000_000 } }), 'invalid-argument', 'reason');
    await holdingOf(shareholderId, 100, { payment: { source: 'prior_record', amountUgx: 1_000_000 }, reason: 'Paid at incorporation, 2019 share certificate 001' });
    assert.equal((await sh(shareholderId)).paidUgx, 1_000_000);
    assert.equal((await txns()).length, 0, 'no ledger entry');
  });

  test('negative, zero, fractional or absurd share numbers are refused', async () => {
    await ordinary();
    const { shareholderId } = await person('John Okello');
    for (const n of [0, -5, 1.5, '100', 2_000_000_000]) await rejects(issue(shareholderId, n), 'invalid-argument', 'shares');
    await rejects(issue(shareholderId, 10, { payment: cashPay(-100) }), 'invalid-argument', 'amount');
    await rejects(issue(shareholderId, 10, { payment: cashPay(200_000) }), 'invalid-argument', 'overpayment');
  });

  test('inactive, suspended or exited shareholders cannot receive new shares; an unknown class is refused', async () => {
    await ordinary();
    const { shareholderId } = await person('John Okello');
    for (const status of ['inactive', 'suspended', 'exited']) {
      await shareholders.setShareholderStatus(deps, 'admin', { shareholderId, status, reason: 'Testing status' }, NOW);
      await rejects(issue(shareholderId, 10), 'failed-precondition', 'shareholder_not_active');
    }
    const { shareholderId: other } = await person('Mary Nakato');
    await rejects(issue(other, 10, { classId: 'preference' }), 'not-found', 'share_class_not_found');
  });

  test('payment policy: full payment by default; part-paid and unpaid only when the policy allows', async () => {
    await ordinary();
    const { shareholderId } = await person('John Okello');
    await rejects(issue(shareholderId, 100, { payment: null }), 'failed-precondition', 'full_payment_required');
    await rejects(issue(shareholderId, 100, { payment: cashPay(400_000) }), 'failed-precondition', 'partial_payment_not_allowed');
    await policy({ allowPartialPayment: true, allowUnpaidShares: true });
    const r = await holdingOf(shareholderId, 100, { payment: cashPay(400_000, 'mtn_merchant') });
    let t = await doc(`share_transactions/${r.transactionId}`);
    assert.deepEqual([t.paidUgx, t.outstandingUgx, t.paymentStatus], [400_000, 600_000, 'partially_paid']);
    assert.equal((await sh(shareholderId)).outstandingUgx, 600_000);
    assert.equal(await balance('mtn_merchant'), 400_000, 'the unpaid commitment is not cash');

    const pay = (amountUgx, extra = {}) => shares.recordShareContribution(deps, 'officer', {
      shareTransactionId: r.transactionId, amountUgx, accountId: 'airtel_merchant', requestId: rid(), ...extra,
    }, NOW);
    await rejects(pay(700_000), 'invalid-argument', 'overpayment');
    const requestId = rid();
    await pay(600_000, { requestId });
    const again = await pay(600_000, { requestId });
    assert.equal(again.duplicate, true, 'a retried payment is recorded once');
    t = await doc(`share_transactions/${r.transactionId}`);
    assert.deepEqual([t.paidUgx, t.outstandingUgx, t.paymentStatus, t.contributionIds.length], [1_000_000, 0, 'paid', 2]);
    assert.equal(await balance('airtel_merchant'), 600_000);
    await rejects(pay(1), 'invalid-argument', 'overpayment');

    const unpaid = await holdingOf((await person('Mary Nakato')).shareholderId, 10, { payment: { source: 'none' } });
    assert.equal((await doc(`share_transactions/${unpaid.transactionId}`)).paymentStatus, 'unpaid');
    await assertLedgerConsistent();
  });

  test('a contribution reversal takes the money back out and makes the amount outstanding again', async () => {
    const { john } = await example();
    const [c] = await all('share_contributions', { shareholderId: john });
    const [original] = await txns({ contributionId: c.contributionId });
    await rejects(finance.reverseFinancialTransaction(deps, 'admin', { transactionId: original.transactionId, reason: 'Generic route' }, NOW),
      'failed-precondition', 'use_ownership_reversal');
    await rejects(shares.reverseShareContribution(deps, 'officer', { contributionId: c.contributionId }, NOW), 'invalid-argument', 'reason');
    await shares.reverseShareContribution(deps, 'officer', { contributionId: c.contributionId, reason: 'Cheque bounced' }, NOW);
    assert.equal(await balance('cash_at_hand'), 1_000_000);
    const s = await sh(john);
    assert.deepEqual([s.totalShares, s.paidUgx, s.outstandingUgx], [100, 0, 1_000_000]);
    assert.equal((await doc(`share_contributions/${c.contributionId}`)).status, 'reversed');
    assert.equal((await doc(`financial_transactions/${original.transactionId}`)).status, 'reversed');
    await rejects(shares.reverseShareContribution(deps, 'officer', { contributionId: c.contributionId, reason: 'Again' }, NOW), 'failed-precondition', 'already_reversed');
    assert.equal((await today()).reversals.share_capital_contributionUgx, 1_000_000);
    await assertLedgerConsistent();
  });

  test('duplicate issue requests (double tap, retry) create one transaction and one posting', async () => {
    await ordinary();
    await policy({ requireApproval: false });
    const { shareholderId } = await person('John Okello');
    const requestId = rid();
    const a = await issue(shareholderId, 100, { requestId });
    const b = await issue(shareholderId, 100, { requestId });
    assert.equal(b.transactionId, a.transactionId);
    assert.equal((await all('share_transactions')).length, 1);
    assert.equal((await txns()).length, 1);
    assert.equal((await sh(shareholderId)).totalShares, 100);
  });
});

describe('ownership', () => {
  test('John 100, Mary 50, Peter 50 → 50%, 25%, 25% (server-side, on profiles and in the register)', async () => {
    const { john, mary, peter } = await example();
    assert.deepEqual([(await sh(john)).ownershipPercent, (await sh(mary)).ownershipPercent, (await sh(peter)).ownershipPercent], [50, 25, 25]);
    const reg = await doc('share_register/current');
    assert.equal(reg.totalShares, 200);
    assert.deepEqual(reg.holders.map((h) => [h.shareholderName, h.shares, h.ownershipPercent]),
      [['John Okello', 100, 50], ['Mary Nakato', 50, 25], ['Peter Mugisha', 50, 25]]);
    assert.deepEqual([reg.totalCommittedUgx, reg.totalPaidUgx, reg.outstandingUgx, reg.holderCount], [2_000_000, 2_000_000, 0, 3]);
    assert.equal(shares.ownershipPercent(1, 3), 33.3333);
  });

  test('a client cannot submit its own ownership percentage or totals', async () => {
    const { john } = await example();
    await shareholders.updateShareholder(deps, 'admin', { shareholderId: john, notes: 'Founder', ownershipPercent: 99, totalShares: 9999 }, NOW);
    const s = await sh(john);
    assert.deepEqual([s.ownershipPercent, s.totalShares, s.notes], [50, 100, 'Founder']);
  });
});

describe('transfers', () => {
  test('John → Mary 30: 100/50 becomes 70/80, total unchanged, no new shares, no money moved', async () => {
    const { john, mary, peter } = await example();
    const cash = await balance('cash_at_hand');
    const r = await transfer(john, mary, 30, {}, 'officer');
    assert.equal(r.status, 'pending_approval');
    await approve(r.transactionId, 'approver');
    assert.deepEqual([(await sh(john)).totalShares, (await sh(mary)).totalShares, (await sh(peter)).totalShares], [70, 80, 50]);
    assert.equal((await doc('share_register/current')).totalShares, 200);
    assert.equal((await doc('share_classes/ordinary')).issuedShares, 200);
    assert.deepEqual([(await sh(john)).ownershipPercent, (await sh(mary)).ownershipPercent], [35, 40]);
    assert.equal(await balance('cash_at_hand'), cash);
    const t = await doc(`share_transactions/${r.transactionId}`);
    assert.deepEqual(t.lines.map((l) => [l.deltaShares, l.sharesAfter]), [[-30, 70], [30, 80]]);
    // Contributions stay with whoever paid them.
    assert.deepEqual([(await sh(john)).paidUgx, (await sh(mary)).paidUgx], [1_000_000, 500_000]);
  });

  test('cannot transfer more than owned, to oneself, to an inactive shareholder, or from a suspended one; a reason is required', async () => {
    const { john, mary, peter } = await example();
    await rejects(transfer(john, mary, 101), 'failed-precondition', 'insufficient_shares');
    await rejects(transfer(john, john, 1), 'invalid-argument', 'same_shareholder');
    await rejects(transfer(john, mary, 10, { reason: '' }), 'invalid-argument', 'reason');
    await shareholders.setShareholderStatus(deps, 'admin', { shareholderId: peter, status: 'inactive', reason: 'Dormant' }, NOW);
    await rejects(transfer(john, peter, 10), 'failed-precondition', 'shareholder_not_active');
    await shareholders.setShareholderStatus(deps, 'admin', { shareholderId: john, status: 'suspended', reason: 'Dispute' }, NOW);
    await rejects(transfer(john, mary, 10), 'failed-precondition', 'shareholder_not_active');
  });

  test('two pending transfers cannot together take more than is owned (checked again at approval)', async () => {
    const { john, mary, peter } = await example();
    const a = await transfer(john, mary, 80);
    const b = await transfer(john, peter, 80);
    await approve(a.transactionId);
    await rejects(approve(b.transactionId), 'failed-precondition', 'insufficient_shares');
    assert.equal((await doc(`share_transactions/${b.transactionId}`)).status, 'pending_approval');
    assert.equal((await sh(john)).totalShares, 20);
  });

  test('a duplicate transfer request is recorded once', async () => {
    const { john, mary } = await example();
    const requestId = rid();
    const a = await transfer(john, mary, 10, { requestId });
    const b = await transfer(john, mary, 10, { requestId });
    assert.equal(b.transactionId, a.transactionId);
    assert.equal((await all('share_transactions', { type: 'shares_transferred' })).length, 1);
  });

  test('shares with an unpaid commitment cannot be transferred', async () => {
    await ordinary();
    await policy({ allowPartialPayment: true });
    const john = (await person('John Okello')).shareholderId;
    const mary = (await person('Mary Nakato')).shareholderId;
    const r = await holdingOf(john, 100, { payment: cashPay(500_000) });
    const t = await transfer(john, mary, 10);
    await rejects(approve(t.transactionId), 'failed-precondition', 'outstanding_commitment');
    await shares.recordShareContribution(deps, 'admin', { shareTransactionId: r.transactionId, amountUgx: 500_000, accountId: 'cash_at_hand', requestId: rid() }, NOW);
    await approve(t.transactionId);
    assert.equal((await sh(mary)).totalShares, 10);
  });
});

describe('approval', () => {
  test('the requester cannot approve their own request (Administrators excepted); rejection needs a reason; workers cannot decide', async () => {
    const { john, mary } = await example();
    const r = await transfer(john, mary, 10, {}, 'officer');
    await rejects(approve(r.transactionId, 'officer'), 'permission-denied', 'self_approval');
    await rejects(approve(r.transactionId, 'wkr'), 'permission-denied');
    await rejects(approve(r.transactionId, 'aud'), 'permission-denied');
    await rejects(shares.decideShareTransaction(deps, 'approver', { transactionId: r.transactionId, decision: 'reject' }, NOW), 'invalid-argument', 'reason');
    await shares.decideShareTransaction(deps, 'approver', { transactionId: r.transactionId, decision: 'reject', reason: 'No signed transfer form' }, NOW);
    assert.equal((await doc(`share_transactions/${r.transactionId}`)).status, 'rejected');
    await rejects(approve(r.transactionId, 'approver'), 'failed-precondition', 'already_decided');
    assert.equal((await sh(john)).totalShares, 100);
    assert.equal((await audits('shares.rejected')).length, 1);
    // An Administrator may approve what they requested.
    const own = await transfer(john, mary, 5);
    await approve(own.transactionId, 'admin');
    assert.equal((await sh(mary)).totalShares, 55);
  });

  test('nobody approves a transaction on their own shareholding (Administrators excepted)', async () => {
    const { john, mary } = await example();
    await shareholders.linkShareholderAccount(deps, 'admin', { shareholderId: mary, uid: 'approver' }, NOW);
    const r = await transfer(john, mary, 10, {}, 'officer');
    await rejects(approve(r.transactionId, 'approver'), 'permission-denied', 'own_shareholding');
  });

  test('with approval switched off, requests post at once', async () => {
    await ordinary();
    await policy({ requireApproval: false });
    const { shareholderId } = await person('John Okello');
    const r = await issue(shareholderId, 10, {}, 'officer');
    assert.equal(r.status, 'posted');
    assert.equal((await sh(shareholderId)).totalShares, 10);
  });

  test('only shares.issue / transfer / adjust holders can request; auditors and cashiers cannot', async () => {
    const { john, mary } = await example();
    for (const uid of ['aud', 'cash', 'wkr', 'sh', 'mgr']) {
      await rejects(issue(john, 1, {}, uid), 'permission-denied');
      await rejects(transfer(john, mary, 1, {}, uid), 'permission-denied');
      await rejects(shares.adjustShares(deps, uid, { shareholderId: john, classId: 'ordinary', deltaShares: -1, reason: 'Nope', requestId: rid() }, NOW), 'permission-denied');
    }
  });
});

describe('adjustments and reversals', () => {
  const adjust = (shareholderId, deltaShares, extra = {}, actor = 'admin') => shares.adjustShares(deps, actor, {
    shareholderId, classId: 'ordinary', deltaShares, reason: 'Verified historical correction', requestId: rid(), ...extra,
  }, NOW);

  test('100 → 95 is a −5 adjustment entry with a reason; the original stays visible', async () => {
    const { john } = await example();
    await rejects(adjust(john, -5, { reason: '' }), 'invalid-argument', 'reason');
    await rejects(adjust(john, 0), 'invalid-argument', 'shares');
    const r = await adjust(john, -5);
    await approve(r.transactionId);
    assert.equal((await sh(john)).totalShares, 95);
    const history = await all('share_transactions');
    assert.equal(history.filter((t) => t.shareholderIds.includes(john)).length, 2);
    assert.equal(history.find((t) => t.type === 'shares_issued' && t.toShareholderId === john).shares, 100, 'the issue is not overwritten');
    await rejects(approve((await adjust(john, -96)).transactionId), 'failed-precondition', 'insufficient_shares');
  });

  test('an adjustment can move the commitment too, never below what was paid', async () => {
    const { john } = await example();
    await rejects(approve((await adjust(john, -5, { adjustCommitment: true })).transactionId), 'failed-precondition', 'commitment_below_paid');
    await approve((await adjust(john, 5, { adjustCommitment: true })).transactionId);
    const s = await sh(john);
    assert.deepEqual([s.totalShares, s.committedUgx, s.outstandingUgx], [105, 1_050_000, 50_000]);
  });

  test('reversing a transfer restores both holdings; the original is kept, marked reversed; a retry reverses once', async () => {
    const { john, mary } = await example();
    const t = await transfer(john, mary, 30);
    await approve(t.transactionId);
    await rejects(shares.reverseShareTransaction(deps, 'officer', { transactionId: t.transactionId, requestId: rid() }, NOW), 'invalid-argument', 'reason');
    const requestId = rid();
    const r = await shares.reverseShareTransaction(deps, 'officer', { transactionId: t.transactionId, reason: 'Transfer form was void', requestId }, NOW);
    assert.equal((await shares.reverseShareTransaction(deps, 'officer', { transactionId: t.transactionId, reason: 'Again', requestId }, NOW)).duplicate, true);
    assert.deepEqual([(await sh(john)).totalShares, (await sh(mary)).totalShares], [100, 50]);
    const original = await doc(`share_transactions/${t.transactionId}`);
    assert.deepEqual([original.status, original.reversedByTransactionId], ['reversed', r.transactionId]);
    const rev = await doc(`share_transactions/${r.transactionId}`);
    assert.deepEqual([rev.type, rev.reversalOfType, rev.lines.map((l) => l.deltaShares)], ['reversal', 'shares_transferred', [30, -30]]);
    await rejects(shares.reverseShareTransaction(deps, 'officer', { transactionId: t.transactionId, reason: 'Again', requestId: rid() }, NOW),
      'failed-precondition', 'already_reversed');
    await rejects(shares.reverseShareTransaction(deps, 'officer', { transactionId: r.transactionId, reason: 'Undo', requestId: rid() }, NOW),
      'failed-precondition', 'is_reversal');
    assert.equal((await audits('shares.reversed')).length, 1);
  });

  test('reversing an issue reverses its contribution in the ledger in the same step', async () => {
    const { john } = await example();
    const t = (await all('share_transactions', { type: 'shares_issued' })).find((x) => x.toShareholderId === john);
    await shares.reverseShareTransaction(deps, 'admin', { transactionId: t.transactionId, reason: 'Issued to the wrong person', requestId: rid() }, NOW);
    const s = await sh(john);
    assert.deepEqual([s.totalShares, s.committedUgx, s.paidUgx], [0, 0, 0]);
    assert.equal(await balance('cash_at_hand'), 1_000_000);
    assert.equal((await all('share_contributions', { shareholderId: john }))[0].status, 'reversed');
    assert.equal((await doc('share_register/current')).totalShares, 100);
    await assertLedgerConsistent();
  });

  test('an issue whose shares were transferred on cannot be reversed; reversal needs shares.adjust', async () => {
    const { john, mary } = await example();
    const issued = (await all('share_transactions', { type: 'shares_issued' })).find((x) => x.toShareholderId === mary);
    await approve((await transfer(mary, john, 50)).transactionId);
    await rejects(shares.reverseShareTransaction(deps, 'admin', { transactionId: issued.transactionId, reason: 'Wrong', requestId: rid() }, NOW),
      'failed-precondition', 'insufficient_shares');
    await rejects(shares.reverseShareTransaction(deps, 'approver', { transactionId: issued.transactionId, reason: 'Wrong', requestId: rid() }, NOW), 'permission-denied');
  });
});

describe('historical ownership', () => {
  test('January John 100%; June transfer to Mary → John 40%, Mary 60%; January is not rewritten', async () => {
    await ordinary();
    const john = (await person('John Okello')).shareholderId;
    const mary = (await person('Mary Nakato')).shareholderId;
    await holdingOf(john, 100, { effectiveDate: eat(10, 12, 0, 1), acquisitionDate: eat(10, 12, 0, 1) });
    await approve((await transfer(john, mary, 60, { effectiveDate: eat(15, 12, 0, 6) })).transactionId);
    const jan = await shares.getOwnershipAsOf(deps, 'aud', { date: eat(31, 12, 0, 1) }, NOW);
    assert.deepEqual(jan.holders.map((h) => [h.shareholderName, h.shares, h.ownershipPercent]), [['John Okello', 100, 100]]);
    const june = await shares.getOwnershipAsOf(deps, 'mgr', { date: eat(30, 12, 0, 6) }, NOW);
    assert.deepEqual(june.holders.map((h) => [h.shareholderName, h.ownershipPercent]), [['Mary Nakato', 60], ['John Okello', 40]]);
    const before = await shares.getOwnershipAsOf(deps, 'admin', { date: eat(9, 12, 0, 1) }, NOW);
    assert.deepEqual([before.totalShares, before.holders.length], [0, 0]);
    await rejects(shares.getOwnershipAsOf(deps, 'wkr', {}, NOW), 'permission-denied');
    await rejects(shares.getOwnershipAsOf(deps, 'sh', {}, NOW), 'permission-denied');
  });

  test('a backdated transfer before the shares existed is refused (history can never go negative)', async () => {
    await ordinary();
    const john = (await person('John Okello')).shareholderId;
    const mary = (await person('Mary Nakato')).shareholderId;
    await holdingOf(john, 100, { effectiveDate: eat(1, 12, 0, 6) });
    const t = await transfer(john, mary, 10, { effectiveDate: eat(1, 12, 0, 3) });
    await rejects(approve(t.transactionId), 'failed-precondition', 'insufficient_shares');
    await rejects(transfer(john, mary, 10, { effectiveDate: eat(1, 12, 0, 1, 2027) }), 'invalid-argument', 'date');
  });

  test('pure helpers: holdingsAsOf and neverNegative', () => {
    const t = (effectiveDate, lines, classId = 'ordinary') => ({ applied: true, effectiveDate, classId, lines });
    const list = [t(10, [{ shareholderId: 'a', deltaShares: 100 }]), t(20, [{ shareholderId: 'a', deltaShares: -40 }, { shareholderId: 'b', deltaShares: 40 }]),
      { ...t(15, [{ shareholderId: 'a', deltaShares: 999 }]), applied: false }];
    assert.equal(shares.holdingsAsOf(list, 15).get('a').shares, 100);
    assert.equal(shares.holdingsAsOf(list, 20).get('b').shares, 40);
    assert.equal(shares.neverNegative(list, 'a', 'ordinary', [{ effectiveMs: 5, delta: -1 }]), false);
    assert.equal(shares.neverNegative(list, 'a', 'ordinary', [{ effectiveMs: 25, delta: -60 }]), true);
    assert.equal(shares.neverNegative(list, 'a', 'ordinary', [{ effectiveMs: 25, delta: -61 }]), false);
    assert.equal(shares.contributionFor(100, 10000), 1_000_000);
  });
});

describe('shareholder self-service', () => {
  test('a linked shareholder sees only their own shareholding; nobody else\'s data is returned', async () => {
    const { john, mary } = await example();
    await approve((await transfer(john, mary, 10)).transactionId);
    await rejects(shareholders.linkShareholderAccount(deps, 'officer', { shareholderId: mary, uid: 'sh' }, NOW), 'permission-denied');
    await shareholders.linkShareholderAccount(deps, 'admin', { shareholderId: mary, uid: 'sh' }, NOW);
    await rejects(shareholders.linkShareholderAccount(deps, 'admin', { shareholderId: john, uid: 'sh' }, NOW), 'already-exists', 'duplicate_link');
    const mine = await shareholders.getMyShareholding(deps, 'sh', {}, NOW);
    assert.equal(mine.linked, true);
    assert.deepEqual([mine.shareholder.fullName, mine.shareholder.totalShares, mine.shareholder.ownershipPercent], ['Mary Nakato', 60, 30]);
    assert.deepEqual(mine.transactions.map((t) => t.deltaShares).sort(), [10, 50]);
    const text = JSON.stringify(mine);
    assert.ok(!text.includes('John') && !text.includes(john), 'no other shareholder appears');
    assert.deepEqual(await shareholders.getMyShareholding(deps, 'sh2', {}, NOW), { linked: false });
    await rejects(shareholders.getMyShareholding(deps, 'wkr', {}, NOW), 'permission-denied');
    await rejects(shareholders.getMyShareholding(deps, 'cash', {}, NOW), 'permission-denied');
  });
});
