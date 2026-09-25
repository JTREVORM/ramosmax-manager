import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import { getReceipt } from '@/lib/server/operations';
import { requireAnyPermission } from '@/lib/server/guard';
import { ShareReceipt } from './share-receipt';

export const metadata: Metadata = { title: 'Receipt' };

interface Snapshot {
  businessName: string; receiptNumber: string; invoiceNumber: string; jobNumber: string;
  numberPlate: string; customerName: string | null;
  lines: { name: string; priceUgx: number }[];
  subtotalUgx: number; discountUgx: number; totalUgx: number;
  paymentUgx: number; method: string; reference: string | null;
  paidUgx: number; balanceUgx: number; pointsEarned: number; pointsBalance: number;
  cashier: string | null; issuedAt: string;
}

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ receiptNumber: string }>;
}) {
  await requireAnyPermission('payments.view', 'invoices.view');
  const { receiptNumber } = await params;
  const receipt = await getReceipt(decodeURIComponent(receiptNumber));
  if (!receipt) notFound();

  const s = receipt.snapshot as unknown as Snapshot;

  return (
    <div className="mx-auto max-w-md space-y-4">
      <PageHeader
        title={s.receiptNumber}
        back={{ href: `/invoices/${receipt.invoice_id}`, label: 'Invoice' }}
        action={receipt.status === 'reversed' ? <Badge tone="danger">Reversed</Badge> : undefined}
      />

      <Card>
        <CardBody className="space-y-4">
          <div className="border-border border-b pb-3 text-center">
            <p className="text-foreground font-semibold">{s.businessName}</p>
            <p className="text-muted-foreground text-xs">Receipt {s.receiptNumber}</p>
          </div>

          <dl className="space-y-1 text-sm">
            <Line label="Invoice" value={s.invoiceNumber} />
            <Line label="Job" value={s.jobNumber} />
            <Line label="Vehicle" value={s.numberPlate} />
            <Line label="Customer" value={s.customerName ?? 'Walk-in'} />
          </dl>

          <ul className="border-border divide-border divide-y border-y">
            {s.lines.map((line) => (
              <li key={line.name} className="flex justify-between py-2 text-sm">
                <span className="text-foreground">{line.name}</span>
                <span className="tabular text-foreground">{formatUgx(line.priceUgx)}</span>
              </li>
            ))}
          </ul>

          <dl className="space-y-1 text-sm">
            <Line label="Subtotal" value={formatUgx(s.subtotalUgx)} />
            {s.discountUgx > 0 && <Line label="Discount" value={`− ${formatUgx(s.discountUgx)}`} />}
            <Line label="Total" value={formatUgx(s.totalUgx)} strong />
            <Line label="This payment" value={formatUgx(s.paymentUgx)} strong />
            <Line label="Method" value={s.method.replace(/_/g, ' ')} />
            {s.reference && <Line label="Reference" value={s.reference} />}
            <Line label="Paid so far" value={formatUgx(s.paidUgx)} />
            <Line label="Balance" value={formatUgx(s.balanceUgx)} strong />
          </dl>

          {s.pointsEarned > 0 && (
            <p className="bg-info-bg text-info rounded-[var(--radius)] px-3 py-2 text-sm">
              {s.pointsEarned} loyalty points earned · balance {s.pointsBalance}
            </p>
          )}

          <p className="text-muted-foreground border-border border-t pt-3 text-center text-xs">
            {s.cashier ? `Served by ${s.cashier} · ` : ''}
            {formatDateTime(s.issuedAt)}
          </p>
        </CardBody>
      </Card>

      <ShareReceipt snapshot={receipt.snapshot} />
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`tabular ${strong ? 'text-foreground font-semibold' : 'text-foreground'}`}>
        {value}
      </dd>
    </div>
  );
}
