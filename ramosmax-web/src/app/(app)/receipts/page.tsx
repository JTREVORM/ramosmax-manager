import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { ReceiptsTable } from './receipts-table';
import { listReceipts } from '@/lib/server/operations';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Receipts' };

export default async function ReceiptsPage() {
  await requireAnyPermission('payments.view', 'invoices.view');
  const receipts = await listReceipts();
  return (
    <div className="space-y-4">
      <PageHeader title="Receipts" subtitle={`${receipts.length} issued`} />
      <ReceiptsTable receipts={receipts} />
    </div>
  );
}
