'use client';

import * as React from 'react';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { createVehicleAction, updateVehicleAction } from '@/lib/server/operations-actions';
import type { CustomerRow, VehicleRow } from '@/lib/server/operations';

const TYPES = ['car', 'suv', 'pickup', 'van', 'bus', 'truck', 'motorcycle', 'other'];

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * Registering a vehicle. The plate is normalised and checked for uniqueness by
 * the server — "UGB 123A" and "ugb-123a" are the same vehicle — so this form
 * accepts whatever the person types.
 */
export function VehicleForm({
  vehicle,
  customers,
  initialPlate,
  nextAction,
}: {
  vehicle?: VehicleRow;
  customers?: CustomerRow[];
  initialPlate?: string;
  nextAction?: 'start';
}) {
  const editing = Boolean(vehicle);

  return (
    <ActionForm
      action={editing ? updateVehicleAction : createVehicleAction}
      submitLabel={editing ? 'Save changes' : 'Register vehicle'}
      redirectTo={(result) =>
        editing
          ? `/vehicles/${vehicle!.id}`
          : nextAction === 'start'
            ? `/new-service?vehicle=${result.id}`
            : `/vehicles/${result.id}`
      }
      className="max-w-2xl"
    >
      {editing && <input type="hidden" name="id" value={vehicle!.id} />}

      <div className="grid gap-4 md:grid-cols-2">
        {!editing && (
          <div className="md:col-span-2">
            <Field
              label="Number plate"
              htmlFor="number_plate"
              hint="Any spacing works — UGB 123A, ugb-123a and UGB123A are the same vehicle."
            >
              <Input
                name="number_plate"
                required
                autoFocus
                autoCapitalize="characters"
                defaultValue={initialPlate ?? ''}
                className="font-medium uppercase"
              />
            </Field>
          </div>
        )}

        <Field label="Make" htmlFor="make" hint="Optional">
          <Input name="make" defaultValue={vehicle?.make ?? ''} />
        </Field>

        <Field label="Model" htmlFor="model">
          <Input name="model" required defaultValue={vehicle?.model} />
        </Field>

        <Field label="Colour" htmlFor="colour">
          <Input name="colour" required defaultValue={vehicle?.colour} />
        </Field>

        <Field label="Year" htmlFor="year" hint="Optional">
          <Input
            name="year"
            type="number"
            inputMode="numeric"
            min={1950}
            max={2100}
            defaultValue={vehicle?.year ?? ''}
          />
        </Field>

        <Field label="Vehicle type" htmlFor="vehicle_type" hint="Optional">
          <select
            id="vehicle_type"
            name="vehicle_type"
            defaultValue={vehicle?.vehicle_type ?? ''}
            className={selectClass}
          >
            <option value="">Not specified</option>
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </option>
            ))}
          </select>
        </Field>

        {!editing && customers && (
          <Field label="Owner" htmlFor="customer_id" hint="Optional — leave blank for a walk-in.">
            <select id="customer_id" name="customer_id" className={selectClass} defaultValue="">
              <option value="">No customer</option>
              {customers
                .filter((c) => c.status === 'active')
                .map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.full_name} · {customer.customer_number}
                  </option>
                ))}
            </select>
          </Field>
        )}

        <div className="md:col-span-2">
          <Field label="Notes" htmlFor="notes" hint="Optional">
            <Input name="notes" defaultValue={vehicle?.notes ?? ''} />
          </Field>
        </div>
      </div>
    </ActionForm>
  );
}
