import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import { listDeductions } from '@/lib/server/workforce';
import { queryAsUser } from '@/lib/server/db';
import { sessionUserId } from '@/lib/server/session';
import { DecideDeductionCard } from '../../payroll-forms';
import { CancelDeductionCard } from './cancel-deduction';

export const metadata: Metadata = { title: 'Deduction' };

interface ApplicationRow {
  id: string;
  payroll_number: string;
  period_key: string;
  amount_ugx: number;
  applied_at: string;
  reversed: boolean;
  reversal_reason: string | null;
}

export default async function DeductionPage({
  params,
}: {
  params: Promise<{ deductionId: string }>;
}) {
  const granted = await requireAnyPermission(
    'payroll.view',
    'losses.view',
    'deductions.manage',
    'payroll.view.own',
  );
  const { deductionId } = await params;
  const deduction = (await listDeductions()).find((d) => d.id === deductionId);
  if (!deduction) notFound();

  const uid = await sessionUserId();
  const applications = await queryAsUser<ApplicationRow>(
    uid as string,
    `select id, payroll_number, period_key, amount_ugx, applied_at, reversed, reversal_reason
       from public.deduction_applications where deduction_id = $1 order by applied_at desc`,
    [deductionId],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={deduction.deduction_number}
        subtitle={`${deduction.staff_name ?? 'Staff member'} · ${deduction.reason}`}
        back={{ href: '/payroll?tab=deductions', label: 'Deductions' }}
        action={<StatusBadge status={deduction.status} />}
      />

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Total" value={formatUgx(deduction.total_amount_ugx)} />
          <Row label="Per payroll" value={formatUgx(deduction.instalment_ugx)} />
          <Row label="Recovered" value={formatUgx(deduction.recovered_ugx)} />
          <Row label="Remaining" value={formatUgx(deduction.remaining_ugx)} strong />
          <Row label="From" value={formatDate(deduction.starts_from)} />
          <Row
            label="Type"
            value={
              deduction.type === 'loss_recovery'
                ? 'Loss recovery'
                : deduction.type === 'authorized_deduction'
                  ? 'Authorised salary deduction'
                  : 'Another approved deduction'
            }
          />
          {deduction.reference && <Row label="Source" value={deduction.reference} />}
          {deduction.rejection_reason && (
            <Row label="Rejected because" value={deduction.rejection_reason} />
          )}
          {deduction.cancel_reason && (
            <Row label="Stopped because" value={deduction.cancel_reason} />
          )}
        </CardBody>
      </Card>

      {deduction.loss_number && (
        <Card>
          <CardBody>
            <Link href="/losses" className="text-primary text-sm hover:underline">
              Loss incident {deduction.loss_number}
            </Link>
          </CardBody>
        </Card>
      )}

      {granted.has('payroll.approve') && <DecideDeductionCard deduction={deduction} />}

      {(granted.has('deductions.manage') || granted.has('losses.adjust')) && (
        <CancelDeductionCard deduction={deduction} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Applied in {applications.length} payroll{applications.length === 1 ? '' : 's'}
          </CardTitle>
        </CardHeader>
        <CardBody>
          {applications.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing has been taken yet. A deduction is applied only when a payroll is paid.
            </p>
          ) : (
            <ul className="space-y-2">
              {applications.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    {a.payroll_number} · {a.period_key}
                    {a.reversed ? ' · reversed' : ''}
                  </span>
                  <span className="tabular">
                    {formatUgx(a.amount_ugx)}
                    <span className="text-muted-foreground ml-2 text-xs">
                      {formatDateTime(a.applied_at)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
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
      <span
        className={`tabular text-sm ${strong ? 'text-foreground font-semibold' : 'text-foreground'}`}
      >
        {value}
      </span>
    </div>
  );
}
