import { CarFront, ClipboardList, Plus, Wrench } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/card';
import { LinkButton } from '@/components/ui/button';
import { currentUser } from '@/lib/server/auth-service';
import { listJobs, listMyOrders } from '@/lib/server/operations';

export default async function DashboardPage() {
  const user = await currentUser();
  const permissions = new Set(user?.permissions ?? []);

  const canStart = permissions.has('jobs.create');
  const ownWork = permissions.has('jobs.view.own') && !permissions.has('jobs.view');

  const [openJobs, myOrders] = await Promise.all([
    permissions.has('jobs.view') ? listJobs('', 'open') : Promise.resolve([]),
    ownWork ? listMyOrders() : Promise.resolve([]),
  ]);

  const readyToInvoice = permissions.has('jobs.view')
    ? (await listJobs('', 'completed')).length
    : 0;
  const todo = myOrders.filter((o) => !['completed', 'cancelled'].includes(o.status)).length;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-foreground text-lg font-semibold">
          {user ? `Hello, ${user.fullName.split(' ')[0]}` : 'Dashboard'}
        </h1>
        <p className="text-muted-foreground text-sm capitalize">{user?.role}</p>
      </header>

      {canStart && (
        <Card className="bg-primary/5">
          <CardBody>
            <p className="text-foreground mb-3 text-sm font-medium">
              Start here — enter the number plate.
            </p>
            <LinkButton href="/new-service" size="lg" block>
              <Plus aria-hidden="true" />
              New service
            </LinkButton>
          </CardBody>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3">
        {permissions.has('jobs.view') && (
          <>
            <Stat label="Open jobs" value={openJobs.length} href="/jobs" icon="jobs" />
            <Stat
              label="Ready to invoice"
              value={readyToInvoice}
              href="/jobs?status=completed"
              icon="ready"
            />
          </>
        )}
        {ownWork && <Stat label="Jobs to do" value={todo} href="/my-jobs" icon="mine" />}
        {permissions.has('vehicles.view') && (
          <Stat label="Vehicles" value={null} href="/vehicles" icon="vehicles" />
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  icon,
}: {
  label: string;
  value: number | null;
  href: string;
  icon: 'jobs' | 'ready' | 'mine' | 'vehicles';
}) {
  const Icon = { jobs: Wrench, ready: ClipboardList, mine: ClipboardList, vehicles: CarFront }[
    icon
  ];
  return (
    <LinkButton
      href={href}
      variant="secondary"
      className="h-auto flex-col items-start gap-1 px-4 py-4 text-left"
    >
      <Icon className="text-muted-foreground size-4" aria-hidden="true" />
      {value !== null && <span className="text-foreground text-2xl font-semibold">{value}</span>}
      <span className="text-muted-foreground text-xs font-normal">{label}</span>
    </LinkButton>
  );
}
