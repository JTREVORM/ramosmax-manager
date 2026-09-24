'use client';

import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { createServiceAction, updateServiceAction } from '@/lib/server/operations-actions';
import type { ServiceRow } from '@/lib/server/operations';

const CATEGORIES = ['washing', 'interior', 'exterior', 'detailing', 'polishing', 'waxing', 'other'];

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * Prices are whole Uganda shillings. The server re-checks the range and
 * records a price change in the audit trail with the old and new value.
 */
export function ServiceForm({ service }: { service?: ServiceRow }) {
  const editing = Boolean(service);

  return (
    <ActionForm
      action={editing ? updateServiceAction : createServiceAction}
      submitLabel={editing ? 'Save changes' : 'Add service'}
      redirectTo={() => '/services'}
      className="max-w-2xl"
    >
      {editing && <input type="hidden" name="id" value={service!.id} />}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Field label="Name" htmlFor="name">
            <Input name="name" required defaultValue={service?.name} autoFocus />
          </Field>
        </div>

        <Field label="Category" htmlFor="category">
          <select
            id="category"
            name="category"
            required
            defaultValue={service?.category ?? 'washing'}
            className={selectClass}
          >
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category.charAt(0).toUpperCase() + category.slice(1)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Price (UGX)" htmlFor="price_ugx" hint="Whole shillings only.">
          <Input
            name="price_ugx"
            type="number"
            inputMode="numeric"
            min={0}
            max={100000000}
            step={1}
            required
            defaultValue={service?.price_ugx ?? ''}
            className="tabular"
          />
        </Field>

        <Field label="Duration (minutes)" htmlFor="duration" hint="Optional">
          <Input
            name="duration"
            type="number"
            inputMode="numeric"
            min={1}
            max={1440}
            defaultValue={service?.estimated_duration_minutes ?? ''}
          />
        </Field>

        <div className="flex items-end">
          <label className="flex items-center gap-2 pb-3 text-sm">
            <input
              type="checkbox"
              name="qualifies_for_loyalty"
              defaultChecked={service?.qualifies_for_loyalty}
              className="size-5"
            />
            Qualifies for loyalty
          </label>
        </div>

        <div className="md:col-span-2">
          <Field label="Description" htmlFor="description" hint="Optional">
            <Input name="description" defaultValue={service?.description ?? ''} />
          </Field>
        </div>

        {editing && (
          <div className="md:col-span-2">
            <Field
              label="Reason for this change"
              htmlFor="reason"
              hint="Recommended when changing a price — it is kept in the audit trail."
            >
              <Input name="reason" />
            </Field>
          </div>
        )}
      </div>
    </ActionForm>
  );
}
