/**
 * Fixtures for the ownership suites.
 *
 * Everything goes through the real functions: a class is created by an
 * Administrator, shares are issued and approved by the people who may. A
 * fixture that writes a holding directly would prove nothing, because the
 * holdings are DERIVED from the ledger.
 */
import { asAdminDb, becomeClient, becomeOwner, makeUser, type Session, SEED } from './harness';
import { requestId } from './billing-helpers';
import { accountId } from './finance-helpers';

/**
 * A share class. Nothing is hard-coded: the business creates its own.
 *
 * The committing suites leave their class behind, so this creates one only
 * when it is missing.
 */
export async function shareClass(
  db: Session,
  code = 'ORDINARY',
  valuePerShareUgx = 100_000,
): Promise<string> {
  const id = code.toLowerCase();
  const { rows: existing } = await db.query<{ id: string }>(
    `select id from public.share_classes where id = $1`, [id]);
  if (existing.length > 0) return id;
  await becomeClient(db, SEED.admin);
  await db.query(`select app.create_share_class($1, $2, $3)`,
    [code, `${code} shares`, valuePerShareUgx]);
  await becomeOwner(db);
  return id;
}

/**
 * A day on which an ownership change may take effect.
 *
 * A calculated dividend locks ownership on and before its record date, and a
 * paid one keeps that lock. The committing suites leave such locks behind, so
 * a fixture works from the first open day.
 */
export const testClassCode = () => `T${Math.floor(Math.random() * 90000000) + 10000000}`;

export async function openDay(db: Session, offset = 0): Promise<string> {
  const { rows } = await db.query<{ d: string }>(
    `select least(coalesce(app.locked_record_date() + 1 + $1::int, app.eat_day() - 400 + $1::int),
                  app.eat_day())::text as d`, [offset]);
  return rows[0].d;
}

export async function shareholder(db: Session, name: string, phone?: string): Promise<string> {
  await becomeClient(db, SEED.admin);
  const { rows } = await db.query<{ shareholder_id: string }>(
    `select * from app.create_shareholder($1, $2, $3)`,
    [name, requestId('shareholder'), phone ?? null]);
  await becomeOwner(db);
  return rows[0].shareholder_id;
}

/** Turns second-person approval ON, for tests that are about approval. */
export async function requireApproval(db: Session): Promise<void> {
  await becomeClient(db, SEED.admin);
  await db.expectError(`select app.update_shareholding_policy('share', $1::jsonb, 'Test setup')`,
    [JSON.stringify({ requireApproval: true })]);
  await becomeOwner(db);
}

/**
 * Turns second-person approval off, for tests that are not about approval.
 * Safe to call twice: an unchanged policy is refused, which is not a failure.
 */
export async function autoPost(db: Session): Promise<void> {
  await becomeClient(db, SEED.admin);
  await db.expectError(`select app.update_shareholding_policy('share', $1::jsonb, 'Test setup')`,
    [JSON.stringify({ requireApproval: false })]);
  await becomeOwner(db);
}

/** Allows a commitment to stand unpaid, for tests about outstanding money. */
export async function allowUnpaid(db: Session): Promise<void> {
  await becomeClient(db, SEED.admin);
  await db.expectError(`select app.update_shareholding_policy('share', $1::jsonb, 'Test setup')`,
    [JSON.stringify({ allowUnpaidShares: true, allowPartialPayment: true })]);
  await becomeOwner(db);
}

export interface IssueResult {
  transaction_id: string;
  transaction_number: string;
  status: string;
  committed_ugx: number;
  paid_ugx: number;
  outstanding_ugx: number;
}

/** Issues shares, paying from an account unless told otherwise. */
export async function issue(
  db: Session,
  options: {
    shareholder: string;
    classId?: string;
    shares: number;
    account?: string | null;
    source?: 'account' | 'prior_record' | 'none';
    amount?: number | null;
    effective?: string | null;
    by?: string;
  },
): Promise<IssueResult> {
  await becomeClient(db, options.by ?? SEED.admin);
  const { rows } = await db.query<IssueResult>(
    `select * from app.issue_shares($1, $2, $3, $4, $5::date, $6, $7, $8)`,
    [
      options.shareholder,
      options.classId ?? 'ordinary',
      options.shares,
      requestId('issue'),
      options.effective ?? null,
      options.source ?? 'account',
      options.amount ?? null,
      options.account ?? null,
    ],
  );
  await becomeOwner(db);
  return {
    ...rows[0],
    committed_ugx: Number(rows[0].committed_ugx),
    paid_ugx: Number(rows[0].paid_ugx),
    outstanding_ugx: Number(rows[0].outstanding_ugx),
  };
}

/** An account holding [amount], of its own. */
export async function ownAccount(db: Session, amount = 50_000_000): Promise<string> {
  await becomeClient(db, SEED.admin);
  const { rows } = await db.query<{ id: string }>(
    `select app.create_financial_account($1, 'bank', 'Test Bank') as id`,
    [`Capital ${Math.random().toString(36).slice(2, 8)}`]);
  if (amount > 0) {
    await db.query(`select * from app.record_opening_balance($1, $2, 'Test float')`,
      [rows[0].id, amount]);
  }
  await becomeOwner(db);
  return rows[0].id;
}

export async function holdingOf(db: Session, staff: string, classId = 'ordinary') {
  const { rows } = await db.query<Record<string, string>>(
    `select * from public.shareholdings where shareholder_id = $1 and class_id = $2`,
    [staff, classId]);
  return rows[0] ?? null;
}

export async function shareholderRow(db: Session, id: string) {
  const { rows } = await db.query<Record<string, string | null>>(
    `select * from public.shareholders where id = $1`, [id]);
  return rows[0];
}

export const ugx = (v: unknown): number => Number(v ?? 0);

export { asAdminDb, becomeClient, becomeOwner, makeUser, requestId, SEED, accountId };
