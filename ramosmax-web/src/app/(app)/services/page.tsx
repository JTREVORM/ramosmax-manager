import type { Metadata } from 'next';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { LinkButton } from '@/components/ui/button';
import { ServicesTable } from './services-table';
import { listServices } from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Services' };

export default async function ServicesPage() {
  await requireAnyPermission('services.view');
  const [services, user] = await Promise.all([listServices(), currentUser()]);
  const canManage = user?.permissions.includes('services.manage') ?? false;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Services"
        subtitle="Prices are set here, never in the app's code."
        action={
          canManage ? (
            <LinkButton href="/services/new">
              <Plus aria-hidden="true" />
              Add service
            </LinkButton>
          ) : undefined
        }
      />
      <ServicesTable services={services} canManage={canManage} />
    </div>
  );
}
