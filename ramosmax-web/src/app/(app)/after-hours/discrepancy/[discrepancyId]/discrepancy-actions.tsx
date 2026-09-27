'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import {
  resolveCashDiscrepancyAction, reviewCashDiscrepancyAction,
} from '@/lib/server/after-hours-actions';
import type { DiscrepancyRow } from '@/lib/server/after-hours';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

export function DiscrepancyActions({
  discrepancy,
  permissions,
  viewerUid,
}: {
  discrepancy: DiscrepancyRow;
  permissions: string[];
  viewerUid: string;
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);
  const [request, setRequest] = React.useState(newRequestId);
  const [outcome, setOutcome] = React.useState('resolved');
  const toggle = (next: string) => {
    setRequest(newRequestId());
    setPanel(panel === next ? null : next);
  };

  // Nobody reviews or resolves a discrepancy about their own handover.
  const mine = discrepancy.staff_uid === viewerUid;
  const reviewer = can('after_hours.discrepancy.review') && !mine;
  const open = ['open', 'under_review'].includes(discrepancy.status);
  const mayReview = reviewer && discrepancy.status === 'open';
  const mayResolve = reviewer && open;
  const shortage = discrepancy.difference_ugx < 0;

  if (!mayReview && !mayResolve) {
    return mine && open ? (
      <Card className="bg-surface-muted">
        <CardBody>
          <p className="text-muted-foreground text-sm">
            Somebody else reviews this. You cannot review or resolve a difference on your own
            handover.
          </p>
        </CardBody>
      </Card>
    ) : null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {mayReview && (
            <Button size="sm" onClick={() => toggle('review')}>
              Put under review
            </Button>
          )}
          {mayResolve && (
            <Button size="sm" variant="secondary" onClick={() => toggle('resolve')}>
              Close it
            </Button>
          )}
        </div>

        {panel === 'review' && (
          <ActionForm action={reviewCashDiscrepancyAction} submitLabel="Put under review">
            <input type="hidden" name="discrepancy_id" value={discrepancy.id} />
            <Field label="What did you find?" htmlFor="d-review-notes" hint="Required.">
              <Input id="d-review-notes" name="notes" required />
            </Field>
          </ActionForm>
        )}

        {panel === 'resolve' && (
          <ActionForm action={resolveCashDiscrepancyAction} submitLabel="Close the discrepancy">
            <input type="hidden" name="discrepancy_id" value={discrepancy.id} />
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field label="Outcome" htmlFor="d-outcome">
                <select
                  id="d-outcome"
                  name="outcome"
                  className={selectClass}
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                >
                  <option value="resolved">Resolved</option>
                  <option value="waived">Waived</option>
                </select>
              </Field>
              <Field label="What was decided?" htmlFor="d-resolution" hint="Required.">
                <Input id="d-resolution" name="resolution" required />
              </Field>

              {shortage && outcome === 'resolved' && can('losses.create') && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="recover_from_worker" className="mt-1" />
                  <span>
                    Report a loss incident about the worker
                    <span className="text-muted-foreground block text-xs">
                      This REPORTS it. Nothing is charged: the incident goes through the usual
                      review and decision, and any deduction from salary needs its own
                      authorisation afterwards.
                    </span>
                  </span>
                </label>
              )}

              {can('finance.adjust') && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="post_adjustment" className="mt-1" />
                  <span>
                    Post the adjustment on Cash at Hand
                    <span className="text-muted-foreground block text-xs">
                      Exactly {formatUgx(Math.abs(discrepancy.difference_ugx))}{' '}
                      {shortage ? 'out of' : 'into'} the account, so the recorded balance matches
                      the cash that was counted. Never any other amount.
                    </span>
                  </span>
                </label>
              )}
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
