'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import { reconcileAccountAction, recordAdjustmentAction } from '@/lib/server/finance-actions';
import type { AccountRow, ReconciliationRow } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

export function ReconciliationPanels({
  accounts,
  open,
  permissions,
}: {
  accounts: AccountRow[];
  open: ReconciliationRow[];
  permissions: string[];
}) {
  const [panel, setPanel] = React.useState<string | null>(null);
  const canReconcile = permissions.includes('finance.reconcile');
  const canAdjust = permissions.includes('finance.adjust');
  if (!canReconcile && !canAdjust) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {canReconcile && (
            <Button size="sm" onClick={() => setPanel(panel === 'count' ? null : 'count')}>
              Reconcile an account
            </Button>
          )}
          {canAdjust && open.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(panel === 'close' ? null : 'close')}>
              Close a difference
            </Button>
          )}
        </div>

        {panel === 'count' && <CountPanel accounts={accounts} />}
        {panel === 'close' && <ClosePanel open={open} />}
      </CardBody>
    </Card>
  );
}

function CountPanel({ accounts }: { accounts: AccountRow[] }) {
  const [requestId] = React.useState(newRequestId);
  const [account, setAccount] = React.useState(accounts[0]?.id ?? '');
  const [counted, setCounted] = React.useState('');

  const chosen = accounts.find((a) => a.id === account);
  const parsed = counted.replace(/[\s,]/g, '');
  const difference =
    chosen && /^\d+$/.test(parsed) ? Number(parsed) - chosen.balance_ugx : null;

  return (
    <ActionForm action={reconcileAccountAction} submitLabel="Record the count">
      <input type="hidden" name="request_id" value={requestId} />
      <div className="space-y-4">
        <Field label="Account" htmlFor="account_id">
          <select
            id="account_id"
            name="account_id"
            className={selectClass}
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            required
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Counted / statement balance (UGX)" htmlFor="actual_balance_ugx">
          <Input
            name="actual_balance_ugx"
            type="number"
            inputMode="numeric"
            min={0}
            required
            className="tabular text-lg"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
          />
        </Field>

        <Field label="Notes" htmlFor="recon-notes" hint="Optional">
          <Input name="notes" />
        </Field>

        {chosen && (
          <div className="bg-surface-muted rounded-[var(--radius)] px-4 py-3 text-sm">
            <p className="text-muted-foreground">System balance {formatUgx(chosen.balance_ugx)}</p>
            {difference !== null && (
              <p className={difference === 0 ? 'text-success mt-1' : 'text-warning mt-1'}>
                {difference === 0
                  ? 'Balanced'
                  : `Difference ${difference > 0 ? '+' : '−'} ${formatUgx(Math.abs(difference))}`}
              </p>
            )}
          </div>
        )}
      </div>
    </ActionForm>
  );
}

function ClosePanel({ open }: { open: ReconciliationRow[] }) {
  const [requestId] = React.useState(newRequestId);
  const [chosen, setChosen] = React.useState(open[0]?.id ?? '');
  const reconciliation = open.find((r) => r.id === chosen);
  const direction = (reconciliation?.difference_ugx ?? 0) > 0 ? 'in' : 'out';
  const amount = Math.abs(reconciliation?.difference_ugx ?? 0);

  return (
    <ActionForm action={recordAdjustmentAction} submitLabel="Record adjustment">
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="reconciliation_id" value={chosen} />
      <input type="hidden" name="account_id" value={reconciliation?.account_id ?? ''} />
      <input type="hidden" name="direction" value={direction} />
      <input type="hidden" name="amount_ugx" value={amount} />
      <div className="space-y-4">
        <Field label="Open difference" htmlFor="reconciliation_choice">
          <select
            id="reconciliation_choice"
            className={selectClass}
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
          >
            {open.map((r) => (
              <option key={r.id} value={r.id}>
                {r.reconciliation_number} · {r.account_name} ·{' '}
                {r.difference_ugx > 0 ? '+' : '−'}
                {formatUgx(Math.abs(r.difference_ugx))}
              </option>
            ))}
          </select>
        </Field>

        <div className="bg-surface-muted rounded-[var(--radius)] px-4 py-3 text-sm">
          <p className="text-foreground">
            {direction === 'in' ? 'Adding' : 'Removing'} {formatUgx(amount)}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            The adjustment must match the difference exactly; the server refuses anything else.
          </p>
        </div>

        <Field label="Reason" htmlFor="close-reason" hint="Required, and kept in the audit trail.">
          <Input name="reason" required />
        </Field>
      </div>
    </ActionForm>
  );
}
