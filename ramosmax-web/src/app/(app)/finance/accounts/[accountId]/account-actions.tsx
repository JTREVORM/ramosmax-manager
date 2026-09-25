'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { newRequestId } from '@/lib/online';
import {
  reconcileAccountAction, recordAdjustmentAction, recordOpeningBalanceAction, updateAccountAction,
} from '@/lib/server/finance-actions';
import type { AccountRow } from '@/lib/server/finance';
import { formatUgx } from '@/lib/format/money';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * What can be done to this account.
 *
 * The balance shown is the server's. A reconciliation sends only what was
 * COUNTED; the system figure is read inside the transaction, so the browser
 * never decides whether an account reconciles.
 */
export function AccountActions({
  account,
  permissions,
}: {
  account: AccountRow;
  permissions: string[];
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);

  const canOpening = can('finance.accounts.manage') && !account.opening_balance_recorded;
  const canEdit = can('finance.accounts.manage');
  const canReconcile = can('finance.reconcile');
  const canAdjust = can('finance.adjust');

  if (!canOpening && !canEdit && !canReconcile && !canAdjust) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {canReconcile && (
            <Button size="sm" onClick={() => setPanel(panel === 'reconcile' ? null : 'reconcile')}>
              Reconcile
            </Button>
          )}
          {canOpening && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(panel === 'opening' ? null : 'opening')}>
              Record opening balance
            </Button>
          )}
          {canAdjust && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(panel === 'adjust' ? null : 'adjust')}>
              Record adjustment
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'edit' ? null : 'edit')}>
              Edit details
            </Button>
          )}
        </div>

        {panel === 'reconcile' && <ReconcilePanel account={account} />}
        {panel === 'opening' && <OpeningPanel account={account} />}
        {panel === 'adjust' && <AdjustPanel account={account} />}
        {panel === 'edit' && <EditPanel account={account} />}
      </CardBody>
    </Card>
  );
}

function ReconcilePanel({ account }: { account: AccountRow }) {
  const [requestId] = React.useState(newRequestId);
  const [counted, setCounted] = React.useState('');

  const parsed = counted.replace(/[\s,]/g, '');
  const difference = /^\d+$/.test(parsed) ? Number(parsed) - account.balance_ugx : null;

  return (
    <ActionForm action={reconcileAccountAction} submitLabel="Record the count">
      <input type="hidden" name="account_id" value={account.id} />
      <input type="hidden" name="request_id" value={requestId} />
      <div className="space-y-4">
        <Field
          label="Counted / statement balance (UGX)"
          htmlFor="actual_balance_ugx"
          hint="What is actually there. The system figure comes from the server."
        >
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
        <Field label="Notes" htmlFor="notes" hint="Optional">
          <Input name="notes" />
        </Field>
        <div className="bg-surface-muted rounded-[var(--radius)] px-4 py-3 text-sm">
          <p className="text-muted-foreground">System balance {formatUgx(account.balance_ugx)}</p>
          {difference !== null && (
            <p className={difference === 0 ? 'text-success mt-1' : 'text-warning mt-1'}>
              {difference === 0
                ? 'Balanced'
                : `Difference ${difference > 0 ? '+' : '−'} ${formatUgx(Math.abs(difference))}`}
            </p>
          )}
          <p className="text-muted-foreground mt-1 text-xs">
            Recording a count never changes the balance. A difference is closed by an adjustment.
          </p>
        </div>
      </div>
    </ActionForm>
  );
}

function OpeningPanel({ account }: { account: AccountRow }) {
  return (
    <ActionForm action={recordOpeningBalanceAction} submitLabel="Record opening balance">
      <input type="hidden" name="account_id" value={account.id} />
      <div className="space-y-4">
        <Field
          label="Amount (UGX)"
          htmlFor="amount_ugx"
          hint="The money this account held when RamosMAX started tracking it. Once only."
        >
          <Input name="amount_ugx" type="number" inputMode="numeric" min={1} required className="tabular text-lg" />
        </Field>
        <Field label="Reason" htmlFor="opening-reason" hint="Optional, and kept in the audit trail.">
          <Input name="reason" />
        </Field>
      </div>
    </ActionForm>
  );
}

function AdjustPanel({ account }: { account: AccountRow }) {
  const [requestId] = React.useState(newRequestId);
  return (
    <ActionForm action={recordAdjustmentAction} submitLabel="Record adjustment">
      <input type="hidden" name="account_id" value={account.id} />
      <input type="hidden" name="request_id" value={requestId} />
      <div className="space-y-4">
        <Field label="Direction" htmlFor="direction">
          <select id="direction" name="direction" className={selectClass} required>
            <option value="in">Money in (+)</option>
            <option value="out">Money out (−)</option>
          </select>
        </Field>
        <Field label="Amount (UGX)" htmlFor="amount_ugx">
          <Input name="amount_ugx" type="number" inputMode="numeric" min={1} required className="tabular" />
        </Field>
        <Field label="Reason" htmlFor="adjust-reason" hint="Required, and kept in the audit trail.">
          <Input name="reason" required />
        </Field>
      </div>
    </ActionForm>
  );
}

function EditPanel({ account }: { account: AccountRow }) {
  return (
    <ActionForm action={updateAccountAction} submitLabel="Save changes">
      <input type="hidden" name="account_id" value={account.id} />
      <div className="space-y-4">
        <Field label="Name" htmlFor="name">
          <Input name="name" defaultValue={account.name} />
        </Field>
        <Field label="Provider / bank" htmlFor="provider">
          <Input name="provider" defaultValue={account.provider ?? ''} />
        </Field>
        <Field label="Notes" htmlFor="account-notes">
          <Input name="notes" defaultValue={account.notes ?? ''} />
        </Field>
        <Field
          label="Reason"
          htmlFor="edit-reason"
          hint="Required when deactivating; kept in the audit trail."
        >
          <Input name="reason" />
        </Field>
        {!account.is_default && (
          <Field
            label="Active"
            htmlFor="active"
            hint="An account can only be deactivated once its balance is zero."
          >
            <select id="active" name="active" className={selectClass} defaultValue={String(account.is_active)}>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </Field>
        )}
      </div>
    </ActionForm>
  );
}
