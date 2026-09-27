import 'server-only';
import { queryAsUser } from './db';
import { sessionUserId } from './session';

/**
 * Reads for the Phase F screens: attendance, allowances, payroll and losses.
 *
 * Every query runs AS THE SIGNED-IN USER, so RLS decides what comes back. A
 * worker asking for payslips receives their own, and only once the payroll has
 * been paid; a manager holding workforce reports and nothing more receives
 * payroll totals and no individual's pay. The page never filters for security.
 */

async function requireUser(): Promise<string> {
  const id = await sessionUserId();
  if (!id) throw new Error('Not signed in.');
  return id;
}

export const currentUserId = requireUser;

/* -------------------------------------------------------------------------- */
/* policy                                                                      */
/* -------------------------------------------------------------------------- */

export interface PayrollPolicy {
  reportingTime: string;
  workingDays: number[];
  gracePeriodMinutes: number;
  lateThresholdMinutes: number;
  requireClockOut: boolean;
  allowanceOnNonWorkingDays: boolean;
  defaultDailyAllowanceUgx: number;
  allowanceEligibleRoles: string[];
  lateAllowancePolicy: 'full' | 'deduct' | 'reject';
  lateDeductionUgx: number;
  maxLateDeductionUgx: number;
  allowanceApprovalRequired: boolean;
  maxDeductionPercentOfGross: number;
  payrollRequiresAdminApproval: boolean;
}

export async function getPayrollPolicy(): Promise<PayrollPolicy> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ payroll_policy: PayrollPolicy }>(
    uid,
    `select app.payroll_policy() as payroll_policy`,
  );
  return rows[0].payroll_policy;
}

/** Today, as the business counts it (EAT), for a date input's default. */
export async function businessToday(): Promise<string> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ day: string }>(uid, `select app.eat_day()::text as day`);
  return rows[0].day;
}

/* -------------------------------------------------------------------------- */
/* attendance                                                                  */
/* -------------------------------------------------------------------------- */

export interface AttendanceRow {
  id: string;
  attendance_number: string;
  staff_uid: string;
  staff_name: string | null;
  staff_role: string | null;
  business_day: string;
  working_day: boolean;
  clock_in_at: string | null;
  clock_out_at: string | null;
  minutes_late: number;
  late: boolean;
  severely_late: boolean;
  arrival_status: string;
  status: string;
  verification_status: string;
  recorded_via: string;
  notes: string | null;
  verified_by_name: string | null;
  verified_at: string | null;
  rejection_reason: string | null;
  allowance_id: string | null;
  correction_count: number;
}

const ATTENDANCE_COLUMNS = `
  id, attendance_number, staff_uid, staff_name, staff_role, business_day::text as business_day,
  working_day, clock_in_at, clock_out_at, minutes_late, late, severely_late, arrival_status,
  status, verification_status, recorded_via, notes, verified_by_name, verified_at,
  rejection_reason, allowance_id, correction_count`;

export async function listAttendance(
  day: string | null,
  status?: string,
): Promise<AttendanceRow[]> {
  const uid = await requireUser();
  return queryAsUser<AttendanceRow>(
    uid,
    `select ${ATTENDANCE_COLUMNS} from public.attendance
      where business_day = coalesce($1::date, app.eat_day())
        and ($2::text is null or verification_status = $2)
      order by staff_name, attendance_number`,
    [day, status ?? null],
  );
}

export async function getAttendance(id: string): Promise<AttendanceRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<AttendanceRow>(
    uid,
    `select ${ATTENDANCE_COLUMNS} from public.attendance where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** One person's recent days, for the history screen and for "My attendance". */
export async function listAttendanceFor(staff: string, limit = 60): Promise<AttendanceRow[]> {
  const uid = await requireUser();
  return queryAsUser<AttendanceRow>(
    uid,
    `select ${ATTENDANCE_COLUMNS} from public.attendance
      where staff_uid = $1 order by business_day desc limit $2`,
    [staff, limit],
  );
}

export interface CorrectionRow {
  id: string;
  attendance_number: string;
  staff_name: string | null;
  business_day: string;
  previous_value: Record<string, unknown>;
  new_value: Record<string, unknown>;
  changed_fields: string[];
  reason: string;
  corrected_by_name: string | null;
  created_at: string;
}

export async function listCorrections(attendance: string): Promise<CorrectionRow[]> {
  const uid = await requireUser();
  return queryAsUser<CorrectionRow>(
    uid,
    `select id, attendance_number, staff_name, business_day::text as business_day,
            previous_value, new_value, changed_fields, reason, corrected_by_name, created_at
       from public.attendance_corrections where attendance_id = $1 order by created_at desc`,
    [attendance],
  );
}

/** The people whose attendance may be recorded. */
export interface StaffOption {
  id: string;
  full_name: string;
  staff_id: string | null;
  role: string;
}

export async function listStaff(): Promise<StaffOption[]> {
  const uid = await requireUser();
  return queryAsUser<StaffOption>(
    uid,
    `select id, full_name, staff_id, role from public.users
      where active and role <> 'shareholder' order by full_name`,
  );
}

/* -------------------------------------------------------------------------- */
/* allowances                                                                  */
/* -------------------------------------------------------------------------- */

export interface AllowanceRow {
  id: string;
  allowance_number: string;
  staff_uid: string;
  staff_name: string | null;
  attendance_number: string | null;
  business_day: string;
  late: boolean;
  severely_late: boolean;
  minutes_late: number;
  calculated_amount_ugx: number;
  suggested_decision: string | null;
  suggested_deduction_ugx: number | null;
  decision: string | null;
  deduction_ugx: number;
  approved_amount_ugx: number | null;
  proposed_decision: string | null;
  proposed_deduction_ugx: number | null;
  proposal_reason: string | null;
  status: string;
  paid_via: string | null;
  paid_at: string | null;
  payroll_number: string | null;
  rejection_reason: string | null;
}

const ALLOWANCE_COLUMNS = `
  id, allowance_number, staff_uid, staff_name, attendance_number,
  business_day::text as business_day, late, severely_late, minutes_late,
  calculated_amount_ugx, suggested_decision, suggested_deduction_ugx, decision, deduction_ugx,
  approved_amount_ugx, proposed_decision, proposed_deduction_ugx, proposal_reason,
  status, paid_via, paid_at, payroll_number, rejection_reason`;

export async function listAllowances(day: string | null, status?: string): Promise<AllowanceRow[]> {
  const uid = await requireUser();
  return queryAsUser<AllowanceRow>(
    uid,
    `select ${ALLOWANCE_COLUMNS} from public.worker_allowances
      where ($1::date is null or business_day = $1::date)
        and ($2::text is null or status = $2)
      order by business_day desc, staff_name`,
    [day, status ?? null],
  );
}

export async function listAllowancesFor(staff: string, limit = 60): Promise<AllowanceRow[]> {
  const uid = await requireUser();
  return queryAsUser<AllowanceRow>(
    uid,
    `select ${ALLOWANCE_COLUMNS} from public.worker_allowances
      where staff_uid = $1 order by business_day desc limit $2`,
    [staff, limit],
  );
}

/* -------------------------------------------------------------------------- */
/* salary                                                                      */
/* -------------------------------------------------------------------------- */

export interface SalaryProfileRow {
  staff_uid: string;
  staff_id: string | null;
  staff_name: string | null;
  staff_role: string | null;
  basic_salary_ugx: number;
  payment_frequency: string;
  allowance_eligible: boolean;
  allowance_amount_ugx: number | null;
  active: boolean;
  effective_from: string;
  version: number;
  updated_by_name: string | null;
  updated_at: string;
}

export async function listSalaryProfiles(): Promise<SalaryProfileRow[]> {
  const uid = await requireUser();
  return queryAsUser<SalaryProfileRow>(
    uid,
    `select staff_uid, staff_id, staff_name, staff_role, basic_salary_ugx, payment_frequency,
            allowance_eligible, allowance_amount_ugx, active, effective_from::text as effective_from,
            version, updated_by_name, updated_at
       from public.salary_profiles order by staff_name`,
  );
}

export interface SalaryVersionRow {
  id: string;
  staff_uid: string;
  staff_name: string | null;
  version: number;
  basic_salary_ugx: number;
  payment_frequency: string;
  allowance_eligible: boolean;
  allowance_amount_ugx: number | null;
  active: boolean;
  effective_from: string;
  reason: string | null;
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
}

export async function listSalaryHistory(staff: string): Promise<SalaryVersionRow[]> {
  const uid = await requireUser();
  return queryAsUser<SalaryVersionRow>(
    uid,
    `select id, staff_uid, staff_name, version, basic_salary_ugx, payment_frequency,
            allowance_eligible, allowance_amount_ugx, active, effective_from::text as effective_from,
            reason, notes, created_by_name, created_at
       from public.salary_history where staff_uid = $1 order by effective_from desc, version desc`,
    [staff],
  );
}

/* -------------------------------------------------------------------------- */
/* payroll                                                                     */
/* -------------------------------------------------------------------------- */

export interface PayrollRow {
  id: string;
  payroll_number: string;
  frequency: string;
  period_key: string;
  period_label: string;
  period_start: string;
  period_end: string;
  status: string;
  version: number;
  employee_count: number;
  total_basic_ugx: number;
  total_allowances_ugx: number;
  total_other_earnings_ugx: number;
  total_gross_ugx: number;
  total_deductions_ugx: number;
  total_loss_recoveries_ugx: number;
  total_net_ugx: number;
  prepared_by_name: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  returned_reason: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  paid_by_name: string | null;
  paid_at: string | null;
  paid_from_account_name: string | null;
  financial_transaction_number: string | null;
  locked_at: string | null;
  cancel_reason: string | null;
}

const PAYROLL_COLUMNS = `
  id, payroll_number, frequency, period_key, period_label,
  period_start::text as period_start, period_end::text as period_end, status, version,
  employee_count, total_basic_ugx, total_allowances_ugx, total_other_earnings_ugx,
  total_gross_ugx, total_deductions_ugx, total_loss_recoveries_ugx, total_net_ugx,
  prepared_by_name, reviewed_by_name, reviewed_at, review_notes, returned_reason,
  approved_by_name, approved_at, paid_by_name, paid_at, paid_from_account_name,
  financial_transaction_number, locked_at, cancel_reason`;

export async function listPayrolls(status?: string): Promise<PayrollRow[]> {
  const uid = await requireUser();
  return queryAsUser<PayrollRow>(
    uid,
    `select ${PAYROLL_COLUMNS} from public.payroll
      where ($1::text is null or status = $1) order by period_start desc, payroll_number desc`,
    [status ?? null],
  );
}

export async function getPayroll(id: string): Promise<PayrollRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<PayrollRow>(
    uid,
    `select ${PAYROLL_COLUMNS} from public.payroll where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface PayslipRow {
  id: string;
  item_number: string;
  payroll_id: string;
  payroll_number: string;
  period_label: string;
  staff_uid: string;
  staff_name: string | null;
  staff_role: string | null;
  salary_version: number;
  salary_active: boolean;
  basic_salary_ugx: number;
  allowances_ugx: number;
  allowance_days: number;
  other_earnings_ugx: number;
  gross_ugx: number;
  salary_deductions_ugx: number;
  loss_recoveries_ugx: number;
  other_deductions_ugx: number;
  total_deductions_ugx: number;
  deduction_capped: boolean;
  net_ugx: number;
  deduction_lines: Array<Record<string, unknown>>;
  other_earnings: Array<Record<string, unknown>>;
  status: string;
  payment_status: string;
  paid_at: string | null;
  visible_to_staff: boolean;
}

const PAYSLIP_COLUMNS = `
  id, item_number, payroll_id, payroll_number, period_label, staff_uid, staff_name, staff_role,
  salary_version, salary_active, basic_salary_ugx, allowances_ugx, allowance_days,
  other_earnings_ugx, gross_ugx, salary_deductions_ugx, loss_recoveries_ugx, other_deductions_ugx,
  total_deductions_ugx, deduction_capped, net_ugx, deduction_lines, other_earnings,
  status, payment_status, paid_at, visible_to_staff`;

export async function listPayslips(payroll: string): Promise<PayslipRow[]> {
  const uid = await requireUser();
  return queryAsUser<PayslipRow>(
    uid,
    `select ${PAYSLIP_COLUMNS} from public.payroll_items
      where payroll_id = $1 and current order by staff_name`,
    [payroll],
  );
}

/** "My payslips": whatever RLS lets this person see of their own pay. */
export async function listMyPayslips(): Promise<PayslipRow[]> {
  const uid = await requireUser();
  return queryAsUser<PayslipRow>(
    uid,
    `select ${PAYSLIP_COLUMNS} from public.payroll_items
      where staff_uid = $1 and current order by period_start desc`,
    [uid],
  );
}

export interface EarningRow {
  id: string;
  payroll_id: string;
  staff_uid: string;
  staff_name: string | null;
  description: string;
  amount_ugx: number;
  reason: string | null;
  added_at: string;
  removed_at: string | null;
}

export async function listEarnings(payroll: string): Promise<EarningRow[]> {
  const uid = await requireUser();
  return queryAsUser<EarningRow>(
    uid,
    `select e.id, e.payroll_id, e.staff_uid, u.full_name as staff_name, e.description,
            e.amount_ugx, e.reason, e.added_at, e.removed_at
       from public.payroll_earnings e
       left join public.users u on u.id = e.staff_uid
      where e.payroll_id = $1 order by e.added_at desc`,
    [payroll],
  );
}

/** Workforce reporting: totals, and no individual's pay. */
export interface PayrollTotalsRow {
  id: string;
  payroll_number: string;
  period_label: string;
  status: string;
  employee_count: number;
  total_gross_ugx: number;
  total_allowances_ugx: number;
  total_deductions_ugx: number;
  total_net_ugx: number;
  paid_at: string | null;
}

export async function listPayrollTotals(): Promise<PayrollTotalsRow[]> {
  const uid = await requireUser();
  return queryAsUser<PayrollTotalsRow>(
    uid,
    `select id, payroll_number, period_label, status, employee_count, total_gross_ugx,
            total_allowances_ugx, total_deductions_ugx, total_net_ugx, paid_at
       from public.payroll_report_totals order by period_start desc`,
  );
}

/* -------------------------------------------------------------------------- */
/* losses and deductions                                                       */
/* -------------------------------------------------------------------------- */

export interface LossRow {
  id: string;
  loss_number: string;
  staff_uid: string | null;
  staff_name: string | null;
  incident_type: string;
  incident_date: string;
  amount_ugx: number;
  description: string;
  notes: string | null;
  status: string;
  visible_to_staff: boolean;
  reported_by_name: string | null;
  reviewed_by_name: string | null;
  review_notes: string | null;
  approved_by_name: string | null;
  approved_recovery_ugx: number;
  recovery_reason: string | null;
  rejection_reason: string | null;
  recovered_ugx: number;
  outstanding_ugx: number;
  deduction_number: string | null;
  cancel_reason: string | null;
  created_at: string;
}

const LOSS_COLUMNS = `
  id, loss_number, staff_uid, staff_name, incident_type, incident_date::text as incident_date,
  amount_ugx, description, notes, status, visible_to_staff, reported_by_name, reviewed_by_name,
  review_notes, approved_by_name, approved_recovery_ugx, recovery_reason, rejection_reason,
  recovered_ugx, outstanding_ugx, deduction_number, cancel_reason, created_at`;

export async function listLosses(status?: string): Promise<LossRow[]> {
  const uid = await requireUser();
  return queryAsUser<LossRow>(
    uid,
    `select ${LOSS_COLUMNS} from public.loss_incidents
      where ($1::text is null or status = $1) order by created_at desc`,
    [status ?? null],
  );
}

export async function getLoss(id: string): Promise<LossRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<LossRow>(
    uid,
    `select ${LOSS_COLUMNS} from public.loss_incidents where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** What the business is still owed, across every live incident. */
export async function outstandingLossTotal(): Promise<number> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ total: string }>(
    uid,
    `select coalesce(sum(outstanding_ugx), 0)::text as total from public.loss_incidents
      where status in ('approved', 'recovery_scheduled', 'partially_recovered')`,
  );
  return Number(rows[0]?.total ?? 0);
}

export interface DeductionRow {
  id: string;
  deduction_number: string;
  staff_uid: string;
  staff_name: string | null;
  type: string;
  reason: string;
  reference: string | null;
  loss_number: string | null;
  total_amount_ugx: number;
  instalment_ugx: number;
  recovered_ugx: number;
  remaining_ugx: number;
  starts_from: string;
  status: string;
  approved_by_name: string | null;
  rejection_reason: string | null;
  cancel_reason: string | null;
  created_by_name: string | null;
  created_at: string;
}

const DEDUCTION_COLUMNS = `
  id, deduction_number, staff_uid, staff_name, type, reason, reference, loss_number,
  total_amount_ugx, instalment_ugx, recovered_ugx, remaining_ugx,
  starts_from::text as starts_from, status, approved_by_name, rejection_reason, cancel_reason,
  created_by_name, created_at`;

export async function listDeductions(status?: string): Promise<DeductionRow[]> {
  const uid = await requireUser();
  return queryAsUser<DeductionRow>(
    uid,
    `select ${DEDUCTION_COLUMNS} from public.salary_deductions
      where ($1::text is null or status = $1) order by created_at desc`,
    [status ?? null],
  );
}

export async function listDeductionsFor(staff: string): Promise<DeductionRow[]> {
  const uid = await requireUser();
  return queryAsUser<DeductionRow>(
    uid,
    `select ${DEDUCTION_COLUMNS} from public.salary_deductions
      where staff_uid = $1 order by created_at desc`,
    [staff],
  );
}

/** The incidents about ME that have been decided, for "My pay". */
export async function listMyLosses(): Promise<LossRow[]> {
  const uid = await requireUser();
  return queryAsUser<LossRow>(
    uid,
    `select ${LOSS_COLUMNS} from public.loss_incidents
      where staff_uid = $1 order by created_at desc`,
    [uid],
  );
}
