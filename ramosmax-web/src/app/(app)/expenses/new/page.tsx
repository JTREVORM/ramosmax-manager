import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody } from '@/components/ui/card';
import { listExpenseCategories, listPickableAccounts } from '@/lib/server/finance';
import { requireAnyPermission } from '@/lib/server/guard';
import { ExpenseForm } from './expense-form';

export const metadata: Metadata = { title: 'Record expense' };

export default async function NewExpensePage() {
  await requireAnyPermission('expenses.create');
  const [categories, accounts] = await Promise.all([
    listExpenseCategories(),
    listPickableAccounts(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Record expense"
        subtitle="Recording an expense moves no money."
        back={{ href: '/expenses', label: 'Expenses' }}
      />
      <Card>
        <CardBody>
          <ExpenseForm categories={categories.filter((c) => c.active)} accounts={accounts} />
        </CardBody>
      </Card>
    </div>
  );
}
