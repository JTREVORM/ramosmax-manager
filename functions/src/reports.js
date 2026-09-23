// ===========================================================================
// RamosMAX reports (Phase 9) - one read-only callable, getBusinessReport.
// ===========================================================================
// Every figure is derived on the server from the authoritative records:
//   * money totals from `finance_daily_summaries`, which the Phase 5 ledger
//     writes in the SAME transaction as each ledger entry (never recomputed
//     here, never stored twice);
//   * account balances from `financial_accounts` (ledger-maintained);
//   * payments, invoices, expenses, stock, attendance, payroll, shares,
//     dividends and after-hours records from their own collections.
// Nothing is written. Nothing the app sends is used except the report name
// and the period. Sections the caller has no permission for are left out, so
// a report never reveals more than the screens would.
//
// Accounting separation (unchanged from Phases 5-8):
//   operating revenue  = customer payments − their reversals
//   NOT revenue        = share capital, transfers, bank deposits, opening
//                        balances, adjustments, after-hours handovers
//   operating expenses = expense payments − their reversals
//   shown separately   = inventory purchases, staff pay (allowances, payroll),
//                        dividends (distributions to owners)
//
// Reads are bounded: a period is at most MAX_DAYS days and every query has a
// limit (MAX_DOCS); a report that hit a limit says so (`truncated`).
// ===========================================================================

import { Timestamp } from 'firebase-admin/firestore';

import { deny, invalid } from './access.js';
import { dayKey, dayStart } from './finance.js';
import { loadActor, requireObject } from './user_admin.js';

export const MAX_DAYS = 400;
export const MAX_DOCS = 5000;
const DAY_MS = 24 * 3600_000;

/** Report → the permissions that open it (any one). */
export const REPORTS = Object.freeze({
  executive: ['reports.operational.view', 'reports.financial.view'],
  financial: ['reports.financial.view', 'finance.view'],
  revenue: ['reports.financial.view', 'finance.view'],
  payment_methods: ['reports.financial.view', 'finance.view'],
  outstanding: ['credit.view'],
  expenses: ['expenses.view'],
  inventory: ['inventory.reports.view', 'inventory.view'],
  workforce: ['attendance.view', 'payroll.view', 'reports.payroll.view'],
  shareholders: ['shareholders.reports.view', 'shares.view', 'shareholders.view'],
  after_hours: ['after_hours.view'],
});

const METHODS = ['cash', 'mtn_merchant', 'airtel_merchant', 'bank'];
const METHOD_LABEL = { cash: 'Cash', mtn_merchant: 'MTN Merchant', airtel_merchant: 'Airtel Merchant', bank: 'Bank' };

// --- period ----------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `{from, to}` EAT day keys (inclusive) → millis bounds; validated. */
export function requirePeriod(from, to, now) {
  if (typeof from !== 'string' || typeof to !== 'string' || !DAY_RE.test(from) || !DAY_RE.test(to)) {
    throw invalid('Choose the period (from and to dates).', 'period');
  }
  const startMs = Date.parse(`${from}T00:00:00+03:00`);
  const endStart = Date.parse(`${to}T00:00:00+03:00`);
  if (Number.isNaN(startMs) || Number.isNaN(endStart) || dayKey(startMs) !== from || dayKey(endStart) !== to) {
    throw invalid('Choose valid dates.', 'period');
  }
  if (endStart < startMs) throw invalid('The period must end on or after its start.', 'period');
  if (startMs > dayStart(now)) throw invalid('The period cannot start in the future.', 'period');
  const days = Math.round((endStart - startMs) / DAY_MS) + 1;
  if (days > MAX_DAYS) throw invalid(`A report can cover at most ${MAX_DAYS} days.`, 'period');
  return { from, to, startMs, endMs: endStart + DAY_MS, days };
}

// --- helpers ---------------------------------------------------------------

const ms = (t) => (t?.toMillis ? t.toMillis() : typeof t === 'number' ? t : null);
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const money = (key, label, value) => ({ key, label, value: n(value), kind: 'money' });
const count = (key, label, value) => ({ key, label, value: n(value), kind: 'count' });
const col = (key, label, kind = 'text') => ({ key, label, kind });

function tracker() {
  let truncated = false;
  return {
    get truncated() { return truncated; },
    /** Runs [query] with MAX_DOCS + 1 and notes a cut-off. */
    async docs(query, limit = MAX_DOCS) {
      const snap = await query.limit(limit + 1).get();
      if (snap.size > limit) truncated = true;
      return snap.docs.slice(0, limit).map((d) => ({ id: d.id, ...d.data() }));
    },
  };
}

/** Docs whose [field] (a Timestamp) falls in the period. Single-field range: automatic index. */
function inPeriod(db, t, collection, field, p, limit) {
  return t.docs(db.collection(collection).where(field, '>=', Timestamp.fromMillis(p.startMs))
    .where(field, '<', Timestamp.fromMillis(p.endMs)).orderBy(field), limit);
}

/** Daily ledger summaries for the period, oldest first. */
async function summaries(db, t, p) {
  return t.docs(db.collection('finance_daily_summaries').where('day', '>=', p.from).where('day', '<=', p.to).orderBy('day'), MAX_DAYS + 1);
}

function sumSummaries(days) {
  const total = {
    customerPaymentsUgx: 0, expensesPaidUgx: 0, purchasesPaidUgx: 0, transfersUgx: 0, depositsUgx: 0, openingBalancesUgx: 0,
    adjustmentsInUgx: 0, adjustmentsOutUgx: 0, allowancesPaidUgx: 0, payrollPaidUgx: 0, shareCapitalInUgx: 0, dividendsPaidUgx: 0,
    transactionCount: 0, reversals: {}, expensesByCategory: {},
  };
  for (const d of days) {
    for (const k of Object.keys(total)) if (typeof total[k] === 'number') total[k] += n(d[k]);
    for (const [k, v] of Object.entries(d.reversals ?? {})) total.reversals[k] = n(total.reversals[k]) + n(v);
    for (const [k, v] of Object.entries(d.expensesByCategory ?? {})) total.expensesByCategory[k] = n(total.expensesByCategory[k]) + n(v);
  }
  const rev = (type) => n(total.reversals[`${type}Ugx`]);
  total.netCustomerPaymentsUgx = total.customerPaymentsUgx - rev('customer_payment');
  total.netExpensesUgx = total.expensesPaidUgx - rev('expense_payment');
  total.netPurchasesUgx = total.purchasesPaidUgx - rev('inventory_purchase_payment');
  total.netStaffPayUgx = total.allowancesPaidUgx + total.payrollPaidUgx - rev('allowance_payment') - rev('payroll_payment');
  total.netShareCapitalUgx = total.shareCapitalInUgx - rev('share_capital_contribution');
  total.netDividendsUgx = total.dividendsPaidUgx - rev('dividend_payment');
  total.paymentReversalsUgx = rev('customer_payment');
  return total;
}

/** Payments received in the period by method: count, gross, reversed since, net. */
async function paymentsByMethod(db, t, p) {
  const payments = await inPeriod(db, t, 'payments', 'receivedAt', p);
  const rows = Object.fromEntries(METHODS.map((m) => [m, { method: METHOD_LABEL[m], count: 0, grossUgx: 0, reversedCount: 0, reversedUgx: 0, netUgx: 0 }]));
  for (const x of payments) {
    const r = rows[x.method] ?? (rows[x.method] = { method: x.method, count: 0, grossUgx: 0, reversedCount: 0, reversedUgx: 0, netUgx: 0 });
    r.count += 1;
    r.grossUgx += n(x.amountUgx);
    if (x.status === 'reversed') {
      r.reversedCount += 1;
      r.reversedUgx += n(x.amountUgx);
    } else r.netUgx += n(x.amountUgx);
  }
  const list = Object.values(rows);
  const totals = list.reduce((a, r) => ({ count: a.count + r.count, grossUgx: a.grossUgx + r.grossUgx, reversedCount: a.reversedCount + r.reversedCount,
    reversedUgx: a.reversedUgx + r.reversedUgx, netUgx: a.netUgx + r.netUgx }), { count: 0, grossUgx: 0, reversedCount: 0, reversedUgx: 0, netUgx: 0 });
  return { rows: list, totals, afterHoursNetUgx: payments.filter((x) => x.isAfterHours === true && x.status !== 'reversed').reduce((a, x) => a + n(x.amountUgx), 0) };
}

const OPEN_INVOICE = ['unpaid', 'partially_paid', 'credit'];

async function openInvoices(db, t, limit = 1000) {
  return t.docs(db.collection('invoices').where('paymentStatus', 'in', OPEN_INVOICE).orderBy('createdAt', 'desc'), limit);
}

const PAYMENT_TABLE = [col('method', 'Method'), col('count', 'Payments', 'count'), col('grossUgx', 'Gross', 'money'),
  col('reversedCount', 'Reversed', 'count'), col('reversedUgx', 'Reversed amount', 'money'), col('netUgx', 'Net', 'money')];

// --- sections --------------------------------------------------------------

async function operationsSection(db, t, p) {
  const intakes = await inPeriod(db, t, 'service_intakes', 'createdAt', p);
  const services = new Map((await t.docs(db.collection('services'), 500)).map((s) => [s.id, s]));
  const byStatus = { open: 0, completed: 0, cancelled: 0, draft: 0 };
  const orders = { pending: 0, assigned: 0, accepted: 0, in_progress: 0, paused: 0, completed: 0, cancelled: 0 };
  const vehicles = new Set();
  const byCategory = {};
  for (const i of intakes) {
    byStatus[i.status] = n(byStatus[i.status]) + 1;
    if (i.status === 'completed' && i.vehicleId) vehicles.add(i.vehicleId);
    for (const o of i.orders ?? []) orders[o.status] = n(orders[o.status]) + 1;
    if (i.status !== 'cancelled') {
      for (const sid of i.serviceIds ?? []) {
        const c = services.get(sid)?.category ?? 'other';
        byCategory[c] = n(byCategory[c]) + 1;
      }
    }
  }
  return {
    key: 'operations',
    title: 'Operations',
    figures: [
      count('jobs', 'Jobs started', intakes.length),
      count('jobs_completed', 'Jobs completed', byStatus.completed),
      count('jobs_open', 'Jobs still open', byStatus.open),
      count('jobs_cancelled', 'Jobs cancelled', byStatus.cancelled),
      count('vehicles_serviced', 'Vehicles serviced', vehicles.size),
      count('orders_in_progress', 'Work in progress', orders.in_progress + orders.accepted + orders.paused),
      count('orders_pending', 'Work not yet started', orders.pending + orders.assigned),
    ],
    tables: [{
      key: 'services_by_category', title: 'Services by category',
      columns: [col('category', 'Category'), col('count', 'Services', 'count')],
      rows: Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([category, c]) => ({ category, count: c })),
    }],
  };
}

async function revenueSection(db, t, p, { withCredit }) {
  const s = sumSummaries(await summaries(db, t, p));
  const byMethod = await paymentsByMethod(db, t, p);
  const figures = [
    money('operating_revenue', 'Operating revenue (payments received, net of reversals)', s.netCustomerPaymentsUgx),
    money('payments_gross', 'Customer payments before reversals', s.customerPaymentsUgx),
    money('payment_reversals', 'Customer payments reversed', s.paymentReversalsUgx),
    ...byMethod.rows.map((r) => money(`method_${r.method}`, `${r.method} (net)`, r.netUgx)),
    money('after_hours_payments', 'Of which collected after hours', byMethod.afterHoursNetUgx),
  ];
  if (withCredit) {
    const open = await openInvoices(db, t);
    figures.push(money('credit_outstanding', 'Owed by customers now (credit / unpaid)', open.reduce((a, i) => a + n(i.outstandingUgx), 0)));
  }
  return { key: 'revenue', title: 'Revenue', note: 'Revenue counts customer payments only. Share capital, transfers, deposits, adjustments and after-hours handovers are not revenue.', figures, tables: [] };
}

async function financeSection(db, t, p) {
  const s = sumSummaries(await summaries(db, t, p));
  const accounts = await t.docs(db.collection('financial_accounts'), 100);
  const recs = await inPeriod(db, t, 'reconciliations', 'reconciliationDate', p, 1000);
  return {
    key: 'finance',
    title: 'Finance',
    figures: [
      ...accounts.filter((a) => a.active !== false).map((a) => money(`balance_${a.accountId ?? a.id}`, `${a.name ?? a.id} balance now`, a.balanceUgx)),
      money('expenses_paid', 'Operating expenses paid', s.netExpensesUgx),
      money('purchases_paid', 'Inventory purchases paid', s.netPurchasesUgx),
      money('staff_pay', 'Staff pay (allowances and payroll)', s.netStaffPayUgx),
      money('transfers', 'Transfers between accounts', s.transfersUgx),
      money('deposits', 'Bank deposits', s.depositsUgx),
      money('adjustments_in', 'Adjustments in', s.adjustmentsInUgx),
      money('adjustments_out', 'Adjustments out', s.adjustmentsOutUgx),
      count('reconciliations', 'Reconciliations', recs.length),
      count('reconciliation_differences', 'Reconciliations with a difference', recs.filter((r) => n(r.differenceUgx) !== 0).length),
    ],
    tables: [],
  };
}

async function workforceSection(db, t, p, can) {
  const figures = [];
  const tables = [];
  const users = await t.docs(db.collection('users').where('active', '==', true), 1000);
  figures.push(count('staff', 'Active staff accounts', users.filter((u) => u.role !== 'shareholder').length));
  if (can('attendance.view')) {
    const att = await t.docs(db.collection('attendance').where('dayKey', '>=', p.from).where('dayKey', '<=', p.to).orderBy('dayKey'));
    const per = new Map();
    const tally = { on_time: 0, late: 0, absent: 0, excused: 0 };
    for (const a of att) {
      if (a.status === 'rejected') continue;
      tally[a.arrivalStatus] = n(tally[a.arrivalStatus]) + 1;
      const r = per.get(a.staffUid) ?? { staff: a.staffName ?? a.staffUid, present: 0, late: 0, absent: 0, excused: 0, minutesLate: 0 };
      if (a.arrivalStatus === 'on_time' || a.arrivalStatus === 'late') r.present += 1;
      if (a.arrivalStatus === 'late') { r.late += 1; r.minutesLate += n(a.minutesLate); }
      if (a.arrivalStatus === 'absent') r.absent += 1;
      if (a.arrivalStatus === 'excused') r.excused += 1;
      per.set(a.staffUid, r);
    }
    figures.push(count('attendance_on_time', 'On-time days', tally.on_time), count('attendance_late', 'Late arrivals', tally.late),
      count('attendance_absent', 'Absences', tally.absent), count('attendance_excused', 'Excused', tally.excused));
    tables.push({
      key: 'attendance_by_staff', title: 'Attendance by staff member',
      columns: [col('staff', 'Staff'), col('present', 'Present', 'count'), col('late', 'Late', 'count'), col('minutesLate', 'Minutes late', 'count'),
        col('absent', 'Absent', 'count'), col('excused', 'Excused', 'count')],
      rows: [...per.values()].sort((a, b) => a.staff.localeCompare(b.staff)),
    });
  }
  if (can('allowances.view')) {
    const all = await t.docs(db.collection('worker_allowances').where('dayKey', '>=', p.from).where('dayKey', '<=', p.to).orderBy('dayKey'));
    const by = {};
    for (const a of all) by[a.status] = n(by[a.status]) + n(a.amountUgx);
    figures.push(money('allowances_approved', 'Allowances approved, not yet paid', by.approved), money('allowances_paid', 'Allowances paid', by.paid),
      money('allowances_pending', 'Allowances awaiting a decision', n(by.calculated) + n(by.pending_approval)));
  }
  if (can('payroll.view') || can('reports.payroll.view')) {
    const runs = await inPeriod(db, t, 'payroll', 'periodStart', p, 200);
    tables.push({
      key: 'payroll', title: 'Payroll runs',
      columns: [col('payroll', 'Payroll'), col('period', 'Period'), col('status', 'Status'), col('employees', 'Staff', 'count'),
        col('grossUgx', 'Gross', 'money'), col('deductionsUgx', 'Deductions', 'money'), col('netUgx', 'Net', 'money')],
      rows: runs.filter((r) => r.status !== 'cancelled').map((r) => ({ payroll: r.payrollNumber, period: r.periodLabel ?? r.periodKey, status: r.status,
        employees: n(r.employeeCount), grossUgx: n(r.totalGrossUgx), deductionsUgx: n(r.totalDeductionsUgx), netUgx: n(r.totalNetUgx) })),
    });
    const paid = runs.filter((r) => ['paid', 'locked'].includes(r.status));
    figures.push(money('payroll_net_paid', 'Payroll net paid', paid.reduce((a, r) => a + n(r.totalNetUgx), 0)),
      money('payroll_deductions', 'Payroll deductions', paid.reduce((a, r) => a + n(r.totalDeductionsUgx), 0)));
  }
  if (can('losses.view')) {
    const losses = await inPeriod(db, t, 'loss_incidents', 'createdAt', p, 1000);
    const open = await t.docs(db.collection('loss_incidents').where('outstandingUgx', '>', 0), 1000);
    figures.push(count('losses_reported', 'Loss incidents reported', losses.length),
      money('losses_amount', 'Losses reported (amount)', losses.reduce((a, l) => a + n(l.amountUgx), 0)),
      money('losses_recovered', 'Recovered so far (these incidents)', losses.reduce((a, l) => a + n(l.recoveredUgx), 0)),
      money('losses_outstanding', 'All recoveries still outstanding', open.reduce((a, l) => a + n(l.outstandingUgx), 0)));
  }
  return { key: 'workforce', title: 'Workforce', figures, tables };
}

async function inventorySection(db, t, p, { detail }) {
  const items = await t.docs(db.collection('inventory_items'), 2000);
  const active = items.filter((i) => i.active !== false);
  const value = active.reduce((a, i) => a + n(i.quantity) * n(i.lastUnitCostUgx), 0);
  const low = active.filter((i) => i.stockStatus === 'low' || i.stockStatus === 'out_of_stock');
  const moves = await inPeriod(db, t, 'stock_movements', 'createdAt', p);
  const byType = {};
  for (const m of moves) {
    const k = m.type === 'stock_out' && m.reasonCode ? `stock_out: ${m.reasonCode}` : m.type;
    const r = byType[k] ?? { type: k, movements: 0, quantity: 0 };
    r.movements += 1;
    r.quantity += n(m.quantity);
    byType[k] = r;
  }
  const s = sumSummaries(await summaries(db, t, p));
  const purchases = await inPeriod(db, t, 'inventory_purchases', 'createdAt', p, 1000);
  const suppliers = await t.docs(db.collection('suppliers'), 1000);
  const tables = [
    { key: 'low_stock', title: 'Low or out of stock', columns: [col('item', 'Item'), col('sku', 'SKU'), col('quantity', 'Quantity', 'count'),
      col('reorderLevel', 'Reorder level', 'count'), col('status', 'Status')],
    rows: low.map((i) => ({ item: i.name, sku: i.sku, quantity: n(i.quantity), reorderLevel: n(i.reorderLevel), status: i.stockStatus })) },
    { key: 'movements', title: 'Stock movements in the period', columns: [col('type', 'Type'), col('movements', 'Movements', 'count'), col('quantity', 'Quantity', 'count')],
      rows: Object.values(byType) },
  ];
  if (detail) {
    tables.unshift({ key: 'stock', title: 'Current stock', columns: [col('item', 'Item'), col('sku', 'SKU'), col('quantity', 'Quantity', 'count'),
      col('unit', 'Unit'), col('unitCostUgx', 'Last unit cost', 'money'), col('valueUgx', 'Indicative value', 'money')],
    rows: active.map((i) => ({ item: i.name, sku: i.sku, quantity: n(i.quantity), unit: i.unit ?? '', unitCostUgx: n(i.lastUnitCostUgx),
      valueUgx: n(i.quantity) * n(i.lastUnitCostUgx) })).sort((a, b) => a.item.localeCompare(b.item)) });
  }
  return {
    key: 'inventory',
    title: 'Inventory',
    note: 'Stock value is indicative: quantity × last purchase cost. It is not an audited valuation.',
    figures: [
      count('items', 'Active items', active.length), count('low_stock', 'Low or out of stock', low.length),
      money('stock_value', 'Indicative stock value', value), count('movements', 'Stock movements', moves.length),
      count('purchases', 'Purchases raised', purchases.length), money('purchases_paid', 'Purchases paid', s.netPurchasesUgx),
      count('suppliers', 'Suppliers', suppliers.length),
    ],
    tables,
  };
}

async function ownershipSection(db, t, p, can) {
  const reg = (await db.collection('share_register').doc('current').get()).data() ?? {};
  const s = sumSummaries(await summaries(db, t, p));
  const dividends = await inPeriod(db, t, 'dividends', 'declarationDate', p, 200);
  const figures = [
    count('shareholders', 'Shareholders', reg.shareholderCount), count('holders', 'Holding shares', reg.holderCount),
    { key: 'total_shares', label: 'Total shares', value: n(reg.totalShares), kind: 'count' },
    money('capital_paid', 'Share capital received (all time)', reg.totalPaidUgx),
    money('capital_outstanding', 'Share capital outstanding', reg.outstandingUgx),
    money('capital_in_period', 'Share capital received in the period', s.netShareCapitalUgx),
    money('dividends_paid', 'Dividends paid in the period', s.netDividendsUgx),
    count('dividends_declared', 'Dividends declared in the period', dividends.filter((d) => d.status !== 'draft' && d.status !== 'cancelled').length),
    count('pending_approvals', 'Share transactions awaiting approval', reg.pendingApprovals),
  ];
  const tables = [
    { key: 'distribution', title: 'Ownership distribution', columns: [col('number', 'Shareholder no.'), col('name', 'Name'),
      col('shares', 'Shares', 'count'), col('percent', 'Ownership %', 'percent')],
    rows: (reg.holders ?? []).map((h) => ({ number: h.shareholderNumber, name: h.shareholderName, shares: n(h.shares), percent: n(h.ownershipPercent) })) },
    { key: 'by_class', title: 'Shares by class', columns: [col('classCode', 'Class'), col('shares', 'Shares', 'count'), col('paidUgx', 'Capital paid', 'money')],
      rows: Object.entries(reg.byClass ?? {}).map(([k, v]) => ({ classCode: v?.classCode ?? k, shares: n(v?.issuedShares), paidUgx: n(v?.paidUgx) })) },
    { key: 'dividends', title: 'Dividends declared in the period', columns: [col('dividend', 'Dividend'), col('period', 'Financial period'),
      col('status', 'Status'), col('allocatedUgx', 'Allocated', 'money'), col('paidUgx', 'Paid', 'money'), col('outstandingUgx', 'Outstanding', 'money')],
    rows: dividends.map((d) => ({ dividend: d.dividendNumber, period: d.financialPeriod, status: d.status, allocatedUgx: n(d.allocatedUgx),
      paidUgx: n(d.paidUgx), outstandingUgx: n(d.outstandingUgx) })) },
  ];
  if (can('shares.view')) {
    const txns = await inPeriod(db, t, 'share_transactions', 'createdAt', p, 1000);
    const cons = await inPeriod(db, t, 'share_contributions', 'createdAt', p, 1000);
    const kinds = {};
    for (const x of txns.filter((x) => x.applied)) kinds[x.type] = (kinds[x.type] ?? 0) + 1;
    figures.push(count('issues', 'Share issues posted', kinds.shares_issued), count('transfers', 'Share transfers posted', kinds.shares_transferred),
      count('adjustments', 'Share adjustments posted', kinds.shares_adjusted));
    tables.push({ key: 'contributions', title: 'Contributions recorded in the period', columns: [col('contribution', 'Contribution'),
      col('shareholder', 'Shareholder'), col('source', 'Source'), col('status', 'Status'), col('amountUgx', 'Amount', 'money')],
    rows: cons.map((c) => ({ contribution: c.contributionNumber, shareholder: c.shareholderName ?? c.shareholderNumber, source: c.source,
      status: c.status, amountUgx: n(c.amountUgx) })) });
  }
  return { key: 'ownership', title: 'Ownership', note: 'Share capital and dividends are owners\' money: never revenue, never operating expenses.', figures, tables };
}

async function afterHoursSection(db, t, p) {
  const sessions = await inPeriod(db, t, 'after_hours_sessions', 'openedAt', p, 2000);
  const handovers = await inPeriod(db, t, 'cash_handovers', 'createdAt', p, 2000);
  const discrepancies = await inPeriod(db, t, 'cash_discrepancies', 'createdAt', p, 2000);
  const workers = new Map();
  for (const s of sessions) {
    const w = workers.get(s.staffUid) ?? { worker: s.staffName ?? s.staffUid, sessions: 0, jobs: 0, payments: 0, expectedUgx: 0 };
    w.sessions += 1;
    w.jobs += n(s.intakesCreated);
    w.payments += n(s.paymentCount);
    w.expectedUgx += s.status === 'cancelled' ? 0 : n(s.expectedCashUgx);
    workers.set(s.staffUid, w);
  }
  const short = discrepancies.filter((d) => n(d.differenceUgx) < 0).reduce((a, d) => a - n(d.differenceUgx), 0);
  const over = discrepancies.filter((d) => n(d.differenceUgx) > 0).reduce((a, d) => a + n(d.differenceUgx), 0);
  return {
    key: 'after_hours',
    title: 'After-hours',
    note: 'Payments collected after hours are already in revenue. Handovers move custody only; they are never counted again.',
    figures: [
      count('sessions', 'Sessions opened', sessions.length),
      count('sessions_open', 'Still open', sessions.filter((s) => s.status === 'open').length),
      money('expected', 'Expected cash (handovers)', handovers.reduce((a, h) => a + n(h.expectedCashUgx), 0)),
      money('received', 'Cash received (counted)', handovers.reduce((a, h) => a + n(h.actualAmountUgx), 0)),
      count('handovers_waiting', 'Handovers waiting', handovers.filter((h) => h.status === 'pending' || h.status === 'submitted').length),
      count('discrepancies', 'Discrepancies', discrepancies.length),
      count('discrepancies_open', 'Discrepancies unresolved', discrepancies.filter((d) => d.status === 'open' || d.status === 'under_review').length),
      money('shortages', 'Shortages', short),
      money('excesses', 'Excesses', over),
    ],
    tables: [
      { key: 'workers', title: 'By worker', columns: [col('worker', 'Worker'), col('sessions', 'Sessions', 'count'), col('jobs', 'Jobs', 'count'),
        col('payments', 'Payments', 'count'), col('expectedUgx', 'Expected cash', 'money')], rows: [...workers.values()] },
      { key: 'discrepancy_list', title: 'Discrepancies', columns: [col('discrepancy', 'Discrepancy'), col('worker', 'Worker'), col('status', 'Status'),
        col('expectedUgx', 'Expected', 'money'), col('actualUgx', 'Counted', 'money'), col('differenceUgx', 'Difference', 'money')],
      rows: discrepancies.map((d) => ({ discrepancy: d.discrepancyNumber, worker: d.staffName, status: d.status, expectedUgx: n(d.expectedCashUgx),
        actualUgx: n(d.actualAmountUgx), differenceUgx: n(d.differenceUgx) })) },
    ],
  };
}

// --- reports ---------------------------------------------------------------

const BUILDERS = {
  async executive(db, t, p, can) {
    const sections = [];
    if (can('reports.operational.view') || can('jobs.view')) sections.push(await operationsSection(db, t, p));
    const fin = can('reports.financial.view') || can('finance.view');
    if (fin) sections.push(await revenueSection(db, t, p, { withCredit: can('credit.view') || can('reports.financial.view') }));
    if (can('finance.view')) sections.push(await financeSection(db, t, p));
    if (can('attendance.view') || can('payroll.view') || can('reports.payroll.view')) sections.push(await workforceSection(db, t, p, can));
    if (can('inventory.view') || can('inventory.reports.view')) sections.push(await inventorySection(db, t, p, { detail: false }));
    if (can('shareholders.reports.view')) sections.push(await ownershipSection(db, t, p, can));
    if (can('after_hours.view')) sections.push(await afterHoursSection(db, t, p));
    return sections;
  },

  async financial(db, t, p) {
    const days = await summaries(db, t, p);
    const s = sumSummaries(days);
    const rev = (d, k) => n(d.reversals?.[`${k}Ugx`]);
    return [{
      key: 'financial',
      title: 'Money in and out',
      note: 'From the daily ledger summaries (East Africa Time business days). Reversals are counted on the day they are made.',
      figures: [
        money('sales', 'Customer payments (net)', s.netCustomerPaymentsUgx),
        money('payment_reversals', 'Customer payments reversed', s.paymentReversalsUgx),
        money('expenses', 'Operating expenses paid (net)', s.netExpensesUgx),
        money('purchases', 'Inventory purchases paid (net)', s.netPurchasesUgx),
        money('staff_pay', 'Staff pay (net)', s.netStaffPayUgx),
        money('transfers', 'Transfers', s.transfersUgx),
        money('deposits', 'Bank deposits', s.depositsUgx),
        money('adjustments_in', 'Adjustments in', s.adjustmentsInUgx),
        money('adjustments_out', 'Adjustments out', s.adjustmentsOutUgx),
        money('capital', 'Share capital received (net)', s.netShareCapitalUgx),
        money('dividends', 'Dividends paid (net)', s.netDividendsUgx),
        count('transactions', 'Ledger entries', s.transactionCount),
      ],
      tables: [{
        key: 'daily', title: 'By day',
        columns: [col('day', 'Day', 'date'), col('salesUgx', 'Payments', 'money'), col('reversedUgx', 'Reversed', 'money'),
          col('expensesUgx', 'Expenses', 'money'), col('purchasesUgx', 'Purchases', 'money'), col('staffPayUgx', 'Staff pay', 'money'),
          col('transfersUgx', 'Transfers', 'money'), col('depositsUgx', 'Deposits', 'money'), col('adjustmentsUgx', 'Adjustments (in − out)', 'money'),
          col('capitalUgx', 'Share capital', 'money'), col('dividendsUgx', 'Dividends', 'money')],
        rows: days.map((d) => ({
          day: d.day, salesUgx: n(d.customerPaymentsUgx), reversedUgx: rev(d, 'customer_payment'), expensesUgx: n(d.expensesPaidUgx) - rev(d, 'expense_payment'),
          purchasesUgx: n(d.purchasesPaidUgx) - rev(d, 'inventory_purchase_payment'),
          staffPayUgx: n(d.allowancesPaidUgx) + n(d.payrollPaidUgx) - rev(d, 'allowance_payment') - rev(d, 'payroll_payment'),
          transfersUgx: n(d.transfersUgx), depositsUgx: n(d.depositsUgx), adjustmentsUgx: n(d.adjustmentsInUgx) - n(d.adjustmentsOutUgx),
          capitalUgx: n(d.shareCapitalInUgx) - rev(d, 'share_capital_contribution'), dividendsUgx: n(d.dividendsPaidUgx) - rev(d, 'dividend_payment'),
        })),
      }],
    }];
  },

  async revenue(db, t, p, can) {
    const s = sumSummaries(await summaries(db, t, p));
    const invoices = await inPeriod(db, t, 'invoices', 'createdAt', p);
    const billed = invoices.filter((i) => i.paymentStatus !== 'cancelled');
    const figures = [
      money('invoiced', 'Invoiced in the period', billed.reduce((a, i) => a + n(i.totalUgx), 0)),
      money('discounts', 'Discounts given', billed.reduce((a, i) => a + n(i.discountUgx), 0)),
      money('payments_gross', 'Customer payments received', s.customerPaymentsUgx),
      money('payment_reversals', 'Less: payments reversed', s.paymentReversalsUgx),
      money('operating_revenue', 'Operating revenue', s.netCustomerPaymentsUgx),
    ];
    if (can('credit.view') || can('reports.financial.view')) {
      const open = await openInvoices(db, t);
      figures.push(money('credit_outstanding', 'Owed by customers now (not revenue until paid)', open.reduce((a, i) => a + n(i.outstandingUgx), 0)));
    }
    return [{
      key: 'revenue', title: 'Revenue', note: 'Only customer payments are operating revenue. The items below are shown so they are never mistaken for it.',
      figures,
      tables: [{
        key: 'not_revenue', title: 'Money that is NOT operating revenue', columns: [col('item', 'Item'), col('amountUgx', 'Amount', 'money')],
        rows: [
          { item: 'Share capital received (owners)', amountUgx: s.netShareCapitalUgx },
          { item: 'Dividends paid (owners, not an operating expense)', amountUgx: s.netDividendsUgx },
          { item: 'Transfers between accounts', amountUgx: s.transfersUgx },
          { item: 'Bank deposits', amountUgx: s.depositsUgx },
          { item: 'Opening balances', amountUgx: s.openingBalancesUgx },
          { item: 'Adjustments in', amountUgx: s.adjustmentsInUgx },
          { item: 'Adjustments out', amountUgx: s.adjustmentsOutUgx },
        ],
      }],
    }];
  },

  async payment_methods(db, t, p) {
    const r = await paymentsByMethod(db, t, p);
    return [{
      key: 'payment_methods', title: 'Payments by method',
      note: 'Payments received in the period. "Reversed" are those among them reversed since; they are counted once and excluded from net.',
      figures: [count('count', 'Payments', r.totals.count), money('gross', 'Gross', r.totals.grossUgx), money('reversed', 'Reversed', r.totals.reversedUgx),
        money('net', 'Net', r.totals.netUgx)],
      tables: [{ key: 'by_method', title: 'By method', columns: PAYMENT_TABLE, rows: r.rows }],
    }];
  },

  async outstanding(db, t, p, can, now) {
    const open = await openInvoices(db, t, 1000);
    const withNames = can('customers.view');
    const ids = open.map((i) => i.id);
    const history = new Map();
    for (let i = 0; i < ids.length && i < 300; i += 30) {
      const chunk = ids.slice(i, i + 30);
      const snap = await db.collection('payments').where('invoiceId', 'in', chunk).limit(1000).get();
      for (const d of snap.docs) {
        const x = d.data();
        if (x.status === 'reversed') continue;
        const h = history.get(x.invoiceId) ?? { count: 0, last: null };
        h.count += 1;
        h.last = Math.max(h.last ?? 0, ms(x.receivedAt) ?? 0);
        history.set(x.invoiceId, h);
      }
    }
    const buckets = { '0-7': 0, '8-30': 0, '31-60': 0, '61+': 0 };
    const rows = open.map((i) => {
      const issued = ms(i.issuedAt) ?? ms(i.createdAt) ?? now;
      const age = Math.max(0, Math.floor((dayStart(now) - dayStart(issued)) / DAY_MS));
      const bucket = age <= 7 ? '0-7' : age <= 30 ? '8-30' : age <= 60 ? '31-60' : '61+';
      buckets[bucket] += n(i.outstandingUgx);
      const h = history.get(i.id);
      return {
        invoice: i.invoiceNumber, plate: i.numberPlate, ...(withNames ? { customer: i.customerName ?? '' } : {}),
        status: i.paymentStatus, issued: dayKey(issued), totalUgx: n(i.totalUgx), paidUgx: n(i.paidUgx), outstandingUgx: n(i.outstandingUgx),
        ageDays: age, payments: h?.count ?? 0, lastPayment: h?.last ? dayKey(h.last) : '',
      };
    });
    return [{
      key: 'outstanding', title: 'Outstanding and credit', note: 'Current balances owed (all dates). Not revenue until paid.',
      figures: [count('invoices', 'Open invoices', rows.length), money('outstanding', 'Total owed', rows.reduce((a, r) => a + r.outstandingUgx, 0)),
        ...Object.entries(buckets).map(([k, v]) => money(`age_${k}`, `Owed ${k} days`, v))],
      tables: [{
        key: 'invoices', title: 'Open invoices',
        columns: [col('invoice', 'Invoice'), col('plate', 'Plate'), ...(withNames ? [col('customer', 'Customer')] : []), col('status', 'Status'),
          col('issued', 'Issued', 'date'), col('totalUgx', 'Original', 'money'), col('paidUgx', 'Paid', 'money'), col('outstandingUgx', 'Remaining', 'money'),
          col('ageDays', 'Age (days)', 'count'), col('payments', 'Payments', 'count'), col('lastPayment', 'Last payment', 'date')],
        rows,
      }],
    }];
  },

  async expenses(db, t, p, can) {
    const list = await inPeriod(db, t, 'expenses', 'expenseDate', p);
    const byStatus = {};
    const byCategory = {};
    for (const e of list) {
      const s = byStatus[e.status] ?? { status: e.status, count: 0, amountUgx: 0 };
      s.count += 1;
      s.amountUgx += n(e.amountUgx);
      byStatus[e.status] = s;
      if (e.status !== 'cancelled' && e.status !== 'rejected') {
        const c = byCategory[e.categoryId] ?? { category: e.categoryName ?? e.categoryId, count: 0, amountUgx: 0 };
        c.count += 1;
        c.amountUgx += n(e.amountUgx);
        byCategory[e.categoryId] = c;
      }
    }
    const sections = [{
      key: 'expenses', title: 'Expenses (by expense date)',
      figures: ['draft', 'pending_review', 'approved', 'paid', 'rejected', 'cancelled'].map((st) => money(`status_${st}`, `${st.replace('_', ' ')} (${byStatus[st]?.count ?? 0})`, byStatus[st]?.amountUgx)),
      tables: [
        { key: 'by_category', title: 'By category (excluding rejected and cancelled)', columns: [col('category', 'Category'), col('count', 'Expenses', 'count'),
          col('amountUgx', 'Amount', 'money')], rows: Object.values(byCategory).sort((a, b) => b.amountUgx - a.amountUgx) },
        { key: 'list', title: 'Expenses', columns: [col('expense', 'Expense'), col('date', 'Date', 'date'), col('category', 'Category'), col('payee', 'Payee'),
          col('status', 'Status'), col('amountUgx', 'Amount', 'money')],
        rows: list.map((e) => ({ expense: e.expenseNumber, date: dayKey(ms(e.expenseDate) ?? 0), category: e.categoryName ?? e.categoryId,
          payee: e.payee ?? '', status: e.status, amountUgx: n(e.amountUgx) })) },
      ],
    }];
    if (can('reports.financial.view') || can('finance.view')) {
      const s = sumSummaries(await summaries(db, t, p));
      sections.push({
        key: 'money_out', title: 'Money paid out (by payment date)', note: 'Kept apart as in the ledger: purchases, staff pay and dividends are not operating expenses.',
        figures: [money('operating', 'Operating expenses', s.netExpensesUgx), money('purchases', 'Inventory purchases', s.netPurchasesUgx),
          money('staff_pay', 'Staff pay (allowances and payroll)', s.netStaffPayUgx), money('dividends', 'Dividends (owners)', s.netDividendsUgx)],
        tables: [],
      });
    }
    return sections;
  },

  async inventory(db, t, p) {
    return [await inventorySection(db, t, p, { detail: true })];
  },

  async workforce(db, t, p, can) {
    return [await workforceSection(db, t, p, can)];
  },

  async shareholders(db, t, p, can) {
    return [await ownershipSection(db, t, p, can)];
  },

  async after_hours(db, t, p) {
    return [await afterHoursSection(db, t, p)];
  },
};

/**
 * getBusinessReport({report, from, to}) - read-only. `from` / `to` are EAT
 * day keys (inclusive). Returns sections of figures and tables; the app
 * renders and exports them as they are.
 */
export async function getBusinessReport(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const report = typeof data.report === 'string' && Object.hasOwn(REPORTS, data.report) ? data.report : null;
  if (!report) throw invalid('Choose a report.', 'report');
  const actor = await loadActor(db, callerUid, now);
  if (!REPORTS[report].some((perm) => actor.perms.has(perm))) {
    throw deny('You do not have permission to view this report.', 'report_forbidden');
  }
  const period = requirePeriod(data.from, data.to, now);
  const t = tracker();
  const can = (perm) => actor.perms.has(perm);
  const sections = await BUILDERS[report](db, t, period, can, now);
  return {
    report,
    from: period.from,
    to: period.to,
    days: period.days,
    generatedAt: now,
    truncated: t.truncated,
    sections,
  };
}
