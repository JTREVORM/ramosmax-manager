'use client';

import * as React from 'react';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import { recordDepositAction } from '@/lib/server/finance-actions';
import type { AccountRow } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/** Taking cash to the bank. Pre-filled with what is waiting. */
export function DepositForm({ sources, banks }: { sources: AccountRow[]; banks: AccountRow[] }) {
  const [requestId] = React.useState(newRequestId);
  const cash = sources.find((a) => a.type === 'cash') ?? sources[0];
  const [source, setSource] = React.useState(cash?.id ?? '');
  const account = sources.find((a) => a.id === source);
  const [amount, setAmount] = React.useState(String(cash?.awaiting_banking_ugx ?? ''));

  const parsed = Number(amount.replace(/[\s,]/g, ''));
  const tooMuch = account != null && Number.isFinite(parsed) && parsed > account.balance_ugx;

  return (
    <ActionForm action={recordDepositAction} submitLabel="Record deposit" busyLabel="Recording…">
      <input type="hidden" name="request_id" value={requestId} />
      <div className="space-y-4">
        <Field
          label="From"
          htmlFor="source_account_id"
          hint={account ? `Holds ${formatUgx(account.balance_ugx)}, ${formatUgx(account.awaiting_banking_ugx)} waiting` : undefined}
        >
          <select
            id="source_account_id"
            name="source_account_id"
            className={selectClass}
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              const next = sources.find((a) => a.id === e.target.value);
              setAmount(String(next?.awaiting_banking_ugx ?? ''));
            }}
            required
          >
            {sources.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Into bank account" htmlFor="bank_account_id">
          <select id="bank_account_id" name="bank_account_id" className={selectClass} required>
            {banks.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>

        <Field
          label="Amount (UGX)"
          htmlFor="amount_ugx"
          error={tooMuch ? 'That is more than the account holds.' : undefined}
        >
          <Input
            name="amount_ugx"
            type="number"
            inputMode="numeric"
            min={1}
            required
            className="tabular text-lg"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>

        <Field
          label="Bank reference / slip number"
          htmlFor="bank_reference"
          hint="Required: the deposit cannot be traced without it."
        >
          <Input name="bank_reference" required />
        </Field>

        <Field label="Description" htmlFor="description" hint="Optional">
          <Input name="description" />
        </Field>
      </div>
    </ActionForm>
  );
}
