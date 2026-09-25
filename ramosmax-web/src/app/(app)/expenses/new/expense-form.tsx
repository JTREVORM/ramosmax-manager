'use client';

import * as React from 'react';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { newRequestId } from '@/lib/online';
import { createExpenseAction } from '@/lib/server/finance-actions';
import type { CategoryRow, PickableAccount } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * Recording an expense. Nothing moves here: the account is a PLAN until
 * someone with `expenses.pay` pays it.
 */
export function ExpenseForm({
  categories,
  accounts,
}: {
  categories: CategoryRow[];
  accounts: PickableAccount[];
}) {
  const [requestId] = React.useState(newRequestId);
  const [submit, setSubmit] = React.useState(true);

  return (
    <ActionForm
      action={createExpenseAction}
      submitLabel={submit ? 'Submit for review' : 'Save draft'}
      redirectTo={(result) => (result.id ? `/expenses/${result.id}` : '/expenses')}
    >
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="submit" value={String(submit)} />
      <div className="space-y-4">
        <Field label="Description" htmlFor="description">
          <Input name="description" required maxLength={200} />
        </Field>

        <Field label="Category" htmlFor="category_id">
          <select id="category_id" name="category_id" className={selectClass} required>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Amount (UGX)" htmlFor="amount_ugx">
          <Input name="amount_ugx" type="number" inputMode="numeric" min={1} required className="tabular text-lg" />
        </Field>

        <Field label="Date" htmlFor="expense_date" hint="A bill may be dated up to a year ahead.">
          <Input name="expense_date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
        </Field>

        <Field label="Payee" htmlFor="payee" hint="Optional">
          <Input name="payee" />
        </Field>

        <Field
          label="Intended account"
          htmlFor="payment_account_id"
          hint="A plan only. Nothing leaves it until the expense is paid."
        >
          <select id="payment_account_id" name="payment_account_id" className={selectClass}>
            <option value="">Decide later</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Reference" htmlFor="reference" hint="Optional">
          <Input name="reference" />
        </Field>

        <Field label="Notes" htmlFor="notes" hint="Optional">
          <Input name="notes" />
        </Field>

        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={submit}
            onChange={(e) => setSubmit(e.target.checked)}
          />
          <span className="text-foreground">Send for review now</span>
        </label>
      </div>
    </ActionForm>
  );
}
