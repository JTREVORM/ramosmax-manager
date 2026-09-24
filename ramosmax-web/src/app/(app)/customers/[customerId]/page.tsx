import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Pencil } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { LinkButton } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { getCustomer, listCustomerVehicles } from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';
import { formatPhoneForDisplay } from '@/lib/auth/phone';
import { formatDate } from '@/lib/format/date';
import { CustomerStatusForm } from './customer-status-form';
import { VehiclesTable } from '../../vehicles/vehicles-table';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Customer' };

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  await requireAnyPermission('customers.view');
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) notFound();

  const [vehicles, user] = await Promise.all([listCustomerVehicles(customerId), currentUser()]);
  const canManage = user?.permissions.includes('customers.manage') ?? false;

  return (
    <div className="space-y-4">
      <PageHeader
        title={customer.full_name}
        subtitle={customer.customer_number}
        back={{ href: '/customers', label: 'Customers' }}
        action={
          canManage ? (
            <LinkButton href={`/customers/${customerId}/edit`} variant="secondary">
              <Pencil aria-hidden="true" />
              Edit
            </LinkButton>
          ) : undefined
        }
      />

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Customer information</CardTitle>
          <StatusBadge status={customer.status} />
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {[
              ['Phone', customer.phone_number ? formatPhoneForDisplay(customer.phone_number) : '—'],
              [
                'Alternative phone',
                customer.alternative_phone
                  ? formatPhoneForDisplay(customer.alternative_phone)
                  : '—',
              ],
              ['Email', customer.email ?? '—'],
              ['Address', customer.address ?? '—'],
              ['Vehicles', String(customer.vehicle_count)],
              ['Registered', formatDate(customer.created_at)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground text-xs">{label}</dt>
                <dd className="text-foreground text-sm">{value}</dd>
              </div>
            ))}
          </dl>
          {customer.notes && (
            <p className="text-muted-foreground border-border mt-4 border-t pt-3 text-sm">
              {customer.notes}
            </p>
          )}
        </CardBody>
      </Card>

      <section>
        <h2 className="text-foreground mb-2 text-sm font-semibold">Vehicles</h2>
        <VehiclesTable vehicles={vehicles} empty="No vehicles are linked to this customer." />
      </section>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>
              {customer.status === 'active' ? 'Deactivate customer' : 'Reactivate customer'}
            </CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-muted-foreground mb-3 text-sm">
              Customers are never deleted. Deactivating keeps their history and stops new work.
            </p>
            <CustomerStatusForm id={customerId} active={customer.status !== 'active'} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
