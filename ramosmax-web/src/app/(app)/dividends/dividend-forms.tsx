'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import { createDividendAction } from '@/lib/server/ownership-actions';
import type { ShareClassRow } from '@/lib/server/ownership';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * Start a dividend run.
 *
 * Nothing is allocated here. The run is a draft until somebody calculates it,
 * and the calculation happens on the server against the ownership the record
 * date froze.
 */
export function NewDividendCard({
  classes,
  today,
  canCreate,
}: {
  classes: ShareClassRow[];
  today: string;
  canCreate: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [request, setRequest] = React.useState(newRequestId);
  const [method, setMethod] = React.useState('pool');

  if (!canCreate) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>New dividend run</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <Button
          size="sm"
          onClick={() => {
            setRequest(newRequestId());
            setOpen(!open);
          }}
        >
          {open ? 'Close' : 'Start a dividend run'}
        </Button>

        {open && (
          <ActionForm
            action={createDividendAction}
            submitLabel="Create draft"
            redirectTo={(r) => (r.id ? `/dividends/${r.id}` : '/dividends')}
          >
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field label="Financial period" htmlFor="div-period" hint="For example 2026 or 2026-H1.">
                <Input id="div-period" name="financial_period" required />
              </Field>
              <Field
                label="Record date"
                htmlFor="div-record"
                hint="Who owned what on this date decides who is paid. It is frozen once calculated."
              >
                <Input id="div-record" name="record_date" type="date" defaultValue={today} max={today} required />
              </Field>
              <Field label="Declaration date" htmlFor="div-declared">
                <Input id="div-declared" name="declaration_date" type="date" defaultValue={today} />
              </Field>
              <Field label="Share class" htmlFor="div-class">
                <select id="div-class" name="class_id" className={selectClass}>
                  <option value="">All classes</option>
                  {classes.filter((c) => c.active).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {formatUgx(c.value_per_share_ugx)} a share
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="How it is worked out" htmlFor="div-method">
                <select
                  id="div-method"
                  name="calculation_method"
                  className={selectClass}
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                >
                  <option value="pool">Share a pool by ownership</option>
                  <option value="per_share">Pay a set amount for every share</option>
                </select>
              </Field>
              {method === 'pool' ? (
                <Field
                  label="Pool to distribute"
                  htmlFor="div-pool"
                  hint="Split by ownership at the record date, rounded down to the shilling."
                >
                  <Input id="div-pool" name="total_distributable_ugx" inputMode="numeric" required />
                </Field>
              ) : (
                <Field label="Amount for every share" htmlFor="div-per-share">
                  <Input id="div-per-share" name="dividend_per_share_ugx" inputMode="numeric" required />
                </Field>
              )}
              <Field label="Payment date" htmlFor="div-payment">
                <Input id="div-payment" name="payment_date" type="date" />
              </Field>
              <Field label="Notes" htmlFor="div-notes">
                <Input id="div-notes" name="notes" />
              </Field>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
