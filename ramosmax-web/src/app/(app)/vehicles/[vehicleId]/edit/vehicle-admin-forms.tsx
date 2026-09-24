'use client';

import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { changeVehiclePlateAction, setVehicleStatusAction } from '@/lib/server/operations-actions';

export function PlateChangeForm({ id }: { id: string }) {
  return (
    <ActionForm action={changeVehiclePlateAction} submitLabel="Change plate">
      <input type="hidden" name="id" value={id} />
      <div className="space-y-4">
        <Field label="New number plate" htmlFor="number_plate">
          <Input name="number_plate" required autoCapitalize="characters" className="uppercase" />
        </Field>
        <Field label="Reason" htmlFor="plate_reason" hint="Required, and kept in the audit trail.">
          <Input name="reason" required />
        </Field>
      </div>
    </ActionForm>
  );
}

export function VehicleStatusForm({ id, active }: { id: string; active: boolean }) {
  return (
    <ActionForm
      action={setVehicleStatusAction}
      submitLabel={active ? 'Reactivate vehicle' : 'Deactivate vehicle'}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={String(active)} />
      <Field label="Reason" htmlFor="status_reason" hint="Required, and kept in the audit trail.">
        <Input name="reason" required />
      </Field>
    </ActionForm>
  );
}
