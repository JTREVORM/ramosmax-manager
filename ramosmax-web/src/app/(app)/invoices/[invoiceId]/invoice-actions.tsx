'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx, parseUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import {
  applyDiscountAction, applyLoyaltyRewardAction, cancelInvoiceAction,
  markCreditAction, recordPaymentAction,
} from '@/lib/server/billing-actions';
import type { InvoiceRow, PaymentAccountRow, VehicleLoyalty } from '@/lib/server/operations';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'mtn_merchant', label: 'MTN Merchant' },
  { value: 'airtel_merchant', label: 'Airtel Merchant' },
  { value: 'bank', label: 'Bank' },
];

/**
 * What can be done to this invoice.
 *
 * Every amount shown is a PREVIEW for the person at the counter. The server
 * recomputes all of it and refuses anything that disagrees, so nothing here is
 * authoritative — it exists so a cashier can see what they are about to do.
 */
export function InvoiceActions({
  invoice,
  hasDiscount,
  accounts,
  loyalty,
  permissions,
}: {
  invoice: InvoiceRow;
  hasDiscount: boolean;
  accounts: PaymentAccountRow[];
  loyalty: VehicleLoyalty | null;
  permissions: string[];
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);

  const open = invoice.status !== 'cancelled';
  const owing = invoice.outstanding_ugx > 0;
  const noPayments = invoice.paid_ugx === 0;

  const canPay = open && owing && can('payments.record');
  const canDiscount = open && owing && noPayments && !hasDiscount && can('discounts.apply');
  const canReward =
    open && owing && noPayments && !hasDiscount && can('loyalty.redeem')
    && (loyalty?.reward_available ?? false);
  const canCredit = open && owing && !invoice.on_credit && can('credit.manage');
  const canCancel = open && noPayments && can('invoices.void');

  if (!canPay && !canDiscount && !canReward && !canCredit && !canCancel) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {canPay && (
            <Button size="sm" onClick={() => setPanel(panel === 'pay' ? null : 'pay')}>
              Take payment
            </Button>
          )}
          {canReward && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPanel(panel === 'reward' ? null : 'reward')}
            >
              Use loyalty reward
            </Button>
          )}
          {canDiscount && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPanel(panel === 'discount' ? null : 'discount')}
            >
              Apply discount
            </Button>
          )}
          {canCredit && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPanel(panel === 'credit' ? null : 'credit')}
            >
              Put on credit
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}>
              Cancel invoice
            </Button>
          )}
        </div>

        {panel === 'pay' && <PaymentPanel invoice={invoice} accounts={accounts} />}
        {panel === 'reward' && loyalty && <RewardPanel invoice={invoice} loyalty={loyalty} />}
        {panel === 'discount' && <DiscountPanel invoice={invoice} />}
        {panel === 'credit' && (
          <ActionForm action={markCreditAction} submitLabel="Put on credit">
            <input type="hidden" name="invoice_id" value={invoice.id} />
            <p className="text-muted-foreground mb-3 text-sm">
              Credit records money <strong>owed</strong>. No cash is received and nothing is posted
              to an account.
            </p>
            <Field label="Reason" htmlFor="credit-reason" hint="Required, and kept in the audit trail.">
              <Input name="reason" required />
            </Field>
          </ActionForm>
        )}
        {panel === 'cancel' && (
          <ActionForm
            action={cancelInvoiceAction}
            submitLabel="Cancel invoice"
            confirm="Cancel this invoice? The job can then be invoiced again."
          >
            <input type="hidden" name="invoice_id" value={invoice.id} />
            <Field label="Reason" htmlFor="cancel-reason" hint="Required, and kept in the audit trail.">
              <Input name="reason" required />
            </Field>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Taking a payment.
 *
 * The request id is generated ONCE when this panel opens and reused for every
 * attempt, so a double tap or a retry after a lost response reaches the same
 * logical payment and cannot charge twice.
 */
function PaymentPanel({
  invoice,
  accounts,
}: {
  invoice: InvoiceRow;
  accounts: PaymentAccountRow[];
}) {
  const [requestId] = React.useState(newRequestId);
  const [method, setMethod] = React.useState('cash');
  const [amount, setAmount] = React.useState(String(invoice.outstanding_ugx));

  const parsed = parseUgx(amount);
  const tooMuch = parsed !== null && parsed > invoice.outstanding_ugx;
  const banks = accounts.filter((a) => a.type === 'bank');

  return (
    <ActionForm action={recordPaymentAction} submitLabel="Record payment" busyLabel="Recording…">
      <input type="hidden" name="invoice_id" value={invoice.id} />
      <input type="hidden" name="request_id" value={requestId} />

      <div className="space-y-4">
        <Field
          label="Amount (UGX)"
          htmlFor="amount_ugx"
          hint={`Outstanding ${formatUgx(invoice.outstanding_ugx)}. A part payment is fine.`}
          error={tooMuch ? 'That is more than the outstanding balance.' : undefined}
        >
          <Input
            name="amount_ugx"
            type="number"
            inputMode="numeric"
            min={1}
            max={invoice.outstanding_ugx}
            required
            className="tabular text-lg"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>

        <Field label="Method" htmlFor="method">
          <select
            id="method"
            name="method"
            className={selectClass}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>

        {method === 'bank' && banks.length > 1 && (
          <Field label="Bank account" htmlFor="account_id">
            <select id="account_id" name="account_id" className={selectClass} required>
              {banks.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {method !== 'cash' && (
          <Field
            label="Transaction reference"
            htmlFor="reference"
            hint="Required for every method except cash."
          >
            <Input name="reference" required />
          </Field>
        )}

        <Field label="Notes" htmlFor="payment-notes" hint="Optional">
          <Input name="notes" />
        </Field>
      </div>
    </ActionForm>
  );
}

function RewardPanel({ invoice, loyalty }: { invoice: InvoiceRow; loyalty: VehicleLoyalty }) {
  // The preview and the amount sent are the same figure. If the server would
  // apply anything else it refuses rather than charging a different amount.
  const expected = Math.floor((invoice.subtotal_ugx * loyalty.reward_percent + 50) / 100);

  return (
    <ActionForm action={applyLoyaltyRewardAction} submitLabel="Use the reward">
      <input type="hidden" name="invoice_id" value={invoice.id} />
      <input type="hidden" name="expected_ugx" value={expected} />
      <div className="bg-surface-muted space-y-1 rounded-[var(--radius)] px-4 py-3 text-sm">
        <p className="text-foreground font-medium">
          {loyalty.reward_percent}% off — {formatUgx(expected)}
        </p>
        <p className="text-muted-foreground">
          New total {formatUgx(invoice.subtotal_ugx - expected)}
        </p>
        <p className="text-muted-foreground">
          Points {loyalty.points_balance} → {Math.max(0, loyalty.points_balance - 200)}
        </p>
      </div>
    </ActionForm>
  );
}

function DiscountPanel({ invoice }: { invoice: InvoiceRow }) {
  const [type, setType] = React.useState('percentage');
  const [value, setValue] = React.useState('10');
  const [reasonCode, setReasonCode] = React.useState('promotional');

  const numeric = Number(value);
  const preview = Number.isFinite(numeric)
    ? type === 'percentage'
      ? Math.floor((invoice.subtotal_ugx * numeric + 50) / 100)
      : numeric
    : 0;
  // The threshold above which a manager must approve; the server enforces it.
  const needsApproval = preview * 100 > invoice.subtotal_ugx * 25;

  return (
    <ActionForm action={applyDiscountAction} submitLabel="Apply discount">
      <input type="hidden" name="invoice_id" value={invoice.id} />
      <div className="space-y-4">
        <Field label="Type" htmlFor="discount_type">
          <select
            id="discount_type"
            name="discount_type"
            className={selectClass}
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="percentage">Percentage</option>
            <option value="fixed">Fixed amount</option>
          </select>
        </Field>

        <Field label={type === 'percentage' ? 'Percent' : 'Amount (UGX)'} htmlFor="discount_value">
          <Input
            name="discount_value"
            type="number"
            inputMode="numeric"
            min={1}
            required
            className="tabular"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>

        <Field label="Reason" htmlFor="reason_code">
          <select
            id="reason_code"
            name="reason_code"
            className={selectClass}
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
          >
            <option value="promotional">Promotional</option>
            <option value="service_issue">Service issue</option>
            <option value="manager_approval">Manager approval</option>
            <option value="other">Other</option>
          </select>
        </Field>

        {reasonCode === 'other' && (
          <Field label="Description" htmlFor="description" hint="Required when the reason is Other.">
            <Input name="description" required />
          </Field>
        )}

        <div className="bg-surface-muted rounded-[var(--radius)] px-4 py-3 text-sm">
          <p className="text-foreground">
            {formatUgx(preview)} off · new total {formatUgx(Math.max(0, invoice.subtotal_ugx - preview))}
          </p>
          {needsApproval && (
            <p className="text-warning mt-1">
              Above 25% — this needs a manager&rsquo;s approval.
            </p>
          )}
        </div>
      </div>
    </ActionForm>
  );
}
