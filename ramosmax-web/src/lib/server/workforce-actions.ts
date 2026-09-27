'use server';

import { revalidatePath } from 'next/cache';
import { callRpc } from './operations';
import type { ActionResult } from './operations-actions';

/**
 * Server Actions for attendance, allowances, payroll and losses.
 *
 * Each forwards to ONE SECURITY DEFINER function and returns what the database
 * said. No lateness, allowance, gross, deduction, net or total is decided
 * here: where pay is concerned a Server Action is as untrusted as the browser
 * it was called from.
 */

async function run(fn: string, params: unknown[], revalidate: string[]): Promise<ActionResult> {
  try {
    const rows = await callRpc<Record<string, unknown>>(fn, params);
    for (const path of revalidate) revalidatePath(path);
    const first = rows[0] ? Object.values(rows[0])[0] : undefined;
    return { ok: true, id: typeof first === 'string' ? first : undefined };
  } catch (e) {
    return {
      ok: false,
      message: ((e as Error).message ?? 'Something went wrong.').replace(/^error:\s*/i, ''),
    };
  }
}

const text = (form: FormData, key: string): string | null => {
  const value = form.get(key);
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
};

const money = (form: FormData, key: string): number | null => {
  const value = text(form, key);
  if (value === null) return null;
  const digits = value.replace(/[\s,]/g, '');
  return /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
};

const flag = (form: FormData, key: string): boolean | null => {
  const value = form.get(key);
  if (value == null || value === '') return null;
  return value === 'true' || value === 'on';
};

const ids = (form: FormData, key: string): string[] =>
  form
    .getAll(key)
    .map((v) => String(v))
    .filter((v) => v !== '');

/**
 * A local time typed on a form (HH:MM) against a business day, sent as an
 * instant in Kampala. The server still decides whether it is late.
 */
const eatInstant = (form: FormData, day: string | null, key: string): string | null => {
  const time = text(form, key);
  if (day === null || time === null) return null;
  return `${day}T${time.length === 5 ? `${time}:00` : time}+03:00`;
};

const ATTENDANCE = ['/attendance', '/allowances', '/my-pay'];
const PAYROLL = ['/payroll', '/my-pay'];
const LOSSES = ['/losses', '/payroll/deductions'];

/* ------------------------------------------------------------- attendance */

export async function clockInAction(form: FormData): Promise<ActionResult> {
  // No time is sent: a self clock-in uses the server's clock.
  return run(
    'record_attendance',
    [null, 'present', null, null, null, text(form, 'notes')],
    ATTENDANCE,
  );
}

export async function clockOutAction(form: FormData): Promise<ActionResult> {
  return run('clock_out', [text(form, 'attendance_id'), null], ATTENDANCE);
}

export async function recordAttendanceAction(form: FormData): Promise<ActionResult> {
  const day = text(form, 'business_day');
  const arrival = text(form, 'arrival') ?? 'present';
  return run(
    'record_attendance',
    [
      text(form, 'staff_uid'),
      arrival,
      day,
      arrival === 'present' ? eatInstant(form, day, 'clock_in_time') : null,
      arrival === 'present' ? eatInstant(form, day, 'clock_out_time') : null,
      text(form, 'notes'),
    ],
    ATTENDANCE,
  );
}

export async function verifyAttendanceAction(form: FormData): Promise<ActionResult> {
  return run(
    'verify_attendance',
    [ids(form, 'attendance_id'), text(form, 'action'), text(form, 'reason'), text(form, 'notes')],
    ATTENDANCE,
  );
}

export async function correctAttendanceAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('attendance_id'));
  const day = text(form, 'business_day');
  const arrival = text(form, 'arrival');
  return run(
    'correct_attendance',
    [
      id,
      text(form, 'reason'),
      arrival,
      arrival === 'absent' || arrival === 'excused' ? null : eatInstant(form, day, 'clock_in_time'),
      arrival === 'absent' || arrival === 'excused'
        ? null
        : eatInstant(form, day, 'clock_out_time'),
      text(form, 'notes'),
      flag(form, 'clear_clock_out') ?? false,
    ],
    [...ATTENDANCE, `/attendance/${id}`],
  );
}

/* -------------------------------------------------------------- allowances */

export async function calculateAllowancesAction(form: FormData): Promise<ActionResult> {
  return run('calculate_allowances', [text(form, 'business_day')], ATTENDANCE);
}

export async function reviewAllowanceAction(form: FormData): Promise<ActionResult> {
  return run(
    'review_allowance',
    [
      ids(form, 'allowance_id'),
      text(form, 'decision'),
      text(form, 'reason'),
      money(form, 'deduction_ugx'),
    ],
    ATTENDANCE,
  );
}

export async function payAllowancesAction(form: FormData): Promise<ActionResult> {
  return run(
    'pay_allowances',
    [
      ids(form, 'allowance_id'),
      text(form, 'account_id'),
      text(form, 'request_id'),
      text(form, 'reference'),
      text(form, 'payment_date'),
    ],
    [...ATTENDANCE, '/finance', '/transactions'],
  );
}

export async function reverseAllowancePaymentAction(form: FormData): Promise<ActionResult> {
  return run(
    'reverse_allowance_payment',
    [text(form, 'transaction_id'), text(form, 'reason')],
    [...ATTENDANCE, '/finance', '/transactions'],
  );
}

export async function cancelAllowanceAction(form: FormData): Promise<ActionResult> {
  return run('cancel_allowance', [ids(form, 'allowance_id'), text(form, 'reason')], ATTENDANCE);
}

/* ------------------------------------------------------------------ salary */

export async function setSalaryProfileAction(form: FormData): Promise<ActionResult> {
  const staff = String(form.get('staff_uid'));
  return run(
    'set_salary_profile',
    [
      staff,
      money(form, 'basic_salary_ugx'),
      text(form, 'effective_from'),
      text(form, 'payment_frequency') ?? 'monthly',
      flag(form, 'allowance_eligible'),
      money(form, 'allowance_amount_ugx'),
      flag(form, 'active') ?? true,
      text(form, 'reason'),
      text(form, 'notes'),
    ],
    ['/payroll/salaries', `/payroll/salaries/${staff}`, ...PAYROLL],
  );
}

/* ----------------------------------------------------------------- payroll */

export async function createPayrollAction(form: FormData): Promise<ActionResult> {
  const year = text(form, 'year');
  const month = text(form, 'month');
  return run(
    'create_payroll',
    [
      text(form, 'frequency') ?? 'monthly',
      year === null ? null : Number(year),
      month === null ? null : Number(month),
      text(form, 'week_start'),
      text(form, 'notes'),
    ],
    PAYROLL,
  );
}

export async function preparePayrollAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('payroll_id'));
  return run('prepare_payroll', [id, text(form, 'reason')], [...PAYROLL, `/payroll/${id}`]);
}

export async function correctPayrollAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('payroll_id'));
  return run('correct_payroll', [id, text(form, 'reason')], [...PAYROLL, `/payroll/${id}`]);
}

export async function addPayrollEarningAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('payroll_id'));
  return run(
    'add_payroll_earning',
    [
      id,
      text(form, 'staff_uid'),
      text(form, 'description'),
      money(form, 'amount_ugx'),
      text(form, 'reason'),
    ],
    [...PAYROLL, `/payroll/${id}`],
  );
}

export async function removePayrollEarningAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('payroll_id'));
  return run(
    'remove_payroll_earning',
    [text(form, 'earning_id'), text(form, 'reason')],
    [...PAYROLL, `/payroll/${id}`],
  );
}

export async function updatePayrollStatusAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('payroll_id'));
  return run(
    'update_payroll_status',
    [id, text(form, 'action'), text(form, 'reason'), text(form, 'notes')],
    [...PAYROLL, `/payroll/${id}`],
  );
}

export async function payPayrollAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('payroll_id'));
  return run(
    'pay_payroll',
    [
      id,
      text(form, 'account_id'),
      text(form, 'request_id'),
      text(form, 'reference'),
      text(form, 'payment_date'),
    ],
    [...PAYROLL, `/payroll/${id}`, '/finance', '/transactions'],
  );
}

export async function reversePayrollPaymentAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('payroll_id'));
  return run(
    'reverse_payroll_payment',
    [id, text(form, 'reason')],
    [...PAYROLL, `/payroll/${id}`, '/finance', '/transactions'],
  );
}

export async function lockPayrollAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('payroll_id'));
  return run('lock_payroll', [id], [...PAYROLL, `/payroll/${id}`]);
}

export async function cancelPayrollAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('payroll_id'));
  return run('cancel_payroll', [id, text(form, 'reason')], [...PAYROLL, `/payroll/${id}`]);
}

/* ------------------------------------------------------ losses, deductions */

export async function createLossAction(form: FormData): Promise<ActionResult> {
  return run(
    'create_loss_incident',
    [
      text(form, 'incident_type'),
      money(form, 'amount_ugx'),
      text(form, 'description'),
      text(form, 'request_id'),
      text(form, 'staff_uid'),
      text(form, 'incident_date'),
      text(form, 'notes'),
    ],
    LOSSES,
  );
}

export async function reviewLossAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('incident_id'));
  return run('review_loss_incident', [id, text(form, 'notes')], [...LOSSES, `/losses/${id}`]);
}

export async function decideLossAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('incident_id'));
  return run(
    'decide_loss_incident',
    [id, text(form, 'decision'), text(form, 'reason'), money(form, 'recovery_ugx') ?? 0],
    [...LOSSES, `/losses/${id}`],
  );
}

export async function scheduleLossRecoveryAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('incident_id'));
  return run(
    'schedule_loss_recovery',
    [id, money(form, 'instalment_ugx'), text(form, 'start_date'), text(form, 'reason')],
    [...LOSSES, `/losses/${id}`],
  );
}

export async function cancelLossAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('incident_id'));
  return run('cancel_loss_incident', [id, text(form, 'reason')], [...LOSSES, `/losses/${id}`]);
}

export async function createDeductionAction(form: FormData): Promise<ActionResult> {
  return run(
    'create_salary_deduction',
    [
      text(form, 'staff_uid'),
      text(form, 'type'),
      money(form, 'total_amount_ugx'),
      text(form, 'reason'),
      text(form, 'reference'),
      text(form, 'request_id'),
      money(form, 'instalment_ugx'),
      text(form, 'starts_from'),
    ],
    LOSSES,
  );
}

export async function decideDeductionAction(form: FormData): Promise<ActionResult> {
  return run(
    'decide_salary_deduction',
    [text(form, 'deduction_id'), text(form, 'decision'), text(form, 'reason')],
    LOSSES,
  );
}

export async function cancelDeductionAction(form: FormData): Promise<ActionResult> {
  return run('cancel_salary_deduction', [text(form, 'deduction_id'), text(form, 'reason')], LOSSES);
}

/* ------------------------------------------------------------------ policy */

export async function updatePayrollPolicyAction(form: FormData): Promise<ActionResult> {
  const changes: Record<string, unknown> = {};
  const numbers = [
    'gracePeriodMinutes',
    'lateThresholdMinutes',
    'defaultDailyAllowanceUgx',
    'lateDeductionUgx',
    'maxLateDeductionUgx',
    'maxDeductionPercentOfGross',
  ];
  for (const key of numbers) {
    const value = text(form, key);
    if (value !== null) changes[key] = Number(value.replace(/[\s,]/g, ''));
  }
  const time = text(form, 'reportingTime');
  if (time !== null) changes.reportingTime = time;
  const policy = text(form, 'lateAllowancePolicy');
  if (policy !== null) changes.lateAllowancePolicy = policy;
  for (const key of [
    'requireClockOut',
    'allowanceOnNonWorkingDays',
    'allowanceApprovalRequired',
    'payrollRequiresAdminApproval',
  ]) {
    const value = flag(form, key);
    if (value !== null) changes[key] = value;
  }
  const days = ids(form, 'workingDays').map(Number);
  if (days.length > 0) changes.workingDays = days;

  return run(
    'update_payroll_policy',
    [JSON.stringify(changes), text(form, 'reason')],
    ['/payroll/policy', ...ATTENDANCE, ...PAYROLL],
  );
}
