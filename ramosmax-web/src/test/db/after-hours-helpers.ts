/**
 * Fixtures for the after-hours suites.
 *
 * Everything goes through the real functions: a manager authorises, the
 * worker opens their own session, the worker collects, somebody else counts.
 * A fixture that wrote a session or a custody entry directly would prove
 * nothing, because the whole point is what the server decides.
 */
import { becomeClient, becomeOwner, makeUser, type Session, SEED } from './harness';
import { requestId } from './billing-helpers';

/** A worker eligible for after-hours work: the permanent `after_hours.request`. */
export async function eligibleWorker(db: Session, extra: string[] = []): Promise<string> {
  return makeUser(db, { role: 'worker', permissions: ['after_hours.request', ...extra] });
}

/** A supervisor who may authorise. */
export async function supervisor(db: Session, extra: string[] = []): Promise<string> {
  return makeUser(db, {
    role: 'manager',
    permissions: ['after_hours.approve', 'after_hours.view', ...extra],
  });
}

export interface Authorization {
  authorization_id: string;
  authorization_number: string;
  granted: string[];
}

/** Authorises `staff` for the next `hours` hours. */
export async function authorize(
  db: Session,
  options: {
    staff: string;
    by: string;
    hours?: number;
    startsIn?: string;
    permissions?: string[] | null;
    floatUgx?: number | null;
    reason?: string;
  },
): Promise<Authorization> {
  await becomeClient(db, options.by);
  const { rows } = await db.query<Authorization>(
    `select * from app.authorize_after_hours(
       $1, now() + $2::interval, $3, $4, $5::timestamptz, $6::text[], $7::bigint)`,
    [
      options.staff,
      `${options.hours ?? 8} hours`,
      options.reason ?? 'Covering the evening shift',
      requestId('authorize'),
      options.startsIn ? `now() + ${options.startsIn}` : null,
      options.permissions ?? null,
      options.floatUgx ?? null,
    ],
  );
  await becomeOwner(db);
  return rows[0];
}

export interface OpenSession {
  session_id: string;
  session_number: string;
  opening_float_ugx: number;
}

/** The worker opens their own session. Nobody can open it for them. */
export async function openSession(db: Session, staff: string): Promise<OpenSession> {
  await becomeClient(db, staff);
  const { rows } = await db.query<OpenSession>(
    `select * from app.open_after_hours_session($1)`, [requestId('session')]);
  await becomeOwner(db);
  return { ...rows[0], opening_float_ugx: Number(rows[0].opening_float_ugx) };
}

export interface ClosedSession {
  session_id: string;
  status: string;
  expected_cash_ugx: number;
  handover_id: string | null;
  handover_number: string | null;
}

export async function closeSession(
  db: Session,
  session: string,
  by: string,
): Promise<ClosedSession> {
  await becomeClient(db, by);
  const { rows } = await db.query<ClosedSession>(
    `select * from app.close_after_hours_session($1)`, [session]);
  await becomeOwner(db);
  return { ...rows[0], expected_cash_ugx: Number(rows[0].expected_cash_ugx) };
}

/** The signed-in worker takes a payment on an open invoice. */
export async function collect(
  db: Session,
  options: { invoice: string; amount: number; method?: string; by: string; reference?: string },
): Promise<string | null> {
  await becomeClient(db, options.by);
  const method = options.method ?? 'cash';
  const error = await db.expectError(
    `select * from app.record_payment($1, $2, $3, $4, $5)`,
    [options.invoice, options.amount, method, requestId('collect'),
     method === 'cash' ? null : `REF-${Math.random().toString(36).slice(2, 8)}`],
  );
  await becomeOwner(db);
  return error;
}

export async function sessionRow(db: Session, id: string) {
  const { rows } = await db.query<Record<string, string>>(
    `select status, opening_float_ugx, cash_collected_ugx, non_cash_collected_ugx,
            cash_reversed_ugx, expected_cash_ugx, payment_count, intakes_created,
            invoices_created, jobs_completed, handover_status, post_close_reversals_ugx
       from public.after_hours_sessions where id = $1`, [id]);
  return rows[0];
}

export async function handoverRow(db: Session, id: string) {
  const { rows } = await db.query<Record<string, string>>(
    `select handover_number, status, expected_cash_ugx, declared_amount_ugx,
            actual_amount_ugx, difference_ugx, discrepancy_number, staff_uid
       from public.cash_handovers where id = $1`, [id]);
  return rows[0];
}

/** Every permission the person holds right now, as the server sees it. */
export async function permissionsOf(db: Session, uid: string): Promise<string[]> {
  const { rows } = await db.query<{ p: string[] }>(
    `select app.effective_permissions($1) as p`, [uid]);
  return rows[0].p;
}

export { becomeClient, becomeOwner, makeUser, requestId, SEED };
