'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import {
  calculateDividendAction, cancelDividendAction, payDividendAction,
  reverseDividendPaymentAction, updateDividendStatusAction,
} from '@/lib/server/ownership-actions';
import type { AllocationRow, DividendRow } from '@/lib/server/ownership';
import type { PickableAccount } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/** The most allocations one distribution may carry — the server refuses more. */
const BATCH_LIMIT = 50;

export function DividendActions({
  dividend,
  allocations,
  accounts,
  permissions,
  today,
}: {
  dividend: DividendRow;
  allocations: AllocationRow[];
  accounts: PickableAccount[];
  permissions: string[];
  today: string;
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);
  const [request, setRequest] = React.useState(newRequestId);
  const toggle = (next: string) => {
    setRequest(newRequestId());
    setPanel(panel === next ? null : next);
  };

  const payable = allocations.filter((a) => a.payment_status === 'unpaid' && a.net_ugx > 0);
  const paid = allocations.filter((a) => a.payment_status === 'paid');
  const batch = payable.slice(0, BATCH_LIMIT);
  const batchTotal = batch.reduce((sum, a) => sum + Number(a.net_ugx), 0);

  const canCalculate = dividend.status === 'draft' && can('dividends.calculate');
  const canDeclare = dividend.status === 'draft' && dividend.allocation_count > 0
    && can('dividends.declare');
  const canReturn = dividend.status === 'declared' && can('dividends.declare');
  const canApprove = dividend.status === 'declared' && can('dividends.approve');
  const canPay = ['approved', 'partially_paid'].includes(dividend.status)
    && payable.length > 0 && can('dividends.pay');
  const canCancel = dividend.paid_ugx === 0
    && ['draft', 'declared', 'approved'].includes(dividend.status) && can('dividends.adjust');
  const canReverse = paid.length > 0 && can('dividends.adjust');

  if (!canCalculate && !canDeclare && !canReturn && !canApprove && !canPay && !canCancel
    && !canReverse) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {canCalculate && (
            <Button size="sm" onClick={() => toggle('calculate')}>
              {dividend.allocation_count > 0 ? 'Recalculate' : 'Calculate'}
            </Button>
          )}
          {canDeclare && <Button size="sm" onClick={() => toggle('declare')}>Declare</Button>}
          {canApprove && <Button size="sm" onClick={() => toggle('approve')}>Approve</Button>}
          {canReturn && (
            <Button size="sm" variant="secondary" onClick={() => toggle('return')}>
              Return to draft
            </Button>
          )}
          {canPay && (
            <Button size="sm" variant="secondary" onClick={() => toggle('pay')}>Distribute</Button>
          )}
          {canReverse && (
            <Button size="sm" variant="ghost" onClick={() => toggle('reverse')}>
              Reverse a payment
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="ghost" onClick={() => toggle('cancel')}>Cancel</Button>
          )}
        </div>

        {panel === 'calculate' && (
          <ActionForm
            action={calculateDividendAction}
            submitLabel="Calculate allocations"
            confirm={
              dividend.record_locked
                ? 'The record date is already locked. Recalculating replaces the current allocations. Continue?'
                : 'This locks the record date. Ownership on or before it can no longer be back-dated. Continue?'
            }
          >
            <input type="hidden" name="dividend_id" value={dividend.id} />
            <p className="text-muted-foreground text-sm">
              The server works out every allocation from ownership at {dividend.record_date}, in
              whole shillings. Nothing is paid and nothing is declared by calculating.
            </p>
          </ActionForm>
        )}

        {panel === 'declare' && (
          <ActionForm action={updateDividendStatusAction} submitLabel="Declare">
            <input type="hidden" name="dividend_id" value={dividend.id} />
            <input type="hidden" name="action" value="declare" />
            <p className="text-muted-foreground text-sm">
              Declaring freezes the allocations and asks a second person to approve. You cannot
              approve a dividend you declared.
            </p>
          </ActionForm>
        )}

        {panel === 'return' && (
          <ActionForm action={updateDividendStatusAction} submitLabel="Return to draft">
            <input type="hidden" name="dividend_id" value={dividend.id} />
            <input type="hidden" name="action" value="return" />
            <Field label="Why is it going back?" htmlFor="div-return-reason">
              <Input id="div-return-reason" name="reason" required />
            </Field>
          </ActionForm>
        )}

        {panel === 'approve' && (
          <ActionForm action={updateDividendStatusAction} submitLabel="Approve">
            <input type="hidden" name="dividend_id" value={dividend.id} />
            <input type="hidden" name="action" value="approve" />
            <p className="text-muted-foreground text-sm">
              Approving allows distribution of {formatUgx(dividend.allocated_ugx)} across{' '}
              {dividend.allocation_count} shareholders. A person who holds shares in this dividend
              cannot approve it.
            </p>
          </ActionForm>
        )}

        {panel === 'pay' && (
          <ActionForm
            action={payDividendAction}
            submitLabel={`Pay ${formatUgx(batchTotal)}`}
            confirm={`Pay ${batch.length} allocation(s) totalling ${formatUgx(batchTotal)}?`}
          >
            <input type="hidden" name="dividend_id" value={dividend.id} />
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field label="Pay from" htmlFor="div-pay-account">
                <select id="div-pay-account" name="account_id" required className={selectClass}>
                  <option value="">Choose…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.code}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Payment date" htmlFor="div-pay-date">
                <Input id="div-pay-date" name="payment_date" type="date" defaultValue={today} max={today} />
              </Field>
              <Field label="Reference" htmlFor="div-pay-ref">
                <Input id="div-pay-ref" name="reference" />
              </Field>
              <fieldset className="space-y-2">
                <legend className="text-muted-foreground text-sm">
                  Who is paid ({batch.length} of {payable.length} unpaid
                  {payable.length > BATCH_LIMIT ? `, ${BATCH_LIMIT} at a time` : ''})
                </legend>
                {batch.map((a) => (
                  <label key={a.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2">
                      <input type="checkbox" name="allocation_id" value={a.id} defaultChecked />
                      {a.shareholder_name ?? a.allocation_number}
                    </span>
                    <span className="tabular">{formatUgx(a.net_ugx)}</span>
                  </label>
                ))}
              </fieldset>
              <p className="text-muted-foreground text-xs">
                Each allocation becomes its own entry in the same ledger as everything else. This is
                owners&apos; money leaving the business — never an expense.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'reverse' && (
          <ActionForm action={reverseDividendPaymentAction} submitLabel="Reverse payment">
            <input type="hidden" name="dividend_id" value={dividend.id} />
            <div className="space-y-3">
              <Field label="Which payment?" htmlFor="div-rev-allocation">
                <select id="div-rev-allocation" name="allocation_id" required className={selectClass}>
                  <option value="">Choose…</option>
                  {paid.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.shareholder_name ?? a.allocation_number} · {formatUgx(a.net_ugx)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Why?" htmlFor="div-rev-reason">
                <Input id="div-rev-reason" name="reason" required />
              </Field>
              <p className="text-muted-foreground text-xs">
                The allocation goes back to unpaid and a reversing entry is posted. Nothing is
                deleted.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'cancel' && (
          <ActionForm action={cancelDividendAction} submitLabel="Cancel dividend">
            <input type="hidden" name="dividend_id" value={dividend.id} />
            <Field label="Why is it cancelled?" htmlFor="div-cancel-reason">
              <Input id="div-cancel-reason" name="reason" required />
            </Field>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
