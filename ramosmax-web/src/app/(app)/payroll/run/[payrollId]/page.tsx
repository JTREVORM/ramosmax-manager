import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import { listPickableAccounts } from '@/lib/server/finance';
import { businessToday, getPayroll, listEarnings, listPayslips } from '@/lib/server/workforce';
import { PayslipsTable } from '../../payroll-tables';
import { EarningsCard, RunActions } from './run-actions';

export const metadata: Metadata = { title: 'Payroll run' };

export default async function PayrollRunPage({
  params,
}: {
  params: Promise<{ payrollId: string }>;
}) {
  const granted = await requireAnyPermission('payroll.view');
  const { payrollId } = await params;
  const [payroll, today] = await Promise.all([getPayroll(payrollId), businessToday()]);
  if (!payroll) notFound();

  const [payslips, earnings, accounts] = await Promise.all([
    listPayslips(payrollId),
    granted.has('payroll.adjust') ? listEarnings(payrollId) : Promise.resolve([]),
    granted.has('payroll.pay') ? listPickableAccounts() : Promise.resolve([]),
  ]);

  const steps: { label: string; when: string | null; who: string | null; note?: string | null }[] =
    [
      {
        label: 'Reviewed',
        when: payroll.reviewed_at,
        who: payroll.reviewed_by_name,
        note: payroll.review_notes,
      },
      { label: 'Approved', when: payroll.approved_at, who: payroll.approved_by_name },
      {
        label: 'Paid',
        when: payroll.paid_at,
        who: payroll.paid_by_name,
        note: payroll.paid_from_account_name,
      },
      { label: 'Locked', when: payroll.locked_at, who: null },
    ].filter((s) => s.when !== null);

  return (
    <div className="space-y-4">
      <PageHeader
        title={payroll.payroll_number}
        subtitle={`${payroll.period_label} · ${formatDate(payroll.period_start)} to ${formatDate(payroll.period_end)}`}
        back={{ href: '/payroll', label: 'Payroll' }}
        action={<StatusBadge status={payroll.status} />}
      />

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Staff" value={String(payroll.employee_count)} />
          <Row label="Basic salaries" value={formatUgx(payroll.total_basic_ugx)} />
          <Row label="Allowances" value={formatUgx(payroll.total_allowances_ugx)} />
          {payroll.total_other_earnings_ugx > 0 && (
            <Row label="Other earnings" value={formatUgx(payroll.total_other_earnings_ugx)} />
          )}
          <Row label="Gross pay" value={formatUgx(payroll.total_gross_ugx)} />
          {payroll.total_loss_recoveries_ugx > 0 && (
            <Row
              label="Loss recoveries"
              value={`− ${formatUgx(payroll.total_loss_recoveries_ugx)}`}
            />
          )}
          <Row label="Deductions" value={`− ${formatUgx(payroll.total_deductions_ugx)}`} />
          <Row label="Net pay" value={formatUgx(payroll.total_net_ugx)} strong />
          <Row label="Calculation" value={`Version ${payroll.version}`} />
        </CardBody>
      </Card>

      {payroll.status !== 'paid' && payroll.status !== 'locked' && (
        <Card className="bg-surface-muted">
          <CardBody>
            <p className="text-muted-foreground text-sm">
              No money has moved and no deduction has been applied. A payroll affects an account, a
              deduction and a loss recovery only when it is paid.
            </p>
          </CardBody>
        </Card>
      )}

      {payroll.returned_reason && (
        <Card className="bg-warning-bg">
          <CardBody>
            <p className="text-warning text-sm">
              Returned for correction: {payroll.returned_reason}
            </p>
          </CardBody>
        </Card>
      )}

      <RunActions
        payroll={payroll}
        payslips={payslips}
        accounts={accounts}
        permissions={[...granted]}
        today={today}
      />

      <EarningsCard
        payroll={payroll}
        payslips={payslips}
        earnings={earnings}
        permissions={[...granted]}
      />

      <PayslipsTable rows={payslips} />

      {steps.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2">
              {steps.map((step) => (
                <li key={step.label} className="text-sm">
                  <span className="text-foreground font-medium">{step.label}</span>{' '}
                  <span className="text-muted-foreground">
                    {formatDateTime(step.when as string)}
                    {step.who ? ` · ${step.who}` : ''}
                    {step.note ? ` · ${step.note}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {payroll.financial_transaction_number && (
        <Card>
          <CardBody>
            <Link href="/transactions" className="text-primary text-sm hover:underline">
              Ledger entry {payroll.financial_transaction_number}
            </Link>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span
        className={`tabular text-sm ${strong ? 'text-foreground font-semibold' : 'text-foreground'}`}
      >
        {value}
      </span>
    </div>
  );
}
