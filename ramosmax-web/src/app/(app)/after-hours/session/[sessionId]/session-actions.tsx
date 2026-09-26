'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import {
  cancelAfterHoursSessionAction, closeAfterHoursSessionAction,
} from '@/lib/server/after-hours-actions';
import type { SessionRow } from '@/lib/server/after-hours';

export function SessionActions({
  session,
  permissions,
  viewerUid,
}: {
  session: SessionRow;
  permissions: string[];
  viewerUid: string;
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);

  const mine = session.staff_uid === viewerUid;
  const open = session.status === 'open';
  const mayAct = open && (mine || can('after_hours.approve'));
  const mayCancel = mayAct && session.payment_count === 0 && session.opening_float_ugx === 0;

  if (!mayAct) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setPanel(panel === 'close' ? null : 'close')}>
            Close session
          </Button>
          {mayCancel && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}
            >
              Cancel it
            </Button>
          )}
        </div>

        {panel === 'close' && (
          <ActionForm action={closeAfterHoursSessionAction} submitLabel="Close session">
            <input type="hidden" name="session_id" value={session.id} />
            <Field label="Notes" htmlFor="close-notes" hint="Optional">
              <Input id="close-notes" name="notes" />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              The cash to hand over is worked out again from the payments themselves and frozen.
              Nothing here sends an amount, and no function accepts one.
            </p>
          </ActionForm>
        )}

        {panel === 'cancel' && (
          <ActionForm action={cancelAfterHoursSessionAction} submitLabel="Cancel session">
            <input type="hidden" name="session_id" value={session.id} />
            <Field label="Why" htmlFor="cancel-reason" hint="Required.">
              <Input id="cancel-reason" name="reason" required />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              Only a session that took nothing and holds no float can be cancelled. Anything else is
              closed and handed over.
            </p>
          </ActionForm>
        )}

        {session.expected_cash_ugx > 0 && (
          <p className="text-muted-foreground text-xs">
            {formatUgx(session.expected_cash_ugx)} is currently in this worker&apos;s hands.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
