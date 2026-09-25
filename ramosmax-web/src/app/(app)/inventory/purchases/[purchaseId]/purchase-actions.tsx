'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import {
  payPurchaseAction, receivePurchaseAction, updatePurchaseStatusAction,
} from '@/lib/server/finance-actions';
import type { PickableAccount, PurchaseRow } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * Approve, receive, pay or cancel.
 *
 * Receiving with a payment does both in ONE transaction: if the account cannot
 * fund it, no stock is received either.
 */
export function PurchaseActions({
  purchase,
  accounts,
  permissions,
}: {
  purchase: PurchaseRow;
  accounts: PickableAccount[];
  permissions: string[];
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);

  const canApprove = purchase.status === 'pending_approval' && can('inventory.purchase.approve');
  const canCancel =
    ['pending_approval', 'approved'].includes(purchase.status) &&
    can('inventory.purchase.approve') &&
    !(purchase.payment_status === 'paid' && purchase.total_ugx > 0);
  const canReceive = purchase.status === 'approved' && can('inventory.stock.in');
  const canPay =
    purchase.payment_status === 'unpaid' &&
    ['approved', 'received'].includes(purchase.status) &&
    can('expenses.pay');

  if (!canApprove && !canCancel && !canReceive && !canPay) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {canReceive && (
            <Button size="sm" onClick={() => setPanel(panel === 'receive' ? null : 'receive')}>
              Receive stock
            </Button>
          )}
          {canApprove && (
            <form
              action={async (form) => {
                form.set('purchase_id', purchase.id);
                form.set('action', 'approve');
                await updatePurchaseStatusAction(form);
              }}
            >
              <Button size="sm" variant="secondary" type="submit">Approve</Button>
            </form>
          )}
          {canPay && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(panel === 'pay' ? null : 'pay')}>
              Pay supplier
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}>
              Cancel
            </Button>
          )}
        </div>

        {panel === 'receive' && (
          <ReceivePanel purchase={purchase} accounts={accounts} mayPay={can('expenses.pay')} />
        )}
        {panel === 'pay' && <PayPanel purchase={purchase} accounts={accounts} />}
        {panel === 'cancel' && (
          <ActionForm
            action={updatePurchaseStatusAction}
            submitLabel="Cancel purchase"
            confirm="Cancel this purchase?"
          >
            <input type="hidden" name="purchase_id" value={purchase.id} />
            <input type="hidden" name="action" value="cancel" />
            <Field label="Reason" htmlFor="cancel-reason" hint="Required, and kept in the audit trail.">
              <Input name="reason" required />
            </Field>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

function ReceivePanel({
  purchase,
  accounts,
  mayPay,
}: {
  purchase: PurchaseRow;
  accounts: PickableAccount[];
  mayPay: boolean;
}) {
  const [requestId] = React.useState(newRequestId);
  const [payNow, setPayNow] = React.useState(false);

  return (
    <ActionForm action={receivePurchaseAction} submitLabel="Receive stock" busyLabel="Receiving…">
      <input type="hidden" name="purchase_id" value={purchase.id} />
      <input type="hidden" name="request_id" value={requestId} />
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Every line is added to stock, once. A received purchase is corrected with a return to the
          supplier, never by un-receiving it.
        </p>

        {mayPay && purchase.payment_status === 'unpaid' && purchase.total_ugx > 0 && (
          <>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={payNow}
                onChange={(e) => setPayNow(e.target.checked)}
              />
              <span className="text-foreground">
                Pay {formatUgx(purchase.total_ugx)} at the same time
              </span>
            </label>
            {payNow && (
              <>
                <Field label="Pay from" htmlFor="pay_from_account_id">
                  <select id="pay_from_account_id" name="pay_from_account_id" className={selectClass} required>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Payment reference" htmlFor="reference" hint="Optional">
                  <Input name="reference" />
                </Field>
                <p className="text-muted-foreground text-xs">
                  Receipt and payment are one transaction: if the account cannot fund it, no stock is
                  received either.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </ActionForm>
  );
}

function PayPanel({ purchase, accounts }: { purchase: PurchaseRow; accounts: PickableAccount[] }) {
  const [requestId] = React.useState(newRequestId);
  return (
    <ActionForm action={payPurchaseAction} submitLabel="Pay supplier" busyLabel="Paying…">
      <input type="hidden" name="purchase_id" value={purchase.id} />
      <input type="hidden" name="request_id" value={requestId} />
      <div className="space-y-4">
        <div className="bg-surface-muted rounded-[var(--radius)] px-4 py-3 text-sm">
          <p className="text-foreground font-medium">
            {formatUgx(purchase.total_ugx)} leaves the account
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            Recorded as a stock purchase. It will not appear in expense reports.
          </p>
        </div>
        <Field label="Pay from" htmlFor="account_id">
          <select id="account_id" name="account_id" className={selectClass} required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Payment reference" htmlFor="pay-reference" hint="Optional">
          <Input name="reference" />
        </Field>
      </div>
    </ActionForm>
  );
}
