import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { CustomerForm } from '../../customer-form';
import { getCustomer } from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Edit customer' };

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  await requireAnyPermission('customers.manage');
  const { customerId } = await params;
  const user = await currentUser();
  if (!user?.permissions.includes('customers.manage')) redirect(`/customers/${customerId}`);

  const customer = await getCustomer(customerId);
  if (!customer) notFound();

  return (
    <>
      <PageHeader
        title={customer.full_name}
        subtitle={customer.customer_number}
        back={{ href: `/customers/${customerId}`, label: 'Customer' }}
      />
      <CustomerForm customer={customer} />
    </>
  );
}
