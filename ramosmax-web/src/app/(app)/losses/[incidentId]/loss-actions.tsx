'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import {
  cancelLossAction,
  decideLossAction,
  reviewLossAction,
  scheduleLossRecoveryAction,
} from '@/lib/server/workforce-actions';
import type { LossRow } from '@/lib/server/workforce';

export function LossActions({
  incident,
  permissions,
  today,
}: {
  incident: LossRow;
  permissions: string[];
  today: string;
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);

  const canReview = incident.status === 'reported' && can('losses.review');
  const canDecide = ['reported', 'under_review'].includes(incident.status) && can('losses.approve');
  const canSchedule =
    ['approved', 'partially_recovered'].includes(incident.status) &&
    incident.outstanding_ugx > 0 &&
    incident.deduction_number === null &&
    can('losses.schedule');
  const canCancel =
    !['rejected', 'recovered', 'cancelled'].includes(incident.status) && can('losses.adjust');

  if (!canReview && !canDecide && !canSchedule && !canCancel) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {canReview && (
            <Button size="sm" onClick={() => setPanel(toggle(panel, 'review'))}>
              Put under review
            </Button>
          )}
          {canDecide && (
            <>
              <Button size="sm" onClick={() => setPanel(toggle(panel, 'approve'))}>
                Approve a recovery
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPanel(toggle(panel, 'reject'))}>
                Reject
              </Button>
            </>
          )}
          {canSchedule && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPanel(toggle(panel, 'schedule'))}
            >
              Schedule recovery
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(toggle(panel, 'cancel'))}>
              Cancel incident
            </Button>
          )}
        </div>

        {canDecide && (
          <p className="text-muted-foreground text-xs">
            Nobody reviews, decides or schedules an incident about themselves. Deciding it is what
            makes it visible to the staff member.
          </p>
        )}

        {panel === 'review' && (
          <ActionForm action={reviewLossAction} submitLabel="Put under review">
            <input type="hidden" name="incident_id" value={incident.id} />
            <Field label="Notes" htmlFor="review-notes" hint="Optional">
              <Input id="review-notes" name="notes" />
            </Field>
          </ActionForm>
        )}

        {panel === 'approve' && (
          <ActionForm action={decideLossAction} submitLabel="Approve">
            <input type="hidden" name="incident_id" value={incident.id} />
            <input type="hidden" name="decision" value="approve" />
            <div className="space-y-3">
              <Field
                label="Amount to recover"
                htmlFor="recovery"
                hint={`0 to ${formatUgx(incident.amount_ugx)}. Zero means the business absorbs it.`}
              >
                <Input id="recovery" name="recovery_ugx" inputMode="numeric" defaultValue="0" />
              </Field>
              <Field label="Reason" htmlFor="approve-reason" hint="Required.">
                <Input id="approve-reason" name="reason" required />
              </Field>
              <p className="text-muted-foreground text-xs">
                Approving decides what is owed. Nothing is deducted until a recovery is scheduled
                and a payroll is paid.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'reject' && (
          <ActionForm action={decideLossAction} submitLabel="Reject">
            <input type="hidden" name="incident_id" value={incident.id} />
            <input type="hidden" name="decision" value="reject" />
            <Field label="Reason" htmlFor="reject-reason" hint="Required.">
              <Input id="reject-reason" name="reason" required />
            </Field>
          </ActionForm>
        )}

        {panel === 'schedule' && (
          <ActionForm action={scheduleLossRecoveryAction} submitLabel="Schedule recovery">
            <input type="hidden" name="incident_id" value={incident.id} />
            <div className="space-y-3">
              <Field
                label="Amount per payroll"
                htmlFor="instalment"
                hint={`At most ${formatUgx(incident.outstanding_ugx)}.`}
              >
                <Input id="instalment" name="instalment_ugx" inputMode="numeric" required />
              </Field>
              <Field label="From" htmlFor="start-date" hint="The first payroll it applies to.">
                <Input id="start-date" name="start_date" type="date" defaultValue={today} />
              </Field>
              <Field label="Reason" htmlFor="schedule-reason" hint="Optional">
                <Input id="schedule-reason" name="reason" />
              </Field>
              <p className="text-muted-foreground text-xs">
                One deduction is created for {formatUgx(incident.outstanding_ugx)}. It never takes
                more than what is outstanding, and never makes net pay negative.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'cancel' && (
          <ActionForm
            action={cancelLossAction}
            submitLabel="Cancel incident"
            confirm="Cancel this incident?"
          >
            <input type="hidden" name="incident_id" value={incident.id} />
            <Field label="Reason" htmlFor="cancel-reason" hint="Required.">
              <Input id="cancel-reason" name="reason" required />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              What has already been recovered stays recorded; the rest is written off. An incident
              an unpaid payroll plans to recover cannot be cancelled until that payroll is
              corrected.
            </p>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

const toggle = (current: string | null, next: string) => (current === next ? null : next);
