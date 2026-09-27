import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { getExpense, listPickableAccounts } from '@/lib/server/finance';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';
import { ExpenseActions } from './expense-actions';

export const metadata: Metadata = { title: 'Expense' };

export default async function ExpensePage({
  params,
}: {
  params: Promise<{ expenseId: string }>;
}) {
  await requireAnyPermission('expenses.view');
  const { expenseId } = await params;
  const [expense, accounts, user] = await Promise.all([
    getExpense(expenseId),
    listPickableAccounts(),
    currentUser(),
  ]);
  if (!expense) notFound();

  const history: { label: string; when: string | null; who: string | null; note?: string | null }[] = [
    { label: 'Recorded', when: expense.created_at, who: expense.created_by_name },
    { label: 'Reviewed', when: expense.reviewed_at, who: expense.reviewed_by_name, note: expense.review_notes },
    { label: 'Approved', when: expense.approved_at, who: expense.approved_by_name },
    { label: 'Rejected', when: expense.rejected_at, who: null, note: expense.rejection_reason },
    { label: 'Paid', when: expense.paid_at, who: expense.paid_by_name, note: expense.paid_from_account_name },
    { label: 'Cancelled', when: expense.cancelled_at, who: null, note: expense.cancel_reason },
  ].filter((h) => h.when !== null);

  return (
    <div className="space-y-4">
      <PageHeader
        title={expense.expense_number}
        subtitle={expense.description}
        back={{ href: '/expenses', label: 'Expenses' }}
        action={<StatusBadge status={expense.status} />}
      />

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Amount" value={formatUgx(expense.amount_ugx)} strong />
          <Row label="Category" value={expense.category_name} />
          <Row label="Dated" value={formatDate(expense.expense_date)} />
          {expense.payee && <Row label="Payee" value={expense.payee} />}
          {expense.reference && <Row label="Reference" value={expense.reference} />}
          {expense.paid_from_account_name && (
            <Row label="Paid from" value={expense.paid_from_account_name} />
          )}
        </CardBody>
      </Card>

      {expense.status !== 'paid' && expense.status !== 'cancelled' && expense.status !== 'rejected' && (
        <Card className="bg-surface-muted">
          <CardBody>
            <p className="text-muted-foreground text-sm">
              No money has moved. An expense affects an account only when it is paid.
            </p>
          </CardBody>
        </Card>
      )}

      {expense.payment_reversal_reason && (
        <Card className="bg-warning-bg">
          <CardBody>
            <p className="text-warning text-sm">
              A payment was reversed: {expense.payment_reversal_reason}
            </p>
          </CardBody>
        </Card>
      )}

      <ExpenseActions
        expense={expense}
        accounts={accounts}
        permissions={user?.permissions ?? []}
        isAuthor={expense.created_by === (user?.id ?? null)}
      />

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {history.map((h) => (
              <li key={h.label} className="px-4 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-foreground text-sm">{h.label}</span>
                  <span className="text-muted-foreground text-xs">{formatDateTime(h.when!)}</span>
                </div>
                {(h.who || h.note) && (
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {[h.who, h.note].filter(Boolean).join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {expense.financial_transaction_id && (
        <Card>
          <CardBody>
            <Link
              href={`/transactions/${expense.financial_transaction_id}`}
              className="text-primary text-sm hover:underline"
            >
              Ledger entry {expense.financial_transaction_number}
            </Link>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className={`tabular text-sm ${strong ? 'text-foreground font-semibold' : 'text-foreground'}`}>
        {value}
      </span>
    </div>
  );
}
