'use client';

import * as React from 'react';
import { ActionForm } from '@/components/forms/action-form';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { createServiceIntakeAction } from '@/lib/server/operations-actions';
import type { ServiceRow, VehicleRow } from '@/lib/server/operations';

/**
 * Selecting services and starting the job.
 *
 * The running total shown here is a CONVENIENCE for the person at the counter.
 * It is not sent anywhere and it is not what gets charged: the server reads
 * each price from the catalogue and snapshots it onto the job, so a price
 * change mid-visit cannot alter what was agreed.
 */
export function StartServiceForm({
  vehicle,
  services,
}: {
  vehicle: VehicleRow;
  services: ServiceRow[];
}) {
  const [selected, setSelected] = React.useState<string[]>([]);

  const total = services
    .filter((s) => selected.includes(s.id))
    .reduce((sum, s) => sum + Number(s.price_ugx), 0);

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((s) => s !== id) : [...current, id],
    );
  }

  return (
    <ActionForm
      action={createServiceIntakeAction}
      submitLabel={selected.length === 0 ? 'Select at least one service' : 'Start service'}
      redirectTo={(result) => `/jobs/${result.id}`}
    >
      <input type="hidden" name="vehicle_id" value={vehicle.id} />
      {selected.map((id) => (
        <input key={id} type="hidden" name="service_ids" value={id} />
      ))}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Services</CardTitle>
          <span className="text-muted-foreground text-xs">{selected.length} selected</span>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {services.map((service) => {
              const checked = selected.includes(service.id);
              return (
                <li key={service.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-3">
                    <input
                      type="checkbox"
                      className="size-5 shrink-0"
                      checked={checked}
                      onChange={() => toggle(service.id)}
                      aria-label={service.name}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block text-sm font-medium">
                        {service.name}
                      </span>
                      <span className="text-muted-foreground block text-xs">
                        {service.category}
                        {service.estimated_duration_minutes
                          ? ` · ${service.estimated_duration_minutes} min`
                          : ''}
                      </span>
                    </span>
                    <span className="tabular text-foreground shrink-0 text-sm font-medium">
                      {formatUgx(service.price_ugx)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>

      {selected.length > 0 && (
        <div className="bg-surface-muted mt-4 flex items-center justify-between rounded-[var(--radius)] px-4 py-3">
          <span className="text-muted-foreground text-sm">Indicative total</span>
          <span className="tabular text-foreground text-base font-semibold">
            {formatUgx(total)}
          </span>
        </div>
      )}

      <div className="mt-4">
        <Field label="Notes" htmlFor="notes" hint="Optional — anything the workers should know.">
          <Input name="notes" />
        </Field>
      </div>
    </ActionForm>
  );
}
