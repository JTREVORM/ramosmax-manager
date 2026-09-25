'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import { payable } from '@/lib/format/workforce';
import type { AllowanceRow } from '@/lib/server/workforce';

const columns: DataColumn<AllowanceRow>[] = [
  { id: 'staff', header: 'Staff', role: 'primary', cell: (a) => a.staff_name ?? '—' },
  { id: 'number', header: 'Number', role: 'secondary', cell: (a) => a.allowance_number },
  {
    id: 'amount',
    header: 'Payable',
    role: 'trailing',
    numeric: true,
    cell: (a) => formatUgx(payable(a)),
  },
  {
    id: 'calculated',
    header: 'Calculated',
    numeric: true,
    cell: (a) => formatUgx(a.calculated_amount_ugx),
  },
  { id: 'deduction', header: 'Deduction', numeric: true, cell: (a) => formatUgx(a.deduction_ugx) },
  { id: 'day', header: 'Day', cell: (a) => formatDate(a.business_day) },
  {
    id: 'arrival',
    header: 'Arrival',
    cell: (a) =>
      a.severely_late ? 'Severely late' : a.late ? `${a.minutes_late} min late` : 'On time',
  },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (a) => <StatusBadge status={a.status} />,
  },
];

export function AllowancesTable({ rows, caption }: { rows: AllowanceRow[]; caption: string }) {
  return (
    <DataView
      rows={rows}
      columns={columns}
      rowKey={(a) => a.id}
      caption={caption}
      empty="No allowances match this filter."
    />
  );
}
