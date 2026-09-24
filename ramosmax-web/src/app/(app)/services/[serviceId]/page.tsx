import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ServiceForm } from '../service-form';
import { ServiceActiveForm } from './service-active-form';
import { getService } from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';

export const metadata: Metadata = { title: 'Service' };

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ serviceId: string }>;
}) {
  const { serviceId } = await params;
  const user = await currentUser();
  if (!user?.permissions.includes('services.manage')) redirect('/services');

  const service = await getService(serviceId);
  if (!service) notFound();

  return (
    <div className="space-y-4">
      <PageHeader
        title={service.name}
        subtitle="Edit service"
        back={{ href: '/services', label: 'Services' }}
      />
      <ServiceForm service={service} />

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>{service.is_active ? 'Deactivate service' : 'Reactivate service'}</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-muted-foreground mb-3 text-sm">
            Services are never deleted. An inactive service is hidden from new jobs; past jobs keep
            it.
          </p>
          <ServiceActiveForm id={serviceId} active={!service.is_active} />
        </CardBody>
      </Card>
    </div>
  );
}
