'use client';

import * as React from 'react';
import Link from 'next/link';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import { reversePaymentAction } from '@/lib/server/billing-actions';
import type { PaymentRow } from '@/lib/server/operations';

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  mtn_merchant: 'MTN',
  airtel_merchant: 'Airtel',
  bank: 'Bank',
};

export function PaymentHistory({
  payments,
  invoiceId,
  canReverse,
}: {
  payments: PaymentRow[];
  invoiceId: string;
  canReverse: boolean;
}) {
  const [reversing, setReversing] = React.useState<string | null>(null);

  if (payments.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments</CardTitle>
      </CardHeader>
      <CardBody className="p-0">
        <ul className="divide-border divide-y">
          {payments.map((payment) => {
            const reversed = payment.status === 'reversed';
            return (
              <li key={payment.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`tabular text-sm font-medium ${
                          reversed ? 'text-muted-foreground line-through' : 'text-foreground'
                        }`}
                      >
                        {formatUgx(payment.amount_ugx)}
                      </span>
                      <Badge tone={reversed ? 'danger' : 'success'}>
                        {reversed ? 'Reversed' : METHOD_LABELS[payment.method] ?? payment.method}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {formatDateTime(payment.created_at)}
                      {payment.created_by_name ? ` · ${payment.created_by_name}` : ''}
                      {payment.reference ? ` · ${payment.reference}` : ''}
                    </p>
                    {reversed && payment.reversal_reason && (
                      <p className="text-danger mt-0.5 text-xs">{payment.reversal_reason}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {payment.receipt_number && (
                      <Link
                        href={`/receipts/${payment.receipt_number}`}
                        className="text-primary text-xs hover:underline"
                      >
                        {payment.receipt_number}
                      </Link>
                    )}
                    {canReverse && !reversed && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setReversing(reversing === payment.id ? null : payment.id)}
                      >
                        Reverse
                      </Button>
                    )}
                  </div>
                </div>

                {reversing === payment.id && (
                  <div className="mt-3">
                    <ActionForm
                      action={reversePaymentAction}
                      submitLabel="Reverse payment"
                      confirm="Reverse this payment? The money is taken back out of the account it went into."
                    >
                      <input type="hidden" name="payment_id" value={payment.id} />
                      <input type="hidden" name="invoice_id" value={invoiceId} />
                      <Field
                        label="Reason"
                        htmlFor={`reverse-${payment.id}`}
                        hint="Required. The payment is kept and marked reversed."
                      >
                        <Input name="reason" required />
                      </Field>
                    </ActionForm>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
