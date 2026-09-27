import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { Card, CardBody } from '@/components/ui/card';
import { requireAnyPermission } from '@/lib/server/guard';
import {
  businessToday,
  getPayrollPolicy,
  listDeductions,
  listPayrolls,
  listPayrollTotals,
  listSalaryProfiles,
  listStaff,
} from '@/lib/server/workforce';
import { DeductionsTable, PayrollTable, PayrollTotalsTable, SalaryTable } from './payroll-tables';
import { CreateDeductionCard, CreatePayrollCard, PolicyCard, SetSalaryCard } from './payroll-forms';

export const metadata: Metadata = { title: 'Payroll' };

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const granted = await requireAnyPermission('payroll.view', 'reports.payroll.view');
  const can = (p: string) => granted.has(p);
  const params = await searchParams;

  // Someone with workforce reports and nothing more sees totals, and no
  // individual's pay. The tabs follow the same rule the database does.
  const seesPay = can('payroll.view');
  const tab = params.tab ?? (seesPay ? 'runs' : 'reports');

  const today = await businessToday();
  const [year, month] = today.split('-').map(Number);

  const [runs, totals, salaries, deductions, staff, policy] = await Promise.all([
    seesPay ? listPayrolls() : Promise.resolve([]),
    can('reports.payroll.view') ? listPayrollTotals() : Promise.resolve([]),
    can('salary.view') || can('staff.salary.view') ? listSalaryProfiles() : Promise.resolve([]),
    can('payroll.view') || can('deductions.manage') ? listDeductions() : Promise.resolve([]),
    can('salary.manage') || can('deductions.manage') ? listStaff() : Promise.resolve([]),
    getPayrollPolicy(),
  ]);

  const tabs = [
    ...(seesPay ? [{ value: 'runs', label: 'Runs' }] : []),
    ...(can('reports.payroll.view') ? [{ value: 'reports', label: 'Reports' }] : []),
    ...(salaries.length > 0 || can('salary.manage')
      ? [{ value: 'salaries', label: 'Salaries' }]
      : []),
    ...(seesPay || can('deductions.manage') ? [{ value: 'deductions', label: 'Deductions' }] : []),
    ...(can('settings.manage') || can('settings.view')
      ? [{ value: 'policy', label: 'Policy' }]
      : []),
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Payroll"
        subtitle={
          seesPay
            ? `${runs.length} run${runs.length === 1 ? '' : 's'}`
            : 'Totals only. Individual pay is not shown.'
        }
      />

      <FilterTabs param="tab" defaultValue={tabs[0]?.value ?? 'runs'} options={tabs} />

      {tab === 'runs' && seesPay && (
        <>
          {(can('payroll.prepare') || can('payroll.process')) && (
            <CreatePayrollCard year={year} month={month} />
          )}
          <PayrollTable rows={runs} />
        </>
      )}

      {tab === 'reports' && (
        <>
          <Card className="bg-surface-muted">
            <CardBody>
              <p className="text-muted-foreground text-sm">
                Period totals for workforce reporting. No individual salary, deduction or payslip
                appears here, whatever else you may see elsewhere.
              </p>
            </CardBody>
          </Card>
          <PayrollTotalsTable rows={totals} />
        </>
      )}

      {tab === 'salaries' && (
        <>
          {can('salary.manage') && <SetSalaryCard staff={staff} today={today} />}
          <SalaryTable rows={salaries} />
        </>
      )}

      {tab === 'deductions' && (
        <>
          {can('deductions.manage') && <CreateDeductionCard staff={staff} today={today} />}
          <DeductionsTable rows={deductions} />
        </>
      )}

      {tab === 'policy' && <PolicyCard policy={policy} />}
    </div>
  );
}
