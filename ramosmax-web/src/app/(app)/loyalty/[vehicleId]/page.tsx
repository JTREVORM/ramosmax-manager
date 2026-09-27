import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/format/date';
import {
  getVehicle, getVehicleLoyalty, listLoyaltyLedger,
} from '@/lib/server/operations';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';
import { LoyaltyCorrections } from './loyalty-corrections';

export const metadata: Metadata = { title: 'Vehicle loyalty' };

const TYPE_TONES: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  earned: 'success',
  redeemed: 'warning',
  adjustment: 'neutral',
  reversal: 'danger',
};

export default async function VehicleLoyaltyPage({
  params,
}: {
  params: Promise<{ vehicleId: string }>;
}) {
  await requireAnyPermission('loyalty.view');
  const { vehicleId } = await params;
  const [vehicle, loyalty, ledger, user] = await Promise.all([
    getVehicle(vehicleId),
    getVehicleLoyalty(vehicleId),
    listLoyaltyLedger(vehicleId),
    currentUser(),
  ]);
  if (!vehicle) notFound();
  const canAdjust = user?.permissions.includes('loyalty.adjust') ?? false;

  return (
    <div className="space-y-4">
      <PageHeader
        title={vehicle.number_plate}
        subtitle="Loyalty"
        back={{ href: '/loyalty', label: 'Loyalty' }}
        action={loyalty?.reward_available ? <Badge tone="success">Reward ready</Badge> : undefined}
      />

      <Card>
        <CardBody>
          <p className="text-muted-foreground text-xs">Points balance</p>
          <p className="tabular text-foreground text-3xl font-semibold">
            {loyalty?.points_balance ?? 0}
          </p>
          {loyalty && !loyalty.reward_available && (
            <p className="text-muted-foreground mt-1 text-sm">
              {loyalty.points_to_next} more for a {loyalty.reward_percent}% reward
            </p>
          )}
          <dl className="mt-4 grid grid-cols-3 gap-2">
            {[
              ['Lifetime', loyalty?.lifetime_points ?? 0],
              ['Unlocked', loyalty?.rewards_unlocked ?? 0],
              ['Redeemed', loyalty?.rewards_redeemed ?? 0],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-muted-foreground text-xs">{label}</dt>
                <dd className="tabular text-foreground text-sm">{value}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ledger</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          {ledger.length === 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-sm">
              No loyalty activity yet.
            </p>
          ) : (
            <ul className="divide-border divide-y">
              {ledger.map((entry) => (
                <li key={entry.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone={TYPE_TONES[entry.type] ?? 'neutral'}>{entry.type}</Badge>
                      {entry.reversed_by_id && <Badge tone="danger">Reversed</Badge>}
                    </div>
                    {entry.reason && (
                      <p className="text-muted-foreground mt-1 text-xs">{entry.reason}</p>
                    )}
                    <p className="text-muted-foreground text-xs">
                      {formatDateTime(entry.created_at)} · {entry.balance_before} →{' '}
                      {entry.balance_after}
                    </p>
                  </div>
                  <span
                    className={`tabular shrink-0 text-sm font-medium ${
                      entry.points >= 0 ? 'text-success' : 'text-danger'
                    }`}
                  >
                    {entry.points >= 0 ? '+' : ''}
                    {entry.points}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {canAdjust && <LoyaltyCorrections vehicleId={vehicleId} ledger={ledger} />}
    </div>
  );
}
