import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import { listPickableAccounts } from '@/lib/server/finance';
import {
  businessToday,
  getPayrollPolicy,
  listAllowances,
  listAllowancesFor,
  listMyPayslips,
  currentUserId,
} from '@/lib/server/workforce';
import { payable } from '@/lib/format/workforce';
import { AllowancesTable } from './allowances-table';
import { CalculateCard, CancelAllowanceCard, PayCard, ReviewCard } from './allowance-actions';

export const metadata: Metadata = { title: 'Allowances & pay' };

export default async function AllowancesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const granted = await requireAnyPermission(
    'allowances.view',
    'allowances.view.own',
    'payroll.view.own',
  );
  const can = (p: string) => granted.has(p);
  const seesEveryone = can('allowances.view');
  const params = await searchParams;
  const view = params.view ?? (seesEveryone ? 'decide' : 'mine');

  const [today, uid, policy] = await Promise.all([
    businessToday(),
    currentUserId(),
    getPayrollPolicy(),
  ]);

  const [all, mine, myPayslips, accounts] = await Promise.all([
    seesEveryone ? listAllowances(null) : Promise.resolve([]),
    listAllowancesFor(uid, 60),
    can('payroll.view.own') ? listMyPayslips() : Promise.resolve([]),
    can('allowances.pay') ? listPickableAccounts() : Promise.resolve([]),
  ]);

  const toDecide = all.filter((a) => a.status === 'calculated' || a.status === 'pending_approval');
  const unpaid = all.filter((a) => a.status === 'approved' && payable(a) > 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Allowances & pay"
        subtitle={`Daily allowance ${formatUgx(policy.defaultDailyAllowanceUgx)} · late policy: ${policy.lateAllowancePolicy}`}
      />

      {seesEveryone && (
        <FilterTabs
          param="view"
          defaultValue="decide"
          options={[
            { value: 'decide', label: `To decide (${toDecide.length})` },
            { value: 'unpaid', label: `Approved, unpaid (${unpaid.length})` },
            { value: 'history', label: 'History' },
            { value: 'mine', label: 'My pay' },
          ]}
        />
      )}

      {seesEveryone && view === 'decide' && (
        <>
          {can('allowances.calculate') && <CalculateCard today={today} />}
          {(can('allowances.approve') || can('allowances.adjust')) && (
            <ReviewCard
              allowances={toDecide}
              policy={policy}
              canApprove={can('allowances.approve')}
            />
          )}
          <AllowancesTable rows={toDecide} caption="Allowances awaiting a decision" />
        </>
      )}

      {seesEveryone && view === 'unpaid' && (
        <>
          {can('allowances.pay') && (
            <PayCard allowances={unpaid} accounts={accounts} today={today} />
          )}
          {can('allowances.adjust') && <CancelAllowanceCard allowances={unpaid} />}
          <AllowancesTable rows={unpaid} caption="Approved and unpaid allowances" />
        </>
      )}

      {seesEveryone && view === 'history' && (
        <AllowancesTable rows={all} caption="All allowances" />
      )}

      {(!seesEveryone || view === 'mine') && (
        <>
          <Card className="bg-surface-muted">
            <CardBody>
              <p className="text-muted-foreground text-sm">
                Your own allowances and payslips. A payslip appears once its payroll has been paid.
              </p>
            </CardBody>
          </Card>
          <AllowancesTable rows={mine} caption="My allowances" />

          {can('payroll.view.own') && (
            <Card>
              <CardHeader>
                <CardTitle>My payslips</CardTitle>
              </CardHeader>
              <CardBody>
                {myPayslips.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No payslip yet. One appears here when a payroll that includes you has been paid.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {myPayslips.map((slip) => (
                      <li
                        key={slip.id}
                        className="border-border border-b pb-3 last:border-0 last:pb-0"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-foreground text-sm font-medium">
                            {slip.period_label}
                          </span>
                          <StatusBadge status={slip.payment_status} />
                        </div>
                        <dl className="mt-2 space-y-1">
                          <Row label="Basic salary" value={formatUgx(slip.basic_salary_ugx)} />
                          <Row
                            label={`Allowances (${slip.allowance_days} day${slip.allowance_days === 1 ? '' : 's'})`}
                            value={formatUgx(slip.allowances_ugx)}
                          />
                          {slip.other_earnings_ugx > 0 && (
                            <Row
                              label="Other earnings"
                              value={formatUgx(slip.other_earnings_ugx)}
                            />
                          )}
                          <Row label="Gross" value={formatUgx(slip.gross_ugx)} />
                          {slip.total_deductions_ugx > 0 && (
                            <Row
                              label="Deductions"
                              value={`− ${formatUgx(slip.total_deductions_ugx)}`}
                            />
                          )}
                          <Row label="Net pay" value={formatUgx(slip.net_ugx)} strong />
                        </dl>
                        {slip.paid_at && (
                          <p className="text-muted-foreground mt-1 text-xs">
                            Paid {formatDate(slip.paid_at)} · {slip.payroll_number}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          )}

          <p className="text-muted-foreground text-sm">
            <Link href="/attendance" className="text-primary hover:underline">
              My attendance
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd
        className={`tabular text-sm ${strong ? 'text-foreground font-semibold' : 'text-foreground'}`}
      >
        {value}
      </dd>
    </div>
  );
}
