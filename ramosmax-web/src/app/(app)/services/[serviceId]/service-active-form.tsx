'use client';

import { ActionForm } from '@/components/forms/action-form';
import { setServiceActiveAction } from '@/lib/server/operations-actions';

export function ServiceActiveForm({ id, active }: { id: string; active: boolean }) {
  return (
    <ActionForm
      action={setServiceActiveAction}
      submitLabel={active ? 'Reactivate service' : 'Deactivate service'}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={String(active)} />
    </ActionForm>
  );
}
