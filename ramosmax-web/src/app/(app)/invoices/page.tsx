import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { SearchField } from '@/components/ui/search-field';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { InvoicesTable } from './invoices-table';
import { listInvoices } from '@/lib/server/operations';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Invoices' };

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  await requireAnyPermission('invoices.view');
  const params = await searchParams;
  const invoices = await listInvoices(params.q ?? '', params.status ?? 'all');

  return (
    <div className="space-y-4">
      <PageHeader title="Invoices" subtitle={`${invoices.length} shown`} />
      <SearchField label="Search invoices" placeholder="Plate, invoice number or customer" />
      <FilterTabs
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'unpaid', label: 'Unpaid' },
          { value: 'partially_paid', label: 'Part paid' },
          { value: 'credit', label: 'Credit' },
          { value: 'paid', label: 'Paid' },
          { value: 'cancelled', label: 'Cancelled' },
        ]}
      />
      <InvoicesTable invoices={invoices} />
    </div>
  );
}
