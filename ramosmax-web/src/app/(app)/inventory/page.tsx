import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { SearchField } from '@/components/ui/search-field';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { formatUgx } from '@/lib/format/money';
import { listItems } from '@/lib/server/finance';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';
import { ItemsTable } from './items-table';

export const metadata: Metadata = { title: 'Inventory' };

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  await requireAnyPermission('inventory.view');
  const params = await searchParams;
  const [items, user] = await Promise.all([
    listItems(params.q ?? '', params.status ?? 'all'),
    currentUser(),
  ]);
  const permissions = user?.permissions ?? [];

  const low = items.filter((i) => i.stock_status !== 'ok' && i.active).length;
  // Indicative only: quantity × last purchase cost, for items that have one.
  const indicative = items
    .filter((i) => i.last_unit_cost_ugx != null)
    .reduce((sum, i) => sum + i.quantity * Number(i.last_unit_cost_ugx), 0);
  const withoutCost = items.filter((i) => i.last_unit_cost_ugx == null).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inventory"
        subtitle={`${items.length} item${items.length === 1 ? '' : 's'}`}
        action={
          permissions.includes('inventory.manage') ? (
            <Link href="/inventory/items/new">
              <Button size="sm">New item</Button>
            </Link>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Card className={low > 0 ? 'bg-warning-bg' : undefined}>
          <CardBody>
            <p className={`text-xs ${low > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
              Low or out of stock
            </p>
            <p className="tabular text-foreground mt-1 text-2xl font-semibold">{low}</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-muted-foreground text-xs">Indicative stock value</p>
            <p className="tabular text-foreground mt-1 text-2xl font-semibold">
              {formatUgx(indicative)}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              Quantity × last purchase cost. Not an accounting valuation
              {withoutCost > 0 ? `; ${withoutCost} item(s) have no cost and are excluded` : ''}.
            </p>
          </CardBody>
        </Card>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/inventory/purchases" className="text-primary hover:underline">Purchases</Link>
        <Link href="/inventory/suppliers" className="text-primary hover:underline">Suppliers</Link>
        <Link href="/inventory/movements" className="text-primary hover:underline">Movements</Link>
      </div>

      <SearchField label="Search inventory" placeholder="Name, SKU or category" />
      <FilterTabs
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'low', label: 'Low' },
          { value: 'out_of_stock', label: 'Out of stock' },
          { value: 'ok', label: 'In stock' },
        ]}
      />
      <ItemsTable items={items} />
    </div>
  );
}
