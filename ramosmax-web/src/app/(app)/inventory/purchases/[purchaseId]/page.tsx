import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { getPurchase, listPickableAccounts, listPurchaseLines } from '@/lib/server/finance';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';
import { PurchaseActions } from './purchase-actions';

export const metadata: Metadata = { title: 'Purchase' };

export default async function PurchasePage({
  params,
}: {
  params: Promise<{ purchaseId: string }>;
}) {
  await requireAnyPermission('inventory.view');
  const { purchaseId } = await params;
  const [purchase, lines, accounts, user] = await Promise.all([
    getPurchase(purchaseId),
    listPurchaseLines(purchaseId),
    listPickableAccounts(),
    currentUser(),
  ]);
  if (!purchase) notFound();

  return (
    <div className="space-y-4">
      <PageHeader
        title={purchase.purchase_number}
        subtitle={purchase.supplier_name}
        back={{ href: '/inventory/purchases', label: 'Purchases' }}
        action={<StatusBadge status={purchase.status} />}
      />

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {lines.map((line) => (
              <li key={line.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <span className="min-w-0">
                  <span className="text-foreground block truncate text-sm">{line.name}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {line.sku} · {line.quantity} {line.unit} × {formatUgx(line.unit_cost_ugx)}
                  </span>
                </span>
                <span className="tabular text-foreground shrink-0 text-sm">
                  {formatUgx(line.line_total_ugx)}
                </span>
              </li>
            ))}
          </ul>
          <div className="border-border flex justify-between border-t px-4 py-3">
            <span className="text-foreground text-sm font-medium">Total</span>
            <span className="tabular text-foreground text-sm font-semibold">
              {formatUgx(purchase.total_ugx)}
            </span>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Dated" value={formatDate(purchase.purchase_date)} />
          {purchase.supplier_reference && (
            <Row label="Supplier reference" value={purchase.supplier_reference} />
          )}
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground text-sm">Payment</span>
            {purchase.payment_status === 'paid' ? (
              <Badge tone="success">Paid</Badge>
            ) : (
              <Badge tone="warning">Unpaid</Badge>
            )}
          </div>
          {purchase.received_at && (
            <Row
              label="Received"
              value={`${formatDateTime(purchase.received_at)}${
                purchase.received_by_name ? ` · ${purchase.received_by_name}` : ''
              }`}
            />
          )}
          {purchase.cancel_reason && <Row label="Cancelled" value={purchase.cancel_reason} />}
          {purchase.payment_reversal_reason && (
            <Row label="Payment reversed" value={purchase.payment_reversal_reason} />
          )}
        </CardBody>
      </Card>

      <PurchaseActions
        purchase={purchase}
        accounts={accounts}
        permissions={user?.permissions ?? []}
      />

      {purchase.financial_transaction_id && (
        <Card>
          <CardBody>
            <Link
              href={`/transactions/${purchase.financial_transaction_id}`}
              className="text-primary text-sm hover:underline"
            >
              Ledger entry {purchase.financial_transaction_number}
            </Link>
            <p className="text-muted-foreground mt-1 text-xs">
              Recorded as a stock purchase, not an operating expense.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-foreground text-sm">{value}</span>
    </div>
  );
}
