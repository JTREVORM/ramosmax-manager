// Financial accounts, the ledger, payment posting, transfers, bank deposits,
// reconciliation, adjustments and reversals (Phase 5) - against the
// Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as billing from '../src/billing.js';
import * as finance from '../src/finance.js';
import { emulatorDb, financeHelpers, helpers, rejects, resetAndSeed, rid } from './helpers.js';

const db = emulatorDb('finance-tests');
const { deps, doc, audits, world, newVehicle, invoicedJob, pay } = helpers(db);
const { account, balance, txns, today, assertLedgerConsistent } = financeHelpers(db);

beforeEach(() => resetAndSeed(db));

const opening = (accountId, amountUgx) => finance.recordOpeningBalance(deps, 'admin', { accountId, amountUgx, reason: 'Starting balance' });
const transfer = (actor, fromAccountId, toAccountId, amountUgx, extra = {}) => finance.transferFunds(deps, actor, {
  fromAccountId, toAccountId, amountUgx, reason: 'Banking the takings', requestId: rid(), ...extra,
});
const deposit = (actor, amountUgx, extra = {}) => finance.recordBankDeposit(deps, actor, {
  bankAccountId: 'bank_1', amountUgx, bankReference: 'SLIP-001', requestId: rid(), ...extra,
});
const newBank = (name, extra = {}) => finance.createFinancialAccount(deps, 'admin', { name, type: 'bank', provider: 'Stanbic', accountNumber: `90${name.length}1234`, ...extra });

describe('customer payments post to their financial account', () => {
  test('cash → Cash at Hand, MTN → MTN Merchant, Airtel → Airtel Merchant, bank → the bank account', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash, w.interior, w.tyre]); // 45,000
    await pay('cash', a.invoiceId, 20000);
    await pay('cash', a.invoiceId, 10000, { method: 'mtn_merchant', reference: 'MP1' });
    await pay('cash', a.invoiceId, 5000, { method: 'airtel_merchant', reference: 'AT1' });
    const last = await pay('cash', a.invoiceId, 10000, { method: 'bank', reference: 'EFT1' });
    assert.deepEqual(
      [await balance('cash_at_hand'), await balance('mtn_merchant'), await balance('airtel_merchant'), await balance('bank_1')],
      [20000, 10000, 5000, 10000]);
    const cash = await account('cash_at_hand');
    assert.equal(cash.awaitingBankingUgx, 20000, 'cash takings await banking');
    assert.equal((await account('mtn_merchant')).awaitingBankingUgx, 0);
    const p = await doc(`payments/${last.paymentId}`);
    assert.equal(p.financialAccountId, 'bank_1');
    const t = await doc(`financial_transactions/${p.financialTransactionId}`);
    assert.deepEqual([t.type, t.amountUgx, t.destinationAccountId, t.sourceAccountId, t.isRevenue, t.paymentId, t.invoiceId],
      ['customer_payment', 10000, 'bank_1', null, true, last.paymentId, a.invoiceId]);
    assert.match(t.transactionNumber, /^RMX-TXN-\d{6}$/);
    assert.equal((await txns({ type: 'customer_payment' })).length, 4);
    assert.equal((await today()).customerPaymentsUgx, 45000);
    await assertLedgerConsistent();
  });

  test('a UGX 50,000 cash payment adds exactly 50,000 to Cash at Hand', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash, w.interior, w.tyre]);
    const b = await invoicedJob(await newVehicle(w.customerId), [w.wash]);
    await pay('cash', a.invoiceId, 45000);
    await pay('cash', b.invoiceId, 5000);
    assert.equal(await balance('cash_at_hand'), 50000);
  });

  test('a retried payment request posts once', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    const data = { invoiceId: a.invoiceId, amountUgx: 15000, method: 'cash', requestId: 'dup-payment-1' };
    const first = await billing.recordPayment(deps, 'cash', data);
    const again = await billing.recordPayment(deps, 'cash', data);
    assert.equal(again.duplicate, true);
    assert.equal(again.transactionNumber, first.transactionNumber);
    assert.equal(await balance('cash_at_hand'), 15000);
    assert.equal((await txns()).length, 1);
  });

  test('with several bank accounts the cashier must choose; the chosen one is credited', async () => {
    const w = await world();
    await finance.ensureDefaultFinancialAccounts(deps, 'admin', {});
    const { accountId: second } = await newBank('Centenary Bank');
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    await rejects(pay('cash', a.invoiceId, 1000, { method: 'bank', reference: 'EFT' }), 'invalid-argument', 'bank_account_required');
    await pay('cash', a.invoiceId, 1000, { method: 'bank', reference: 'EFT', accountId: second });
    assert.deepEqual([await balance(second), await balance('bank_1')], [1000, 0]);
    // An account that is not a bank cannot receive a bank payment; cash cannot name an account.
    await rejects(pay('cash', a.invoiceId, 1000, { method: 'bank', reference: 'EFT', accountId: 'mtn_merchant' }), 'invalid-argument', 'account');
    await rejects(pay('cash', a.invoiceId, 1000, { accountId: 'bank_1' }), 'invalid-argument', 'account');
    // The cashier's bank list: names and masked numbers, never balances.
    const list = await doc('settings/payment_accounts');
    assert.equal(list.banks.length, 2);
    assert.ok(list.banks.every((b) => !('balanceUgx' in b)));
  });

  test('atomic: if the posting fails, the payment is not recorded at all', async () => {
    const w = await world();
    const { accountId } = await newBank('Old Bank');
    await finance.updateFinancialAccount(deps, 'admin', { accountId, active: false, reason: 'Account closed' });
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    await rejects(pay('cash', a.invoiceId, 1000, { method: 'bank', reference: 'EFT', accountId }), 'failed-precondition', 'account_inactive');
    assert.equal((await db.collection('payments').get()).size, 0);
    assert.equal((await db.collection('receipts').get()).size, 0);
    assert.equal((await doc(`invoices/${a.invoiceId}`)).paidUgx, 0);
    assert.equal((await txns()).length, 0);
  });

  test('reversing a payment takes the money back out, keeps both ledger entries, and reduces cash awaiting banking', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    const p = await pay('cash', a.invoiceId, 15000);
    await billing.reversePayment(deps, 'admin', { paymentId: p.paymentId, reason: 'Wrong invoice' });
    const cash = await account('cash_at_hand');
    assert.deepEqual([cash.balanceUgx, cash.awaitingBankingUgx], [0, 0]);
    const all = await txns();
    assert.equal(all.length, 2);
    const original = all.find((t) => t.type === 'customer_payment');
    const reversal = all.find((t) => t.type === 'reversal');
    assert.equal(original.status, 'reversed');
    assert.deepEqual([reversal.reversalOfTransactionId, reversal.reversalOfType, reversal.sourceAccountId, reversal.amountUgx],
      [original.transactionId, 'customer_payment', 'cash_at_hand', 15000]);
    assert.equal((await doc(`payments/${p.paymentId}`)).reversalTransactionId, reversal.transactionId);
    // A customer payment is reversed only through its invoice.
    await rejects(finance.reverseFinancialTransaction(deps, 'admin', { transactionId: original.transactionId, reason: 'Again' }),
      'failed-precondition');
    await assertLedgerConsistent();
  });

  test('a payment whose cash has already been banked cannot be reversed into a negative balance', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    const p = await pay('cash', a.invoiceId, 15000);
    await deposit('mgr', 15000);
    await rejects(billing.reversePayment(deps, 'admin', { paymentId: p.paymentId, reason: 'Wrong invoice' }), 'failed-precondition', 'insufficient_funds');
    assert.equal((await doc(`payments/${p.paymentId}`)).status, 'completed');
  });
});

describe('financial accounts', () => {
  test('defaults: Cash at Hand, MTN Merchant, Airtel Merchant, Bank Account 1; idempotent; admin only by default', async () => {
    for (const uid of ['mgr', 'cash', 'wkr', 'aud', 'sh', 'mgrOff', 'mgrPending']) {
      await rejects(finance.ensureDefaultFinancialAccounts(deps, uid, {}), 'permission-denied');
    }
    const r = await finance.ensureDefaultFinancialAccounts(deps, 'admin', {});
    assert.deepEqual(r.created.sort(), ['airtel_merchant', 'bank_1', 'cash_at_hand', 'mtn_merchant']);
    const cash = await account('cash_at_hand');
    assert.deepEqual([cash.name, cash.type, cash.balanceUgx, cash.active, cash.createdBy], ['Cash at Hand', 'cash', 0, true, 'admin']);
    assert.equal((await account('mtn_merchant')).type, 'mobile_money');
    assert.equal((await finance.ensureDefaultFinancialAccounts(deps, 'admin', {})).created.length, 0);
    assert.equal((await audits('financial_account.created')).length, 4);
  });

  test('a new bank account with an opening balance: posted as OPENING_BALANCE, balance from the ledger', async () => {
    const { accountId } = await newBank('Stanbic Main', { openingBalanceUgx: 3_500_000, balanceUgx: 999_999_999, notes: 'Main' });
    const a = await account(accountId);
    assert.deepEqual([a.type, a.provider, a.balanceUgx, a.openingBalanceUgx, a.openingBalanceRecorded], ['bank', 'Stanbic', 3_500_000, 3_500_000, true]);
    const [t] = await txns({ type: 'opening_balance' });
    assert.deepEqual([t.destinationAccountId, t.amountUgx, t.isRevenue], [accountId, 3_500_000, false]);
    // Only once.
    await rejects(opening(accountId, 100), 'failed-precondition', 'opening_balance_exists');
    await assertLedgerConsistent();
  });

  test('opening balance on a default account (created on first use)', async () => {
    await opening('cash_at_hand', 1_250_000);
    assert.equal(await balance('cash_at_hand'), 1_250_000);
    assert.equal((await account('cash_at_hand')).awaitingBankingUgx, 0, 'an opening float is not takings');
    await rejects(opening('cash_at_hand', 5), 'failed-precondition', 'opening_balance_exists');
    for (const amountUgx of [0, -5, 1.5, '100']) {
      await rejects(finance.recordOpeningBalance(deps, 'admin', { accountId: 'mtn_merchant', amountUgx }), 'invalid-argument', 'amount');
    }
  });

  test('validation and duplicates', async () => {
    await newBank('Stanbic Main', { accountNumber: '9030001234' });
    await rejects(finance.createFinancialAccount(deps, 'admin', { name: 'stanbic  main', type: 'bank' }), 'already-exists', 'duplicate_account');
    await rejects(finance.createFinancialAccount(deps, 'admin', { name: 'Other', type: 'bank', accountNumber: '9030001234' }), 'already-exists', 'duplicate_account_number');
    await rejects(finance.createFinancialAccount(deps, 'admin', { name: 'Cash at hand', type: 'mobile_money' }), 'already-exists', 'duplicate_account');
    await rejects(finance.createFinancialAccount(deps, 'admin', { name: 'Petty', type: 'cash' }), 'invalid-argument', 'account_type');
    await rejects(finance.createFinancialAccount(deps, 'admin', { name: 'X', type: 'crypto' }), 'invalid-argument', 'account_type');
    await rejects(finance.createFinancialAccount(deps, 'admin', { name: 'Y', type: 'bank', openingBalanceUgx: -1 }), 'invalid-argument', 'amount');
    await rejects(finance.createFinancialAccount(deps, 'mgr', { name: 'Z', type: 'bank' }), 'permission-denied');
  });

  test('deactivation: never the payment accounts; only at zero balance; reason required; audited', async () => {
    await rejects(finance.updateFinancialAccount(deps, 'admin', { accountId: 'cash_at_hand', active: false, reason: 'Not needed' }), 'failed-precondition', 'permanent_account');
    const { accountId } = await newBank('Spare', { openingBalanceUgx: 1000 });
    await rejects(finance.updateFinancialAccount(deps, 'admin', { accountId, active: false }), 'invalid-argument', 'reason');
    await rejects(finance.updateFinancialAccount(deps, 'admin', { accountId, active: false, reason: 'Closed' }), 'failed-precondition', 'balance_not_zero');
    await transfer('admin', accountId, 'bank_1', 1000);
    await finance.updateFinancialAccount(deps, 'admin', { accountId, active: false, reason: 'Closed' });
    assert.equal((await account(accountId)).active, false);
    await rejects(transfer('admin', 'bank_1', accountId, 10), 'failed-precondition', 'account_inactive');
    assert.equal((await audits('financial_account.deactivated')).length, 1);
    // Renaming is audited; balances cannot be written through an update.
    await finance.updateFinancialAccount(deps, 'admin', { accountId: 'bank_1', name: 'Stanbic Operations', balanceUgx: 5 });
    const b = await account('bank_1');
    assert.deepEqual([b.name, b.balanceUgx], ['Stanbic Operations', 1000]);
  });
});

describe('transfers', () => {
  test('Cash → Bank: both sides move atomically; not revenue; audited; numbered', async () => {
    await opening('cash_at_hand', 1_000_000);
    const r = await transfer('mgr', 'cash_at_hand', 'bank_1', 400_000, { reference: 'DEP-1', description: 'Weekly banking' });
    assert.deepEqual([r.sourceBalanceUgx, r.destinationBalanceUgx], [600_000, 400_000]);
    const t = await doc(`financial_transactions/${r.transactionId}`);
    assert.deepEqual([t.type, t.isRevenue, t.sourceAccountId, t.destinationAccountId, t.reason, t.createdBy],
      ['account_transfer', false, 'cash_at_hand', 'bank_1', 'Banking the takings', 'mgr']);
    assert.deepEqual(t.entries.map((e) => [e.accountId, e.deltaUgx, e.balanceAfterUgx]), [['cash_at_hand', -400_000, 600_000], ['bank_1', 400_000, 400_000]]);
    const day = await today();
    assert.equal(day.transfersUgx, 400_000);
    assert.equal(day.customerPaymentsUgx ?? 0, 0, 'a transfer is not income');
    assert.equal((await audits('finance.transfer')).length, 1);
    await assertLedgerConsistent();
  });

  test('MTN → Bank', async () => {
    await opening('mtn_merchant', 250_000);
    await transfer('mgr', 'mtn_merchant', 'bank_1', 100_000);
    assert.deepEqual([await balance('mtn_merchant'), await balance('bank_1')], [150_000, 100_000]);
  });

  test('refused: insufficient balance (nothing moves), same account, bad amounts, missing reason, future date', async () => {
    await opening('cash_at_hand', 50_000);
    await assert.rejects(transfer('mgr', 'cash_at_hand', 'bank_1', 50_001), (e) => {
      assert.equal(e.details.reason, 'insufficient_funds');
      assert.equal(e.details.availableUgx, 50_000);
      return true;
    });
    assert.deepEqual([await balance('cash_at_hand'), await balance('bank_1')], [50_000, 0]);
    await rejects(transfer('mgr', 'cash_at_hand', 'cash_at_hand', 10), 'invalid-argument', 'same_account');
    for (const amount of [0, -100, 10.5, '1000', null, 3_000_000_000]) {
      await rejects(transfer('mgr', 'cash_at_hand', 'bank_1', amount), 'invalid-argument', 'amount');
    }
    await rejects(transfer('mgr', 'cash_at_hand', 'bank_1', 10, { reason: '' }), 'invalid-argument', 'reason');
    await rejects(transfer('mgr', 'cash_at_hand', 'bank_1', 10, { transferDate: Date.now() + 3 * 86_400_000 }), 'invalid-argument', 'date');
    await rejects(transfer('mgr', 'cash_at_hand', 'nope', 10), 'not-found');
    assert.equal((await txns({ type: 'account_transfer' })).length, 0);
  });

  test('a duplicate request moves the money once', async () => {
    await opening('cash_at_hand', 100_000);
    const requestId = 'transfer-dup-1';
    const first = await transfer('mgr', 'cash_at_hand', 'bank_1', 30_000, { requestId });
    const again = await transfer('mgr', 'cash_at_hand', 'bank_1', 30_000, { requestId });
    assert.equal(again.duplicate, true);
    assert.equal(again.transactionId, first.transactionId);
    assert.equal(await balance('cash_at_hand'), 70_000);
    // The same key from someone else, or for another kind of request, is refused.
    await rejects(transfer('admin', 'cash_at_hand', 'bank_1', 30_000, { requestId }), 'invalid-argument', 'request_id');
  });

  test('concurrent transfers never overdraw the source', async () => {
    await opening('cash_at_hand', 100_000);
    const r = await Promise.allSettled([1, 2, 3].map(() => transfer('mgr', 'cash_at_hand', 'bank_1', 40_000)));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 2);
    assert.deepEqual([await balance('cash_at_hand'), await balance('bank_1')], [20_000, 80_000]);
    await assertLedgerConsistent();
  });

  test('who may transfer: not cashiers, workers, auditors, shareholders, inactive or pending accounts', async () => {
    await opening('cash_at_hand', 100_000);
    for (const uid of ['cash', 'wkr', 'aud', 'sh', 'mgrOff', 'mgrPending', 'ghost']) {
      await rejects(transfer(uid, 'cash_at_hand', 'bank_1', 1000), 'permission-denied');
    }
    assert.equal(await balance('cash_at_hand'), 100_000);
  });
});

describe('cash awaiting banking and bank deposits', () => {
  test('deposit: cash down, bank up, awaiting banking down; RMX-BNK numbers; not revenue', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash, w.interior, w.tyre]);
    await pay('cash', a.invoiceId, 45000);
    assert.equal((await account('cash_at_hand')).awaitingBankingUgx, 45000);
    const r = await deposit('mgr', 30000, { description: 'Morning banking' });
    assert.equal(r.depositNumber, 'RMX-BNK-000001');
    const cash = await account('cash_at_hand');
    assert.deepEqual([cash.balanceUgx, cash.awaitingBankingUgx, await balance('bank_1')], [15000, 15000, 30000]);
    const d = await doc(`bank_deposits/${r.depositId}`);
    assert.deepEqual([d.status, d.amountUgx, d.bankReference, d.transactionId, d.sourceAccountId], ['completed', 30000, 'SLIP-001', r.transactionId, 'cash_at_hand']);
    const t = await doc(`financial_transactions/${r.transactionId}`);
    assert.deepEqual([t.type, t.isRevenue, t.depositNumber], ['bank_deposit', false, 'RMX-BNK-000001']);
    assert.equal((await deposit('mgr', 1000)).depositNumber, 'RMX-BNK-000002');
    assert.equal((await audits('finance.bank_deposit')).length, 2);
    await assertLedgerConsistent();
  });

  test('awaiting banking never exceeds the cash actually held', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    await pay('cash', a.invoiceId, 15000);
    await transfer('mgr', 'cash_at_hand', 'mtn_merchant', 10000); // not to a bank: still awaiting, but capped
    const cash = await account('cash_at_hand');
    assert.deepEqual([cash.balanceUgx, cash.awaitingBankingUgx], [5000, 5000]);
  });

  test('refused: over the balance, same account, not into a bank, from a bank, no slip, bad amounts; duplicates post once', async () => {
    await opening('cash_at_hand', 20_000);
    await rejects(deposit('mgr', 20_001), 'failed-precondition', 'insufficient_funds');
    await rejects(deposit('mgr', 100, { bankAccountId: 'cash_at_hand', sourceAccountId: 'cash_at_hand' }), 'invalid-argument', 'same_account');
    await rejects(deposit('mgr', 100, { bankAccountId: 'mtn_merchant' }), 'invalid-argument', 'not_bank');
    const { accountId } = await newBank('Second');
    await rejects(deposit('mgr', 100, { sourceAccountId: accountId }), 'invalid-argument', 'source_is_bank');
    await rejects(deposit('mgr', 100, { bankReference: '' }), 'invalid-argument', 'required');
    for (const amount of [0, -1, 2.5]) await rejects(deposit('mgr', amount), 'invalid-argument', 'amount');
    await rejects(deposit('mgr', 100, { attachmentPath: 'staff/x/profile/a.png' }), 'invalid-argument', 'attachment');
    await rejects(deposit('cash', 100), 'permission-denied');
    await rejects(deposit('aud', 100), 'permission-denied');
    const requestId = 'deposit-dup-1';
    await deposit('mgr', 5000, { requestId, attachmentPath: 'finance_uploads/deposits/upload12345/slip.jpg' });
    const again = await deposit('mgr', 5000, { requestId });
    assert.equal(again.duplicate, true);
    assert.equal((await db.collection('bank_deposits').get()).size, 1);
    assert.equal(await balance('cash_at_hand'), 15_000);
  });

  test('reversing a deposit restores cash, the bank and the waiting amount, and marks the deposit', async () => {
    const w = await world();
    const a = await invoicedJob(w.vehicleId, [w.wash]);
    await pay('cash', a.invoiceId, 15000);
    const r = await deposit('mgr', 15000);
    await finance.reverseFinancialTransaction(deps, 'admin', { transactionId: r.transactionId, reason: 'Slip was for another day' });
    const cash = await account('cash_at_hand');
    assert.deepEqual([cash.balanceUgx, cash.awaitingBankingUgx, await balance('bank_1')], [15000, 15000, 0]);
    assert.equal((await doc(`bank_deposits/${r.depositId}`)).status, 'reversed');
    await assertLedgerConsistent();
  });
});

describe('reconciliation and adjustments', () => {
  test('difference = actual − system; positive, negative and zero; the balance is never changed silently', async () => {
    await opening('cash_at_hand', 100_000);
    const rec = (actualBalanceUgx) => finance.reconcileAccount(deps, 'mgr', { accountId: 'cash_at_hand', actualBalanceUgx, requestId: rid(), notes: 'Counted at close' });
    const zero = await rec(100_000);
    const over = await rec(100_500);
    const short = await rec(98_000);
    assert.deepEqual([zero.differenceUgx, over.differenceUgx, short.differenceUgx], [0, 500, -2000]);
    assert.equal(zero.reconciliationNumber, 'RMX-REC-000001');
    assert.equal((await doc(`reconciliations/${zero.reconciliationId}`)).status, 'balanced');
    const s = await doc(`reconciliations/${short.reconciliationId}`);
    assert.deepEqual([s.status, s.systemBalanceUgx, s.actualBalanceUgx, s.reconciledBy], ['discrepancy', 100_000, 98_000, 'mgr']);
    assert.equal(await balance('cash_at_hand'), 100_000, 'no hidden correction');
    assert.equal((await audits('finance.reconciled')).length, 3);
    await rejects(finance.reconcileAccount(deps, 'mgr', { accountId: 'cash_at_hand', actualBalanceUgx: -1, requestId: rid() }), 'invalid-argument', 'amount');
    await rejects(finance.reconcileAccount(deps, 'cash', { accountId: 'cash_at_hand', actualBalanceUgx: 1, requestId: rid() }), 'permission-denied');
    await rejects(finance.reconcileAccount(deps, 'aud', { accountId: 'cash_at_hand', actualBalanceUgx: 1, requestId: rid() }), 'permission-denied');
  });

  test('a discrepancy is closed only by an explicit, authorised adjustment of exactly the difference', async () => {
    await opening('cash_at_hand', 100_000);
    const short = await finance.reconcileAccount(deps, 'mgr', { accountId: 'cash_at_hand', actualBalanceUgx: 98_000, requestId: rid() });
    const adjust = (actor, extra) => finance.recordAccountAdjustment(deps, actor, {
      accountId: 'cash_at_hand', direction: 'out', amountUgx: 2000, reason: 'Cash count shortage', reconciliationId: short.reconciliationId, requestId: rid(), ...extra,
    });
    await rejects(adjust('mgr'), 'permission-denied'); // managers reconcile; adjusting is Admin-only by default
    await rejects(adjust('admin', { direction: 'in' }), 'invalid-argument', 'adjustment_mismatch');
    await rejects(adjust('admin', { amountUgx: 1999 }), 'invalid-argument', 'adjustment_mismatch');
    await rejects(adjust('admin', { reason: '' }), 'invalid-argument', 'reason');
    const r = await adjust('admin');
    assert.equal(r.balanceUgx, 98_000);
    const s = await doc(`reconciliations/${short.reconciliationId}`);
    assert.deepEqual([s.status, s.adjustmentTransactionId], ['adjusted', r.transactionId]);
    await rejects(adjust('admin'), 'failed-precondition', 'reconciliation_closed');
    assert.equal((await audits('finance.adjustment')).length, 1);
    // An outgoing adjustment can never take an account below zero.
    await rejects(finance.recordAccountAdjustment(deps, 'admin', { accountId: 'mtn_merchant', direction: 'out', amountUgx: 1, reason: 'Fee', requestId: rid() }),
      'failed-precondition', 'insufficient_funds');
    await assertLedgerConsistent();
  });
});

describe('reversals', () => {
  test('a transfer reversal restores both sides; once only; a reversal cannot be reversed; reason required', async () => {
    await opening('cash_at_hand', 100_000);
    const t = await transfer('mgr', 'cash_at_hand', 'bank_1', 60_000);
    await rejects(finance.reverseFinancialTransaction(deps, 'admin', { transactionId: t.transactionId }), 'invalid-argument', 'reason');
    await rejects(finance.reverseFinancialTransaction(deps, 'mgr', { transactionId: t.transactionId, reason: 'Wrong account' }), 'permission-denied');
    const r = await finance.reverseFinancialTransaction(deps, 'admin', { transactionId: t.transactionId, reason: 'Wrong account' });
    assert.deepEqual([await balance('cash_at_hand'), await balance('bank_1')], [100_000, 0]);
    assert.notEqual(r.transactionNumber, t.transactionNumber, 'numbers are never reused');
    await rejects(finance.reverseFinancialTransaction(deps, 'admin', { transactionId: t.transactionId, reason: 'Again' }), 'failed-precondition', 'already_reversed');
    await rejects(finance.reverseFinancialTransaction(deps, 'admin', { transactionId: r.transactionId, reason: 'Undo' }), 'failed-precondition', 'is_reversal');
    const original = await doc(`financial_transactions/${t.transactionId}`);
    assert.deepEqual([original.status, original.reversedByTransactionId, original.reversalReason], ['reversed', r.transactionId, 'Wrong account']);
    assert.equal((await txns()).length, 3, 'nothing deleted');
    assert.equal((await audits('finance.transaction_reversed')).length, 1);
    await assertLedgerConsistent();
  });

  test('an opening balance can be reversed and recorded again correctly', async () => {
    const r = await opening('cash_at_hand', 500_000);
    await finance.reverseFinancialTransaction(deps, 'admin', { transactionId: r.transactionId, reason: 'Typo' });
    await opening('cash_at_hand', 50_000);
    assert.equal(await balance('cash_at_hand'), 50_000);
    await assertLedgerConsistent();
  });

  test('pure helpers: EAT business days', () => {
    const t = Date.UTC(2026, 8, 21, 22, 30); // 01:30 EAT on the 22nd
    assert.equal(finance.dayKey(t), '2026-09-22');
    assert.equal(finance.dayStart(t), Date.UTC(2026, 8, 21, 21));
  });
});
