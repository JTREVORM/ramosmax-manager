'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { createCategoryAction, updateCategoryAction } from '@/lib/server/finance-actions';
import type { CategoryRow } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

export function CategoryPanels({ categories }: { categories: CategoryRow[] }) {
  const [panel, setPanel] = React.useState<string | null>(null);
  const active = categories.filter((c) => c.active);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setPanel(panel === 'add' ? null : 'add')}>
            Add a category
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setPanel(panel === 'rename' ? null : 'rename')}>
            Rename
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'retire' ? null : 'retire')}>
            Retire
          </Button>
        </div>

        {panel === 'add' && (
          <ActionForm action={createCategoryAction} submitLabel="Add category">
            <Field label="Name" htmlFor="name" hint="The id is made from the name, e.g. Security Services → security_services.">
              <Input name="name" required maxLength={40} />
            </Field>
          </ActionForm>
        )}

        {panel === 'rename' && (
          <ActionForm action={updateCategoryAction} submitLabel="Rename">
            <div className="space-y-4">
              <Field label="Category" htmlFor="category_id">
                <select id="category_id" name="category_id" className={selectClass} required>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="New name" htmlFor="name">
                <Input name="name" required maxLength={40} />
              </Field>
            </div>
          </ActionForm>
        )}

        {panel === 'retire' && (
          <ActionForm action={updateCategoryAction} submitLabel="Retire category">
            <input type="hidden" name="active" value="false" />
            <div className="space-y-4">
              <Field
                label="Category"
                htmlFor="retire_category_id"
                hint="A retired category cannot be used for new expenses. Existing ones keep it."
              >
                <select id="retire_category_id" name="category_id" className={selectClass} required>
                  {active.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Reason" htmlFor="retire-reason" hint="Required, and kept in the audit trail.">
                <Input name="reason" required />
              </Field>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
