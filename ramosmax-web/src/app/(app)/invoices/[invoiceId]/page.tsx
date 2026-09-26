import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import {
  getInvoice, getInvoiceDiscount, getVehicleLoyalty,
  listInvoiceItems, listInvoicePayments, listPaymentAccounts,
} from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';
import { paymentContext } from '@/lib/server/after-hours';
import { InvoiceActions } from './invoice-actions';
import { PaymentHistory } from './payment-history';

export const metadata: Metadata = { title: 'Invoice' };

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  await requireAnyPermission('invoices.view');
  const { invoiceId } = await params;
  const invoice = await getInvoice(invoiceId);
  if (!invoice) notFound();

  const [items, discount, payments, accounts, user, afterHours] = await Promise.all([
    listInvoiceItems(invoiceId),
    getInvoiceDiscount(invoiceId),
    listInvoicePayments(invoiceId),
    listPaymentAccounts(),
    currentUser(),
    paymentContext(),
  ]);
  const permissions = new Set(user?.permissions ?? []);
  const loyalty = permissions.has('loyalty.view') || permissions.has('loyalty.redeem')
    ? await getVehicleLoyalty(invoice.vehicle_id)
    : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={invoice.invoice_number}
        subtitle={`${invoice.number_plate} · ${invoice.customer_name ?? 'Walk-in'}`}
        back={{ href: '/invoices', label: 'Invoices' }}
        action={<StatusBadge status={invoice.payment_status} />}
      />

      <Card>
        <CardHeader>
          <CardTitle>Services</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {items.map((item) => (
              <li key={item.id} className="flex justify-between px-4 py-2.5">
                <span className="text-foreground text-sm">{item.service_name}</span>
                <span className="tabular text-foreground text-sm">{formatUgx(item.price_ugx)}</span>
              </li>
            ))}
          </ul>
          <dl className="border-border space-y-1.5 border-t px-4 py-3">
            <Row label="Subtotal" value={formatUgx(invoice.subtotal_ugx)} />
            {invoice.discount_ugx > 0 && (
              <Row
                label={
                  discount?.source === 'loyalty_reward'
                    ? 'Loyalty reward'
                    : `Discount${discount ? ` · ${discount.reason_code.replace(/_/g, ' ')}` : ''}`
                }
                value={`− ${formatUgx(invoice.discount_ugx)}`}
              />
            )}
            <Row label="Total" value={formatUgx(invoice.total_ugx)} strong />
            <Row label="Paid" value={formatUgx(invoice.paid_ugx)} />
            <Row label="Outstanding" value={formatUgx(invoice.outstanding_ugx)} strong />
          </dl>
        </CardBody>
      </Card>

      {invoice.on_credit && invoice.outstanding_ugx > 0 && (
        <Card className="bg-warning-bg">
          <CardBody>
            <p className="text-warning text-sm font-medium">
              On credit — {formatUgx(invoice.outstanding_ugx)} owed
            </p>
            {invoice.credit_reason && (
              <p className="text-warning mt-1 text-sm opacity-90">{invoice.credit_reason}</p>
            )}
          </CardBody>
        </Card>
      )}

      {invoice.status === 'cancelled' && (
        <Card className="bg-danger-bg">
          <CardBody>
            <p className="text-danger text-sm">Cancelled: {invoice.cancel_reason}</p>
          </CardBody>
        </Card>
      )}

      <InvoiceActions
        invoice={invoice}
        hasDiscount={discount !== null}
        accounts={accounts}
        afterHours={afterHours}
        loyalty={loyalty}
        permissions={[...permissions]}
      />

      <PaymentHistory
        payments={payments}
        invoiceId={invoiceId}
        canReverse={permissions.has('payments.reverse')}
      />

      <Card>
        <CardHeader>
          <CardTitle>Job</CardTitle>
        </CardHeader>
        <CardBody className="space-y-1 text-sm">
          <p className="text-muted-foreground">
            Raised {formatDateTime(invoice.created_at)}
            {invoice.created_by_name ? ` by ${invoice.created_by_name}` : ''}
          </p>
          <Link href={`/jobs/${invoice.service_intake_id}`} className="text-primary hover:underline">
            {invoice.job_number}
          </Link>
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={strong ? 'text-foreground text-sm font-medium' : 'text-muted-foreground text-sm'}>
        {label}
      </dt>
      <dd className={`tabular text-sm ${strong ? 'text-foreground font-semibold' : 'text-foreground'}`}>
        {value}
      </dd>
    </div>
  );
}
