import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { MyJobCard } from './my-job-card';
import { listMyOrders } from '@/lib/server/operations';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'My jobs' };

/**
 * A worker's own work.
 *
 * The list comes from public.my_worker_orders, which is filtered to the
 * signed-in worker by the database. No filter is applied here, and none is
 * trusted from the browser.
 */
export default async function MyJobsPage() {
  await requireAnyPermission('jobs.view.own');
  const orders = await listMyOrders();

  const todo = orders.filter((o) => !['completed', 'cancelled'].includes(o.status));
  const done = orders.filter((o) => ['completed', 'cancelled'].includes(o.status));

  return (
    <div className="space-y-4">
      <PageHeader
        title="My jobs"
        subtitle={
          todo.length === 0
            ? 'Nothing waiting for you.'
            : `${todo.length} to do · ${done.length} finished`
        }
      />

      {orders.length === 0 && (
        <Card className="text-muted-foreground px-4 py-10 text-center text-sm">
          No work has been assigned to you yet.
        </Card>
      )}

      {todo.length > 0 && (
        <section>
          <h2 className="text-foreground mb-2 text-sm font-semibold">To do</h2>
          <ul className="space-y-2">
            {todo.map((order) => (
              <li key={order.id}>
                <MyJobCard order={order} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {done.length > 0 && (
        <section>
          <h2 className="text-foreground mb-2 text-sm font-semibold">Finished</h2>
          <ul className="space-y-2">
            {done.map((order) => (
              <li key={order.id}>
                <MyJobCard order={order} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
