import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { requireAnyPermission } from '@/lib/server/guard';
import { businessToday } from '@/lib/server/workforce';
import { listDividends, listShareClasses } from '@/lib/server/ownership';
import { DividendsTable } from './dividends-tables';
import { NewDividendCard } from './dividend-forms';

export const metadata: Metadata = { title: 'Dividends' };

export default async function DividendsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const granted = await requireAnyPermission('dividends.view');
  const params = await searchParams;
  const status = params.status ?? 'all';

  const [dividends, all, classes, today] = await Promise.all([
    listDividends(status),
    status === 'all' ? Promise.resolve(null) : listDividends('all'),
    listShareClasses(),
    businessToday(),
  ]);

  const counted = all ?? dividends;
  const count = (s: string) => counted.filter((d) => d.status === s).length;
  const awaiting = count('declared');

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dividends"
        subtitle={awaiting > 0 ? `${awaiting} awaiting approval` : 'Declared, approved, distributed'}
      />

      <NewDividendCard classes={classes} today={today} canCreate={granted.has('dividends.create')} />

      <FilterTabs
        param="status"
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'draft', label: `Draft (${count('draft')})` },
          { value: 'declared', label: `Declared (${awaiting})` },
          { value: 'approved', label: `Approved (${count('approved')})` },
          { value: 'partially_paid', label: 'Part paid' },
          { value: 'paid', label: 'Paid' },
          { value: 'cancelled', label: 'Cancelled' },
        ]}
      />

      <DividendsTable rows={dividends} />
    </div>
  );
}
