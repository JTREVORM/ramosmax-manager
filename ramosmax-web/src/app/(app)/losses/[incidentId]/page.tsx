import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import { businessToday, getLoss, listDeductionsFor } from '@/lib/server/workforce';
import { lossType } from '@/lib/format/workforce';
import { LossActions } from './loss-actions';

export const metadata: Metadata = { title: 'Loss incident' };

export default async function LossPage({ params }: { params: Promise<{ incidentId: string }> }) {
  const granted = await requireAnyPermission('losses.view', 'payroll.view.own');
  const { incidentId } = await params;
  const [incident, today] = await Promise.all([getLoss(incidentId), businessToday()]);
  if (!incident) notFound();

  const deductions = incident.staff_uid
    ? (await listDeductionsFor(incident.staff_uid)).filter(
        (d) => d.loss_number === incident.loss_number,
      )
    : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={incident.loss_number}
        subtitle={incident.description}
        back={{ href: '/losses', label: 'Loss incidents' }}
        action={<StatusBadge status={incident.status} />}
      />

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Loss" value={formatUgx(incident.amount_ugx)} strong />
          <Row label="Type" value={lossType(incident)} />
          <Row label="Dated" value={formatDate(incident.incident_date)} />
          <Row label="Staff member" value={incident.staff_name ?? 'Nobody in particular'} />
          <Row label="Reported by" value={incident.reported_by_name ?? '—'} />
          {incident.notes && <Row label="Notes" value={incident.notes} />}
        </CardBody>
      </Card>

      {['reported', 'under_review'].includes(incident.status) && (
        <Card className="bg-surface-muted">
          <CardBody>
            <p className="text-muted-foreground text-sm">
              Nothing is owed. Nobody has been asked to repay anything, and the staff member does
              not see this incident until it has been decided.
            </p>
          </CardBody>
        </Card>
      )}

      {incident.status !== 'reported' && incident.status !== 'under_review' && (
        <Card>
          <CardHeader>
            <CardTitle>Decision</CardTitle>
          </CardHeader>
          <CardBody className="space-y-1.5">
            {incident.status === 'rejected' ? (
              <Row label="Rejected because" value={incident.rejection_reason ?? '—'} />
            ) : (
              <>
                <Row label="Approved recovery" value={formatUgx(incident.approved_recovery_ugx)} />
                <Row label="Recovered so far" value={formatUgx(incident.recovered_ugx)} />
                <Row label="Outstanding" value={formatUgx(incident.outstanding_ugx)} strong />
                {incident.recovery_reason && (
                  <Row label="Reason" value={incident.recovery_reason} />
                )}
              </>
            )}
            {incident.approved_by_name && (
              <Row label="Decided by" value={incident.approved_by_name} />
            )}
            {incident.cancel_reason && (
              <Row label="Cancelled because" value={incident.cancel_reason} />
            )}
          </CardBody>
        </Card>
      )}

      <LossActions incident={incident} permissions={[...granted]} today={today} />

      {deductions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recovery</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2">
              {deductions.map((d) => (
                <li key={d.id} className="text-sm">
                  <Link
                    href={`/payroll/deduction/${d.id}`}
                    className="text-primary hover:underline"
                  >
                    {d.deduction_number}
                  </Link>
                  <span className="text-muted-foreground">
                    {' '}
                    · {formatUgx(d.instalment_ugx)} per payroll · {formatUgx(d.remaining_ugx)}{' '}
                    remaining · {d.status}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-3 text-xs">
              A recovery reaches the staff member only when a payroll is paid.
            </p>
          </CardBody>
        </Card>
      )}

      {incident.review_notes && (
        <Card>
          <CardBody>
            <p className="text-muted-foreground text-sm">
              Review notes ({incident.reviewed_by_name ?? 'reviewer'}): {incident.review_notes}
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span
        className={`tabular text-sm ${strong ? 'text-foreground font-semibold' : 'text-foreground'}`}
      >
        {value}
      </span>
    </div>
  );
}
