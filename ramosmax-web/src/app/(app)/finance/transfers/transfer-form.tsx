'use client';

import * as React from 'react';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import { transferFundsAction } from '@/lib/server/finance-actions';
import type { AccountRow } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * A transfer.
 *
 * The request id is generated ONCE when the form opens and reused for every
 * attempt, so pressing the button again after a lost response moves the money
 * once. The balances shown come from the server and are a preview only.
 */
export function TransferForm({ accounts }: { accounts: AccountRow[] }) {
  const [requestId] = React.useState(newRequestId);
  const [from, setFrom] = React.useState(accounts[0]?.id ?? '');
  const [to, setTo] = React.useState(accounts[1]?.id ?? '');
  const [amount, setAmount] = React.useState('');

  const source = accounts.find((a) => a.id === from);
  const parsed = Number(amount.replace(/[\s,]/g, ''));
  const tooMuch = source != null && Number.isFinite(parsed) && parsed > source.balance_ugx;

  return (
    <ActionForm action={transferFundsAction} submitLabel="Transfer" busyLabel="Transferring…">
      <input type="hidden" name="request_id" value={requestId} />
      <div className="space-y-4">
        <Field label="From" htmlFor="from_account_id" hint={source ? `Holds ${formatUgx(source.balance_ugx)}` : undefined}>
          <select
            id="from_account_id"
            name="from_account_id"
            className={selectClass}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>

        <Field label="To" htmlFor="to_account_id" error={from === to ? 'Choose two different accounts.' : undefined}>
          <select
            id="to_account_id"
            name="to_account_id"
            className={selectClass}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>

        <Field
          label="Amount (UGX)"
          htmlFor="amount_ugx"
          error={tooMuch ? 'That is more than the source account holds.' : undefined}
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

        <Field label="Reason" htmlFor="transfer-reason" hint="Required, and kept in the audit trail.">
          <Input name="reason" required />
        </Field>

        <Field label="Reference" htmlFor="reference" hint="Optional">
          <Input name="reference" />
        </Field>
      </div>
    </ActionForm>
  );
}
