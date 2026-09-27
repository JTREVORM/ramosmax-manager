import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import { listPickableAccounts } from '@/lib/server/finance';
import { businessToday } from '@/lib/server/workforce';
import { getDividend, listAllocations } from '@/lib/server/ownership';
import { DIVIDEND_METHOD_LABELS } from '@/lib/format/ownership';
import { AllocationsTable } from '../dividends-tables';
import { DividendActions } from './dividend-actions';

export const metadata: Metadata = { title: 'Dividend' };

export default async function DividendPage({
  params,
}: {
  params: Promise<{ dividendId: string }>;
}) {
  const granted = await requireAnyPermission('dividends.view');
  const { dividendId } = await params;
  const dividend = await getDividend(dividendId);
  if (!dividend) notFound();

  const [allocations, accounts, today] = await Promise.all([
    listAllocations(dividendId),
    granted.has('dividends.pay') ? listPickableAccounts() : Promise.resolve([]),
    businessToday(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title={dividend.dividend_number}
        subtitle={`${dividend.financial_period} · ${dividend.class_code ?? 'All classes'}`}
        back={{ href: '/dividends', label: 'Dividends' }}
        action={<StatusBadge status={dividend.status} />}
      />

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Method" value={DIVIDEND_METHOD_LABELS[dividend.calculation_method] ?? dividend.calculation_method} />
          {dividend.total_distributable_ugx !== null && (
            <Row label="Pool" value={formatUgx(dividend.total_distributable_ugx)} strong />
          )}
          {dividend.dividend_per_share_ugx !== null && (
            <Row label="Declared per share" value={formatUgx(dividend.dividend_per_share_ugx)} strong />
          )}
          {dividend.per_share_rate !== null && (
            <Row
              label="Works out at"
              value={`${Number(dividend.per_share_rate).toFixed(4)} a share`}
            />
          )}
          <Row label="Record date" value={formatDate(dividend.record_date)} />
          <Row label="Declaration date" value={formatDate(dividend.declaration_date)} />
          {dividend.payment_date && (
            <Row label="Payment date" value={formatDate(dividend.payment_date)} />
          )}
          <Row
            label="Eligible"
            value={`${Number(dividend.eligible_shares).toLocaleString('en-US')} shares · ${dividend.eligible_shareholder_count} shareholders`}
          />
          <Row label="Allocated" value={formatUgx(dividend.allocated_ugx)} />
          {dividend.unallocated_ugx > 0 && (
            <Row
              label="Left over from rounding"
              value={formatUgx(dividend.unallocated_ugx)}
            />
          )}
          <Row label="Paid" value={`${formatUgx(dividend.paid_ugx)} · ${dividend.paid_count}`} />
          <Row label="Outstanding" value={formatUgx(dividend.outstanding_ugx)} />
          {dividend.notes && <Row label="Notes" value={dividend.notes} />}
        </CardBody>
      </Card>

      {dividend.record_locked && (
        <Card className="bg-surface-muted">
          <CardBody>
            <p className="text-muted-foreground text-sm">
              The record date is locked. No share transaction may take effect on or before{' '}
              {formatDate(dividend.record_date)}, so what this dividend pays cannot change
              underneath it.
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardBody className="space-y-1.5">
          <Row
            label="Calculated"
            value={
              dividend.calculated_at
                ? `${dividend.calculated_by_name ?? '—'} · ${formatDateTime(dividend.calculated_at)}`
                : 'Not yet'
            }
          />
          <Row
            label="Declared"
            value={
              dividend.declared_at
                ? `${dividend.declared_by_name ?? '—'} · ${formatDateTime(dividend.declared_at)}`
                : 'Not yet'
            }
          />
          <Row
            label="Approved"
            value={
              dividend.approved_at
                ? `${dividend.approved_by_name ?? '—'} · ${formatDateTime(dividend.approved_at)}`
                : 'Not yet'
            }
          />
          {dividend.returned_reason && (
            <Row label="Returned because" value={dividend.returned_reason} />
          )}
          {dividend.cancel_reason && <Row label="Cancelled because" value={dividend.cancel_reason} />}
        </CardBody>
      </Card>

      <DividendActions
        dividend={dividend}
        allocations={allocations}
        accounts={accounts}
        permissions={[...granted]}
        today={today}
      />

      <AllocationsTable rows={allocations} />
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className={`tabular text-sm ${strong ? 'text-foreground font-semibold' : 'text-foreground'}`}>
        {value}
      </span>
    </div>
  );
}
