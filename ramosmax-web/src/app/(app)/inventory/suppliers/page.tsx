import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { SearchField } from '@/components/ui/search-field';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUgx } from '@/lib/format/money';
import { listSuppliers } from '@/lib/server/finance';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';
import { SupplierForm } from './supplier-form';

export const metadata: Metadata = { title: 'Suppliers' };

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireAnyPermission('inventory.view');
  const { q } = await searchParams;
  const [suppliers, user] = await Promise.all([listSuppliers(q ?? ''), currentUser()]);
  const canManage = user?.permissions.includes('inventory.suppliers.manage') ?? false;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Suppliers"
        subtitle={`${suppliers.length} shown`}
        back={{ href: '/inventory', label: 'Inventory' }}
      />

      {canManage && <SupplierForm />}

      <SearchField label="Search suppliers" placeholder="Name or contact" />

      <Card>
        <CardHeader>
          <CardTitle>Suppliers</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {suppliers.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/inventory/suppliers/${s.id}`}
                  className="active:bg-surface-muted hover:bg-surface-muted flex items-start justify-between gap-3 px-4 py-3"
                >
                  <span className="min-w-0">
                    <span className="text-foreground block truncate text-sm font-medium">{s.name}</span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {s.supplier_number}
                      {s.contact_person ? ` · ${s.contact_person}` : ''}
                      {s.phone ? ` · ${s.phone}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tabular text-foreground block text-sm">
                      {formatUgx(s.total_purchased_ugx)}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {s.purchase_count} purchase{s.purchase_count === 1 ? '' : 's'}
                    </span>
                    {!s.active && <Badge tone="neutral">Inactive</Badge>}
                  </span>
                </Link>
              </li>
            ))}
            {suppliers.length === 0 && (
              <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                No suppliers yet.
              </li>
            )}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
