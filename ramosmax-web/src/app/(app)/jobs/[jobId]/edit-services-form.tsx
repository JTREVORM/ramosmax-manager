'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { updateServiceIntakeAction } from '@/lib/server/operations-actions';
import type { ServiceRow } from '@/lib/server/operations';

/**
 * Adds or removes services on a job.
 *
 * The prices shown are today's catalogue prices, which is what a service added
 * now will be charged at. The prices already on the job do not move: the job
 * keeps what it was quoted.
 */
export function EditServicesForm({
  jobId,
  services,
  selected,
}: {
  jobId: string;
  services: ServiceRow[];
  selected: string[];
}) {
  const [open, setOpen] = React.useState(false);
  const [chosen, setChosen] = React.useState<string[]>(selected);

  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Change services
      </Button>
    );
  }

  const total = services
    .filter((s) => chosen.includes(s.id))
    .reduce((sum, s) => sum + Number(s.price_ugx), 0);

  const toggle = (id: string) =>
    setChosen((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );

  return (
    <ActionForm
      action={updateServiceIntakeAction}
      submitLabel="Save services"
      onDone={() => setOpen(false)}
    >
      <input type="hidden" name="id" value={jobId} />
      <div className="space-y-3">
        <fieldset className="space-y-1">
          <legend className="text-muted-foreground text-sm">
            Services on this job (1 to 20)
          </legend>
          <ul className="border-border max-h-72 divide-y divide-border overflow-y-auto rounded-[var(--radius)] border">
            {services.map((service) => (
              <li key={service.id}>
                <label className="flex min-h-12 items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    name="service_ids"
                    value={service.id}
                    checked={chosen.includes(service.id)}
                    onChange={() => toggle(service.id)}
                  />
                  <span className="text-foreground flex-1 text-sm">{service.name}</span>
                  <span className="tabular text-muted-foreground text-sm">
                    {formatUgx(service.price_ugx)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">
            {chosen.length} chosen · today&rsquo;s prices
          </span>
          <span className="tabular text-foreground font-semibold">{formatUgx(total)}</span>
        </div>

        <Field label="Why" htmlFor="services-reason" hint="Kept in the audit trail.">
          <Input id="services-reason" name="reason" />
        </Field>

        <p className="text-muted-foreground text-xs">
          A service somebody has already started cannot be taken off. Removing one that has not
          been started cancels its work order; it is never deleted.
        </p>

        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Leave it as it is
        </Button>
      </div>
    </ActionForm>
  );
}
