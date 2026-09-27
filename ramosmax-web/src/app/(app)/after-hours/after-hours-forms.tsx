'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import { GRANT_LABELS, PAYMENT_METHOD_LABELS } from '@/lib/format/after-hours';
import {
  authorizeAfterHoursAction, revokeAfterHoursAction, updateAfterHoursPolicyAction,
} from '@/lib/server/after-hours-actions';
import type { AuthorizationRow } from '@/lib/server/after-hours';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * Put somebody on an after-hours shift.
 *
 * The length is sent, not an end time: the database adds it to its own clock,
 * so a full-length shift is never refused because a browser or a web server
 * is a second ahead.
 */
export function AuthorizeCard({
  staff,
  grantable,
  defaults,
  maxHours,
  maxFloatUgx,
  canApprove,
}: {
  staff: Array<{ id: string; full_name: string; role: string }>;
  grantable: string[];
  defaults: string[];
  maxHours: number;
  maxFloatUgx: number;
  canApprove: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [request, setRequest] = React.useState(newRequestId);

  if (!canApprove) return null;

  const hours = [2, 4, 6, 8, 12, 16, 24].filter((h) => h <= maxHours);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Authorise after-hours work</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <Button
          size="sm"
          onClick={() => {
            setRequest(newRequestId());
            setOpen(!open);
          }}
        >
          {open ? 'Close' : 'Authorise somebody'}
        </Button>

        {open && (
          <ActionForm action={authorizeAfterHoursAction} submitLabel="Authorise">
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field label="Who is on duty" htmlFor="ah-staff">
                <select id="ah-staff" name="staff_uid" required className={selectClass}>
                  <option value="">Choose…</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="For how long" htmlFor="ah-hours">
                <select id="ah-hours" name="hours" defaultValue="8" className={selectClass}>
                  {hours.map((h) => (
                    <option key={h} value={h}>
                      {h} hours
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Opening float"
                htmlFor="ah-float"
                hint={`At most ${formatUgx(maxFloatUgx)}. It goes into their hands and has to come back.`}
              >
                <Input id="ah-float" name="opening_float_ugx" inputMode="numeric" defaultValue="0" />
              </Field>
              <fieldset className="space-y-2">
                <legend className="text-muted-foreground text-sm">What they may do</legend>
                {grantable.map((permission) => (
                  <label key={permission} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="permissions"
                      value={permission}
                      defaultChecked={defaults.includes(permission)}
                      disabled={permission === 'after_hours.operate'}
                    />
                    {GRANT_LABELS[permission] ?? permission}
                  </label>
                ))}
                <p className="text-muted-foreground text-xs">
                  This list is the whole of it. No user or password administration, no salaries or
                  payroll, no finance, no reversals, no discounts, no settings — those cannot be
                  handed out by an authorisation at all.
                </p>
              </fieldset>
              <Field label="Why" htmlFor="ah-reason">
                <Input id="ah-reason" name="reason" required />
              </Field>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

/** End an authorisation now. The cash still has to come back. */
export function RevokeCard({
  authorizations,
  canApprove,
}: {
  authorizations: AuthorizationRow[];
  canApprove: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const live = authorizations.filter((a) => a.live);
  if (!canApprove || live.length === 0) return null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'End an authorisation'}
        </Button>
        {open && (
          <ActionForm action={revokeAfterHoursAction} submitLabel="End it now">
            <div className="space-y-3">
              <Field label="Whose" htmlFor="ah-revoke">
                <select id="ah-revoke" name="authorization_id" required className={selectClass}>
                  <option value="">Choose…</option>
                  {live.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.staff_name} · {a.authorization_number}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Why" htmlFor="ah-revoke-reason">
                <Input id="ah-revoke-reason" name="reason" required />
              </Field>
              <p className="text-muted-foreground text-xs">
                The permissions go at once. An open session still has to be closed and the cash
                handed over — ending access must never strand the money.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

export function AfterHoursPolicyCard({
  policy,
  canManage,
}: {
  policy: { allowedPaymentMethods: string[]; maxAuthorizationHours: number; maxOpeningFloatUgx: number };
  canManage: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>After-hours policy</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Payment methods allowed</dt>
            <dd>
              {policy.allowedPaymentMethods
                .map((m) => PAYMENT_METHOD_LABELS[m] ?? m)
                .join(', ')}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Longest authorisation</dt>
            <dd className="tabular">{policy.maxAuthorizationHours} hours</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Largest opening float</dt>
            <dd className="tabular">{formatUgx(policy.maxOpeningFloatUgx)}</dd>
          </div>
        </dl>

        {canManage && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(!open)}>
            {open ? 'Close' : 'Change the policy'}
          </Button>
        )}

        {canManage && open && (
          <ActionForm action={updateAfterHoursPolicyAction} submitLabel="Save policy">
            <div className="space-y-3">
              <fieldset className="space-y-2">
                <legend className="text-muted-foreground text-sm">
                  Payment methods allowed after hours
                </legend>
                {['cash', 'mtn_merchant', 'airtel_merchant', 'bank'].map((method) => (
                  <label key={method} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="allowed_payment_methods"
                      value={method}
                      defaultChecked={policy.allowedPaymentMethods.includes(method)}
                    />
                    {PAYMENT_METHOD_LABELS[method]}
                  </label>
                ))}
              </fieldset>
              <Field label="Longest authorisation (hours)" htmlFor="ah-policy-hours" hint="1 to 24.">
                <Input
                  id="ah-policy-hours"
                  name="max_authorization_hours"
                  inputMode="numeric"
                  defaultValue={String(policy.maxAuthorizationHours)}
                />
              </Field>
              <Field label="Largest opening float" htmlFor="ah-policy-float">
                <Input
                  id="ah-policy-float"
                  name="max_opening_float_ugx"
                  inputMode="numeric"
                  defaultValue={String(policy.maxOpeningFloatUgx)}
                />
              </Field>
              <Field label="Why" htmlFor="ah-policy-reason">
                <Input id="ah-policy-reason" name="reason" required />
              </Field>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
