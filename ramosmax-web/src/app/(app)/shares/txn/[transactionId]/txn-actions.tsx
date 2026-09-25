'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import {
  decideShareTransactionAction, recordShareContributionAction, reverseShareContributionAction,
  reverseShareTransactionAction,
} from '@/lib/server/ownership-actions';
import type { ContributionRow, ShareTransactionRow } from '@/lib/server/ownership';
import type { PickableAccount } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

export function TransactionActions({
  transaction,
  contributions,
  accounts,
  permissions,
  today,
}: {
  transaction: ShareTransactionRow;
  contributions: ContributionRow[];
  accounts: PickableAccount[];
  permissions: string[];
  today: string;
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);
  const [request, setRequest] = React.useState(newRequestId);
  const [source, setSource] = React.useState('account');
  const toggle = (next: string) => {
    setRequest(newRequestId());
    setPanel(panel === next ? null : next);
  };

  const pending = transaction.status === 'pending_approval';
  const canDecide = pending && can('shares.approve');
  const canPay = transaction.type === 'shares_issued' && transaction.status === 'posted'
    && transaction.outstanding_ugx > 0 && can('shares.issue');
  const canReverse = transaction.status === 'posted' && transaction.type !== 'reversal'
    && can('shares.adjust');
  const live = contributions.filter((c) => c.status === 'posted');
  const canReverseContribution = live.length > 0 && can('shares.adjust');

  if (!canDecide && !canPay && !canReverse && !canReverseContribution) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {canDecide && (
            <>
              <Button size="sm" onClick={() => toggle('approve')}>Approve</Button>
              <Button size="sm" variant="ghost" onClick={() => toggle('reject')}>Reject</Button>
            </>
          )}
          {canPay && (
            <Button size="sm" variant="secondary" onClick={() => toggle('pay')}>Record a payment</Button>
          )}
          {canReverse && (
            <Button size="sm" variant="ghost" onClick={() => toggle('reverse')}>Reverse entry</Button>
          )}
          {canReverseContribution && (
            <Button size="sm" variant="ghost" onClick={() => toggle('reverse-contribution')}>
              Reverse a payment
            </Button>
          )}
        </div>

        {canDecide && (
          <p className="text-muted-foreground text-xs">
            Everything is re-checked at approval, so a request that has stopped being valid is
            refused. Nobody approves their own request or a transaction on their own shareholding.
          </p>
        )}

        {panel === 'approve' && (
          <ActionForm action={decideShareTransactionAction} submitLabel="Approve transaction">
            <input type="hidden" name="transaction_id" value={transaction.id} />
            <input type="hidden" name="decision" value="approve" />
            <Field label="Note" htmlFor="approve-note" hint="Optional">
              <Input id="approve-note" name="reason" />
            </Field>
          </ActionForm>
        )}

        {panel === 'reject' && (
          <ActionForm action={decideShareTransactionAction} submitLabel="Reject transaction">
            <input type="hidden" name="transaction_id" value={transaction.id} />
            <input type="hidden" name="decision" value="reject" />
            <Field label="Reason" htmlFor="reject-reason" hint="Required.">
              <Input id="reject-reason" name="reason" required />
            </Field>
          </ActionForm>
        )}

        {panel === 'pay' && (
          <ActionForm action={recordShareContributionAction} submitLabel="Record payment">
            <input type="hidden" name="share_transaction_id" value={transaction.id} />
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field
                label="Amount"
                htmlFor="pay-amount"
                hint={`At most ${formatUgx(transaction.outstanding_ugx)} outstanding.`}
              >
                <Input id="pay-amount" name="amount_ugx" inputMode="numeric" required />
              </Field>
              <Field label="Source" htmlFor="pay-source">
                <select
                  id="pay-source"
                  name="source"
                  className={selectClass}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  <option value="account">Into a business account</option>
                  <option value="prior_record">Paid before RamosMAX tracked the accounts</option>
                </select>
              </Field>
              {source === 'account' && (
                <Field label="Account" htmlFor="pay-account">
                  <select id="pay-account" name="account_id" required className={selectClass}>
                    <option value="">Choose an account…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Payment date" htmlFor="pay-date">
                <Input id="pay-date" name="payment_date" type="date" defaultValue={today} max={today} />
              </Field>
              <Field label="Reference" htmlFor="pay-reference" hint="Optional">
                <Input id="pay-reference" name="reference" />
              </Field>
              <Field
                label="Reason"
                htmlFor="pay-reason"
                hint={source === 'prior_record' ? 'Required.' : 'Optional'}
              >
                <Input id="pay-reason" name="reason" required={source === 'prior_record'} />
              </Field>
            </div>
          </ActionForm>
        )}

        {panel === 'reverse' && (
          <ActionForm action={reverseShareTransactionAction} submitLabel="Reverse entry">
            <input type="hidden" name="transaction_id" value={transaction.id} />
            <input type="hidden" name="request_id" value={request} />
            <Field label="Reason" htmlFor="reverse-reason" hint="Required.">
              <Input id="reverse-reason" name="reason" required />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              The mirror image is posted TODAY and this entry stays in the history, marked reversed.
              Its live contributions and their ledger entries are reversed in the same act.
            </p>
          </ActionForm>
        )}

        {panel === 'reverse-contribution' && (
          <ActionForm action={reverseShareContributionAction} submitLabel="Reverse payment">
            <div className="space-y-3">
              <Field label="Payment" htmlFor="contribution">
                <select id="contribution" name="contribution_id" required className={selectClass}>
                  {live.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.contribution_number} · {formatUgx(c.amount_ugx)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason" htmlFor="reverse-c-reason" hint="Required.">
                <Input id="reverse-c-reason" name="reason" required />
              </Field>
              <p className="text-muted-foreground text-xs">
                The money leaves the account again and the commitment is outstanding once more. The
                payment record stays, marked reversed.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
