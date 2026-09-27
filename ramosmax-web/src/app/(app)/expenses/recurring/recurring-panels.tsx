'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { createRecurringAction, updateRecurringAction } from '@/lib/server/finance-actions';
import type { CategoryRow, PickableAccount, RecurringRow } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

export function RecurringPanels({
  recurring,
  categories,
  accounts,
}: {
  recurring: RecurringRow[];
  categories: CategoryRow[];
  accounts: PickableAccount[];
}) {
  const [panel, setPanel] = React.useState<string | null>(null);
  const switchable = recurring.filter((r) => r.active);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setPanel(panel === 'add' ? null : 'add')}>
            Add a recurring expense
          </Button>
          {switchable.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'off' ? null : 'off')}>
              Switch one off
            </Button>
          )}
        </div>

        {panel === 'add' && (
          <ActionForm action={createRecurringAction} submitLabel="Add">
            <div className="space-y-4">
              <Field label="Name" htmlFor="name">
                <Input name="name" required maxLength={80} />
              </Field>
              <Field label="Category" htmlFor="category_id">
                <select id="category_id" name="category_id" className={selectClass} required>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Expected amount (UGX)" htmlFor="expected_amount_ugx">
                <Input name="expected_amount_ugx" type="number" inputMode="numeric" min={1} required className="tabular" />
              </Field>
              <Field label="Frequency" htmlFor="frequency">
                <select id="frequency" name="frequency" className={selectClass} required>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </Field>
              <Field label="Next due" htmlFor="next_due_date">
                <Input name="next_due_date" type="date" required />
              </Field>
              <Field label="Remind days before" htmlFor="reminder_days_before" hint="0 to 30">
                <Input name="reminder_days_before" type="number" min={0} max={30} defaultValue={3} className="tabular" />
              </Field>
              <Field label="Payee" htmlFor="payee" hint="Optional">
                <Input name="payee" />
              </Field>
              <Field label="Intended account" htmlFor="payment_account_id" hint="A plan only.">
                <select id="payment_account_id" name="payment_account_id" className={selectClass}>
                  <option value="">Decide later</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </Field>
            </div>
          </ActionForm>
        )}

        {panel === 'off' && (
          <ActionForm action={updateRecurringAction} submitLabel="Switch off">
            <input type="hidden" name="active" value="false" />
            <div className="space-y-4">
              <Field label="Which one" htmlFor="recurring_id">
                <select id="recurring_id" name="recurring_id" className={selectClass} required>
                  {switchable.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Reason" htmlFor="off-reason" hint="Required, and kept in the audit trail.">
                <Input name="reason" required />
              </Field>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
