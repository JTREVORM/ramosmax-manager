'use server';

import { revalidatePath } from 'next/cache';
import { callRpc } from './operations';
import type { ActionResult } from './operations-actions';

/**
 * Server Actions for shareholders, shares and dividends.
 *
 * Each forwards to ONE SECURITY DEFINER function. No commitment, percentage,
 * allocation or total is decided here: the server works out what a shareholder
 * owns and what a dividend pays, and a Server Action is as untrusted as the
 * browser it was called from.
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

const flag = (form: FormData, key: string): boolean | null => {
  const value = form.get(key);
  if (value == null || value === '') return null;
  return value === 'true' || value === 'on';
};

const ids = (form: FormData, key: string): string[] =>
  form.getAll(key).map((v) => String(v)).filter((v) => v !== '');

const SHAREHOLDERS = ['/shareholders', '/shares', '/my-shares'];
const DIVIDENDS = ['/dividends', '/shareholders', '/my-shares'];

/* ----------------------------------------------------------- shareholders */

export async function createShareholderAction(form: FormData): Promise<ActionResult> {
  return run('create_shareholder', [
    text(form, 'full_name'), text(form, 'request_id'), text(form, 'phone_number'),
    text(form, 'email'), text(form, 'address'), text(form, 'id_type'), text(form, 'id_number'),
    text(form, 'join_date'), text(form, 'notes'),
  ], SHAREHOLDERS);
}

export async function updateShareholderAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('shareholder_id'));
  return run('update_shareholder', [
    id, text(form, 'full_name'), text(form, 'phone_number'), text(form, 'email'),
    text(form, 'address'), text(form, 'id_type'), text(form, 'id_number'), text(form, 'notes'),
    text(form, 'reason'),
  ], [...SHAREHOLDERS, `/shareholders/${id}`]);
}

export async function setShareholderStatusAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('shareholder_id'));
  return run('set_shareholder_status', [id, text(form, 'status'), text(form, 'reason')],
    [...SHAREHOLDERS, `/shareholders/${id}`]);
}

export async function linkShareholderAccountAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('shareholder_id'));
  return run('link_shareholder_account', [id, text(form, 'uid'), text(form, 'reason')],
    [...SHAREHOLDERS, `/shareholders/${id}`]);
}

/* ------------------------------------------------------------ share classes */

export async function createShareClassAction(form: FormData): Promise<ActionResult> {
  return run('create_share_class', [
    text(form, 'code'), text(form, 'name'), money(form, 'value_per_share_ugx'),
    text(form, 'description'),
  ], ['/shares', ...SHAREHOLDERS]);
}

export async function updateShareClassAction(form: FormData): Promise<ActionResult> {
  return run('update_share_class', [
    text(form, 'class_id'), text(form, 'name'), text(form, 'description'),
    money(form, 'value_per_share_ugx'), flag(form, 'active'), text(form, 'reason'),
  ], ['/shares', ...SHAREHOLDERS]);
}

export async function updateShareholdingPolicyAction(form: FormData): Promise<ActionResult> {
  const which = String(form.get('policy') ?? 'share');
  const changes: Record<string, boolean> = {};
  const keys = which === 'share'
    ? ['requireApproval', 'allowUnpaidShares', 'allowPartialPayment']
    : ['requireAdminApproval'];
  for (const key of keys) changes[key] = flag(form, key) ?? false;
  return run('update_shareholding_policy', [which, JSON.stringify(changes), text(form, 'reason')],
    ['/shares', '/dividends']);
}

/* ------------------------------------------------------ the ownership ledger */

export async function issueSharesAction(form: FormData): Promise<ActionResult> {
  const source = text(form, 'payment_source') ?? 'account';
  return run('issue_shares', [
    text(form, 'shareholder_id'), text(form, 'class_id'), money(form, 'shares'),
    text(form, 'request_id'), text(form, 'effective_date'), source,
    source === 'none' ? null : money(form, 'payment_amount'),
    source === 'account' ? text(form, 'account_id') : null,
    text(form, 'acquisition_date'), text(form, 'reference'), text(form, 'notes'),
    text(form, 'reason'),
  ], ['/shares', ...SHAREHOLDERS, '/finance', '/transactions']);
}

export async function transferSharesAction(form: FormData): Promise<ActionResult> {
  return run('transfer_shares', [
    text(form, 'from_shareholder_id'), text(form, 'to_shareholder_id'), text(form, 'class_id'),
    money(form, 'shares'), text(form, 'reason'), text(form, 'request_id'),
    text(form, 'effective_date'), text(form, 'reference'), text(form, 'notes'),
  ], ['/shares', ...SHAREHOLDERS]);
}

export async function adjustSharesAction(form: FormData): Promise<ActionResult> {
  return run('adjust_shares', [
    text(form, 'shareholder_id'), text(form, 'class_id'), money(form, 'delta_shares'),
    text(form, 'reason'), text(form, 'request_id'), flag(form, 'adjust_commitment') ?? false,
    text(form, 'effective_date'), text(form, 'reference'), text(form, 'notes'),
  ], ['/shares', ...SHAREHOLDERS]);
}

export async function decideShareTransactionAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('transaction_id'));
  return run('decide_share_transaction', [id, text(form, 'decision'), text(form, 'reason')],
    ['/shares', `/shares/txn/${id}`, ...SHAREHOLDERS, '/finance', '/transactions']);
}

export async function recordShareContributionAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('share_transaction_id'));
  return run('record_share_contribution', [
    id, money(form, 'amount_ugx'), text(form, 'request_id'), text(form, 'source') ?? 'account',
    text(form, 'account_id'), text(form, 'payment_date'), text(form, 'reference'),
    text(form, 'reason'),
  ], ['/shares', `/shares/txn/${id}`, ...SHAREHOLDERS, '/finance', '/transactions']);
}

export async function reverseShareContributionAction(form: FormData): Promise<ActionResult> {
  return run('reverse_share_contribution', [
    text(form, 'contribution_id'), text(form, 'reason'),
  ], ['/shares', ...SHAREHOLDERS, '/finance', '/transactions']);
}

export async function reverseShareTransactionAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('transaction_id'));
  return run('reverse_share_transaction', [id, text(form, 'reason'), text(form, 'request_id')],
    ['/shares', `/shares/txn/${id}`, ...SHAREHOLDERS, '/finance', '/transactions']);
}

/* ------------------------------------------------------------------ dividends */

export async function createDividendAction(form: FormData): Promise<ActionResult> {
  const method = text(form, 'calculation_method') ?? 'pool';
  return run('create_dividend', [
    text(form, 'financial_period'), text(form, 'record_date'), text(form, 'request_id'), method,
    method === 'pool' ? money(form, 'total_distributable_ugx') : null,
    method === 'per_share' ? money(form, 'dividend_per_share_ugx') : null,
    text(form, 'declaration_date'), text(form, 'payment_date'), text(form, 'class_id'),
    text(form, 'notes'),
  ], DIVIDENDS);
}

export async function updateDividendAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('dividend_id'));
  const method = text(form, 'calculation_method');
  return run('update_dividend', [
    id, text(form, 'financial_period'), text(form, 'record_date'), method,
    money(form, 'total_distributable_ugx'), money(form, 'dividend_per_share_ugx'),
    text(form, 'declaration_date'), text(form, 'payment_date'), text(form, 'notes'),
    text(form, 'reason'),
  ], [...DIVIDENDS, `/dividends/${id}`]);
}

export async function calculateDividendAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('dividend_id'));
  return run('calculate_dividend', [id], [...DIVIDENDS, `/dividends/${id}`]);
}

export async function updateDividendStatusAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('dividend_id'));
  return run('update_dividend_status', [id, text(form, 'action'), text(form, 'reason')],
    [...DIVIDENDS, `/dividends/${id}`]);
}

export async function payDividendAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('dividend_id'));
  return run('pay_dividend', [
    id, ids(form, 'allocation_id'), text(form, 'account_id'), text(form, 'request_id'),
    text(form, 'reference'), text(form, 'payment_date'),
  ], [...DIVIDENDS, `/dividends/${id}`, '/finance', '/transactions']);
}

export async function reverseDividendPaymentAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('dividend_id'));
  return run('reverse_dividend_payment', [text(form, 'allocation_id'), text(form, 'reason')],
    [...DIVIDENDS, `/dividends/${id}`, '/finance', '/transactions']);
}

export async function cancelDividendAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('dividend_id'));
  return run('cancel_dividend', [id, text(form, 'reason')], [...DIVIDENDS, `/dividends/${id}`]);
}
