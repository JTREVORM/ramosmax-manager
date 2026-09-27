'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { cancelDeductionAction } from '@/lib/server/workforce-actions';
import type { DeductionRow } from '@/lib/server/workforce';

export function CancelDeductionCard({ deduction }: { deduction: DeductionRow }) {
  const [open, setOpen] = React.useState(false);
  if (!['active', 'pending_approval'].includes(deduction.status)) return null;

  return (
    <Card>
      <CardBody className="space-y-3">
        {!open ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            Stop this deduction
          </Button>
        ) : (
          <ActionForm action={cancelDeductionAction} submitLabel="Stop deduction">
            <input type="hidden" name="deduction_id" value={deduction.id} />
            <Field
              label="Reason"
              htmlFor="stop-reason"
              hint="Required, and kept in the audit trail."
            >
              <Input id="stop-reason" name="reason" required />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              What has already been recovered stays recorded. A deduction an unpaid payroll plans to
              take cannot be stopped until that payroll has been corrected or cancelled.
            </p>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
