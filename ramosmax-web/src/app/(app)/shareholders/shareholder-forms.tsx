'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { newRequestId } from '@/lib/online';
import {
  createShareholderAction, linkShareholderAccountAction, setShareholderStatusAction,
  updateShareholderAction,
} from '@/lib/server/ownership-actions';
import type { ShareholderRow } from '@/lib/server/ownership';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

const ID_TYPES = [
  ['', 'None'],
  ['national_id', 'National ID'],
  ['passport', 'Passport'],
  ['company_registration', 'Company registration'],
  ['other', 'Other'],
] as const;

export function AddShareholderCard({ today }: { today: string }) {
  const [open, setOpen] = React.useState(false);
  const [request] = React.useState(newRequestId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a shareholder</CardTitle>
      </CardHeader>
      <CardBody>
        {!open ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Add shareholder
          </Button>
        ) : (
          <ActionForm action={createShareholderAction} submitLabel="Add shareholder">
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field label="Full name" htmlFor="full_name" hint="A person or a company.">
                <Input id="full_name" name="full_name" required />
              </Field>
              <Field label="Phone number" htmlFor="phone_number" hint="Optional. One shareholder per number.">
                <Input id="phone_number" name="phone_number" inputMode="tel" />
              </Field>
              <Field label="Email" htmlFor="email" hint="Optional">
                <Input id="email" name="email" type="email" />
              </Field>
              <Field label="Address" htmlFor="address" hint="Optional">
                <Input id="address" name="address" />
              </Field>
              <Field label="Identification type" htmlFor="id_type" hint="Enter both the type and the number, or neither.">
                <select id="id_type" name="id_type" className={selectClass}>
                  {ID_TYPES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Identification number" htmlFor="id_number" hint="Optional">
                <Input id="id_number" name="id_number" />
              </Field>
              <Field label="Join date" htmlFor="join_date">
                <Input id="join_date" name="join_date" type="date" defaultValue={today} max={today} />
              </Field>
              <Field label="Notes" htmlFor="notes" hint="Optional">
                <Input id="notes" name="notes" />
              </Field>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

export function ShareholderActions({
  shareholder,
  permissions,
  users,
}: {
  shareholder: ShareholderRow;
  permissions: string[];
  users: Array<{ id: string; full_name: string; role: string }>;
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);
  const toggle = (next: string) => setPanel(panel === next ? null : next);

  if (!can('shareholders.update') && !can('shareholders.manage')) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {can('shareholders.update') && (
            <Button size="sm" variant="secondary" onClick={() => toggle('edit')}>
              Edit profile
            </Button>
          )}
          {can('shareholders.manage') && (
            <>
              <Button size="sm" variant="secondary" onClick={() => toggle('status')}>
                Change status
              </Button>
              <Button size="sm" variant="ghost" onClick={() => toggle('link')}>
                {shareholder.linked_uid ? 'Unlink sign-in' : 'Link sign-in'}
              </Button>
            </>
          )}
        </div>

        {panel === 'edit' && (
          <ActionForm action={updateShareholderAction} submitLabel="Save changes">
            <input type="hidden" name="shareholder_id" value={shareholder.id} />
            <div className="space-y-3">
              <Field label="Full name" htmlFor="edit-name">
                <Input id="edit-name" name="full_name" defaultValue={shareholder.full_name} />
              </Field>
              <Field label="Phone number" htmlFor="edit-phone">
                <Input id="edit-phone" name="phone_number" defaultValue={shareholder.phone_number ?? ''} />
              </Field>
              <Field label="Email" htmlFor="edit-email">
                <Input id="edit-email" name="email" type="email" defaultValue={shareholder.email ?? ''} />
              </Field>
              <Field label="Address" htmlFor="edit-address">
                <Input id="edit-address" name="address" defaultValue={shareholder.address ?? ''} />
              </Field>
              <Field label="Notes" htmlFor="edit-notes">
                <Input id="edit-notes" name="notes" defaultValue={shareholder.notes ?? ''} />
              </Field>
              <Field label="Reason" htmlFor="edit-reason" hint="Optional, and kept in the audit trail.">
                <Input id="edit-reason" name="reason" />
              </Field>
              <p className="text-muted-foreground text-xs">
                The phone number and identification are masked in the audit trail.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'status' && (
          <ActionForm action={setShareholderStatusAction} submitLabel="Change status">
            <input type="hidden" name="shareholder_id" value={shareholder.id} />
            <div className="space-y-3">
              <Field label="Status" htmlFor="status">
                <select id="status" name="status" className={selectClass} defaultValue={shareholder.status}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="suspended">Suspended</option>
                  <option value="exited">Exited</option>
                </select>
              </Field>
              <Field label="Reason" htmlFor="status-reason" hint="Required.">
                <Input id="status-reason" name="reason" required />
              </Field>
              <p className="text-muted-foreground text-xs">
                Only an active shareholder can receive new shares. Exiting needs no shares, nothing
                outstanding and no pending transaction — the history is kept either way.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'link' && (
          <ActionForm action={linkShareholderAccountAction} submitLabel="Save link">
            <input type="hidden" name="shareholder_id" value={shareholder.id} />
            <div className="space-y-3">
              <Field
                label="RamosMAX sign-in"
                htmlFor="uid"
                hint="The person who IS this shareholder. Leave blank to unlink."
              >
                <select id="uid" name="uid" className={selectClass} defaultValue={shareholder.linked_uid ?? ''}>
                  <option value="">Nobody</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name} · {u.role}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason" htmlFor="link-reason" hint="Optional">
                <Input id="link-reason" name="reason" />
              </Field>
              <p className="text-muted-foreground text-xs">
                A linked person sees their own shareholding in My Shareholding, and nothing else.
                One sign-in belongs to one shareholder.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
