'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { reverseTransactionAction } from '@/lib/server/finance-actions';

/** Reversing posts the mirror entry. Nothing is edited and nothing is deleted. */
export function ReverseTransaction({ transactionId }: { transactionId: string }) {
  const [open, setOpen] = React.useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Correction</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-muted-foreground text-sm">
          A mistake is corrected by reversing it. Both entries stay in the ledger.
        </p>
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          Reverse this transaction
        </Button>
        {open && (
          <ActionForm
            action={reverseTransactionAction}
            submitLabel="Reverse transaction"
            confirm="Reverse this transaction? The mirror entry is posted and both are kept."
          >
            <input type="hidden" name="transaction_id" value={transactionId} />
            <Field label="Reason" htmlFor="reverse-reason" hint="Required, and kept in the audit trail.">
              <Input name="reason" required />
            </Field>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
