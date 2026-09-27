import 'server-only';
import { queryAsUser } from './db';
import { sessionUserId } from './session';

/**
 * Reads for the after-hours screens.
 *
 * Every query runs AS THE SIGNED-IN USER, so RLS decides what comes back. A
 * worker asking for the sessions list receives their own and nothing else;
 * their own record is served by `myAfterHours()`, which the database builds
 * from their sign-in. The page never filters for security.
 */

async function requireUser(): Promise<string> {
  const id = await sessionUserId();
  if (!id) throw new Error('Not signed in.');
  return id;
}

/* -------------------------------------------------------------------------- */
/* authorisations                                                              */
/* -------------------------------------------------------------------------- */

export interface AuthorizationRow {
  id: string;
  authorization_number: string;
  staff_uid: string;
  staff_name: string;
  staff_role: string;
  starts_at: string;
  expires_at: string;
  reason: string;
  permissions: string[];
  granted: string[];
  opening_float_ugx: number;
  float_taken: boolean;
  status: string;
  live: boolean;
  granted_by_name: string | null;
  revoked_by_name: string | null;
  revoke_reason: string | null;
  session_count: number;
}

const AUTHORIZATION_COLUMNS = `
  a.id, a.authorization_number, a.staff_uid, a.staff_name, a.staff_role,
  a.starts_at, a.expires_at, a.reason, a.permissions, a.granted, a.opening_float_ugx,
  a.float_session_id is not null as float_taken, a.status,
  (a.status = 'active' and a.starts_at <= now() and a.expires_at > now()) as live,
  a.granted_by_name, a.revoked_by_name, a.revoke_reason,
  (select count(*)::int from public.after_hours_sessions s where s.authorization_id = a.id)
    as session_count`;

export async function listAuthorizations(filter?: string): Promise<AuthorizationRow[]> {
  const uid = await requireUser();
  return queryAsUser<AuthorizationRow>(
    uid,
    `select ${AUTHORIZATION_COLUMNS} from public.after_hours_access a
      where case $1::text
              when 'live' then a.status = 'active' and a.starts_at <= now() and a.expires_at > now()
              when 'ended' then not (a.status = 'active' and a.expires_at > now())
              else true end
      order by a.starts_at desc limit 200`,
    [filter && filter !== 'all' ? filter : null],
  );
}

/* -------------------------------------------------------------------------- */
/* sessions                                                                    */
/* -------------------------------------------------------------------------- */

export interface SessionRow {
  id: string;
  session_number: string;
  staff_uid: string;
  staff_name: string;
  authorization_number: string;
  authorization_expires_at: string;
  supervisor_name: string | null;
  status: string;
  opened_at: string;
  closed_at: string | null;
  closed_by_name: string | null;
  close_notes: string | null;
  cancel_reason: string | null;
  opening_float_ugx: number;
  cash_collected_ugx: number;
  non_cash_collected_ugx: number;
  cash_reversed_ugx: number;
  post_close_reversals_ugx: number;
  payment_count: number;
  reversal_count: number;
  expected_cash_ugx: number;
  intakes_created: number;
  invoices_created: number;
  jobs_completed: number;
  handover_id: string | null;
  handover_number: string | null;
  handover_status: string | null;
  actual_received_ugx: number | null;
  difference_ugx: number | null;
  notes: string | null;
}

const SESSION_COLUMNS = `
  id, session_number, staff_uid, staff_name, authorization_number, authorization_expires_at,
  supervisor_name, status, opened_at, closed_at, closed_by_name, close_notes, cancel_reason,
  opening_float_ugx, cash_collected_ugx, non_cash_collected_ugx, cash_reversed_ugx,
  post_close_reversals_ugx, payment_count, reversal_count, expected_cash_ugx, intakes_created,
  invoices_created, jobs_completed, handover_id, handover_number, handover_status,
  actual_received_ugx, difference_ugx, notes`;

export async function listSessions(status?: string): Promise<SessionRow[]> {
  const uid = await requireUser();
  return queryAsUser<SessionRow>(
    uid,
    `select ${SESSION_COLUMNS} from public.after_hours_sessions
      where ($1::text is null or status = $1) order by opened_at desc limit 200`,
    [status && status !== 'all' ? status : null],
  );
}

export async function getSession(id: string): Promise<SessionRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<SessionRow>(
    uid, `select ${SESSION_COLUMNS} from public.after_hours_sessions where id = $1`, [id]);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* custody                                                                     */
/* -------------------------------------------------------------------------- */

export interface CustodyRow {
  id: string;
  entry_number: string;
  kind: string;
  method: string | null;
  amount_ugx: number;
  cash_delta_ugx: number;
  affects_expected: boolean;
  after_session_closed: boolean;
  receipt_number: string | null;
  invoice_number: string | null;
  number_plate: string | null;
  reason: string | null;
  created_at: string;
}

export async function listCustody(session: string): Promise<CustodyRow[]> {
  const uid = await requireUser();
  return queryAsUser<CustodyRow>(
    uid,
    `select id, entry_number, kind, method, amount_ugx, cash_delta_ugx, affects_expected,
            after_session_closed, receipt_number, invoice_number, number_plate, reason, created_at
       from public.after_hours_cash where session_id = $1 order by created_at`,
    [session],
  );
}

/* -------------------------------------------------------------------------- */
/* handovers                                                                   */
/* -------------------------------------------------------------------------- */

export interface HandoverRow {
  id: string;
  handover_number: string;
  session_id: string;
  session_number: string;
  staff_uid: string;
  staff_name: string;
  opening_float_ugx: number;
  cash_collected_ugx: number;
  cash_reversed_ugx: number;
  non_cash_collected_ugx: number;
  payment_count: number;
  expected_cash_ugx: number;
  declared_amount_ugx: number | null;
  actual_amount_ugx: number | null;
  difference_ugx: number | null;
  status: string;
  destination_account: string;
  submitted_by_name: string | null;
  submitted_at: string | null;
  submit_notes: string | null;
  received_by_name: string | null;
  received_at: string | null;
  receive_notes: string | null;
  explanation: string | null;
  discrepancy_id: string | null;
  discrepancy_number: string | null;
  reconciled_at: string | null;
  created_at: string;
}

const HANDOVER_COLUMNS = `
  id, handover_number, session_id, session_number, staff_uid, staff_name, opening_float_ugx,
  cash_collected_ugx, cash_reversed_ugx, non_cash_collected_ugx, payment_count,
  expected_cash_ugx, declared_amount_ugx, actual_amount_ugx, difference_ugx, status,
  destination_account, submitted_by_name, submitted_at, submit_notes, received_by_name,
  received_at, receive_notes, explanation, discrepancy_id, discrepancy_number, reconciled_at,
  created_at`;

export async function listHandovers(status?: string): Promise<HandoverRow[]> {
  const uid = await requireUser();
  return queryAsUser<HandoverRow>(
    uid,
    `select ${HANDOVER_COLUMNS} from public.cash_handovers
      where case $1::text
              when 'outstanding' then status in ('pending', 'submitted')
              when 'all' then true
              else status = $1 end
      order by created_at desc limit 200`,
    [status ?? 'all'],
  );
}

export async function getHandover(id: string): Promise<HandoverRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<HandoverRow>(
    uid, `select ${HANDOVER_COLUMNS} from public.cash_handovers where id = $1`, [id]);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* discrepancies                                                               */
/* -------------------------------------------------------------------------- */

export interface DiscrepancyRow {
  id: string;
  discrepancy_number: string;
  handover_id: string;
  handover_number: string;
  session_id: string;
  session_number: string;
  staff_uid: string;
  staff_name: string;
  expected_cash_ugx: number;
  declared_amount_ugx: number | null;
  actual_amount_ugx: number;
  difference_ugx: number;
  kind: string;
  reason: string;
  reported_by_name: string | null;
  reported_at: string;
  status: string;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  outcome: string | null;
  resolution: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  loss_number: string | null;
  loss_incident_id: string | null;
  adjustment_transaction_number: string | null;
}

const DISCREPANCY_COLUMNS = `
  id, discrepancy_number, handover_id, handover_number, session_id, session_number, staff_uid,
  staff_name, expected_cash_ugx, declared_amount_ugx, actual_amount_ugx, difference_ugx, kind,
  reason, reported_by_name, reported_at, status, reviewed_by_name, reviewed_at, review_notes,
  outcome, resolution, resolved_by_name, resolved_at, loss_number, loss_incident_id,
  adjustment_transaction_number`;

export async function listDiscrepancies(status?: string): Promise<DiscrepancyRow[]> {
  const uid = await requireUser();
  return queryAsUser<DiscrepancyRow>(
    uid,
    `select ${DISCREPANCY_COLUMNS} from public.cash_discrepancies
      where case $1::text
              when 'open' then status in ('open', 'under_review')
              when 'closed' then status in ('resolved', 'waived')
              else true end
      order by reported_at desc limit 200`,
    [status && status !== 'all' ? status : null],
  );
}

export async function getDiscrepancy(id: string): Promise<DiscrepancyRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<DiscrepancyRow>(
    uid, `select ${DISCREPANCY_COLUMNS} from public.cash_discrepancies where id = $1`, [id]);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* the dashboard and the reports tab                                           */
/* -------------------------------------------------------------------------- */

export interface AfterHoursOverview {
  live_authorizations: number;
  open_sessions: number;
  handovers_to_receive: number;
  open_discrepancies: number;
}

export async function overview(): Promise<AfterHoursOverview> {
  const uid = await requireUser();
  const rows = await queryAsUser<AfterHoursOverview>(
    uid,
    `select
       (select count(*)::int from public.after_hours_access
         where status = 'active' and starts_at <= now() and expires_at > now())
         as live_authorizations,
       (select count(*)::int from public.after_hours_sessions where status = 'open')
         as open_sessions,
       (select count(*)::int from public.cash_handovers where status in ('pending', 'submitted'))
         as handovers_to_receive,
       (select count(*)::int from public.cash_discrepancies
         where status in ('open', 'under_review')) as open_discrepancies`,
  );
  return rows[0];
}

export interface HandoverTotals {
  staff_uid: string;
  staff_name: string;
  handovers: number;
  expected_ugx: number;
  received_ugx: number;
  shortage_ugx: number;
  excess_ugx: number;
}

/**
 * Expected against received, by worker.
 *
 * Only handovers that have actually been counted are summed: a handover
 * nobody has received yet has no "received" figure to report.
 */
export async function handoverTotals(from?: string, to?: string): Promise<HandoverTotals[]> {
  const uid = await requireUser();
  return queryAsUser<HandoverTotals>(
    uid,
    `select h.staff_uid, h.staff_name,
            count(*)::int as handovers,
            coalesce(sum(h.expected_cash_ugx), 0)::bigint as expected_ugx,
            coalesce(sum(h.actual_amount_ugx), 0)::bigint as received_ugx,
            coalesce(sum(-h.difference_ugx) filter (where h.difference_ugx < 0), 0)::bigint
              as shortage_ugx,
            coalesce(sum(h.difference_ugx) filter (where h.difference_ugx > 0), 0)::bigint
              as excess_ugx
       from public.cash_handovers h
      where h.actual_amount_ugx is not null
        and ($1::date is null or h.created_at >= app.eat_day_start($1::date))
        and ($2::date is null or h.created_at < app.eat_day_start($2::date) + interval '1 day')
      group by h.staff_uid, h.staff_name
      order by shortage_ugx desc, h.staff_name`,
    [from ?? null, to ?? null],
  );
}

/* -------------------------------------------------------------------------- */
/* self-service                                                                */
/* -------------------------------------------------------------------------- */

export interface MyAfterHours {
  authorization: {
    authorizationId: string;
    authorizationNumber: string;
    startsAt: string;
    expiresAt: string;
    permissions: string[];
    openingFloatUgx: number;
    floatTaken: boolean;
    supervisorName: string | null;
  } | null;
  session: {
    sessionId: string;
    sessionNumber: string;
    openedAt: string;
    openingFloatUgx: number;
    cashCollectedUgx: number;
    nonCashCollectedUgx: number;
    cashReversedUgx: number;
    expectedCashUgx: number;
    paymentCount: number;
    intakesCreated: number;
    invoicesCreated: number;
    jobsCompleted: number;
    authorizationExpiresAt: string;
  } | null;
  custody: Array<{
    entryNumber: string;
    kind: string;
    method: string | null;
    amountUgx: number;
    cashDeltaUgx: number;
    receiptNumber: string | null;
    numberPlate: string | null;
    createdAt: string;
  }>;
  handovers: Array<{
    handoverId: string;
    handoverNumber: string;
    sessionNumber: string;
    expectedCashUgx: number;
    declaredAmountUgx: number | null;
    actualAmountUgx: number | null;
    differenceUgx: number | null;
    status: string;
    createdAt: string;
  }>;
  discrepancies: Array<{
    discrepancyId: string;
    discrepancyNumber: string;
    kind: string;
    differenceUgx: number;
    status: string;
    outcome: string | null;
    reason: string;
    resolution: string | null;
    reportedAt: string;
  }>;
  sessions: Array<{
    sessionId: string;
    sessionNumber: string;
    status: string;
    openedAt: string;
    closedAt: string | null;
    expectedCashUgx: number;
    actualReceivedUgx: number | null;
    differenceUgx: number | null;
  }>;
}

/**
 * The signed-in worker's OWN after-hours record.
 *
 * This is the only door: the tables are closed to everybody else's rows, and
 * the expected cash arrives as a number to read — never a field to fill in.
 */
export async function myAfterHours(): Promise<MyAfterHours> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ mine: MyAfterHours }>(
    uid, `select app.my_after_hours() as mine`);
  return rows[0].mine;
}

/** The after-hours policy, for the screens that show it. */
export async function afterHoursPolicy(): Promise<{
  allowedPaymentMethods: string[];
  maxAuthorizationHours: number;
  maxOpeningFloatUgx: number;
}> {
  const uid = await requireUser();
  const rows = await queryAsUser<{
    p: { allowedPaymentMethods: string[]; maxAuthorizationHours: number; maxOpeningFloatUgx: number };
  }>(uid, `select app.after_hours_policy() as p`);
  return rows[0].p;
}

/** Everything an authorisation may hand out, in catalogue order. */
export async function grantableAfterHours(): Promise<{ all: string[]; defaults: string[] }> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ all: string[]; defaults: string[] }>(
    uid, `select app.after_hours_grantable() as all, app.after_hours_default_grants() as defaults`);
  return rows[0];
}

/** The people who may be put on an after-hours shift. */
export async function listEligibleStaff(): Promise<Array<{ id: string; full_name: string; role: string }>> {
  const uid = await requireUser();
  return queryAsUser<{ id: string; full_name: string; role: string }>(
    uid,
    `select id, full_name, role from app.after_hours_eligible_staff()`,
  );
}

/**
 * The caller's own after-hours standing at the till.
 *
 * The payment screen asks this so it can offer the right methods and say
 * where the cash is going. It decides nothing: `record_payment` re-checks the
 * session, the window and the method itself.
 */
export interface PaymentContext {
  sessionId: string | null;
  sessionNumber: string | null;
  live: boolean;
  methods: string[];
}

export async function paymentContext(): Promise<PaymentContext> {
  const uid = await requireUser();
  const rows = await queryAsUser<{
    session_id: string | null; session_number: string | null; live: boolean | null;
    methods: string[];
  }>(
    uid,
    `select c.session_id, c.session_number, c.live, app.after_hours_methods() as methods
       from (select 1) one left join app.after_hours_context() c on true`,
  );
  const row = rows[0];
  return {
    sessionId: row?.session_id ?? null,
    sessionNumber: row?.session_number ?? null,
    live: row?.live ?? false,
    methods: row?.methods ?? [],
  };
}
