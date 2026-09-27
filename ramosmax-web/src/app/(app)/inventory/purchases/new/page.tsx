import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody } from '@/components/ui/card';
import { listItems, listSuppliers } from '@/lib/server/finance';
import { requireAnyPermission } from '@/lib/server/guard';
import { PurchaseForm } from './purchase-form';

export const metadata: Metadata = { title: 'New purchase' };

export default async function NewPurchasePage() {
  await requireAnyPermission('inventory.purchase.create');
  const [suppliers, items] = await Promise.all([listSuppliers(), listItems('', 'all')]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="New purchase"
        subtitle="The server prices every line and computes the total."
        back={{ href: '/inventory/purchases', label: 'Purchases' }}
      />
      <Card>
        <CardBody>
          <PurchaseForm
            suppliers={suppliers.filter((s) => s.active)}
            items={items.filter((i) => i.active)}
          />
        </CardBody>
      </Card>
    </div>
  );
}
