import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody } from '@/components/ui/card';
import { listSuppliers } from '@/lib/server/finance';
import { requireAnyPermission } from '@/lib/server/guard';
import { ItemForm } from './item-form';

export const metadata: Metadata = { title: 'New item' };

export default async function NewItemPage() {
  await requireAnyPermission('inventory.manage');
  const suppliers = await listSuppliers();

  return (
    <div className="space-y-4">
      <PageHeader
        title="New item"
        subtitle="Opening stock is recorded as a stock-in movement."
        back={{ href: '/inventory', label: 'Inventory' }}
      />
      <Card>
        <CardBody>
          <ItemForm suppliers={suppliers.filter((s) => s.active)} />
        </CardBody>
      </Card>
    </div>
  );
}
