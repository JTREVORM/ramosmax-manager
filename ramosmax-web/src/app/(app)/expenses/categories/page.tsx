import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { listExpenseCategories } from '@/lib/server/finance';
import { requireAnyPermission } from '@/lib/server/guard';
import { CategoryPanels } from './category-panels';

export const metadata: Metadata = { title: 'Expense categories' };

export default async function CategoriesPage() {
  await requireAnyPermission('expenses.categories.manage', 'expenses.view');
  const categories = await listExpenseCategories();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Expense categories"
        subtitle="The ten built-in categories, plus any of your own."
        back={{ href: '/expenses', label: 'Expenses' }}
      />

      <CategoryPanels categories={categories} />

      <Card>
        <CardHeader>
          <CardTitle>Categories</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {categories.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="text-foreground block truncate text-sm">{c.name}</span>
                  <span className="text-muted-foreground block truncate text-xs">{c.id}</span>
                </span>
                <span className="flex shrink-0 gap-2">
                  {c.is_default && <Badge tone="neutral">Built in</Badge>}
                  {!c.active && <Badge tone="danger">Retired</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
