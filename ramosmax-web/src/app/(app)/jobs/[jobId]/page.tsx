import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import { getJob, listAssignableWorkers, listJobOrders } from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';
import { JobOrders } from './job-orders';
import { CancelJobForm } from './cancel-job-form';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Job' };

export default async function JobDetailPage({ params }: { params: Promise<{ jobId: string }> }) {
  await requireAnyPermission('jobs.view', 'jobs.view.own');
  const { jobId } = await params;
  const job = await getJob(jobId);
  if (!job) notFound();

  const user = await currentUser();
  const canAssign = user?.permissions.includes('jobs.assign') ?? false;
  const canManage = user?.permissions.includes('jobs.manage') ?? false;

  const [orders, workers] = await Promise.all([
    listJobOrders(jobId),
    canAssign ? listAssignableWorkers() : Promise.resolve([]),
  ]);

  const total = job.selected_services.reduce((sum, s) => sum + Number(s.priceUgx), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title={job.job_number}
        subtitle={`${job.number_plate} · ${job.vehicle_summary ?? ''}`}
        back={{ href: '/jobs', label: 'Jobs' }}
        action={<StatusBadge status={job.status} />}
      />

      <Card>
        <CardHeader>
          <CardTitle>Vehicle and customer</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            {[
              ['Plate', job.number_plate],
              ['Customer', job.customer_name ?? 'Walk-in'],
              ['Started', formatDateTime(job.created_at)],
              ['Started by', job.created_by_name ?? '—'],
              ['Completed', job.completed_at ? formatDateTime(job.completed_at) : '—'],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground text-xs">{label}</dt>
                <dd className="text-foreground text-sm">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-3">
            <Link
              href={`/vehicles/${job.vehicle_id}`}
              className="text-primary text-sm hover:underline"
            >
              Open vehicle
            </Link>
          </div>
          {job.notes && (
            <p className="text-muted-foreground border-border mt-4 border-t pt-3 text-sm">
              {job.notes}
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Services</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {job.selected_services.map((service) => (
              <li key={service.serviceId} className="flex justify-between px-4 py-2.5">
                <span className="text-foreground text-sm">{service.name}</span>
                <span className="tabular text-foreground text-sm">
                  {formatUgx(service.priceUgx)}
                </span>
              </li>
            ))}
          </ul>
          <div className="border-border flex justify-between border-t px-4 py-3">
            <span className="text-muted-foreground text-sm">
              Price at intake
              <span className="block text-xs">Fixed when the job started.</span>
            </span>
            <span className="tabular text-foreground font-semibold">{formatUgx(total)}</span>
          </div>
        </CardBody>
      </Card>

      <JobOrders
        jobId={jobId}
        orders={orders}
        workers={workers}
        canAssign={canAssign}
        canManage={canManage}
      />

      {job.status === 'completed' && (
        <Card className="bg-success-bg">
          <CardBody>
            <p className="text-success text-sm font-medium">This job is ready to invoice.</p>
            <p className="text-success mt-1 text-sm opacity-90">
              Invoicing arrives in the next phase of the migration.
            </p>
          </CardBody>
        </Card>
      )}

      {canManage && job.status !== 'cancelled' && job.status !== 'completed' && (
        <Card>
          <CardHeader>
            <CardTitle>Cancel job</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-muted-foreground mb-3 text-sm">
              A job can only be cancelled before any work has started.
            </p>
            <CancelJobForm id={jobId} />
          </CardBody>
        </Card>
      )}

      {job.cancel_reason && (
        <Card className="bg-danger-bg">
          <CardBody>
            <p className="text-danger text-sm">Cancelled: {job.cancel_reason}</p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
