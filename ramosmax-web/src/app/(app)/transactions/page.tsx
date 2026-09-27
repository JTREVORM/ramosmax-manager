import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { listLedger } from '@/lib/server/finance';
import { requireAnyPermission } from '@/lib/server/guard';
import { LedgerTable } from './ledger-table';

export const metadata: Metadata = { title: 'Transactions' };

const TYPES = [
  { value: 'all', label: 'All' },
  { value: 'customer_payment', label: 'Payments' },
  { value: 'expense_payment', label: 'Expenses' },
  { value: 'inventory_purchase_payment', label: 'Stock' },
  { value: 'account_transfer', label: 'Transfers' },
  { value: 'bank_deposit', label: 'Deposits' },
  { value: 'adjustment', label: 'Adjustments' },
  { value: 'reversal', label: 'Reversals' },
];

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  await requireAnyPermission('finance.transactions.view');
  const { type = 'all' } = await searchParams;
  const entries = await listLedger(type);

  return (
    <div className="space-y-4">
      <PageHeader title="Transactions" subtitle={`${entries.length} shown`} />
      <FilterTabs param="type" options={TYPES} defaultValue="all" />
      <LedgerTable entries={entries} />
    </div>
  );
}
