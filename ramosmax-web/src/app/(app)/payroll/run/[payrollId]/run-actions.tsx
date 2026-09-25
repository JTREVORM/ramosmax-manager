'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import {
  addPayrollEarningAction,
  cancelPayrollAction,
  correctPayrollAction,
  lockPayrollAction,
  payPayrollAction,
  preparePayrollAction,
  removePayrollEarningAction,
  reversePayrollPaymentAction,
  updatePayrollStatusAction,
} from '@/lib/server/workforce-actions';
import type { EarningRow, PayrollRow, PayslipRow } from '@/lib/server/workforce';
import type { PickableAccount } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * The payroll workflow: prepare → submit → review → approve → pay → lock.
 *
 * No figure is sent from here. Every button names an action, and the server
 * works out the money.
 */
export function RunActions({
  payroll,
  payslips,
  accounts,
  permissions,
  today,
}: {
  payroll: PayrollRow;
  payslips: PayslipRow[];
  accounts: PickableAccount[];
  permissions: string[];
  today: string;
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);
  const [request] = React.useState(newRequestId);

  const prepares = can('payroll.prepare') || can('payroll.process');
  const canPrepare = ['draft', 'prepared'].includes(payroll.status) && prepares;
  const canSubmit = payroll.status === 'prepared' && prepares && payroll.employee_count > 0;
  const canReview =
    payroll.status === 'pending_review' && !payroll.reviewed_at && can('payroll.review');
  const canReturn =
    payroll.status === 'pending_review' && (can('payroll.review') || can('payroll.approve'));
  const canApprove =
    payroll.status === 'pending_review' && Boolean(payroll.reviewed_at) && can('payroll.approve');
  const canPay = payroll.status === 'approved' && can('payroll.pay');
  const canReverse = payroll.status === 'paid' && can('payroll.adjust');
  const canLock = payroll.status === 'paid' && can('payroll.approve');
  const canCorrect =
    ['prepared', 'pending_review', 'approved'].includes(payroll.status) && can('payroll.adjust');
  const canCancel =
    !['paid', 'locked', 'cancelled'].includes(payroll.status) && can('payroll.adjust');

  const anything =
    canPrepare ||
    canSubmit ||
    canReview ||
    canReturn ||
    canApprove ||
    canPay ||
    canReverse ||
    canLock ||
    canCorrect ||
    canCancel;
  if (!anything) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {canPay && (
            <Button size="sm" onClick={() => setPanel(toggle(panel, 'pay'))}>
              Pay payroll
            </Button>
          )}
          {canPrepare && (
            <Button
              size="sm"
              variant={canPay ? 'secondary' : 'primary'}
              onClick={() => setPanel(toggle(panel, 'prepare'))}
            >
              {payroll.status === 'draft' ? 'Prepare' : 'Recalculate'}
            </Button>
          )}
          {canSubmit && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(toggle(panel, 'submit'))}>
              Submit for review
            </Button>
          )}
          {canReview && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(toggle(panel, 'review'))}>
              Mark reviewed
            </Button>
          )}
          {canApprove && (
            <Button size="sm" onClick={() => setPanel(toggle(panel, 'approve'))}>
              Approve
            </Button>
          )}
          {canReturn && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(toggle(panel, 'return'))}>
              Return
            </Button>
          )}
          {canCorrect && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(toggle(panel, 'correct'))}>
              Correct
            </Button>
          )}
          {canReverse && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(toggle(panel, 'reverse'))}>
              Reverse payment
            </Button>
          )}
          {canLock && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(toggle(panel, 'lock'))}>
              Lock
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(toggle(panel, 'cancel'))}>
              Cancel
            </Button>
          )}
        </div>

        {payroll.status === 'pending_review' && !payroll.reviewed_at && (
          <p className="text-muted-foreground text-xs">
            A payroll must be reviewed before it can be approved, and an Administrator approves it.
            Nobody reviews or approves a payroll that includes their own pay.
          </p>
        )}

        {panel === 'prepare' && (
          <ActionForm action={preparePayrollAction} submitLabel="Work out the pay">
            <input type="hidden" name="payroll_id" value={payroll.id} />
            <Field label="Reason" htmlFor="prepare-reason" hint="Optional">
              <Input id="prepare-reason" name="reason" />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              The server works out every payslip from the salary in force at the end of the period,
              the approved allowances inside it and the active deductions. The previous calculation
              is kept.
            </p>
          </ActionForm>
        )}

        {panel === 'submit' && (
          <ActionForm action={updatePayrollStatusAction} submitLabel="Submit for review">
            <input type="hidden" name="payroll_id" value={payroll.id} />
            <input type="hidden" name="action" value="submit" />
            <p className="text-muted-foreground text-sm">
              {payroll.employee_count} staff · {formatUgx(payroll.total_net_ugx)} net.
            </p>
          </ActionForm>
        )}

        {panel === 'review' && (
          <ActionForm action={updatePayrollStatusAction} submitLabel="Mark reviewed">
            <input type="hidden" name="payroll_id" value={payroll.id} />
            <input type="hidden" name="action" value="review" />
            <Field label="Review notes" htmlFor="review-notes" hint="Optional">
              <Input id="review-notes" name="notes" />
            </Field>
          </ActionForm>
        )}

        {panel === 'approve' && (
          <ActionForm action={updatePayrollStatusAction} submitLabel="Approve payroll">
            <input type="hidden" name="payroll_id" value={payroll.id} />
            <input type="hidden" name="action" value="approve" />
            <p className="text-muted-foreground text-sm">
              {payroll.employee_count} staff · {formatUgx(payroll.total_net_ugx)} net. Approving
              does not move money.
            </p>
          </ActionForm>
        )}

        {panel === 'return' && (
          <ActionForm action={updatePayrollStatusAction} submitLabel="Return for correction">
            <input type="hidden" name="payroll_id" value={payroll.id} />
            <input type="hidden" name="action" value="return" />
            <Field label="Reason" htmlFor="return-reason" hint="Required.">
              <Input id="return-reason" name="reason" required />
            </Field>
          </ActionForm>
        )}

        {panel === 'correct' && (
          <ActionForm action={correctPayrollAction} submitLabel="Correct and recalculate">
            <input type="hidden" name="payroll_id" value={payroll.id} />
            <Field
              label="Reason"
              htmlFor="correct-reason"
              hint="Required, and kept in the audit trail."
            >
              <Input id="correct-reason" name="reason" required />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              The payroll goes back to prepared and every payslip is worked out again. The previous
              version is kept.
            </p>
          </ActionForm>
        )}

        {panel === 'pay' && (
          <ActionForm
            action={payPayrollAction}
            submitLabel={`Pay ${formatUgx(payroll.total_net_ugx)}`}
          >
            <input type="hidden" name="payroll_id" value={payroll.id} />
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field label="Pay from" htmlFor="pay-account">
                <select id="pay-account" name="account_id" required className={selectClass}>
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
                {payslips.length} payslip{payslips.length === 1 ? '' : 's'}. One ledger entry is
                posted for {formatUgx(payroll.total_net_ugx)}, every deduction is applied and every
                payslip becomes visible to its staff member — all in one transaction. A repeated
                attempt with the same request pays once.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'reverse' && (
          <ActionForm action={reversePayrollPaymentAction} submitLabel="Reverse the payment">
            <input type="hidden" name="payroll_id" value={payroll.id} />
            <Field label="Reason" htmlFor="reverse-reason" hint="Required.">
              <Input id="reverse-reason" name="reason" required />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              The money goes back, every deduction and loss recovery this payroll took is given
              back, and the payslips go out of sight again.
            </p>
          </ActionForm>
        )}

        {panel === 'lock' && (
          <ActionForm
            action={lockPayrollAction}
            submitLabel="Lock payroll"
            confirm="Locking is final. Nothing about this payroll can be changed or reversed afterwards."
          >
            <input type="hidden" name="payroll_id" value={payroll.id} />
            <p className="text-muted-foreground text-sm">
              A locked payroll is history: it cannot be reversed, corrected or cancelled. Adjust the
              next payroll instead.
            </p>
          </ActionForm>
        )}

        {panel === 'cancel' && (
          <ActionForm
            action={cancelPayrollAction}
            submitLabel="Cancel payroll"
            confirm="Cancel this payroll?"
          >
            <input type="hidden" name="payroll_id" value={payroll.id} />
            <Field label="Reason" htmlFor="cancel-reason" hint="Required.">
              <Input id="cancel-reason" name="reason" required />
            </Field>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

/** Other earnings, while the payroll is still being prepared. */
export function EarningsCard({
  payroll,
  payslips,
  earnings,
  permissions,
}: {
  payroll: PayrollRow;
  payslips: PayslipRow[];
  earnings: EarningRow[];
  permissions: string[];
}) {
  const [open, setOpen] = React.useState(false);
  const [removing, setRemoving] = React.useState<string | null>(null);
  if (!permissions.includes('payroll.adjust')) return null;
  const editable = payroll.status === 'prepared';
  const live = earnings.filter((e) => e.removed_at === null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Other earnings</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        {live.length === 0 ? (
          <p className="text-muted-foreground text-sm">None.</p>
        ) : (
          <ul className="space-y-2">
            {live.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {e.staff_name} · {e.description}
                </span>
                <span className="tabular flex items-center gap-2">
                  {formatUgx(e.amount_ugx)}
                  {editable && (
                    <button
                      type="button"
                      className="text-danger text-xs hover:underline"
                      onClick={() => setRemoving(removing === e.id ? null : e.id)}
                    >
                      Remove
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {removing && (
          <ActionForm action={removePayrollEarningAction} submitLabel="Remove earning">
            <input type="hidden" name="payroll_id" value={payroll.id} />
            <input type="hidden" name="earning_id" value={removing} />
            <Field label="Reason" htmlFor="remove-reason" hint="Required.">
              <Input id="remove-reason" name="reason" required />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              It disappears from the pay when the payroll is prepared again.
            </p>
          </ActionForm>
        )}

        {editable && !open && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Add an earning
          </Button>
        )}

        {editable && open && (
          <ActionForm action={addPayrollEarningAction} submitLabel="Add earning">
            <input type="hidden" name="payroll_id" value={payroll.id} />
            <div className="space-y-3">
              <Field label="Staff member" htmlFor="earning-staff">
                <select id="earning-staff" name="staff_uid" required className={selectClass}>
                  <option value="">Choose…</option>
                  {payslips.map((p) => (
                    <option key={p.staff_uid} value={p.staff_uid}>
                      {p.staff_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Description" htmlFor="earning-description">
                <Input id="earning-description" name="description" required />
              </Field>
              <Field label="Amount" htmlFor="earning-amount">
                <Input id="earning-amount" name="amount_ugx" inputMode="numeric" required />
              </Field>
              <Field label="Reason" htmlFor="earning-reason" hint="Required.">
                <Input id="earning-reason" name="reason" required />
              </Field>
              <p className="text-muted-foreground text-xs">
                Prepare the payroll again for this to reach the pay.
              </p>
            </div>
          </ActionForm>
        )}

        {!editable && (
          <p className="text-muted-foreground text-xs">
            Earnings can be added while the payroll is prepared, before review.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

const toggle = (current: string | null, next: string) => (current === next ? null : next);
