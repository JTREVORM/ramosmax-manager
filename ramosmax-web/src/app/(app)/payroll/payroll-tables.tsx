'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import type {
  DeductionRow,
  PayrollRow,
  PayrollTotalsRow,
  PayslipRow,
  SalaryProfileRow,
} from '@/lib/server/workforce';

const payrollColumns: DataColumn<PayrollRow>[] = [
  { id: 'period', header: 'Period', role: 'primary', cell: (p) => p.period_label },
  { id: 'number', header: 'Number', role: 'secondary', cell: (p) => p.payroll_number },
  {
    id: 'net',
    header: 'Net pay',
    role: 'trailing',
    numeric: true,
    cell: (p) => formatUgx(p.total_net_ugx),
  },
  { id: 'staff', header: 'Staff', numeric: true, cell: (p) => String(p.employee_count) },
  { id: 'gross', header: 'Gross', numeric: true, cell: (p) => formatUgx(p.total_gross_ugx) },
  {
    id: 'deductions',
    header: 'Deductions',
    numeric: true,
    cell: (p) => formatUgx(p.total_deductions_ugx),
  },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (p) => <StatusBadge status={p.status} />,
  },
];

export function PayrollTable({ rows }: { rows: PayrollRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={payrollColumns}
      rowKey={(p) => p.id}
      href={(p) => `/payroll/run/${p.id}`}
      caption="Payroll runs"
      empty="No payroll runs yet."
    />
  );
}

/** Reporting: totals only, and no way through to an individual's pay. */
const totalsColumns: DataColumn<PayrollTotalsRow>[] = [
  { id: 'period', header: 'Period', role: 'primary', cell: (p) => p.period_label },
  { id: 'number', header: 'Number', role: 'secondary', cell: (p) => p.payroll_number },
  {
    id: 'net',
    header: 'Net pay',
    role: 'trailing',
    numeric: true,
    cell: (p) => formatUgx(p.total_net_ugx),
  },
  { id: 'staff', header: 'Staff', numeric: true, cell: (p) => String(p.employee_count) },
  { id: 'gross', header: 'Gross', numeric: true, cell: (p) => formatUgx(p.total_gross_ugx) },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (p) => <StatusBadge status={p.status} />,
  },
];

export function PayrollTotalsTable({ rows }: { rows: PayrollTotalsRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={totalsColumns}
      rowKey={(p) => p.id}
      caption="Payroll totals"
      empty="No payroll runs yet."
    />
  );
}

const salaryColumns: DataColumn<SalaryProfileRow>[] = [
  { id: 'staff', header: 'Staff', role: 'primary', cell: (s) => s.staff_name ?? '—' },
  { id: 'role', header: 'Role', role: 'secondary', cell: (s) => s.staff_role ?? '—' },
  {
    id: 'basic',
    header: 'Basic salary',
    role: 'trailing',
    numeric: true,
    cell: (s) => formatUgx(s.basic_salary_ugx),
  },
  { id: 'frequency', header: 'Paid', cell: (s) => s.payment_frequency },
  {
    id: 'allowance',
    header: 'Daily allowance',
    numeric: true,
    cell: (s) =>
      s.allowance_eligible
        ? s.allowance_amount_ugx === null
          ? 'Policy'
          : formatUgx(s.allowance_amount_ugx)
        : '—',
  },
  { id: 'from', header: 'Effective', cell: (s) => formatDate(s.effective_from) },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (s) => <StatusBadge status={s.active ? 'active' : 'inactive'} />,
  },
];

export function SalaryTable({ rows }: { rows: SalaryProfileRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={salaryColumns}
      rowKey={(s) => s.staff_uid}
      href={(s) => `/payroll/salary/${s.staff_uid}`}
      caption="Salaries"
      empty="No salaries have been set."
    />
  );
}

const deductionColumns: DataColumn<DeductionRow>[] = [
  { id: 'staff', header: 'Staff', role: 'primary', cell: (d) => d.staff_name ?? '—' },
  { id: 'number', header: 'Number', role: 'secondary', cell: (d) => d.deduction_number },
  {
    id: 'remaining',
    header: 'Remaining',
    role: 'trailing',
    numeric: true,
    cell: (d) => formatUgx(d.remaining_ugx),
  },
  {
    id: 'type',
    header: 'Type',
    cell: (d) =>
      d.type === 'loss_recovery'
        ? 'Loss recovery'
        : d.type === 'authorized_deduction'
          ? 'Authorised'
          : 'Other',
  },
  { id: 'total', header: 'Total', numeric: true, cell: (d) => formatUgx(d.total_amount_ugx) },
  {
    id: 'instalment',
    header: 'Per payroll',
    numeric: true,
    cell: (d) => formatUgx(d.instalment_ugx),
  },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (d) => <StatusBadge status={d.status} />,
  },
];

export function DeductionsTable({ rows }: { rows: DeductionRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={deductionColumns}
      rowKey={(d) => d.id}
      href={(d) => `/payroll/deduction/${d.id}`}
      caption="Deduction schedules"
      empty="No deduction schedules."
    />
  );
}

const payslipColumns: DataColumn<PayslipRow>[] = [
  { id: 'staff', header: 'Staff', role: 'primary', cell: (i) => i.staff_name ?? '—' },
  { id: 'number', header: 'Payslip', role: 'secondary', cell: (i) => i.item_number },
  {
    id: 'net',
    header: 'Net pay',
    role: 'trailing',
    numeric: true,
    cell: (i) => formatUgx(i.net_ugx),
  },
  { id: 'basic', header: 'Basic', numeric: true, cell: (i) => formatUgx(i.basic_salary_ugx) },
  {
    id: 'allowances',
    header: 'Allowances',
    numeric: true,
    cell: (i) => formatUgx(i.allowances_ugx),
  },
  {
    id: 'earnings',
    header: 'Other earnings',
    numeric: true,
    cell: (i) => formatUgx(i.other_earnings_ugx),
  },
  { id: 'gross', header: 'Gross', numeric: true, cell: (i) => formatUgx(i.gross_ugx) },
  {
    id: 'deductions',
    header: 'Deductions',
    numeric: true,
    cell: (i) =>
      i.deduction_capped
        ? `${formatUgx(i.total_deductions_ugx)} (capped)`
        : formatUgx(i.total_deductions_ugx),
  },
  {
    id: 'status',
    header: 'Payment',
    role: 'status',
    cell: (i) => <StatusBadge status={i.payment_status} />,
  },
];

export function PayslipsTable({ rows }: { rows: PayslipRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={payslipColumns}
      rowKey={(i) => i.id}
      caption="Payslips"
      empty="Nobody is in this payroll yet. Prepare it to work out the pay."
    />
  );
}
