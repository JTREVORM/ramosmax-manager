'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import { payExpenseAction, updateExpenseStatusAction } from '@/lib/server/finance-actions';
import type { ExpenseRow, PickableAccount } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * The workflow. Review and approval are separate steps, in that order, and
 * only the payment moves money.
 */
export function ExpenseActions({
  expense,
  accounts,
  permissions,
  isAuthor,
}: {
  expense: ExpenseRow;
  accounts: PickableAccount[];
  permissions: string[];
  isAuthor: boolean;
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);

  const canSubmit = expense.status === 'draft' && can('expenses.create') && (isAuthor || can('expenses.review'));
  const canReview = expense.status === 'pending_review' && !expense.reviewed_at && can('expenses.review');
  const canApprove = expense.status === 'pending_review' && Boolean(expense.reviewed_at) && can('expenses.approve');
  const canReject = expense.status === 'pending_review' && (can('expenses.review') || can('expenses.approve'));
  const canCancel = ['draft', 'pending_review', 'approved'].includes(expense.status) && can('expenses.cancel');
  const canPay = expense.status === 'approved' && can('expenses.pay');

  if (!canSubmit && !canReview && !canApprove && !canReject && !canCancel && !canPay) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {canPay && (
            <Button size="sm" onClick={() => setPanel(panel === 'pay' ? null : 'pay')}>
              Pay expense
            </Button>
          )}
          {canSubmit && <Simple action="submit" label="Submit for review" expense={expense} />}
          {canReview && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(panel === 'review' ? null : 'review')}>
              Mark reviewed
            </Button>
          )}
          {canApprove && <Simple action="approve" label="Approve" expense={expense} />}
          {canReject && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'reject' ? null : 'reject')}>
              Reject
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}>
              Cancel
            </Button>
          )}
        </div>

        {expense.status === 'pending_review' && !expense.reviewed_at && (
          <p className="text-muted-foreground text-xs">
            An expense must be reviewed before it can be approved.
          </p>
        )}

        {panel === 'pay' && <PayPanel expense={expense} accounts={accounts} />}
        {panel === 'review' && (
          <ActionForm action={updateExpenseStatusAction} submitLabel="Mark reviewed">
            <input type="hidden" name="expense_id" value={expense.id} />
            <input type="hidden" name="action" value="review" />
            <Field label="Review notes" htmlFor="review-notes" hint="Optional">
              <Input name="notes" />
            </Field>
          </ActionForm>
        )}
        {panel === 'reject' && (
          <ActionForm action={updateExpenseStatusAction} submitLabel="Reject expense">
            <input type="hidden" name="expense_id" value={expense.id} />
            <input type="hidden" name="action" value="reject" />
            <Field label="Reason" htmlFor="reject-reason" hint="Required. A rejected expense is final.">
              <Input name="reason" required />
            </Field>
          </ActionForm>
        )}
        {panel === 'cancel' && (
          <ActionForm
            action={updateExpenseStatusAction}
            submitLabel="Cancel expense"
            confirm="Cancel this expense?"
          >
            <input type="hidden" name="expense_id" value={expense.id} />
            <input type="hidden" name="action" value="cancel" />
            <Field label="Reason" htmlFor="cancel-reason" hint="Required, and kept in the audit trail.">
              <Input name="reason" required />
            </Field>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

/** An action with nothing to fill in. */
function Simple({ action, label, expense }: { action: string; label: string; expense: ExpenseRow }) {
  return (
    <form
      action={async (form) => {
        form.set('expense_id', expense.id);
        form.set('action', action);
        await updateExpenseStatusAction(form);
      }}
    >
      <Button size="sm" variant="secondary" type="submit">
        {label}
      </Button>
    </form>
  );
}

function PayPanel({ expense, accounts }: { expense: ExpenseRow; accounts: PickableAccount[] }) {
  const [requestId] = React.useState(newRequestId);
  return (
    <ActionForm action={payExpenseAction} submitLabel="Pay expense" busyLabel="Paying…">
      <input type="hidden" name="expense_id" value={expense.id} />
      <input type="hidden" name="request_id" value={requestId} />
      <div className="space-y-4">
        <div className="bg-surface-muted rounded-[var(--radius)] px-4 py-3 text-sm">
          <p className="text-foreground font-medium">{formatUgx(expense.amount_ugx)} leaves the account</p>
          <p className="text-muted-foreground mt-1 text-xs">
            The payment, its ledger entry and the status change are one transaction.
          </p>
        </div>
        <Field label="Pay from" htmlFor="account_id">
          <select
            id="account_id"
            name="account_id"
            className={selectClass}
            required
            defaultValue={expense.payment_account_id ?? ''}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Payment reference" htmlFor="reference" hint="Optional">
          <Input name="reference" />
        </Field>
      </div>
    </ActionForm>
  );
}
