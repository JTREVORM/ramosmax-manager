'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { newRequestId } from '@/lib/online';
import { createLossAction } from '@/lib/server/workforce-actions';
import type { StaffOption } from '@/lib/server/workforce';
import { LOSS_TYPE_LABELS } from '@/lib/format/workforce';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

export function ReportLossCard({ staff, today }: { staff: StaffOption[]; today: string }) {
  const [open, setOpen] = React.useState(false);
  const [request] = React.useState(newRequestId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Report a loss</CardTitle>
      </CardHeader>
      <CardBody>
        {!open ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Report a loss
          </Button>
        ) : (
          <ActionForm action={createLossAction} submitLabel="Report loss">
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field label="Type" htmlFor="incident_type">
                <select id="incident_type" name="incident_type" className={selectClass}>
                  {Object.entries(LOSS_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Amount" htmlFor="loss-amount" hint="What the business lost.">
                <Input id="loss-amount" name="amount_ugx" inputMode="numeric" required />
              </Field>
              <Field label="Date" htmlFor="loss-date">
                <Input
                  id="loss-date"
                  name="incident_date"
                  type="date"
                  defaultValue={today}
                  max={today}
                />
              </Field>
              <Field
                label="Staff member"
                htmlFor="loss-staff"
                hint="Optional. Record one incident per person where several are involved."
              >
                <select id="loss-staff" name="staff_uid" className={selectClass}>
                  <option value="">Nobody in particular</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="What happened" htmlFor="loss-description">
                <Input id="loss-description" name="description" required />
              </Field>
              <Field label="Notes" htmlFor="loss-notes" hint="Optional">
                <Input id="loss-notes" name="notes" />
              </Field>
              <p className="text-muted-foreground text-xs">
                Reporting a loss deducts nothing. Nobody repays anything until an approver decides
                they are liable, a recovery is scheduled and a payroll is paid. The staff member
                sees the incident once it has been decided.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
