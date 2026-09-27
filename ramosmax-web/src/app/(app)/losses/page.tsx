import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { Card, CardBody } from '@/components/ui/card';
import { formatUgx } from '@/lib/format/money';
import { requireAnyPermission } from '@/lib/server/guard';
import { businessToday, listLosses, listStaff, outstandingLossTotal } from '@/lib/server/workforce';
import { LossesTable } from './losses-table';
import { ReportLossCard } from './report-loss';

export const metadata: Metadata = { title: 'Loss incidents' };

export default async function LossesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const granted = await requireAnyPermission('losses.view');
  const params = await searchParams;
  const status = params.status ?? 'all';

  const [losses, outstanding, today, staff] = await Promise.all([
    listLosses(status === 'all' ? undefined : status),
    outstandingLossTotal(),
    businessToday(),
    granted.has('losses.create') ? listStaff() : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Loss incidents"
        subtitle={`${losses.length} shown · ${formatUgx(outstanding)} outstanding`}
      />

      <Card className="bg-surface-muted">
        <CardBody>
          <p className="text-muted-foreground text-sm">
            An incident never deducts anything by itself. A staff member repays only an amount an
            approver decided they are liable for, through a schedule someone set up, and only when a
            payroll is actually paid.
          </p>
        </CardBody>
      </Card>

      {granted.has('losses.create') && <ReportLossCard staff={staff} today={today} />}

      <FilterTabs
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'reported', label: 'Reported' },
          { value: 'under_review', label: 'Under review' },
          { value: 'approved', label: 'Approved' },
          { value: 'recovery_scheduled', label: 'Scheduled' },
          { value: 'partially_recovered', label: 'Partly recovered' },
          { value: 'recovered', label: 'Recovered' },
          { value: 'rejected', label: 'Rejected' },
          { value: 'cancelled', label: 'Cancelled' },
        ]}
      />

      <LossesTable rows={losses} />
    </div>
  );
}
