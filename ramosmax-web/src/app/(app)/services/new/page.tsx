import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { ServiceForm } from '../service-form';
import { currentUser } from '@/lib/server/auth-service';

export const metadata: Metadata = { title: 'Add service' };

export default async function NewServicePage() {
  const user = await currentUser();
  if (!user?.permissions.includes('services.manage')) redirect('/services');

  return (
    <>
      <PageHeader title="Add service" back={{ href: '/services', label: 'Services' }} />
      <ServiceForm />
    </>
  );
}
