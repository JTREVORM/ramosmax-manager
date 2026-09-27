'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { createSupplierAction } from '@/lib/server/finance-actions';

export function SupplierForm() {
  const [open, setOpen] = React.useState(false);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Add a supplier</CardTitle>
        <Button size="sm" variant="secondary" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'New supplier'}
        </Button>
      </CardHeader>
      {open && (
        <CardBody>
          <ActionForm action={createSupplierAction} submitLabel="Add supplier">
            <div className="space-y-4">
              <Field label="Name" htmlFor="name">
                <Input name="name" required maxLength={80} />
              </Field>
              <Field label="Contact person" htmlFor="contact_person" hint="Optional">
                <Input name="contact_person" />
              </Field>
              <Field label="Phone" htmlFor="phone" hint="Optional, e.g. 0772 123 456">
                <Input name="phone" inputMode="tel" />
              </Field>
              <Field label="Email" htmlFor="email" hint="Optional">
                <Input name="email" type="email" />
              </Field>
              <Field label="Address" htmlFor="address" hint="Optional">
                <Input name="address" />
              </Field>
            </div>
          </ActionForm>
        </CardBody>
      )}
    </Card>
  );
}
