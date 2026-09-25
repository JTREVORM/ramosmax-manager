'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import {
  createDeductionAction,
  createPayrollAction,
  decideDeductionAction,
  setSalaryProfileAction,
  updatePayrollPolicyAction,
} from '@/lib/server/workforce-actions';
import type { DeductionRow, PayrollPolicy, StaffOption } from '@/lib/server/workforce';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function CreatePayrollCard({ year, month }: { year: number; month: number }) {
  const [open, setOpen] = React.useState(false);
  const years = [year, year - 1];
  return (
    <Card>
      <CardHeader>
        <CardTitle>New payroll run</CardTitle>
      </CardHeader>
      <CardBody>
        {!open ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Create a payroll
          </Button>
        ) : (
          <ActionForm action={createPayrollAction} submitLabel="Create payroll">
            <input type="hidden" name="frequency" value="monthly" />
            <div className="space-y-3">
              <Field label="Month" htmlFor="month">
                <select
                  id="month"
                  name="month"
                  defaultValue={String(month)}
                  className={selectClass}
                >
                  {MONTHS.map((label, index) => (
                    <option key={label} value={index + 1}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Year" htmlFor="year">
                <select id="year" name="year" defaultValue={String(year)} className={selectClass}>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Notes" htmlFor="payroll-notes" hint="Optional">
                <Input id="payroll-notes" name="notes" />
              </Field>
              <p className="text-muted-foreground text-xs">
                There can be one monthly payroll per period. The figures are worked out by the
                server when it is prepared.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

export function SetSalaryCard({
  staff,
  today,
  current,
}: {
  staff: StaffOption[];
  today: string;
  current?: {
    staff_uid: string;
    basic_salary_ugx: number;
    payment_frequency: string;
    allowance_eligible: boolean;
    allowance_amount_ugx: number | null;
    active: boolean;
  };
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{current ? 'Change salary' : 'Set a salary'}</CardTitle>
      </CardHeader>
      <CardBody>
        {!open ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            {current ? 'Change salary' : 'Set a salary'}
          </Button>
        ) : (
          <ActionForm action={setSalaryProfileAction} submitLabel="Save salary">
            <div className="space-y-3">
              {current ? (
                <input type="hidden" name="staff_uid" value={current.staff_uid} />
              ) : (
                <Field label="Staff member" htmlFor="salary-staff">
                  <select id="salary-staff" name="staff_uid" required className={selectClass}>
                    <option value="">Choose…</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.full_name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Basic salary" htmlFor="basic" hint="Whole shillings.">
                <Input
                  id="basic"
                  name="basic_salary_ugx"
                  inputMode="numeric"
                  required
                  defaultValue={current ? String(current.basic_salary_ugx) : ''}
                />
              </Field>
              <Field
                label="Effective from"
                htmlFor="effective"
                hint="A new version starts on this date. Earlier payrolls are untouched."
              >
                <Input id="effective" name="effective_from" type="date" defaultValue={today} />
              </Field>
              <Field label="Paid" htmlFor="frequency">
                <select
                  id="frequency"
                  name="payment_frequency"
                  defaultValue={current?.payment_frequency ?? 'monthly'}
                  className={selectClass}
                >
                  <option value="monthly">Monthly</option>
                  <option value="weekly">Weekly</option>
                </select>
              </Field>
              <Field
                label="Daily allowance"
                htmlFor="allowance"
                hint="Leave blank to use the policy amount."
              >
                <Input
                  id="allowance"
                  name="allowance_amount_ugx"
                  inputMode="numeric"
                  defaultValue={current?.allowance_amount_ugx ?? ''}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="allowance_eligible"
                  value="true"
                  defaultChecked={current?.allowance_eligible ?? true}
                  className="size-5"
                />
                Earns a daily allowance
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="active"
                  value="true"
                  defaultChecked={current?.active ?? true}
                  className="size-5"
                />
                Active (an inactive salary is not paid)
              </label>
              <Field
                label="Reason"
                htmlFor="salary-reason"
                hint={current ? 'Required for a change.' : 'Optional'}
              >
                <Input id="salary-reason" name="reason" required={Boolean(current)} />
              </Field>
              <Field label="Notes" htmlFor="salary-notes" hint="Optional">
                <Input id="salary-notes" name="notes" />
              </Field>
              <p className="text-muted-foreground text-xs">Nobody sets their own salary.</p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

export function CreateDeductionCard({ staff, today }: { staff: StaffOption[]; today: string }) {
  const [open, setOpen] = React.useState(false);
  const [request] = React.useState(newRequestId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>New salary deduction</CardTitle>
      </CardHeader>
      <CardBody>
        {!open ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Create a deduction
          </Button>
        ) : (
          <ActionForm action={createDeductionAction} submitLabel="Create deduction">
            <input type="hidden" name="request_id" value={request} />
            <div className="space-y-3">
              <Field label="Staff member" htmlFor="ded-staff">
                <select id="ded-staff" name="staff_uid" required className={selectClass}>
                  <option value="">Choose…</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Type" htmlFor="ded-type">
                <select id="ded-type" name="type" className={selectClass}>
                  <option value="authorized_deduction">Authorised salary deduction</option>
                  <option value="other">Another approved deduction</option>
                </select>
              </Field>
              <Field label="Total amount" htmlFor="ded-total">
                <Input id="ded-total" name="total_amount_ugx" inputMode="numeric" required />
              </Field>
              <Field
                label="Amount per payroll"
                htmlFor="ded-instalment"
                hint="Leave blank to take it all at once."
              >
                <Input id="ded-instalment" name="instalment_ugx" inputMode="numeric" />
              </Field>
              <Field label="First payroll date" htmlFor="ded-start">
                <Input id="ded-start" name="starts_from" type="date" defaultValue={today} />
              </Field>
              <Field label="Reason" htmlFor="ded-reason" hint="Required.">
                <Input id="ded-reason" name="reason" required />
              </Field>
              <Field
                label="Source document"
                htmlFor="ded-reference"
                hint="Required: the signed agreement or other authority."
              >
                <Input id="ded-reference" name="reference" required />
              </Field>
              <p className="text-muted-foreground text-xs">
                A deduction applies only once it has been approved, and never makes net pay
                negative.
              </p>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

export function DecideDeductionCard({ deduction }: { deduction: DeductionRow }) {
  const [decision, setDecision] = React.useState<'approve' | 'reject' | null>(null);
  if (deduction.status !== 'pending_approval') return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Approve or reject</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setDecision(decision === 'approve' ? null : 'approve')}>
            Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDecision(decision === 'reject' ? null : 'reject')}
          >
            Reject
          </Button>
        </div>
        {decision && (
          <ActionForm
            action={decideDeductionAction}
            submitLabel={decision === 'approve' ? 'Approve deduction' : 'Reject deduction'}
          >
            <input type="hidden" name="deduction_id" value={deduction.id} />
            <input type="hidden" name="decision" value={decision} />
            <Field
              label="Reason"
              htmlFor="decide-reason"
              hint={decision === 'reject' ? 'Required.' : 'Optional'}
            >
              <Input id="decide-reason" name="reason" required={decision === 'reject'} />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              Nobody approves a deduction from their own pay. {formatUgx(deduction.instalment_ugx)}{' '}
              would be taken from each payroll until {formatUgx(deduction.total_amount_ugx)} has
              been recovered.
            </p>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

const DAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [7, 'Sun'],
] as const;

export function PolicyCard({ policy }: { policy: PayrollPolicy }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Attendance and payroll policy</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <dl className="space-y-1">
          <Row label="Reporting time" value={policy.reportingTime} />
          <Row label="Grace period" value={`${policy.gracePeriodMinutes} minutes`} />
          <Row label="Late threshold" value={`${policy.lateThresholdMinutes} minutes`} />
          <Row label="Daily allowance" value={formatUgx(policy.defaultDailyAllowanceUgx)} />
          <Row label="Late arrivals" value={policy.lateAllowancePolicy} />
          <Row label="Late deduction" value={formatUgx(policy.lateDeductionUgx)} />
          <Row label="Maximum late deduction" value={formatUgx(policy.maxLateDeductionUgx)} />
          <Row label="Deduction cap" value={`${policy.maxDeductionPercentOfGross}% of gross`} />
          <Row label="Clock-out required" value={policy.requireClockOut ? 'Yes' : 'No'} />
          <Row
            label="Payroll approval"
            value={
              policy.payrollRequiresAdminApproval ? 'Administrator only' : 'Anyone who may approve'
            }
          />
        </dl>

        {!open ? (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Change policy
          </Button>
        ) : (
          <ActionForm action={updatePayrollPolicyAction} submitLabel="Save policy">
            <div className="space-y-3">
              <Field label="Reporting time" htmlFor="reportingTime">
                <Input
                  id="reportingTime"
                  name="reportingTime"
                  type="time"
                  defaultValue={policy.reportingTime}
                />
              </Field>
              <Field label="Grace period (minutes)" htmlFor="gracePeriodMinutes">
                <Input
                  id="gracePeriodMinutes"
                  name="gracePeriodMinutes"
                  inputMode="numeric"
                  defaultValue={String(policy.gracePeriodMinutes)}
                />
              </Field>
              <Field
                label="Late threshold (minutes)"
                htmlFor="lateThresholdMinutes"
                hint="Beyond this, an arrival is severely late."
              >
                <Input
                  id="lateThresholdMinutes"
                  name="lateThresholdMinutes"
                  inputMode="numeric"
                  defaultValue={String(policy.lateThresholdMinutes)}
                />
              </Field>
              <fieldset>
                <legend className="text-muted-foreground mb-1 text-sm">Working days</legend>
                <div className="flex flex-wrap gap-3">
                  {DAYS.map(([value, label]) => (
                    <label key={value} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        name="workingDays"
                        value={value}
                        defaultChecked={policy.workingDays.includes(value)}
                        className="size-5"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label="Daily allowance" htmlFor="defaultDailyAllowanceUgx">
                <Input
                  id="defaultDailyAllowanceUgx"
                  name="defaultDailyAllowanceUgx"
                  inputMode="numeric"
                  defaultValue={String(policy.defaultDailyAllowanceUgx)}
                />
              </Field>
              <Field label="Late arrivals" htmlFor="lateAllowancePolicy">
                <select
                  id="lateAllowancePolicy"
                  name="lateAllowancePolicy"
                  defaultValue={policy.lateAllowancePolicy}
                  className={selectClass}
                >
                  <option value="full">Pay in full</option>
                  <option value="deduct">Deduct</option>
                  <option value="reject">Reject</option>
                </select>
              </Field>
              <Field label="Late deduction" htmlFor="lateDeductionUgx">
                <Input
                  id="lateDeductionUgx"
                  name="lateDeductionUgx"
                  inputMode="numeric"
                  defaultValue={String(policy.lateDeductionUgx)}
                />
              </Field>
              <Field label="Maximum late deduction" htmlFor="maxLateDeductionUgx">
                <Input
                  id="maxLateDeductionUgx"
                  name="maxLateDeductionUgx"
                  inputMode="numeric"
                  defaultValue={String(policy.maxLateDeductionUgx)}
                />
              </Field>
              <Field label="Deduction cap (% of gross)" htmlFor="maxDeductionPercentOfGross">
                <Input
                  id="maxDeductionPercentOfGross"
                  name="maxDeductionPercentOfGross"
                  inputMode="numeric"
                  defaultValue={String(policy.maxDeductionPercentOfGross)}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="requireClockOut"
                  value="true"
                  defaultChecked={policy.requireClockOut}
                  className="size-5"
                />
                A clock-out is required before attendance can be approved
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="allowanceApprovalRequired"
                  value="true"
                  defaultChecked={policy.allowanceApprovalRequired}
                  className="size-5"
                />
                Every allowance needs a decision
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="allowanceOnNonWorkingDays"
                  value="true"
                  defaultChecked={policy.allowanceOnNonWorkingDays}
                  className="size-5"
                />
                Allowances on non-working days
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="payrollRequiresAdminApproval"
                  value="true"
                  defaultChecked={policy.payrollRequiresAdminApproval}
                  className="size-5"
                />
                Payroll must be approved by an Administrator
              </label>
              <Field
                label="Reason"
                htmlFor="policy-reason"
                hint="Required, and kept in the audit trail."
              >
                <Input id="policy-reason" name="reason" required />
              </Field>
              <p className="text-muted-foreground text-xs">
                A change applies from now on. Attendance already recorded keeps the policy it was
                recorded under.
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
      <dd className="tabular text-foreground text-sm">{value}</dd>
    </div>
  );
}
