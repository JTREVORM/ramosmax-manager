'use server';

import { revalidatePath } from 'next/cache';
import { callRpc } from './operations';
import type { ActionResult } from './operations-actions';

/**
 * Server Actions for after-hours work and cash handovers.
 *
 * Each forwards to ONE SECURITY DEFINER function. Nothing here works out an
 * expected amount, a difference or a permission list: the server decides all
 * three, and a Server Action is as untrusted as the browser it was called
 * from. In particular there is no action that sends an expected amount,
 * because no function accepts one.
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
  return /^-?\d+$/.test(digits) ? Number(digits) : Number.NaN;
};

const flag = (form: FormData, key: string): boolean => form.get(key) === 'on'
  || form.get(key) === 'true';

const list = (form: FormData, key: string): string[] | null => {
  const values = form.getAll(key).map((v) => String(v)).filter((v) => v !== '');
  return values.length > 0 ? values : null;
};

const AFTER_HOURS = ['/after-hours', '/my-after-hours'];

/* --------------------------------------------------------------- policy */

export async function updateAfterHoursPolicyAction(form: FormData): Promise<ActionResult> {
  const changes: Record<string, unknown> = {};
  const methods = list(form, 'allowed_payment_methods');
  if (methods) changes.allowedPaymentMethods = methods;
  const hours = money(form, 'max_authorization_hours');
  if (hours !== null) changes.maxAuthorizationHours = hours;
  const float = money(form, 'max_opening_float_ugx');
  if (float !== null) changes.maxOpeningFloatUgx = float;
  return run('update_after_hours_policy', [JSON.stringify(changes), text(form, 'reason')],
    [...AFTER_HOURS, '/settings']);
}

/* ------------------------------------------------------- authorisations */

export async function authorizeAfterHoursAction(form: FormData): Promise<ActionResult> {
  // A LENGTH, not an end time: the database adds it to its own clock, so a
  // full-length shift is never refused because this server is a second ahead.
  return run('authorize_after_hours', [
    text(form, 'staff_uid'), null, text(form, 'reason'), text(form, 'request_id'), null,
    list(form, 'permissions'), money(form, 'opening_float_ugx'), money(form, 'hours'),
  ], AFTER_HOURS);
}

export async function revokeAfterHoursAction(form: FormData): Promise<ActionResult> {
  return run('revoke_after_hours', [text(form, 'authorization_id'), text(form, 'reason')],
    AFTER_HOURS);
}

/* ------------------------------------------------------------- sessions */

export async function openAfterHoursSessionAction(form: FormData): Promise<ActionResult> {
  return run('open_after_hours_session', [text(form, 'request_id'), text(form, 'notes')],
    AFTER_HOURS);
}

export async function closeAfterHoursSessionAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('session_id'));
  return run('close_after_hours_session', [id, text(form, 'notes')],
    [...AFTER_HOURS, `/after-hours/session/${id}`]);
}

export async function cancelAfterHoursSessionAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('session_id'));
  return run('cancel_after_hours_session', [id, text(form, 'reason')],
    [...AFTER_HOURS, `/after-hours/session/${id}`]);
}

/* ------------------------------------------------------------ handovers */

export async function submitCashHandoverAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('handover_id'));
  return run('submit_cash_handover', [
    id, money(form, 'declared_amount_ugx'), text(form, 'request_id'), text(form, 'notes'),
  ], [...AFTER_HOURS, `/after-hours/handover/${id}`]);
}

export async function receiveCashHandoverAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('handover_id'));
  return run('receive_cash_handover', [
    id, money(form, 'actual_amount_ugx'), text(form, 'request_id'),
    text(form, 'explanation'), text(form, 'notes'),
  ], [...AFTER_HOURS, `/after-hours/handover/${id}`]);
}

/* -------------------------------------------------------- discrepancies */

export async function reviewCashDiscrepancyAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('discrepancy_id'));
  return run('review_cash_discrepancy', [id, text(form, 'notes')],
    [...AFTER_HOURS, `/after-hours/discrepancy/${id}`]);
}

export async function resolveCashDiscrepancyAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('discrepancy_id'));
  return run('resolve_cash_discrepancy', [
    id, text(form, 'outcome'), text(form, 'resolution'), text(form, 'request_id'),
    flag(form, 'recover_from_worker'), flag(form, 'post_adjustment'),
  ], [...AFTER_HOURS, `/after-hours/discrepancy/${id}`, '/losses', '/finance', '/transactions']);
}
