import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import { listExpenseCategories, listPickableAccounts, listRecurringExpenses } from '@/lib/server/finance';
import { requireAnyPermission } from '@/lib/server/guard';
import { RecurringPanels } from './recurring-panels';

export const metadata: Metadata = { title: 'Recurring expenses' };

export default async function RecurringPage() {
  await requireAnyPermission('expenses.recurring.manage', 'expenses.view');
  const [recurring, categories, accounts] = await Promise.all([
    listRecurringExpenses(),
    listExpenseCategories(),
    listPickableAccounts(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Recurring expenses"
        subtitle="Reminders and draft bills. Nothing is ever paid automatically."
        back={{ href: '/expenses', label: 'Expenses' }}
      />

      <RecurringPanels
        recurring={recurring}
        categories={categories.filter((c) => c.active)}
        accounts={accounts}
      />

      <Card>
        <CardHeader>
          <CardTitle>Scheduled</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {recurring.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-foreground truncate text-sm font-medium">{r.name}</p>
                  <p className="text-muted-foreground mt-0.5 truncate text-xs">
                    {r.category_name} · {r.frequency} · next {formatDate(r.next_due_date)}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Reminder {r.reminder_days_before} day(s) before
                    {r.payee ? ` · ${r.payee}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span className="tabular text-foreground block text-sm">
                    {formatUgx(r.expected_amount_ugx)}
                  </span>
                  {!r.active && <Badge tone="neutral">Off</Badge>}
                </div>
              </li>
            ))}
            {recurring.length === 0 && (
              <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                Nothing recurring yet.
              </li>
            )}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <p className="text-muted-foreground text-sm">
            When a reminder falls due the server creates ONE draft expense for that date and moves
            the schedule on. Someone still has to submit, review, approve and pay it.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
