import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pencil, Wrench } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { LinkButton } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { getVehicle, listJobs } from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';
import { formatDate } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Vehicle' };

export default async function VehicleDetailPage({
  params,
}: {
  params: Promise<{ vehicleId: string }>;
}) {
  await requireAnyPermission('vehicles.view');
  const { vehicleId } = await params;
  const vehicle = await getVehicle(vehicleId);
  if (!vehicle) notFound();

  const user = await currentUser();
  const canManage = user?.permissions.includes('vehicles.manage') ?? false;
  const canStart = user?.permissions.includes('jobs.create') ?? false;
  const canSeeJobs = user?.permissions.includes('jobs.view') ?? false;
  const history = canSeeJobs ? await listJobs(vehicle.normalized_plate, 'all') : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={vehicle.number_plate}
        subtitle={[vehicle.make, vehicle.model, vehicle.colour].filter(Boolean).join(' · ')}
        back={{ href: '/vehicles', label: 'Vehicles' }}
        action={
          <div className="flex gap-2">
            {canManage && (
              <LinkButton href={`/vehicles/${vehicleId}/edit`} variant="secondary">
                <Pencil aria-hidden="true" />
                Edit
              </LinkButton>
            )}
            {canStart && vehicle.status === 'active' && (
              <LinkButton href={`/new-service?vehicle=${vehicleId}`}>
                <Wrench aria-hidden="true" />
                Start service
              </LinkButton>
            )}
          </div>
        }
      />

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Vehicle</CardTitle>
          <StatusBadge status={vehicle.status} />
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            {[
              ['Make', vehicle.make ?? '—'],
              ['Model', vehicle.model],
              ['Colour', vehicle.colour],
              ['Year', vehicle.year ? String(vehicle.year) : '—'],
              ['Type', vehicle.vehicle_type ?? '—'],
              ['Last service', vehicle.last_intake_at ? formatDate(vehicle.last_intake_at) : '—'],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground text-xs">{label}</dt>
                <dd className="text-foreground text-sm">{value}</dd>
              </div>
            ))}
          </dl>
          {vehicle.previous_plates.length > 0 && (
            <p className="text-muted-foreground border-border mt-4 border-t pt-3 text-sm">
              Previously: {vehicle.previous_plates.join(', ')}
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Owner</CardTitle>
        </CardHeader>
        <CardBody>
          {vehicle.customer_id ? (
            user?.permissions.includes('customers.view') ? (
              <Link
                href={`/customers/${vehicle.customer_id}`}
                className="text-primary text-sm hover:underline"
              >
                {vehicle.customer_name} · {vehicle.customer_number}
              </Link>
            ) : (
              // A Worker sees the owner's name for the job card, and no more.
              <p className="text-foreground text-sm">{vehicle.customer_name}</p>
            )
          ) : (
            <p className="text-muted-foreground text-sm">Walk-in — no customer recorded.</p>
          )}
        </CardBody>
      </Card>

      {canSeeJobs && (
        <section>
          <h2 className="text-foreground mb-2 text-sm font-semibold">Service activity</h2>
          {history.length === 0 ? (
            <Card className="text-muted-foreground px-4 py-8 text-center text-sm">
              No services recorded for this vehicle yet.
            </Card>
          ) : (
            <ul className="space-y-2">
              {history.map((job) => (
                <li key={job.id}>
                  <Link href={`/jobs/${job.id}`} className="block">
                    <Card className="hover:bg-surface-muted px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-foreground text-sm font-medium">
                            {job.job_number}
                          </div>
                          <div className="text-muted-foreground text-xs">
                            {job.service_count} service{job.service_count === 1 ? '' : 's'} ·{' '}
                            {formatDate(job.created_at)}
                          </div>
                        </div>
                        <StatusBadge status={job.status} />
                      </div>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
