'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { adjustLoyaltyAction, reverseLoyaltyAction } from '@/lib/server/billing-actions';
import type { LoyaltyEntry } from '@/lib/server/operations';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * Corrections. Nothing is edited or deleted: an adjustment adds a ledger
 * entry, and a reversal adds another. A redemption is undone by cancelling
 * its invoice, not here.
 */
export function LoyaltyCorrections({
  vehicleId,
  ledger,
}: {
  vehicleId: string;
  ledger: LoyaltyEntry[];
}) {
  const [panel, setPanel] = React.useState<'adjust' | 'reverse' | null>(null);

  const reversible = ledger.filter(
    (e) => e.reversed_by_id === null && e.type !== 'reversal' && e.type !== 'redeemed',
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Corrections</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setPanel(panel === 'adjust' ? null : 'adjust')}>
            Adjust points
          </Button>
          {reversible.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPanel(panel === 'reverse' ? null : 'reverse')}
            >
              Reverse an entry
            </Button>
          )}
        </div>

        {panel === 'adjust' && (
          <ActionForm action={adjustLoyaltyAction} submitLabel="Apply adjustment">
            <input type="hidden" name="vehicle_id" value={vehicleId} />
            <div className="space-y-4">
              <Field
                label="Points"
                htmlFor="points"
                hint="Up to 10,000 either way. The balance never goes below zero."
              >
                <Input name="points" type="number" inputMode="numeric" required className="tabular" />
              </Field>
              <Field label="Reason" htmlFor="adjust-reason" hint="Required, and kept in the ledger.">
                <Input name="reason" required />
              </Field>
            </div>
          </ActionForm>
        )}

        {panel === 'reverse' && (
          <ActionForm action={reverseLoyaltyAction} submitLabel="Reverse entry">
            <input type="hidden" name="vehicle_id" value={vehicleId} />
            <div className="space-y-4">
              <Field label="Entry" htmlFor="transaction_id">
                <select id="transaction_id" name="transaction_id" required className={selectClass}>
                  {reversible.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.type} {entry.points >= 0 ? '+' : ''}
                      {entry.points} · {entry.reason ?? 'no reason'}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason" htmlFor="reverse-reason" hint="Required, and kept in the ledger.">
                <Input name="reason" required />
              </Field>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
