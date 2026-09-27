'use client';

import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { cancelServiceIntakeAction } from '@/lib/server/operations-actions';

export function CancelJobForm({ id }: { id: string }) {
  return (
    <ActionForm
      action={cancelServiceIntakeAction}
      submitLabel="Cancel job"
      confirm="Cancel this job? This cannot be undone."
    >
      <input type="hidden" name="id" value={id} />
      <Field label="Reason" htmlFor="reason" hint="Required, and kept in the audit trail.">
        <Input name="reason" required />
      </Field>
    </ActionForm>
  );
}
