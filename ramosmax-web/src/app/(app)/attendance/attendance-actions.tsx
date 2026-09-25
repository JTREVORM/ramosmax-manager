'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import {
  clockInAction,
  clockOutAction,
  recordAttendanceAction,
  verifyAttendanceAction,
} from '@/lib/server/workforce-actions';
import type { AttendanceRow, StaffOption } from '@/lib/server/workforce';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * Clocking in sends NO TIME. The server reads its own clock, so a phone with
 * the wrong time — or a helpful one — cannot change when someone arrived.
 */
export function ClockCard({ mine }: { mine: AttendanceRow | null }) {
  if (mine && mine.clock_out_at) {
    return (
      <Card>
        <CardBody>
          <p className="text-muted-foreground text-sm">
            You clocked in and out today. {mine.attendance_number}.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{mine ? 'Clock out' : 'Clock in'}</CardTitle>
      </CardHeader>
      <CardBody>
        <p className="text-muted-foreground mb-3 text-sm">
          The time is taken from the RamosMAX server, not from this device.
        </p>
        {mine ? (
          <ActionForm action={clockOutAction} submitLabel="Clock out">
            <input type="hidden" name="attendance_id" value={mine.id} />
          </ActionForm>
        ) : (
          <ActionForm action={clockInAction} submitLabel="Clock in">
            <Field label="Notes" htmlFor="clock-notes" hint="Optional">
              <Input name="notes" id="clock-notes" />
            </Field>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

/** A manager entering somebody else's day. */
export function RecordAttendanceCard({ staff, today }: { staff: StaffOption[]; today: string }) {
  const [open, setOpen] = React.useState(false);
  const [arrival, setArrival] = React.useState('present');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Record attendance</CardTitle>
      </CardHeader>
      <CardBody>
        {!open ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Record for a staff member
          </Button>
        ) : (
          <ActionForm action={recordAttendanceAction} submitLabel="Record attendance">
            <div className="space-y-3">
              <Field label="Staff member" htmlFor="staff_uid">
                <select id="staff_uid" name="staff_uid" required className={selectClass}>
                  <option value="">Choose…</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name}
                      {s.staff_id ? ` · ${s.staff_id}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Day" htmlFor="business_day">
                <Input
                  id="business_day"
                  name="business_day"
                  type="date"
                  defaultValue={today}
                  max={today}
                />
              </Field>
              <Field label="Arrival" htmlFor="arrival">
                <select
                  id="arrival"
                  name="arrival"
                  className={selectClass}
                  value={arrival}
                  onChange={(e) => setArrival(e.target.value)}
                >
                  <option value="present">Present</option>
                  <option value="absent">Absent</option>
                  <option value="excused">Excused absence</option>
                </select>
              </Field>
              {arrival === 'present' && (
                <>
                  <Field label="Clock in" htmlFor="clock_in_time" hint="Kampala time">
                    <Input id="clock_in_time" name="clock_in_time" type="time" required />
                  </Field>
                  <Field label="Clock out" htmlFor="clock_out_time" hint="Optional">
                    <Input id="clock_out_time" name="clock_out_time" type="time" />
                  </Field>
                </>
              )}
              <Field
                label="Notes"
                htmlFor="notes"
                hint={arrival === 'excused' ? 'Required: say why it is excused.' : 'Optional'}
              >
                <Input id="notes" name="notes" required={arrival === 'excused'} />
              </Field>
              <p className="text-muted-foreground text-xs">
                Lateness is worked out by the server from the reporting time in force on that day.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

/** Approve or reject a batch of pending records. */
export function VerifyCard({ pending }: { pending: AttendanceRow[] }) {
  const [mode, setMode] = React.useState<'approve' | 'reject' | null>(null);
  if (pending.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Verify {pending.length} record{pending.length === 1 ? '' : 's'}
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setMode(mode === 'approve' ? null : 'approve')}>
            Approve selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setMode(mode === 'reject' ? null : 'reject')}
          >
            Reject selected
          </Button>
        </div>
        {mode && (
          <ActionForm
            action={verifyAttendanceAction}
            submitLabel={mode === 'approve' ? 'Approve attendance' : 'Reject attendance'}
          >
            <input type="hidden" name="action" value={mode} />
            <fieldset className="space-y-2">
              <legend className="text-muted-foreground mb-1 text-sm">Records</legend>
              {pending.map((row) => (
                <label key={row.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="attendance_id"
                    value={row.id}
                    defaultChecked
                    className="size-5"
                  />
                  <span>
                    {row.staff_name} · {row.attendance_number}
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="mt-3 space-y-3">
              {mode === 'reject' ? (
                <Field label="Reason" htmlFor="verify-reason" hint="Required.">
                  <Input id="verify-reason" name="reason" required />
                </Field>
              ) : (
                <Field label="Notes" htmlFor="verify-notes" hint="Optional">
                  <Input id="verify-notes" name="notes" />
                </Field>
              )}
              <p className="text-muted-foreground text-xs">Nobody verifies their own attendance.</p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
