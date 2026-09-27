'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { newRequestId } from '@/lib/online';
import {
  closeAfterHoursSessionAction, openAfterHoursSessionAction, submitCashHandoverAction,
} from '@/lib/server/after-hours-actions';
import { formatUgx } from '@/lib/format/money';

/** Start the shift. Only the person on duty can do this, and only for themselves. */
export function StartSessionCard({ canStart }: { canStart: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [request, setRequest] = React.useState(newRequestId);

  if (!canStart) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start your session</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <Button
          size="sm"
          onClick={() => {
            setRequest(newRequestId());
            setOpen(!open);
          }}
        >
          {open ? 'Not yet' : 'Start session'}
        </Button>
        {open && (
          <ActionForm action={openAfterHoursSessionAction} submitLabel="Start session">
            <input type="hidden" name="request_id" value={request} />
            <Field label="Notes" htmlFor="my-open-notes" hint="Optional">
              <Input id="my-open-notes" name="notes" />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              Everything you record while this is open is tied to you, and the cash you take has to
              be handed over at the end.
            </p>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

export function CloseSessionCard({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card>
      <CardBody className="space-y-3">
        <Button size="sm" variant="secondary" onClick={() => setOpen(!open)}>
          {open ? 'Not yet' : 'Close my session'}
        </Button>
        {open && (
          <ActionForm action={closeAfterHoursSessionAction} submitLabel="Close session">
            <input type="hidden" name="session_id" value={sessionId} />
            <Field label="Notes" htmlFor="my-close-notes" hint="Optional">
              <Input id="my-close-notes" name="notes" />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              The cash to hand over is worked out from your payments and fixed. You cannot change
              it, and you are not asked to.
            </p>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

export function SubmitHandoverCard({
  handoverId,
  expectedUgx,
}: {
  handoverId: string;
  expectedUgx: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [request, setRequest] = React.useState(newRequestId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hand over the cash</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-muted-foreground text-sm">
          {formatUgx(expectedUgx)} is expected from you. A manager will count it.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setRequest(newRequestId());
            setOpen(!open);
          }}
        >
          {open ? 'Not yet' : 'Hand it over'}
        </Button>
        {open && (
          <ActionForm action={submitCashHandoverAction} submitLabel="Submit handover">
            <input type="hidden" name="handover_id" value={handoverId} />
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field label="How much are you handing over?" htmlFor="my-declared">
                <Input id="my-declared" name="declared_amount_ugx" inputMode="numeric" required />
              </Field>
              <Field label="Notes" htmlFor="my-submit-notes" hint="Optional">
                <Input id="my-submit-notes" name="notes" />
              </Field>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
