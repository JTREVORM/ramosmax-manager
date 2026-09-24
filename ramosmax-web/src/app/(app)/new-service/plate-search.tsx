'use client';

import Link from 'next/link';
import { CarFront, Plus } from 'lucide-react';
import { SearchField } from '@/components/ui/search-field';
import { Card } from '@/components/ui/card';
import { LinkButton } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import type { VehicleRow } from '@/lib/server/operations';

export function PlateSearch({
  query,
  matches,
  canRegister,
}: {
  query: string;
  matches: VehicleRow[];
  canRegister: boolean;
}) {
  return (
    <div className="space-y-4">
      <SearchField label="Number plate" placeholder="Number plate, e.g. UGB 123A" />

      {query === '' && (
        <Card className="text-muted-foreground px-4 py-10 text-center text-sm">
          <CarFront className="mx-auto mb-2 size-6" aria-hidden="true" />
          Type a number plate to find the vehicle.
        </Card>
      )}

      {query !== '' && matches.length === 0 && (
        <Card className="px-4 py-8 text-center">
          <p className="text-foreground text-sm font-medium">No vehicle with that plate</p>
          <p className="text-muted-foreground mt-1 text-sm">Register it to start a service.</p>
          {canRegister && (
            <div className="mt-4">
              <LinkButton href={`/vehicles/new?plate=${encodeURIComponent(query)}&next=start`}>
                <Plus aria-hidden="true" />
                Register {query.toUpperCase()}
              </LinkButton>
            </div>
          )}
        </Card>
      )}

      {matches.length > 0 && (
        <ul className="space-y-2" aria-label="Matching vehicles">
          {matches.map((vehicle) => {
            const inactive = vehicle.status !== 'active';
            const body = (
              <Card className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-foreground font-medium">{vehicle.number_plate}</div>
                    <div className="text-muted-foreground truncate text-sm">
                      {[vehicle.make, vehicle.model, vehicle.colour].filter(Boolean).join(' · ')}
                    </div>
                    <div className="text-muted-foreground truncate text-xs">
                      {vehicle.customer_name ?? 'Walk-in'}
                    </div>
                  </div>
                  {inactive ? <StatusBadge status={vehicle.status} /> : null}
                </div>
              </Card>
            );

            return (
              <li key={vehicle.id}>
                {inactive ? (
                  <div className="opacity-60">{body}</div>
                ) : (
                  <Link href={`/new-service?vehicle=${vehicle.id}`} className="block">
                    {body}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
