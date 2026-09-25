import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { listLoyaltyLeaders } from '@/lib/server/operations';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Loyalty' };

export default async function LoyaltyPage() {
  await requireAnyPermission('loyalty.view');
  const leaders = await listLoyaltyLeaders();

  return (
    <div className="space-y-4">
      <PageHeader title="Loyalty" subtitle="Points belong to the vehicle, not the customer." />

      <Card>
        <CardHeader>
          <CardTitle>How it works</CardTitle>
        </CardHeader>
        <CardBody>
          <ul className="text-muted-foreground space-y-1 text-sm">
            <li>20 points for each completed qualifying service.</li>
            <li>Points are earned when the invoice is paid in full.</li>
            <li>200 points unlock a 25% reward on one invoice.</li>
            <li>One available reward per vehicle at a time.</li>
          </ul>
        </CardBody>
      </Card>

      <section>
        <h2 className="text-foreground mb-2 text-sm font-semibold">Vehicles with points</h2>
        {leaders.length === 0 ? (
          <Card className="text-muted-foreground px-4 py-8 text-center text-sm">
            No vehicle has earned points yet.
          </Card>
        ) : (
          <ul className="space-y-2">
            {leaders.map((row) => (
              <li key={row.vehicle_id}>
                <Link href={`/loyalty/${row.vehicle_id}`} className="block">
                  <Card className="hover:bg-surface-muted px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-foreground text-sm font-medium">{row.number_plate}</div>
                        <div className="text-muted-foreground text-xs">
                          {row.points_balance} points
                        </div>
                      </div>
                      {row.reward_available && <Badge tone="success">Reward ready</Badge>}
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
