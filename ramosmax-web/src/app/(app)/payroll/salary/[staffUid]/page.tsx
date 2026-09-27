import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import {
  businessToday,
  listDeductionsFor,
  listSalaryHistory,
  listSalaryProfiles,
} from '@/lib/server/workforce';
import { SetSalaryCard } from '../../payroll-forms';
import { DeductionsTable } from '../../payroll-tables';

export const metadata: Metadata = { title: 'Salary' };

export default async function SalaryPage({ params }: { params: Promise<{ staffUid: string }> }) {
  const granted = await requireAnyPermission(
    'salary.view',
    'staff.salary.view',
    'salary.history.view',
    'payroll.view.own',
  );
  const { staffUid } = await params;
  const [profiles, history, today] = await Promise.all([
    listSalaryProfiles(),
    listSalaryHistory(staffUid),
    businessToday(),
  ]);
  const profile = profiles.find((p) => p.staff_uid === staffUid) ?? null;
  if (!profile && history.length === 0) notFound();

  const deductions =
    granted.has('payroll.view') || granted.has('deductions.manage')
      ? await listDeductionsFor(staffUid)
      : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={profile?.staff_name ?? history[0]?.staff_name ?? 'Salary'}
        subtitle={profile?.staff_role ?? undefined}
        back={{ href: '/payroll?tab=salaries', label: 'Salaries' }}
        action={
          profile ? <StatusBadge status={profile.active ? 'active' : 'inactive'} /> : undefined
        }
      />

      {profile && (
        <Card>
          <CardBody className="space-y-1.5">
            <Row label="Basic salary" value={formatUgx(profile.basic_salary_ugx)} strong />
            <Row label="Paid" value={profile.payment_frequency} />
            <Row
              label="Daily allowance"
              value={
                profile.allowance_eligible
                  ? profile.allowance_amount_ugx === null
                    ? 'The policy amount'
                    : formatUgx(profile.allowance_amount_ugx)
                  : 'Not eligible'
              }
            />
            <Row label="Effective from" value={formatDate(profile.effective_from)} />
            <Row label="Version" value={String(profile.version)} />
          </CardBody>
        </Card>
      )}

      {granted.has('salary.manage') && (
        <SetSalaryCard
          staff={[]}
          today={today}
          current={{
            staff_uid: staffUid,
            basic_salary_ugx: profile?.basic_salary_ugx ?? 0,
            payment_frequency: profile?.payment_frequency ?? 'monthly',
            allowance_eligible: profile?.allowance_eligible ?? true,
            allowance_amount_ugx: profile?.allowance_amount_ugx ?? null,
            active: profile?.active ?? true,
          }}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Salary history ({history.length})</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-muted-foreground mb-3 text-sm">
            Every version is kept. A new one never changes a payroll that has already been prepared.
          </p>
          <ul className="space-y-3">
            {history.map((v) => (
              <li key={v.id} className="border-border border-b pb-3 last:border-0 last:pb-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-foreground text-sm font-medium">
                    Version {v.version} · {formatUgx(v.basic_salary_ugx)}
                  </span>
                  <StatusBadge status={v.active ? 'active' : 'inactive'} />
                </div>
                <p className="text-muted-foreground text-xs">
                  From {formatDate(v.effective_from)} · {v.payment_frequency} ·{' '}
                  {v.created_by_name ?? 'someone'} on {formatDateTime(v.created_at)}
                </p>
                {v.reason && <p className="text-foreground mt-1 text-xs">{v.reason}</p>}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {deductions.length > 0 && (
        <>
          <h2 className="text-foreground text-base font-semibold">Deductions</h2>
          <DeductionsTable rows={deductions} />
        </>
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
