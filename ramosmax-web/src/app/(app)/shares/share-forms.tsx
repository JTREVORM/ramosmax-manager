'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import {
  adjustSharesAction, createShareClassAction, issueSharesAction, transferSharesAction,
  updateShareClassAction, updateShareholdingPolicyAction,
} from '@/lib/server/ownership-actions';
import type { ShareClassRow, ShareholderRow } from '@/lib/server/ownership';
import type { PickableAccount } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * Issue, transfer or adjust.
 *
 * Nothing here sends a commitment or a total: the server multiplies the shares
 * by the class's own value per share, and ignores anything else.
 */
export function NewTransactionCard({
  shareholders,
  classes,
  accounts,
  permissions,
  today,
  approvalRequired,
}: {
  shareholders: ShareholderRow[];
  classes: ShareClassRow[];
  accounts: PickableAccount[];
  permissions: string[];
  today: string;
  approvalRequired: boolean;
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);
  const [request, setRequest] = React.useState(newRequestId);
  const [source, setSource] = React.useState('account');
  const active = classes.filter((c) => c.active);
  const toggle = (next: string) => {
    setRequest(newRequestId());
    setPanel(panel === next ? null : next);
  };

  if (!can('shares.issue') && !can('shares.transfer') && !can('shares.adjust')) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>New share transaction</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {can('shares.issue') && (
            <Button size="sm" onClick={() => toggle('issue')}>Issue shares</Button>
          )}
          {can('shares.transfer') && (
            <Button size="sm" variant="secondary" onClick={() => toggle('transfer')}>Transfer</Button>
          )}
          {can('shares.adjust') && (
            <Button size="sm" variant="ghost" onClick={() => toggle('adjust')}>Adjust</Button>
          )}
        </div>

        {approvalRequired && panel && (
          <p className="text-muted-foreground text-xs">
            This is a request. Another person with share approval has to approve it before ownership
            or money moves.
          </p>
        )}

        {panel === 'issue' && (
          <ActionForm action={issueSharesAction} submitLabel="Request issue">
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field label="Shareholder" htmlFor="issue-sh">
                <select id="issue-sh" name="shareholder_id" required className={selectClass}>
                  <option value="">Choose…</option>
                  {shareholders.filter((s) => s.status === 'active').map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name} · {s.shareholder_number}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Share class" htmlFor="issue-class">
                <select id="issue-class" name="class_id" required className={selectClass}>
                  <option value="">Choose…</option>
                  {active.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {formatUgx(c.value_per_share_ugx)} a share
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Number of shares" htmlFor="issue-shares">
                <Input id="issue-shares" name="shares" inputMode="numeric" required />
              </Field>
              <Field label="Effective date" htmlFor="issue-date">
                <Input id="issue-date" name="effective_date" type="date" defaultValue={today} max={today} />
              </Field>
              <Field label="Money received" htmlFor="issue-source">
                <select
                  id="issue-source"
                  name="payment_source"
                  className={selectClass}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  <option value="account">Into a business account</option>
                  <option value="prior_record">Paid before RamosMAX tracked the accounts</option>
                  <option value="none">Nothing received yet</option>
                </select>
              </Field>
              {source !== 'none' && (
                <Field label="Amount received" htmlFor="issue-amount">
                  <Input id="issue-amount" name="payment_amount" inputMode="numeric" required />
                </Field>
              )}
              {source === 'account' && (
                <Field label="Account" htmlFor="issue-account">
                  <select id="issue-account" name="account_id" required className={selectClass}>
                    <option value="">Choose an account…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Reference" htmlFor="issue-reference" hint="Optional">
                <Input id="issue-reference" name="reference" />
              </Field>
              <Field
                label="Reason"
                htmlFor="issue-reason"
                hint={source === 'prior_record' ? 'Required for money paid before RamosMAX.' : 'Optional'}
              >
                <Input id="issue-reason" name="reason" required={source === 'prior_record'} />
              </Field>
              <p className="text-muted-foreground text-xs">
                The commitment is worked out by the server: shares × the class&rsquo;s value per
                share. Money received into an account posts one share-capital entry in the ledger —
                owners&rsquo; money, never revenue.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'transfer' && (
          <ActionForm action={transferSharesAction} submitLabel="Request transfer">
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field label="From" htmlFor="from-sh">
                <select id="from-sh" name="from_shareholder_id" required className={selectClass}>
                  <option value="">Choose…</option>
                  {shareholders.filter((s) => s.total_shares > 0).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name} · {Number(s.total_shares).toLocaleString('en-US')} shares
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="To" htmlFor="to-sh">
                <select id="to-sh" name="to_shareholder_id" required className={selectClass}>
                  <option value="">Choose…</option>
                  {shareholders.filter((s) => s.status === 'active').map((s) => (
                    <option key={s.id} value={s.id}>{s.full_name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Share class" htmlFor="transfer-class">
                <select id="transfer-class" name="class_id" required className={selectClass}>
                  <option value="">Choose…</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>{c.code}</option>
                  ))}
                </select>
              </Field>
              <Field label="Number of shares" htmlFor="transfer-shares">
                <Input id="transfer-shares" name="shares" inputMode="numeric" required />
              </Field>
              <Field label="Effective date" htmlFor="transfer-date">
                <Input id="transfer-date" name="effective_date" type="date" defaultValue={today} max={today} />
              </Field>
              <Field label="Reason" htmlFor="transfer-reason" hint="Required.">
                <Input id="transfer-reason" name="reason" required />
              </Field>
              <p className="text-muted-foreground text-xs">
                A transfer creates no shares and moves no business money. Any price agreed between
                the two people is private and is not recorded here.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'adjust' && (
          <ActionForm action={adjustSharesAction} submitLabel="Request adjustment">
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field label="Shareholder" htmlFor="adjust-sh">
                <select id="adjust-sh" name="shareholder_id" required className={selectClass}>
                  <option value="">Choose…</option>
                  {shareholders.map((s) => (
                    <option key={s.id} value={s.id}>{s.full_name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Share class" htmlFor="adjust-class">
                <select id="adjust-class" name="class_id" required className={selectClass}>
                  <option value="">Choose…</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>{c.code}</option>
                  ))}
                </select>
              </Field>
              <Field label="Correction" htmlFor="adjust-delta" hint="Whole shares, e.g. -5 or 10.">
                <Input id="adjust-delta" name="delta_shares" required />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="adjust_commitment" value="true" className="size-5" />
                Move the commitment too
              </label>
              <Field label="Effective date" htmlFor="adjust-date">
                <Input id="adjust-date" name="effective_date" type="date" defaultValue={today} max={today} />
              </Field>
              <Field label="Reason" htmlFor="adjust-reason" hint="Required.">
                <Input id="adjust-reason" name="reason" required />
              </Field>
              <p className="text-muted-foreground text-xs">
                A correction is a NEW entry. The earlier ones stay exactly as they were.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

export function ShareClassForms({ classes }: { classes: ShareClassRow[] }) {
  const [panel, setPanel] = React.useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Share classes</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setPanel(panel === 'new' ? null : 'new')}>
            New class
          </Button>
          {classes.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(panel === 'edit' ? null : 'edit')}>
              Change a class
            </Button>
          )}
        </div>

        {panel === 'new' && (
          <ActionForm action={createShareClassAction} submitLabel="Create class">
            <div className="space-y-3">
              <Field label="Code" htmlFor="class-code" hint="2–20 capitals, digits or underscores, e.g. ORDINARY.">
                <Input id="class-code" name="code" required />
              </Field>
              <Field label="Name" htmlFor="class-name">
                <Input id="class-name" name="name" required />
              </Field>
              <Field label="Value per share" htmlFor="class-value" hint="Whole shillings.">
                <Input id="class-value" name="value_per_share_ugx" inputMode="numeric" required />
              </Field>
              <Field label="Description" htmlFor="class-description" hint="Optional">
                <Input id="class-description" name="description" />
              </Field>
              <p className="text-muted-foreground text-xs">
                No legal characteristics are modelled. This is a business record of ownership.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'edit' && (
          <ActionForm action={updateShareClassAction} submitLabel="Save class">
            <div className="space-y-3">
              <Field label="Class" htmlFor="edit-class">
                <select id="edit-class" name="class_id" required className={selectClass}>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {formatUgx(c.value_per_share_ugx)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Name" htmlFor="edit-class-name" hint="Optional">
                <Input id="edit-class-name" name="name" />
              </Field>
              <Field label="Value per share" htmlFor="edit-class-value" hint="Applies to FUTURE issues only.">
                <Input id="edit-class-value" name="value_per_share_ugx" inputMode="numeric" />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="active" value="true" defaultChecked className="size-5" />
                Active (an inactive class receives no new shares)
              </label>
              <Field label="Reason" htmlFor="edit-class-reason" hint="Required to change the price or retire a class.">
                <Input id="edit-class-reason" name="reason" />
              </Field>
              <p className="text-muted-foreground text-xs">
                Every issue keeps the value per share it used, so a change here moves no history.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

export function SharePolicyCard({
  policy,
  dividendPolicy,
}: {
  policy: Record<string, boolean>;
  dividendPolicy: Record<string, boolean>;
}) {
  const [open, setOpen] = React.useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Policy</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <dl className="space-y-1">
          <Row label="Share transactions need approval" value={policy.requireApproval ? 'Yes' : 'No'} />
          <Row label="Shares may be part-paid" value={policy.allowPartialPayment ? 'Yes' : 'No'} />
          <Row label="Shares may be unpaid" value={policy.allowUnpaidShares ? 'Yes' : 'No'} />
          <Row
            label="Dividends need an Administrator"
            value={dividendPolicy.requireAdminApproval ? 'Yes' : 'No'}
          />
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setOpen(open === 'share' ? null : 'share')}>
            Change share policy
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setOpen(open === 'dividend' ? null : 'dividend')}>
            Change dividend policy
          </Button>
        </div>

        {open === 'share' && (
          <ActionForm action={updateShareholdingPolicyAction} submitLabel="Save share policy">
            <input type="hidden" name="policy" value="share" />
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="requireApproval" value="true"
                       defaultChecked={policy.requireApproval} className="size-5" />
                Every ownership change needs a second person&rsquo;s approval
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="allowPartialPayment" value="true"
                       defaultChecked={policy.allowPartialPayment} className="size-5" />
                Shares may be issued part-paid
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="allowUnpaidShares" value="true"
                       defaultChecked={policy.allowUnpaidShares} className="size-5" />
                Shares may be issued with nothing paid
              </label>
              <Field label="Reason" htmlFor="policy-reason" hint="Required.">
                <Input id="policy-reason" name="reason" required />
              </Field>
              <p className="text-muted-foreground text-xs">
                An unpaid commitment is never counted as cash.
              </p>
            </div>
          </ActionForm>
        )}

        {open === 'dividend' && (
          <ActionForm action={updateShareholdingPolicyAction} submitLabel="Save dividend policy">
            <input type="hidden" name="policy" value="dividend" />
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="requireAdminApproval" value="true"
                       defaultChecked={dividendPolicy.requireAdminApproval} className="size-5" />
                Only an Administrator may approve a dividend
              </label>
              <Field label="Reason" htmlFor="div-policy-reason" hint="Required.">
                <Input id="div-policy-reason" name="reason" required />
              </Field>
              <p className="text-muted-foreground text-xs">
                With this off, the declarer still cannot approve their own, and nobody may approve a
                dividend that pays their own shareholding.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-foreground text-sm">{value}</dd>
    </div>
  );
}
