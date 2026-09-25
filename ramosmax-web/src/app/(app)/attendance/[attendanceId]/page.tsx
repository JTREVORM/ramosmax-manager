import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDate, formatDateTime, formatTime } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import { getAttendance, listCorrections } from '@/lib/server/workforce';
import { lateness } from '@/lib/format/workforce';
import { AttendanceActions } from './correction-form';

export const metadata: Metadata = { title: 'Attendance record' };

export default async function AttendanceRecordPage({
  params,
}: {
  params: Promise<{ attendanceId: string }>;
}) {
  const granted = await requireAnyPermission('attendance.view', 'attendance.view.own');
  const { attendanceId } = await params;
  const record = await getAttendance(attendanceId);
  if (!record) notFound();
  const corrections = await listCorrections(attendanceId);

  return (
    <div className="space-y-4">
      <PageHeader
        title={record.attendance_number}
        subtitle={`${record.staff_name ?? 'Staff member'} · ${formatDate(record.business_day)}`}
        back={{ href: '/attendance', label: 'Attendance' }}
        action={<StatusBadge status={record.status} />}
      />

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Arrival" value={lateness(record)} strong />
          <Row label="Clock in" value={record.clock_in_at ? formatTime(record.clock_in_at) : '—'} />
          <Row
            label="Clock out"
            value={record.clock_out_at ? formatTime(record.clock_out_at) : '—'}
          />
          <Row label="Working day" value={record.working_day ? 'Yes' : 'No'} />
          <Row
            label="Recorded"
            value={record.recorded_via === 'self' ? 'By the staff member' : 'By a manager'}
          />
          <Row label="Verification" value={record.verification_status} />
          {record.notes && <Row label="Notes" value={record.notes} />}
          {record.rejection_reason && (
            <Row label="Rejected because" value={record.rejection_reason} />
          )}
        </CardBody>
      </Card>

      {record.allowance_id && (
        <Card>
          <CardBody>
            <Link href="/allowances" className="text-primary text-sm hover:underline">
              An allowance was calculated from this day
            </Link>
          </CardBody>
        </Card>
      )}

      <AttendanceActions record={record} permissions={[...granted]} />

      {corrections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Corrections ({corrections.length})</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-3">
              {corrections.map((c) => (
                <li key={c.id} className="border-border border-b pb-3 last:border-0 last:pb-0">
                  <p className="text-foreground text-sm font-medium">{c.reason}</p>
                  <p className="text-muted-foreground text-xs">
                    {c.corrected_by_name ?? 'Someone'} · {formatDateTime(c.created_at)} ·{' '}
                    {c.changed_fields.join(', ')}
                  </p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Was</dt>
                    <dd className="text-foreground">{describe(c.previous_value)}</dd>
                    <dt className="text-muted-foreground">Became</dt>
                    <dd className="text-foreground">{describe(c.new_value)}</dd>
                  </dl>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {record.verified_at && (
        <Card>
          <CardBody>
            <p className="text-muted-foreground text-sm">
              {record.verification_status === 'approved' ? 'Approved' : 'Rejected'} by{' '}
              {record.verified_by_name ?? 'a manager'} on {formatDateTime(record.verified_at)}.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function describe(value: Record<string, unknown>): string {
  const arrival = String(value.arrivalStatus ?? '—');
  const inAt = value.clockInAt ? formatTime(String(value.clockInAt)) : '—';
  const outAt = value.clockOutAt ? formatTime(String(value.clockOutAt)) : '—';
  return `${arrival} · in ${inAt} · out ${outAt}`;
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
