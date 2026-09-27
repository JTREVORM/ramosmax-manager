'use client';

import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { createCustomerAction, updateCustomerAction } from '@/lib/server/operations-actions';
import type { CustomerRow } from '@/lib/server/operations';

/**
 * The phone number is optional — a walk-in may not give one — but when given
 * it must be unique across customers. The server decides that; this form only
 * collects the value.
 */
export function CustomerForm({ customer }: { customer?: CustomerRow }) {
  const editing = Boolean(customer);

  return (
    <ActionForm
      action={editing ? updateCustomerAction : createCustomerAction}
      submitLabel={editing ? 'Save changes' : 'Add customer'}
      redirectTo={(result) => (editing ? `/customers/${customer!.id}` : `/customers/${result.id}`)}
      className="max-w-2xl"
    >
      {editing && <input type="hidden" name="id" value={customer!.id} />}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Field label="Full name" htmlFor="full_name">
            <Input name="full_name" required defaultValue={customer?.full_name} autoFocus />
          </Field>
        </div>

        <Field label="Phone number" htmlFor="phone_number" hint="Optional. 0772 123 456">
          <Input
            name="phone_number"
            type="tel"
            inputMode="tel"
            defaultValue={customer?.phone_number ?? ''}
          />
        </Field>

        <Field label="Alternative phone" htmlFor="alternative_phone" hint="Optional">
          <Input
            name="alternative_phone"
            type="tel"
            inputMode="tel"
            defaultValue={customer?.alternative_phone ?? ''}
          />
        </Field>

        <Field label="Email" htmlFor="email" hint="Optional">
          <Input name="email" type="email" defaultValue={customer?.email ?? ''} />
        </Field>

        <Field label="Address" htmlFor="address" hint="Optional">
          <Input name="address" defaultValue={customer?.address ?? ''} />
        </Field>

        <div className="md:col-span-2">
          <Field label="Notes" htmlFor="notes" hint="Optional">
            <Input name="notes" defaultValue={customer?.notes ?? ''} />
          </Field>
        </div>
      </div>
    </ActionForm>
  );
}
