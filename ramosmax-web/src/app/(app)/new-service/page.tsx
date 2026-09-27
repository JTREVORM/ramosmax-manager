import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { PlateSearch } from './plate-search';
import { StartServiceForm } from './start-service-form';
import { getVehicle, listServices, searchVehicles } from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';

export const metadata: Metadata = { title: 'New service' };

/**
 * The plate-first reception workflow.
 *
 *   type the plate
 *     ├── found     → select services → create the job
 *     └── not found → register the vehicle (plate pre-filled) → back here
 */
export default async function NewServicePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; vehicle?: string }>;
}) {
  const params = await searchParams;
  const user = await currentUser();
  if (!user?.permissions.includes('jobs.create')) redirect('/');

  // Step two: a vehicle has been chosen.
  if (params.vehicle) {
    const [vehicle, services] = await Promise.all([getVehicle(params.vehicle), listServices(true)]);
    if (!vehicle) redirect('/new-service');

    return (
      <>
        <PageHeader
          title={vehicle.number_plate}
          subtitle={[vehicle.make, vehicle.model, vehicle.colour].filter(Boolean).join(' · ')}
          back={{ href: '/new-service', label: 'Change vehicle' }}
        />
        <StartServiceForm vehicle={vehicle} services={services} />
      </>
    );
  }

  // Step one: find the vehicle by its plate.
  const matches = params.q ? await searchVehicles(params.q) : [];
  const canRegister = user.permissions.includes('vehicles.manage');

  return (
    <>
      <PageHeader title="New service" subtitle="Start by entering the number plate." />
      <PlateSearch query={params.q ?? ''} matches={matches} canRegister={canRegister} />
    </>
  );
}
