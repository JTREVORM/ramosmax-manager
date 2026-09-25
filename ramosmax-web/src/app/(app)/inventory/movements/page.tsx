import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { listStockMovements } from '@/lib/server/finance';
import { requireAnyPermission } from '@/lib/server/guard';
import { MovementsTable } from './movements-table';

export const metadata: Metadata = { title: 'Stock movements' };

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  await requireAnyPermission('inventory.view');
  const { type = 'all' } = await searchParams;
  const movements = await listStockMovements(type);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Stock movements"
        subtitle="Every change to every quantity, in order."
        back={{ href: '/inventory', label: 'Inventory' }}
      />
      <FilterTabs
        param="type"
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'stock_in', label: 'Stock in' },
          { value: 'usage', label: 'Usage' },
          { value: 'stock_out', label: 'Stock out' },
          { value: 'adjustment_in', label: 'Count up' },
          { value: 'adjustment_out', label: 'Count down' },
          { value: 'reversal', label: 'Reversals' },
        ]}
      />
      <MovementsTable movements={movements} />
    </div>
  );
}
