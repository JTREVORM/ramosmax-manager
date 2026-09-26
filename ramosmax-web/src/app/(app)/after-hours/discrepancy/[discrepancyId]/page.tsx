import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import { difference, DISCREPANCY_KIND_LABELS } from '@/lib/format/after-hours';
import { requireAnyPermission } from '@/lib/server/guard';
import { sessionUserId } from '@/lib/server/session';
import { getDiscrepancy } from '@/lib/server/after-hours';
import { DiscrepancyActions } from './discrepancy-actions';

export const metadata: Metadata = { title: 'Cash discrepancy' };

export default async function DiscrepancyPage({
  params,
}: {
  params: Promise<{ discrepancyId: string }>;
}) {
  const granted = await requireAnyPermission(
    'after_hours.view', 'after_hours.request', 'after_hours.discrepancy.review',
    'cash_handover.approve',
  );
  const { discrepancyId } = await params;
  const [discrepancy, viewer] = await Promise.all([
    getDiscrepancy(discrepancyId), sessionUserId(),
  ]);
  if (!discrepancy) notFound();

  return (
    <div className="space-y-4">
      <PageHeader
        title={discrepancy.discrepancy_number}
        subtitle={`${discrepancy.staff_name} · ${DISCREPANCY_KIND_LABELS[discrepancy.kind] ?? discrepancy.kind}`}
        back={{ href: '/after-hours?tab=discrepancies', label: 'After-hours' }}
        action={<StatusBadge status={discrepancy.status} />}
      />

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Expected" value={formatUgx(discrepancy.expected_cash_ugx)} />
          {discrepancy.declared_amount_ugx !== null && (
            <Row label="Declared" value={formatUgx(discrepancy.declared_amount_ugx)} />
          )}
          <Row label="Counted" value={formatUgx(discrepancy.actual_amount_ugx)} />
          <Row label="Difference" value={difference(discrepancy.difference_ugx)} strong />
          <Row label="Reported by" value={discrepancy.reported_by_name ?? '—'} />
          <Row label="Reported" value={formatDateTime(discrepancy.reported_at)} />
          <Row label="Explanation given" value={discrepancy.reason} />
        </CardBody>
      </Card>

      <DiscrepancyActions
        discrepancy={discrepancy}
        permissions={[...granted]}
        viewerUid={viewer ?? ''}
      />

      {(discrepancy.reviewed_at || discrepancy.resolved_at) && (
        <Card>
          <CardHeader>
            <CardTitle>What happened next</CardTitle>
          </CardHeader>
          <CardBody className="space-y-1.5">
            {discrepancy.reviewed_at && (
              <Row
                label="Reviewed"
                value={`${discrepancy.reviewed_by_name ?? '—'} · ${formatDateTime(discrepancy.reviewed_at)}`}
              />
            )}
            {discrepancy.review_notes && <Row label="Review notes" value={discrepancy.review_notes} />}
            {discrepancy.resolved_at && (
              <Row
                label={discrepancy.outcome === 'waived' ? 'Waived' : 'Resolved'}
                value={`${discrepancy.resolved_by_name ?? '—'} · ${formatDateTime(discrepancy.resolved_at)}`}
              />
            )}
            {discrepancy.resolution && <Row label="Decision" value={discrepancy.resolution} />}
          </CardBody>
        </Card>
      )}

      {(discrepancy.loss_number || discrepancy.adjustment_transaction_number) && (
        <Card>
          <CardHeader>
            <CardTitle>Follow-ups</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2">
            {discrepancy.loss_number && (
              <div>
                <Link
                  href={`/losses/${discrepancy.loss_incident_id}`}
                  className="text-primary text-sm hover:underline"
                >
                  Loss incident {discrepancy.loss_number}
                </Link>
                <p className="text-muted-foreground text-xs">
                  Reported, not charged. It goes through the usual review and decision, and any
                  deduction from salary needs its own authorisation.
                </p>
              </div>
            )}
            {discrepancy.adjustment_transaction_number && (
              <p className="text-sm">
                Adjustment {discrepancy.adjustment_transaction_number} on Cash at Hand
                <span className="text-muted-foreground block text-xs">
                  Exactly the difference, so the recorded balance matches the cash counted.
                </span>
              </p>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="space-y-2">
          <Link
            href={`/after-hours/handover/${discrepancy.handover_id}`}
            className="text-primary block text-sm hover:underline"
          >
            Handover {discrepancy.handover_number}
          </Link>
          <Link
            href={`/after-hours/session/${discrepancy.session_id}`}
            className="text-primary block text-sm hover:underline"
          >
            Session {discrepancy.session_number}
          </Link>
        </CardBody>
      </Card>
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
