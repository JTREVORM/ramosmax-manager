import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody } from '@/components/ui/card';
import { CreditTable } from './credit-table';
import { listCredit } from '@/lib/server/operations';
import { requireAnyPermission } from '@/lib/server/guard';
import { formatUgx } from '@/lib/format/money';

export const metadata: Metadata = { title: 'Credit' };

/**
 * Receivables. Credit is money OWED, never cash received, so nothing here is
 * counted as revenue or posted to an account.
 */
export default async function CreditPage() {
  await requireAnyPermission('credit.view');
  const invoices = await listCredit();

  const total = invoices.reduce((sum, i) => sum + Number(i.outstanding_ugx), 0);
  const buckets = [
    { label: 'Today', match: (d: number) => d === 0 },
    { label: 'This week', match: (d: number) => d >= 1 && d <= 7 },
    { label: 'This month', match: (d: number) => d > 7 && d <= 30 },
    { label: 'Older', match: (d: number) => d > 30 },
  ].map((bucket) => ({
    label: bucket.label,
    amount: invoices
      .filter((i) => bucket.match(Number(i.days_owed)))
      .reduce((sum, i) => sum + Number(i.outstanding_ugx), 0),
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Credit"
        subtitle={`${invoices.length} invoice${invoices.length === 1 ? '' : 's'} with money owed`}
      />

      <Card>
        <CardBody>
          <p className="text-muted-foreground text-xs">Total outstanding</p>
          <p className="tabular text-foreground text-2xl font-semibold">{formatUgx(total)}</p>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {buckets.map((bucket) => (
              <div key={bucket.label}>
                <dt className="text-muted-foreground text-xs">{bucket.label}</dt>
                <dd className="tabular text-foreground text-sm">{formatUgx(bucket.amount)}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>

      <CreditTable invoices={invoices} />
    </div>
  );
}
