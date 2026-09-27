import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { Card, CardBody } from '@/components/ui/card';
import { PaymentsTable } from './payments-table';
import { listPayments } from '@/lib/server/operations';
import { requireAnyPermission } from '@/lib/server/guard';
import { formatUgx } from '@/lib/format/money';

export const metadata: Metadata = { title: 'Payments' };

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; method?: string }>;
}) {
  await requireAnyPermission('payments.view');
  const params = await searchParams;
  const payments = await listPayments(params.period ?? 'today', params.method ?? 'all');

  const active = payments.filter((p) => p.status === 'active');
  const total = active.reduce((sum, p) => sum + Number(p.amount_ugx), 0);
  const byMethod = active.reduce<Record<string, number>>((acc, p) => {
    acc[p.method] = (acc[p.method] ?? 0) + Number(p.amount_ugx);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <PageHeader title="Payments" subtitle={`${active.length} received`} />
      <FilterTabs
        param="period"
        defaultValue="today"
        options={[
          { value: 'today', label: 'Today' },
          { value: 'week', label: '7 days' },
          { value: 'month', label: '30 days' },
          { value: 'all', label: 'All' },
        ]}
      />

      <Card>
        <CardBody>
          <p className="text-muted-foreground text-xs">Received (reversals excluded)</p>
          <p className="tabular text-foreground text-2xl font-semibold">{formatUgx(total)}</p>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Object.entries(byMethod).map(([method, amount]) => (
              <div key={method}>
                <dt className="text-muted-foreground text-xs capitalize">
                  {method.replace(/_/g, ' ')}
                </dt>
                <dd className="tabular text-foreground text-sm">{formatUgx(amount)}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>

      <PaymentsTable payments={payments} />
    </div>
  );
}
