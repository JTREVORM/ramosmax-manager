'use client';

import Link from 'next/link';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { ActionForm } from '@/components/forms/action-form';
import { formatUgx } from '@/lib/format/money';
import { createInvoiceAction } from '@/lib/server/billing-actions';
import type { InvoiceRow } from '@/lib/server/operations';

/**
 * The bridge from a finished job to its invoice. A job can only be invoiced
 * once it is complete, and the server refuses anything else.
 */
export function BillingSection({
  jobId,
  jobStatus,
  invoice,
  canCreate,
}: {
  jobId: string;
  jobStatus: string;
  invoice: InvoiceRow | null;
  canCreate: boolean;
}) {
  if (invoice) {
    return (
      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Billing</CardTitle>
          <StatusBadge status={invoice.payment_status} />
        </CardHeader>
        <CardBody className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Total</span>
            <span className="tabular text-foreground">{formatUgx(invoice.total_ugx)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Outstanding</span>
            <span className="tabular text-foreground font-medium">
              {formatUgx(invoice.outstanding_ugx)}
            </span>
          </div>
          <Link href={`/invoices/${invoice.id}`} className="text-primary block pt-1 text-sm hover:underline">
            Open {invoice.invoice_number}
          </Link>
        </CardBody>
      </Card>
    );
  }

  if (jobStatus !== 'completed' || !canCreate) return null;

  return (
    <Card className="bg-success-bg">
      <CardHeader>
        <CardTitle>Ready to invoice</CardTitle>
      </CardHeader>
      <CardBody>
        <p className="text-success mb-3 text-sm">
          All the work on this job is finished.
        </p>
        <ActionForm
          action={createInvoiceAction}
          submitLabel="Create invoice"
          redirectTo={(result) => (result.id ? `/invoices/${result.id}` : '/invoices')}
        >
          <input type="hidden" name="intake_id" value={jobId} />
        </ActionForm>
      </CardBody>
    </Card>
  );
}
