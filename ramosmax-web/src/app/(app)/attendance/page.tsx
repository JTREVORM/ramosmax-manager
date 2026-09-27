import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { Card, CardBody } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/field';
import { requireAnyPermission } from '@/lib/server/guard';
import {
  businessToday,
  currentUserId,
  getPayrollPolicy,
  listAttendance,
  listAttendanceFor,
  listStaff,
} from '@/lib/server/workforce';
import { AttendanceTable } from './attendance-table';
import { ClockCard, RecordAttendanceCard, VerifyCard } from './attendance-actions';

export const metadata: Metadata = { title: 'Attendance' };

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; view?: string }>;
}) {
  const granted = await requireAnyPermission('attendance.view', 'attendance.view.own');
  const params = await searchParams;
  const can = (p: string) => granted.has(p);
  const seesEveryone = can('attendance.view');
  const view = params.view ?? (seesEveryone ? 'day' : 'mine');

  const [today, uid, policy] = await Promise.all([
    businessToday(),
    currentUserId(),
    getPayrollPolicy(),
  ]);
  const day = params.day ?? today;

  const [rows, mine, staff] = await Promise.all([
    seesEveryone && view !== 'mine'
      ? listAttendance(day, view === 'verify' ? 'pending' : undefined)
      : Promise.resolve([]),
    listAttendanceFor(uid, 60),
    can('attendance.record') ? listStaff() : Promise.resolve([]),
  ]);

  const today_mine = mine.find((r) => r.business_day === today) ?? null;
  const pending = seesEveryone ? await listAttendance(day, 'pending') : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Attendance"
        subtitle={`Reporting time ${policy.reportingTime} · ${policy.gracePeriodMinutes} minutes' grace`}
      />

      {can('attendance.mark') && <ClockCard mine={today_mine} />}

      {seesEveryone && (
        <>
          <FilterTabs
            param="view"
            defaultValue="day"
            options={[
              { value: 'day', label: 'Day' },
              { value: 'verify', label: 'To verify' },
              { value: 'mine', label: 'Mine' },
            ]}
          />
          {view !== 'mine' && (
            <form method="get" className="max-w-xs">
              <input type="hidden" name="view" value={view} />
              <Field label="Business day" htmlFor="day">
                <Input id="day" name="day" type="date" defaultValue={day} max={today} />
              </Field>
              <noscript>
                <button type="submit" className="text-primary mt-2 text-sm">
                  Show
                </button>
              </noscript>
            </form>
          )}
        </>
      )}

      {seesEveryone && view === 'verify' && can('attendance.approve') && (
        <VerifyCard pending={pending} />
      )}

      {seesEveryone && view !== 'mine' ? (
        <AttendanceTable rows={rows} caption={`Attendance for ${day}`} />
      ) : (
        <>
          <Card className="bg-surface-muted">
            <CardBody>
              <p className="text-muted-foreground text-sm">
                Your own attendance. A manager records absences and makes corrections.
              </p>
            </CardBody>
          </Card>
          <AttendanceTable rows={mine} caption="My attendance" />
        </>
      )}

      {can('attendance.record') && <RecordAttendanceCard staff={staff} today={today} />}
    </div>
  );
}
