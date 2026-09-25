'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import {
  clockOutAction,
  correctAttendanceAction,
  verifyAttendanceAction,
} from '@/lib/server/workforce-actions';
import type { AttendanceRow } from '@/lib/server/workforce';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/** HH:MM in Kampala, for a time input's default. */
function kampalaTime(at: string | null): string {
  if (!at) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(at));
}

export function AttendanceActions({
  record,
  permissions,
}: {
  record: AttendanceRow;
  permissions: string[];
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);
  const [arrival, setArrival] = React.useState(
    record.arrival_status === 'on_time' || record.arrival_status === 'late'
      ? 'present'
      : record.arrival_status,
  );

  const pending = record.verification_status === 'pending';
  const canApprove = pending && can('attendance.approve');
  const canReject = pending && (can('attendance.review') || can('attendance.approve'));
  const canCorrect = can('attendance.correct');
  const canClockOut =
    pending &&
    record.clock_in_at !== null &&
    record.clock_out_at === null &&
    can('attendance.record');

  if (!canApprove && !canReject && !canCorrect && !canClockOut) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {canApprove && (
            <Button size="sm" onClick={() => setPanel(panel === 'approve' ? null : 'approve')}>
              Approve
            </Button>
          )}
          {canReject && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPanel(panel === 'reject' ? null : 'reject')}
            >
              Reject
            </Button>
          )}
          {canClockOut && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPanel(panel === 'out' ? null : 'out')}
            >
              Clock out now
            </Button>
          )}
          {canCorrect && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPanel(panel === 'correct' ? null : 'correct')}
            >
              Correct record
            </Button>
          )}
        </div>

        {panel === 'approve' && (
          <ActionForm action={verifyAttendanceAction} submitLabel="Approve attendance">
            <input type="hidden" name="attendance_id" value={record.id} />
            <input type="hidden" name="action" value="approve" />
            <Field label="Notes" htmlFor="approve-notes" hint="Optional">
              <Input id="approve-notes" name="notes" />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              Nobody verifies their own attendance.
            </p>
          </ActionForm>
        )}

        {panel === 'reject' && (
          <ActionForm action={verifyAttendanceAction} submitLabel="Reject attendance">
            <input type="hidden" name="attendance_id" value={record.id} />
            <input type="hidden" name="action" value="reject" />
            <Field label="Reason" htmlFor="reject-reason" hint="Required.">
              <Input id="reject-reason" name="reason" required />
            </Field>
          </ActionForm>
        )}

        {panel === 'out' && (
          <ActionForm action={clockOutAction} submitLabel="Clock out">
            <input type="hidden" name="attendance_id" value={record.id} />
            <p className="text-muted-foreground text-sm">
              The clock-out time is the server&rsquo;s, now.
            </p>
          </ActionForm>
        )}

        {panel === 'correct' && (
          <ActionForm action={correctAttendanceAction} submitLabel="Save correction">
            <input type="hidden" name="attendance_id" value={record.id} />
            <input type="hidden" name="business_day" value={record.business_day} />
            <div className="space-y-3">
              <Field
                label="Reason"
                htmlFor="correct-reason"
                hint="Required, and kept in the record's history."
              >
                <Input id="correct-reason" name="reason" required />
              </Field>
              <Field label="Arrival" htmlFor="correct-arrival">
                <select
                  id="correct-arrival"
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
                  <Field label="Clock in" htmlFor="correct-in" hint="Kampala time">
                    <Input
                      id="correct-in"
                      name="clock_in_time"
                      type="time"
                      defaultValue={kampalaTime(record.clock_in_at)}
                      required
                    />
                  </Field>
                  <Field label="Clock out" htmlFor="correct-out" hint="Optional">
                    <Input
                      id="correct-out"
                      name="clock_out_time"
                      type="time"
                      defaultValue={kampalaTime(record.clock_out_at)}
                    />
                  </Field>
                </>
              )}
              <Field label="Notes" htmlFor="correct-notes" hint="Optional">
                <Input id="correct-notes" name="notes" defaultValue={record.notes ?? ''} />
              </Field>
              <p className="text-muted-foreground text-xs">
                The original values are kept. Lateness is recalculated with the reporting time that
                was in force on {record.business_day}, not today&rsquo;s. The record goes back for
                verification, and any allowance calculated from it is cancelled.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
