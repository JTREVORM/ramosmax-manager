'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import {
  calculateAllowancesAction,
  cancelAllowanceAction,
  payAllowancesAction,
  reviewAllowanceAction,
} from '@/lib/server/workforce-actions';
import type { AllowanceRow, PayrollPolicy } from '@/lib/server/workforce';
import type { PickableAccount } from '@/lib/server/finance';
import { payable } from '@/lib/format/workforce';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

export function CalculateCard({ today }: { today: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Calculate allowances</CardTitle>
      </CardHeader>
      <CardBody>
        {!open ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Calculate for a day
          </Button>
        ) : (
          <ActionForm action={calculateAllowancesAction} submitLabel="Calculate">
            <Field label="Business day" htmlFor="calc-day">
              <Input
                id="calc-day"
                name="business_day"
                type="date"
                defaultValue={today}
                max={today}
              />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              Only approved attendance earns an allowance, and only once. Calculating twice creates
              nothing new.
            </p>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * THE LATE-ARRIVAL RESOLUTION: full, deduct or reject.
 *
 * The policy suggests; a person decides, with a reason. Being late never
 * removes an allowance by itself.
 */
export function ReviewCard({
  allowances,
  policy,
  canApprove,
}: {
  allowances: AllowanceRow[];
  policy: PayrollPolicy;
  canApprove: boolean;
}) {
  const [decision, setDecision] = React.useState<'full' | 'deduct' | 'reject' | null>(null);
  if (allowances.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Decide {allowances.length} allowance{allowances.length === 1 ? '' : 's'}
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setDecision(decision === 'full' ? null : 'full')}>
            Pay in full
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDecision(decision === 'deduct' ? null : 'deduct')}
          >
            Deduct
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDecision(decision === 'reject' ? null : 'reject')}
          >
            Reject
          </Button>
        </div>

        {!canApprove && (
          <p className="text-muted-foreground text-xs">
            You may propose a decision. Someone with allowance approval makes it final.
          </p>
        )}

        {decision && (
          <ActionForm
            action={reviewAllowanceAction}
            submitLabel={
              decision === 'full'
                ? 'Pay in full'
                : decision === 'deduct'
                  ? 'Apply deduction'
                  : 'Reject'
            }
          >
            <input type="hidden" name="decision" value={decision} />
            <fieldset className="space-y-2">
              <legend className="text-muted-foreground mb-1 text-sm">Allowances</legend>
              {allowances.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="allowance_id"
                    value={a.id}
                    defaultChecked
                    className="size-5"
                  />
                  <span>
                    {a.staff_name} · {formatUgx(a.calculated_amount_ugx)}
                    {a.late ? ` · ${a.minutes_late} min late` : ''}
                    {a.suggested_decision ? ` · policy suggests ${a.suggested_decision}` : ''}
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="mt-3 space-y-3">
              {decision === 'deduct' && (
                <Field
                  label="Deduction"
                  htmlFor="deduction"
                  hint={`Leave blank for the policy amount (${formatUgx(policy.lateDeductionUgx)}). At most ${formatUgx(policy.maxLateDeductionUgx)}, and it must leave part of the allowance.`}
                >
                  <Input id="deduction" name="deduction_ugx" inputMode="numeric" />
                </Field>
              )}
              <Field
                label="Reason"
                htmlFor="review-reason"
                hint={decision === 'full' ? 'Optional' : 'Required.'}
              >
                <Input id="review-reason" name="reason" required={decision !== 'full'} />
              </Field>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

/** Pays a batch from one account: one ledger entry, one request id. */
export function PayCard({
  allowances,
  accounts,
  today,
}: {
  allowances: AllowanceRow[];
  accounts: PickableAccount[];
  today: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [request] = React.useState(newRequestId);
  if (allowances.length === 0) return null;
  const total = allowances.reduce((sum, a) => sum + payable(a), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Pay {allowances.length} allowance{allowances.length === 1 ? '' : 's'}
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-muted-foreground text-sm">Approved and unpaid: {formatUgx(total)}.</p>
        {!open ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Pay allowances
          </Button>
        ) : (
          <ActionForm action={payAllowancesAction} submitLabel="Pay allowances">
            <input type="hidden" name="request_id" value={request} />
            <fieldset className="space-y-2">
              <legend className="text-muted-foreground mb-1 text-sm">Allowances</legend>
              {allowances.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="allowance_id"
                    value={a.id}
                    defaultChecked
                    className="size-5"
                  />
                  <span>
                    {a.staff_name} · {formatUgx(payable(a))}
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="mt-3 space-y-3">
              <Field label="Pay from" htmlFor="account">
                <select id="account" name="account_id" required className={selectClass}>
                  <option value="">Choose an account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Payment date" htmlFor="pay-date">
                <Input
                  id="pay-date"
                  name="payment_date"
                  type="date"
                  defaultValue={today}
                  max={today}
                />
              </Field>
              <Field label="Reference" htmlFor="pay-reference" hint="Optional">
                <Input id="pay-reference" name="reference" />
              </Field>
              <p className="text-muted-foreground text-xs">
                One ledger entry is posted for the whole batch. A repeated attempt with the same
                request pays once.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

export function CancelAllowanceCard({ allowances }: { allowances: AllowanceRow[] }) {
  const [open, setOpen] = React.useState(false);
  if (allowances.length === 0) return null;
  return (
    <Card>
      <CardBody className="space-y-3">
        {!open ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            Cancel an allowance
          </Button>
        ) : (
          <ActionForm action={cancelAllowanceAction} submitLabel="Cancel allowances">
            <fieldset className="space-y-2">
              <legend className="text-muted-foreground mb-1 text-sm">Allowances</legend>
              {allowances.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="allowance_id" value={a.id} className="size-5" />
                  <span>
                    {a.staff_name} · {a.allowance_number}
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="mt-3">
              <Field label="Reason" htmlFor="cancel-reason" hint="Required.">
                <Input id="cancel-reason" name="reason" required />
              </Field>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
