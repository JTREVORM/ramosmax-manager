import 'server-only';
import { queryAsUser } from './db';
import { sessionUserId } from './session';

/**
 * Reads for the ownership screens: shareholders, shares and dividends.
 *
 * Every query runs AS THE SIGNED-IN USER, so RLS decides what comes back. A
 * shareholder asking for the register receives nothing at all — their own
 * record comes from `myShareholding()`, which the database serves from their
 * sign-in. A manager holding only workforce and shareholder reporting receives
 * the register view, which carries no contact detail. The page never filters
 * for security.
 */

async function requireUser(): Promise<string> {
  const id = await sessionUserId();
  if (!id) throw new Error('Not signed in.');
  return id;
}

/* -------------------------------------------------------------------------- */
/* shareholders                                                                */
/* -------------------------------------------------------------------------- */

export interface ShareholderRow {
  id: string;
  shareholder_number: string;
  full_name: string;
  phone_number: string | null;
  email: string | null;
  address: string | null;
  id_type: string | null;
  id_number: string | null;
  join_date: string;
  notes: string | null;
  status: string;
  status_reason: string | null;
  linked_uid: string | null;
  linked_user_name: string | null;
  total_shares: number;
  ownership_percent: number;
  committed_ugx: number;
  paid_ugx: number;
  outstanding_ugx: number;
  dividends_paid_ugx: number;
}

const SHAREHOLDER_COLUMNS = `
  id, shareholder_number, full_name, phone_number, email, address, id_type, id_number,
  join_date::text as join_date, notes, status, status_reason, linked_uid, linked_user_name,
  total_shares, ownership_percent, committed_ugx, paid_ugx, outstanding_ugx, dividends_paid_ugx`;

export async function listShareholders(status?: string, search?: string): Promise<ShareholderRow[]> {
  const uid = await requireUser();
  return queryAsUser<ShareholderRow>(
    uid,
    `select ${SHAREHOLDER_COLUMNS} from public.shareholders
      where ($1::text is null or status = $1)
        and ($2::text is null or search_text like '%' || lower($2) || '%')
      order by shareholder_number
      limit 100`,
    [status && status !== 'all' ? status : null, search || null],
  );
}

export async function getShareholder(id: string): Promise<ShareholderRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<ShareholderRow>(
    uid, `select ${SHAREHOLDER_COLUMNS} from public.shareholders where id = $1`, [id]);
  return rows[0] ?? null;
}

/** The register: the ownership distribution, with no contact detail at all. */
export interface RegisterRow {
  shareholder_id: string;
  shareholder_number: string;
  shareholder_name: string;
  status: string;
  total_shares: number;
  ownership_percent: number;
  committed_ugx: number;
  paid_ugx: number;
  outstanding_ugx: number;
}

export async function listRegister(): Promise<RegisterRow[]> {
  const uid = await requireUser();
  return queryAsUser<RegisterRow>(
    uid, `select * from public.share_register order by total_shares desc, shareholder_number`);
}

export interface RegisterTotals {
  shareholder_count: number;
  active_count: number;
  holder_count: number;
  total_shares: number;
  total_committed_ugx: number;
  total_paid_ugx: number;
  outstanding_ugx: number;
  pending_approvals: number;
}

export async function registerTotals(): Promise<RegisterTotals | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<RegisterTotals>(uid, `select * from public.share_register_totals`);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* classes and holdings                                                        */
/* -------------------------------------------------------------------------- */

export interface ShareClassRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  value_per_share_ugx: number;
  active: boolean;
  issued_shares: number;
  committed_ugx: number;
  paid_ugx: number;
  outstanding_ugx: number;
}

export async function listShareClasses(): Promise<ShareClassRow[]> {
  const uid = await requireUser();
  return queryAsUser<ShareClassRow>(
    uid, `select * from public.share_classes order by active desc, code`);
}

export interface HoldingRow {
  shareholder_id: string;
  class_id: string;
  class_code: string;
  shareholder_name: string | null;
  shares: number;
  committed_ugx: number;
  paid_ugx: number;
  outstanding_ugx: number;
}

export async function listHoldings(shareholder: string): Promise<HoldingRow[]> {
  const uid = await requireUser();
  return queryAsUser<HoldingRow>(
    uid,
    `select * from public.shareholdings
      where shareholder_id = $1 and (shares > 0 or committed_ugx > 0) order by class_code`,
    [shareholder],
  );
}

/* -------------------------------------------------------------------------- */
/* the ownership ledger                                                        */
/* -------------------------------------------------------------------------- */

export interface ShareTransactionRow {
  id: string;
  transaction_number: string;
  type: string;
  status: string;
  applied: boolean;
  class_id: string;
  class_code: string;
  shares: number;
  adjustment_shares: number | null;
  value_per_share_ugx: number | null;
  committed_ugx: number | null;
  paid_ugx: number;
  outstanding_ugx: number;
  payment_status: string | null;
  lines: Array<Record<string, unknown>>;
  from_shareholder_id: string | null;
  to_shareholder_id: string | null;
  effective_date: string;
  acquisition_date: string | null;
  reference: string | null;
  notes: string | null;
  reason: string | null;
  reversal_of_type: string | null;
  reversal_of_number: string | null;
  reversed_by_number: string | null;
  reversal_reason: string | null;
  requested_by_name: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  rejected_by_name: string | null;
  decision_reason: string | null;
  created_at: string;
}

const TXN_COLUMNS = `
  id, transaction_number, type, status, applied, class_id, class_code, shares, adjustment_shares,
  value_per_share_ugx, committed_ugx, paid_ugx, outstanding_ugx, payment_status, lines,
  from_shareholder_id, to_shareholder_id, effective_date::text as effective_date,
  acquisition_date::text as acquisition_date, reference, notes, reason, reversal_of_type,
  reversal_of_number, reversed_by_number, reversal_reason, requested_by_name, approved_by_name,
  approved_at, rejected_by_name, decision_reason, created_at`;

export async function listShareTransactions(filter?: string): Promise<ShareTransactionRow[]> {
  const uid = await requireUser();
  return queryAsUser<ShareTransactionRow>(
    uid,
    `select ${TXN_COLUMNS} from public.share_transactions
      where ($1::text is null
             or ($1 = 'pending' and status = 'pending_approval')
             or ($1 <> 'pending' and type = $1))
      order by created_at desc limit 200`,
    [filter && filter !== 'all' ? filter : null],
  );
}

export async function getShareTransaction(id: string): Promise<ShareTransactionRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<ShareTransactionRow>(
    uid, `select ${TXN_COLUMNS} from public.share_transactions where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listShareTransactionsFor(shareholder: string): Promise<ShareTransactionRow[]> {
  const uid = await requireUser();
  return queryAsUser<ShareTransactionRow>(
    uid,
    `select ${TXN_COLUMNS} from public.share_transactions
      where $1 = any (shareholder_ids) order by effective_date desc, created_at desc limit 100`,
    [shareholder],
  );
}

/** The lines of one entry, with `sharesAfter` derived from the ledger. */
export interface TransactionLine {
  shareholder_id: string;
  shareholder_number: string;
  shareholder_name: string;
  delta_shares: number;
  committed_delta_ugx: number;
  shares_after: number | null;
}

export async function transactionLines(id: string): Promise<TransactionLine[]> {
  const uid = await requireUser();
  return queryAsUser<TransactionLine>(
    uid, `select * from app.share_transaction_lines($1)`, [id]);
}

export interface ContributionRow {
  id: string;
  contribution_number: string;
  shareholder_id: string;
  shareholder_name: string | null;
  class_code: string | null;
  share_transaction_id: string;
  share_transaction_number: string | null;
  amount_ugx: number;
  source: string;
  account_name: string | null;
  financial_transaction_number: string | null;
  payment_date: string;
  reference: string | null;
  status: string;
  reversal_reason: string | null;
  created_by_name: string | null;
  created_at: string;
}

const CONTRIBUTION_COLUMNS = `
  id, contribution_number, shareholder_id, shareholder_name, class_code, share_transaction_id,
  share_transaction_number, amount_ugx, source, account_name, financial_transaction_number,
  payment_date::text as payment_date, reference, status, reversal_reason, created_by_name, created_at`;

export async function listContributions(shareTransaction?: string): Promise<ContributionRow[]> {
  const uid = await requireUser();
  return queryAsUser<ContributionRow>(
    uid,
    `select ${CONTRIBUTION_COLUMNS} from public.share_contributions
      where ($1::uuid is null or share_transaction_id = $1)
      order by created_at desc limit 200`,
    [shareTransaction ?? null],
  );
}

/** Ownership as it stood at the end of an EAT day, from the ledger. */
export interface OwnershipRow {
  shareholder_id: string;
  shareholder_number: string;
  shareholder_name: string;
  shares: number;
  ownership_percent: number;
  total_shares: number;
  as_of: string;
}

export async function ownershipAsOf(date: string | null, classId?: string): Promise<OwnershipRow[]> {
  const uid = await requireUser();
  return queryAsUser<OwnershipRow>(
    uid, `select * from app.ownership_as_of($1::date, $2)`, [date, classId ?? null]);
}

/* -------------------------------------------------------------------------- */
/* dividends                                                                   */
/* -------------------------------------------------------------------------- */

export interface DividendRow {
  id: string;
  dividend_number: string;
  financial_period: string;
  declaration_date: string;
  record_date: string;
  payment_date: string | null;
  calculation_method: string;
  class_id: string | null;
  class_code: string | null;
  notes: string | null;
  status: string;
  total_distributable_ugx: number | null;
  dividend_per_share_ugx: number | null;
  per_share_rate: number | null;
  eligible_shares: number;
  eligible_shareholder_count: number;
  allocated_ugx: number;
  unallocated_ugx: number;
  allocation_count: number;
  payable_count: number;
  paid_ugx: number;
  paid_count: number;
  outstanding_ugx: number;
  record_locked: boolean;
  calculated_by_name: string | null;
  calculated_at: string | null;
  declared_by_name: string | null;
  declared_at: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  cancel_reason: string | null;
  returned_reason: string | null;
}

const DIVIDEND_COLUMNS = `
  id, dividend_number, financial_period, declaration_date::text as declaration_date,
  record_date::text as record_date, payment_date::text as payment_date, calculation_method,
  class_id, class_code, notes, status, total_distributable_ugx, dividend_per_share_ugx,
  per_share_rate, eligible_shares, eligible_shareholder_count, allocated_ugx, unallocated_ugx,
  allocation_count, payable_count, paid_ugx, paid_count, outstanding_ugx, record_locked,
  calculated_by_name, calculated_at, declared_by_name, declared_at, approved_by_name, approved_at,
  cancel_reason, returned_reason`;

export async function listDividends(status?: string): Promise<DividendRow[]> {
  const uid = await requireUser();
  return queryAsUser<DividendRow>(
    uid,
    `select ${DIVIDEND_COLUMNS} from public.dividends
      where ($1::text is null or status = $1) order by record_date desc, dividend_number desc`,
    [status && status !== 'all' ? status : null],
  );
}

export async function getDividend(id: string): Promise<DividendRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<DividendRow>(
    uid, `select ${DIVIDEND_COLUMNS} from public.dividends where id = $1`, [id]);
  return rows[0] ?? null;
}

export interface AllocationRow {
  id: string;
  allocation_number: string;
  dividend_id: string;
  dividend_number: string;
  shareholder_id: string;
  shareholder_number: string | null;
  shareholder_name: string | null;
  record_date: string;
  shares_at_record_date: number;
  total_shares_at_record_date: number;
  ownership_percent_at_record_date: number;
  dividend_per_share_ugx: number | null;
  per_share_rate: number | null;
  gross_ugx: number;
  deductions_ugx: number;
  net_ugx: number;
  payment_status: string;
  dividend_status: string;
  current: boolean;
  version: number;
  paid_at: string | null;
  account_name: string | null;
  financial_transaction_number: string | null;
  reversals: Array<Record<string, unknown>>;
}

export async function listAllocations(dividend: string): Promise<AllocationRow[]> {
  const uid = await requireUser();
  return queryAsUser<AllocationRow>(
    uid,
    `select id, allocation_number, dividend_id, dividend_number, shareholder_id, shareholder_number,
            shareholder_name, record_date::text as record_date, shares_at_record_date,
            total_shares_at_record_date, ownership_percent_at_record_date, dividend_per_share_ugx,
            per_share_rate, gross_ugx, deductions_ugx, net_ugx, payment_status, dividend_status,
            current, version, paid_at, account_name, financial_transaction_number, reversals
       from public.dividend_allocations
      where dividend_id = $1 and current
      order by shares_at_record_date desc, shareholder_number`,
    [dividend],
  );
}

export async function listAllocationsFor(shareholder: string): Promise<AllocationRow[]> {
  const uid = await requireUser();
  return queryAsUser<AllocationRow>(
    uid,
    `select id, allocation_number, dividend_id, dividend_number, shareholder_id, shareholder_number,
            shareholder_name, record_date::text as record_date, shares_at_record_date,
            total_shares_at_record_date, ownership_percent_at_record_date, dividend_per_share_ugx,
            per_share_rate, gross_ugx, deductions_ugx, net_ugx, payment_status, dividend_status,
            current, version, paid_at, account_name, financial_transaction_number, reversals
       from public.dividend_allocations
      where shareholder_id = $1 and current order by record_date desc`,
    [shareholder],
  );
}

/* -------------------------------------------------------------------------- */
/* self-service                                                                */
/* -------------------------------------------------------------------------- */

export interface MyShareholding {
  linked: boolean;
  shareholder?: {
    shareholderId: string;
    shareholderNumber: string;
    fullName: string;
    status: string;
    joinDate: string;
    totalShares: number;
    ownershipPercent: number;
    committedUgx: number;
    paidUgx: number;
    outstandingUgx: number;
    dividendsPaidUgx: number;
  };
  holdings?: Array<{
    classId: string;
    classCode: string;
    shares: number;
    committedUgx: number;
    paidUgx: number;
    outstandingUgx: number;
  }>;
  transactions?: Array<{
    transactionNumber: string;
    type: string;
    reversalOfType: string | null;
    status: string;
    classCode: string;
    effectiveDate: string;
    deltaShares: number | null;
  }>;
  contributions?: Array<{
    contributionNumber: string;
    amountUgx: number;
    status: string;
    paymentDate: string | null;
    source: string;
    classCode: string | null;
  }>;
  dividends?: Array<{
    allocationNumber: string;
    dividendNumber: string;
    financialPeriod: string;
    recordDate: string;
    sharesAtRecordDate: number;
    dividendPerShareUgx: number | null;
    grossUgx: number;
    deductionsUgx: number;
    netUgx: number;
    paymentStatus: string;
    paidAt: string | null;
  }>;
}

/**
 * The signed-in shareholder's OWN record.
 *
 * This is the only door: the tables themselves are closed to the shareholder
 * role, so a modified client cannot ask for anybody else's.
 */
export async function myShareholding(): Promise<MyShareholding> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ my_shareholding: MyShareholding }>(
    uid, `select app.my_shareholding() as my_shareholding`);
  return rows[0].my_shareholding;
}

/** The share and dividend policies, for the screens that show them. */
export async function ownershipPolicies(): Promise<{
  share: Record<string, boolean>;
  dividend: Record<string, boolean>;
}> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ share: Record<string, boolean>; dividend: Record<string, boolean> }>(
    uid, `select app.share_policy() as share, app.dividend_policy() as dividend`);
  return rows[0];
}

/** The people a shareholder record may be linked to. */
export async function listLinkableUsers(): Promise<Array<{ id: string; full_name: string; role: string }>> {
  const uid = await requireUser();
  return queryAsUser<{ id: string; full_name: string; role: string }>(
    uid,
    `select id, full_name, role from public.users where active order by full_name`,
  );
}
