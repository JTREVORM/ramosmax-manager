import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { listPurchases } from '@/lib/server/finance';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';
import { PurchasesTable } from './purchases-table';

export const metadata: Metadata = { title: 'Purchases' };

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAnyPermission('inventory.view');
  const { status = 'all' } = await searchParams;
  const [purchases, user] = await Promise.all([listPurchases(status), currentUser()]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Purchases"
        subtitle={`${purchases.length} shown`}
        back={{ href: '/inventory', label: 'Inventory' }}
        action={
          user?.permissions.includes('inventory.purchase.create') ? (
            <Link href="/inventory/purchases/new">
              <Button size="sm">New purchase</Button>
            </Link>
          ) : undefined
        }
      />

      <Card className="bg-surface-muted">
        <CardBody>
          <p className="text-muted-foreground text-sm">
            Buying stock is an acquisition, not an operating expense. Paying for a purchase takes
            money out of an account and creates no expense record.
          </p>
        </CardBody>
      </Card>

      <FilterTabs
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'pending_approval', label: 'Awaiting' },
          { value: 'approved', label: 'Approved' },
          { value: 'received', label: 'Received' },
          { value: 'cancelled', label: 'Cancelled' },
        ]}
      />
      <PurchasesTable purchases={purchases} />
    </div>
  );
}
