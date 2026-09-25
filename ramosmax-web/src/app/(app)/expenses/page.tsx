import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { SearchField } from '@/components/ui/search-field';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { Button } from '@/components/ui/button';
import { listExpenses } from '@/lib/server/finance';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';
import { ExpensesTable } from './expenses-table';

export const metadata: Metadata = { title: 'Expenses' };

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  await requireAnyPermission('expenses.view');
  const params = await searchParams;
  const [expenses, user] = await Promise.all([
    listExpenses(params.status ?? 'all', params.q ?? ''),
    currentUser(),
  ]);
  const permissions = user?.permissions ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Expenses"
        subtitle={`${expenses.length} shown`}
        action={
          permissions.includes('expenses.create') ? (
            <Link href="/expenses/new">
              <Button size="sm">Record expense</Button>
            </Link>
          ) : undefined
        }
      />

      <div className="flex flex-wrap gap-2 text-sm">
        {permissions.includes('expenses.recurring.manage') && (
          <Link href="/expenses/recurring" className="text-primary hover:underline">
            Recurring
          </Link>
        )}
        {permissions.includes('expenses.categories.manage') && (
          <Link href="/expenses/categories" className="text-primary hover:underline">
            Categories
          </Link>
        )}
      </div>

      <SearchField label="Search expenses" placeholder="Description, number or payee" />
      <FilterTabs
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'draft', label: 'Draft' },
          { value: 'pending_review', label: 'Awaiting' },
          { value: 'approved', label: 'Approved' },
          { value: 'paid', label: 'Paid' },
          { value: 'rejected', label: 'Rejected' },
          { value: 'cancelled', label: 'Cancelled' },
        ]}
      />
      <ExpensesTable expenses={expenses} />
    </div>
  );
}
