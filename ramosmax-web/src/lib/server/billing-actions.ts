'use server';

import { revalidatePath } from 'next/cache';
import { callRpc } from './operations';
import type { ActionResult } from './operations-actions';

/**
 * Server Actions for the money screens.
 *
 * Each forwards to one SECURITY DEFINER function and returns whatever the
 * database said. No amount, status or balance is decided here — a Server
 * Action is as untrusted as the browser for financial purposes.
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

export async function createInvoiceAction(form: FormData): Promise<ActionResult> {
  const intake = String(form.get('intake_id'));
  return run('create_invoice', [intake], ['/jobs', `/jobs/${intake}`, '/invoices']);
}

export async function applyDiscountAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('invoice_id'));
  return run('apply_invoice_discount', [
    id, form.get('discount_type'), Number(form.get('discount_value')),
    form.get('reason_code'), form.get('description'),
  ], ['/invoices', `/invoices/${id}`]);
}

export async function applyLoyaltyRewardAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('invoice_id'));
  const expected = form.get('expected_ugx');
  return run('apply_loyalty_reward', [id, expected ? Number(expected) : null],
    ['/invoices', `/invoices/${id}`]);
}

export async function markCreditAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('invoice_id'));
  return run('mark_invoice_credit', [id, form.get('reason')],
    ['/invoices', `/invoices/${id}`, '/credit']);
}

/**
 * Recording a payment.
 *
 * The request id comes from the form and is generated ONCE when the form
 * opens, so pressing the button again — or retrying after a lost response —
 * reaches the same logical request and cannot charge twice.
 */
export async function recordPaymentAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('invoice_id'));
  const account = form.get('account_id');
  return run('record_payment', [
    id,
    Number(form.get('amount_ugx')),
    form.get('method'),
    form.get('request_id'),
    form.get('reference'),
    form.get('notes'),
    account ? String(account) : null,
  ], ['/invoices', `/invoices/${id}`, '/payments', '/receipts', '/credit']);
}

export async function reversePaymentAction(form: FormData): Promise<ActionResult> {
  const invoice = String(form.get('invoice_id'));
  return run('reverse_payment', [form.get('payment_id'), form.get('reason')],
    ['/invoices', `/invoices/${invoice}`, '/payments', '/receipts', '/credit']);
}

export async function cancelInvoiceAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('invoice_id'));
  return run('cancel_invoice', [id, form.get('reason')],
    ['/invoices', `/invoices/${id}`, '/jobs']);
}

export async function adjustLoyaltyAction(form: FormData): Promise<ActionResult> {
  const vehicle = String(form.get('vehicle_id'));
  return run('adjust_loyalty_points', [
    vehicle, Number(form.get('points')), form.get('reason'),
  ], ['/loyalty', `/loyalty/${vehicle}`]);
}

export async function reverseLoyaltyAction(form: FormData): Promise<ActionResult> {
  const vehicle = String(form.get('vehicle_id'));
  return run('reverse_loyalty_transaction', [
    form.get('transaction_id'), form.get('reason'),
  ], ['/loyalty', `/loyalty/${vehicle}`]);
}
