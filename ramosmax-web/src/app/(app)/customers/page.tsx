import type { Metadata } from 'next';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { SearchField } from '@/components/ui/search-field';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { LinkButton } from '@/components/ui/button';
import { CustomersTable } from './customers-table';
import { listCustomers } from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Customers' };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  await requireAnyPermission('customers.view');
  const params = await searchParams;
  const user = await currentUser();
  const canManage = user?.permissions.includes('customers.manage') ?? false;
  const customers = await listCustomers(params.q ?? '', params.status ?? 'all');

  return (
    <div className="space-y-4">
      <PageHeader
        title="Customers"
        subtitle={`${customers.length} shown`}
        action={
          canManage ? (
            <LinkButton href="/customers/new">
              <Plus aria-hidden="true" />
              Add customer
            </LinkButton>
          ) : undefined
        }
      />
      <SearchField label="Search customers" placeholder="Name, number or phone" />
      <FilterTabs
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'active', label: 'Active' },
          { value: 'inactive', label: 'Inactive' },
        ]}
      />
      <CustomersTable customers={customers} />
    </div>
  );
}
