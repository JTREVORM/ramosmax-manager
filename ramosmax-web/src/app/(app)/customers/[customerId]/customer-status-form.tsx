'use client';

import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { setCustomerStatusAction } from '@/lib/server/operations-actions';

export function CustomerStatusForm({ id, active }: { id: string; active: boolean }) {
  return (
    <ActionForm
      action={setCustomerStatusAction}
      submitLabel={active ? 'Reactivate customer' : 'Deactivate customer'}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={String(active)} />
      <Field label="Reason" htmlFor="reason" hint="Required, and kept in the audit trail.">
        <Input name="reason" required />
      </Field>
    </ActionForm>
  );
}
