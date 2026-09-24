import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { VehicleForm } from '../../vehicle-form';
import { PlateChangeForm, VehicleStatusForm } from './vehicle-admin-forms';
import { getVehicle } from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';

export const metadata: Metadata = { title: 'Edit vehicle' };

export default async function EditVehiclePage({
  params,
}: {
  params: Promise<{ vehicleId: string }>;
}) {
  const { vehicleId } = await params;
  const user = await currentUser();
  if (!user?.permissions.includes('vehicles.manage')) redirect(`/vehicles/${vehicleId}`);

  const vehicle = await getVehicle(vehicleId);
  if (!vehicle) notFound();

  return (
    <div className="space-y-4">
      <PageHeader
        title={vehicle.number_plate}
        subtitle="Edit vehicle"
        back={{ href: `/vehicles/${vehicleId}`, label: 'Vehicle' }}
      />
      <VehicleForm vehicle={vehicle} />

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Change number plate</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-muted-foreground mb-3 text-sm">
            The previous plate is kept, and past services keep the plate they were recorded with.
          </p>
          <PlateChangeForm id={vehicleId} />
        </CardBody>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>
            {vehicle.status === 'active' ? 'Deactivate vehicle' : 'Reactivate vehicle'}
          </CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-muted-foreground mb-3 text-sm">
            Vehicles are never deleted. An inactive vehicle cannot start a new service.
          </p>
          <VehicleStatusForm id={vehicleId} active={vehicle.status !== 'active'} />
        </CardBody>
      </Card>
    </div>
  );
}
