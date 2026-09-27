import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import { getSupplier, listPurchases } from '@/lib/server/finance';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Supplier' };

export default async function SupplierPage({
  params,
}: {
  params: Promise<{ supplierId: string }>;
}) {
  await requireAnyPermission('inventory.view');
  const { supplierId } = await params;
  const [supplier, purchases] = await Promise.all([getSupplier(supplierId), listPurchases('all')]);
  if (!supplier) notFound();

  const theirs = purchases.filter((p) => p.supplier_id === supplierId);

  return (
    <div className="space-y-4">
      <PageHeader
        title={supplier.name}
        subtitle={supplier.supplier_number}
        back={{ href: '/inventory/suppliers', label: 'Suppliers' }}
        action={supplier.active ? undefined : <Badge tone="neutral">Inactive</Badge>}
      />

      <Card>
        <CardBody className="space-y-1.5">
          {supplier.contact_person && <Row label="Contact" value={supplier.contact_person} />}
          {supplier.phone && <Row label="Phone" value={supplier.phone} />}
          {supplier.email && <Row label="Email" value={supplier.email} />}
          {supplier.address && <Row label="Address" value={supplier.address} />}
          <Row label="Purchases" value={String(supplier.purchase_count)} />
          <Row label="Total purchased" value={formatUgx(supplier.total_purchased_ugx)} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Purchase history</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {theirs.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/inventory/purchases/${p.id}`}
                  className="active:bg-surface-muted hover:bg-surface-muted flex items-start justify-between gap-3 px-4 py-3"
                >
                  <span className="min-w-0">
                    <span className="text-foreground block truncate text-sm">{p.purchase_number}</span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {formatDate(p.purchase_date)} · {p.line_count} line
                      {p.line_count === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tabular text-foreground block text-sm">
                      {formatUgx(p.total_ugx)}
                    </span>
                    <StatusBadge status={p.status} />
                  </span>
                </Link>
              </li>
            ))}
            {theirs.length === 0 && (
              <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                No purchases from this supplier yet.
              </li>
            )}
          </ul>
        </CardBody>
      </Card>
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
