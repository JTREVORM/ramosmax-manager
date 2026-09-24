import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { VehicleForm } from '../vehicle-form';
import { listCustomers } from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';

export const metadata: Metadata = { title: 'Register vehicle' };

export default async function NewVehiclePage({
  searchParams,
}: {
  searchParams: Promise<{ plate?: string; next?: string }>;
}) {
  const params = await searchParams;
  const user = await currentUser();
  if (!user?.permissions.includes('vehicles.manage')) redirect('/vehicles');

  // Only offered when the person may see customers at all.
  const customers = user.permissions.includes('customers.view')
    ? await listCustomers('', 'active')
    : [];

  return (
    <>
      <PageHeader
        title="Register vehicle"
        subtitle={params.plate ? `Plate ${params.plate}` : undefined}
        back={{ href: '/vehicles', label: 'Vehicles' }}
      />
      <VehicleForm
        customers={customers}
        initialPlate={params.plate}
        nextAction={params.next === 'start' ? 'start' : undefined}
      />
    </>
  );
}
