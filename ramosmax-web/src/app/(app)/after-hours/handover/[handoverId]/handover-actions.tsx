'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import {
  receiveCashHandoverAction, submitCashHandoverAction,
} from '@/lib/server/after-hours-actions';
import type { HandoverRow } from '@/lib/server/after-hours';

export function HandoverActions({
  handover,
  permissions,
  viewerUid,
}: {
  handover: HandoverRow;
  permissions: string[];
  viewerUid: string;
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);
  const [request, setRequest] = React.useState(newRequestId);
  const [counted, setCounted] = React.useState('');
  const toggle = (next: string) => {
    setRequest(newRequestId());
    setPanel(panel === next ? null : next);
  };

  const mine = handover.staff_uid === viewerUid;
  const maySubmit = handover.status === 'pending' && (mine || can('cash_handover.submit'));
  // Nobody counts their own cash.
  const mayReceive = ['pending', 'submitted'].includes(handover.status)
    && can('cash_handover.approve') && !mine;

  const differs = counted !== '' && Number(counted.replace(/[\s,]/g, ''))
    !== handover.expected_cash_ugx;

  if (!maySubmit && !mayReceive) {
    return handover.status !== 'reconciled' && handover.status !== 'received' && mine
      ? (
          <Card className="bg-surface-muted">
            <CardBody>
              <p className="text-muted-foreground text-sm">
                Somebody else has to count this cash. That is the point of a handover.
              </p>
            </CardBody>
          </Card>
        )
      : null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {maySubmit && (
            <Button size="sm" onClick={() => toggle('submit')}>
              Hand it over
            </Button>
          )}
          {mayReceive && (
            <Button size="sm" variant="secondary" onClick={() => toggle('receive')}>
              Count and receive
            </Button>
          )}
        </div>

        {panel === 'submit' && (
          <ActionForm action={submitCashHandoverAction} submitLabel="Submit handover">
            <input type="hidden" name="handover_id" value={handover.id} />
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field
                label="How much are you handing over?"
                htmlFor="ho-declared"
                hint="What you say you are giving. The person receiving it counts it themselves."
              >
                <Input id="ho-declared" name="declared_amount_ugx" inputMode="numeric" required />
              </Field>
              <Field label="Notes" htmlFor="ho-submit-notes" hint="Optional">
                <Input id="ho-submit-notes" name="notes" />
              </Field>
            </div>
          </ActionForm>
        )}

        {panel === 'receive' && (
          <ActionForm action={receiveCashHandoverAction} submitLabel="Record the count">
            <input type="hidden" name="handover_id" value={handover.id} />
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field
                label="How much did you count?"
                htmlFor="ho-actual"
                hint={`The server expects ${formatUgx(handover.expected_cash_ugx)}.`}
              >
                <Input
                  id="ho-actual"
                  name="actual_amount_ugx"
                  inputMode="numeric"
                  required
                  value={counted}
                  onChange={(e) => setCounted(e.target.value)}
                />
              </Field>
              <Field
                label="Explanation"
                htmlFor="ho-explanation"
                hint={differs ? 'Required: this does not match.' : 'Optional'}
              >
                <Input id="ho-explanation" name="explanation" required={differs} />
              </Field>
              <Field label="Notes" htmlFor="ho-receive-notes" hint="Optional">
                <Input id="ho-receive-notes" name="notes" />
              </Field>
              {differs && (
                <p className="text-warning text-xs">
                  A count that differs opens a discrepancy for somebody to review. Nothing is
                  charged to anybody by recording it.
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                This records that the cash reached you. It posts nothing to the ledger and moves no
                balance: every payment above was already banked to Cash at Hand when it was taken.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
