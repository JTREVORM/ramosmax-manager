import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { CustomerForm } from '../customer-form';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Add customer' };

export default async function NewCustomerPage() {
  await requireAnyPermission('customers.manage');
  const user = await currentUser();
  // A convenience, not a control: app.create_customer re-checks the permission.
  if (!user?.permissions.includes('customers.manage')) redirect('/customers');

  return (
    <>
      <PageHeader title="Add customer" back={{ href: '/customers', label: 'Customers' }} />
      <CustomerForm />
    </>
  );
}
