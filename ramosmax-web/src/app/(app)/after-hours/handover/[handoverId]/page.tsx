import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import { difference } from '@/lib/format/after-hours';
import { requireAnyPermission } from '@/lib/server/guard';
import { sessionUserId } from '@/lib/server/session';
import { getHandover } from '@/lib/server/after-hours';
import { HandoverActions } from './handover-actions';

export const metadata: Metadata = { title: 'Cash handover' };

export default async function HandoverPage({
  params,
}: {
  params: Promise<{ handoverId: string }>;
}) {
  const granted = await requireAnyPermission(
    'after_hours.view', 'after_hours.request', 'cash_handover.approve', 'cash_handover.submit',
    'after_hours.discrepancy.review',
  );
  const { handoverId } = await params;
  const [handover, viewer] = await Promise.all([getHandover(handoverId), sessionUserId()]);
  if (!handover) notFound();

  return (
    <div className="space-y-4">
      <PageHeader
        title={handover.handover_number}
        subtitle={`${handover.staff_name} · ${handover.session_number}`}
        back={{ href: '/after-hours?tab=handovers', label: 'After-hours' }}
        action={<StatusBadge status={handover.status} />}
      />

      <Card>
        <CardHeader>
          <CardTitle>The cash</CardTitle>
        </CardHeader>
        <CardBody className="space-y-1.5">
          <Row label="Opening float" value={formatUgx(handover.opening_float_ugx)} />
          <Row label="Cash taken" value={formatUgx(handover.cash_collected_ugx)} />
          {handover.cash_reversed_ugx > 0 && (
            <Row label="Reversed in the session" value={`− ${formatUgx(handover.cash_reversed_ugx)}`} />
          )}
          <Row label="Expected" value={formatUgx(handover.expected_cash_ugx)} strong />
          <Row
            label="Declared"
            value={handover.declared_amount_ugx === null
              ? 'Not yet'
              : formatUgx(handover.declared_amount_ugx)}
          />
          <Row
            label="Counted"
            value={handover.actual_amount_ugx === null
              ? 'Not yet'
              : formatUgx(handover.actual_amount_ugx)}
          />
          {handover.actual_amount_ugx !== null && (
            <Row label="Difference" value={difference(handover.difference_ugx)} strong />
          )}
          <Row
            label="Mobile money in the session"
            value={`${formatUgx(handover.non_cash_collected_ugx)} · never in hand`}
          />
        </CardBody>
      </Card>

      <Card className="bg-surface-muted">
        <CardBody>
          <p className="text-muted-foreground text-sm">
            The expected figure was worked out by the server from the session&apos;s own payments
            when the session closed, and frozen. Nothing in this application can change it.
          </p>
        </CardBody>
      </Card>

      <HandoverActions
        handover={handover}
        permissions={[...granted]}
        viewerUid={viewer ?? ''}
      />

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardBody className="space-y-1.5">
          <Row label="Created" value={formatDateTime(handover.created_at)} />
          <Row
            label="Handed over"
            value={handover.submitted_at
              ? `${handover.submitted_by_name ?? '—'} · ${formatDateTime(handover.submitted_at)}`
              : 'Not yet'}
          />
          <Row
            label="Counted by"
            value={handover.received_at
              ? `${handover.received_by_name ?? '—'} · ${formatDateTime(handover.received_at)}`
              : 'Not yet'}
          />
          {handover.explanation && <Row label="Explanation" value={handover.explanation} />}
          {handover.submit_notes && <Row label="Handover notes" value={handover.submit_notes} />}
          {handover.receive_notes && <Row label="Counting notes" value={handover.receive_notes} />}
          {handover.reconciled_at && (
            <Row label="Reconciled" value={formatDateTime(handover.reconciled_at)} />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-2">
          <Link
            href={`/after-hours/session/${handover.session_id}`}
            className="text-primary block text-sm hover:underline"
          >
            Session {handover.session_number}
          </Link>
          {handover.discrepancy_id && (
            <Link
              href={`/after-hours/discrepancy/${handover.discrepancy_id}`}
              className="text-primary block text-sm hover:underline"
            >
              Discrepancy {handover.discrepancy_number}
            </Link>
          )}
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
