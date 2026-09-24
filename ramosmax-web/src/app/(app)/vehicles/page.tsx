import type { Metadata } from 'next';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { SearchField } from '@/components/ui/search-field';
import { LinkButton } from '@/components/ui/button';
import { VehiclesTable } from './vehicles-table';
import { searchVehicles } from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Vehicles' };

export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireAnyPermission('vehicles.view');
  const params = await searchParams;
  const [vehicles, user] = await Promise.all([searchVehicles(params.q ?? ''), currentUser()]);
  const canManage = user?.permissions.includes('vehicles.manage') ?? false;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Vehicles"
        subtitle={params.q ? `${vehicles.length} matching` : 'Recently registered'}
        action={
          canManage ? (
            <LinkButton href="/vehicles/new">
              <Plus aria-hidden="true" />
              Register vehicle
            </LinkButton>
          ) : undefined
        }
      />
      <SearchField label="Search by number plate" placeholder="Number plate, e.g. UGB 123A" />
      <VehiclesTable vehicles={vehicles} />
    </div>
  );
}
