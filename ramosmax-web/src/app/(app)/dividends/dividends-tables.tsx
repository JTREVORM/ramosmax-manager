'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import type { AllocationRow, DividendRow } from '@/lib/server/ownership';

const columns: DataColumn<DividendRow>[] = [
  { id: 'number', header: 'Dividend', role: 'primary', cell: (d) => d.dividend_number },
  { id: 'period', header: 'Period', role: 'secondary', cell: (d) => d.financial_period },
  {
    id: 'total',
    header: 'Distributable',
    role: 'trailing',
    numeric: true,
    cell: (d) => (d.total_distributable_ugx === null ? '—' : formatUgx(d.total_distributable_ugx)),
  },
  { id: 'record', header: 'Record date', cell: (d) => formatDate(d.record_date) },
  { id: 'class', header: 'Class', cell: (d) => d.class_code ?? 'All classes' },
  {
    id: 'allocated',
    header: 'Allocated',
    numeric: true,
    cell: (d) => `${formatUgx(d.allocated_ugx)} · ${d.allocation_count}`,
  },
  { id: 'paid', header: 'Paid', numeric: true, cell: (d) => formatUgx(d.paid_ugx) },
  { id: 'status', header: 'Status', role: 'status', cell: (d) => <StatusBadge status={d.status} /> },
];

export function DividendsTable({ rows }: { rows: DividendRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={columns}
      rowKey={(d) => d.id}
      href={(d) => `/dividends/${d.id}`}
      caption="Dividends"
      empty="No dividend matches this filter."
    />
  );
}

/**
 * The allocation review.
 *
 * Every figure here was worked out by the server at the record date and then
 * frozen. Nothing on this screen recalculates anything.
 */
const allocationColumns: DataColumn<AllocationRow>[] = [
  {
    id: 'shareholder',
    header: 'Shareholder',
    role: 'primary',
    cell: (a) => a.shareholder_name ?? a.shareholder_number ?? '—',
  },
  { id: 'number', header: 'Allocation', role: 'secondary', cell: (a) => a.allocation_number },
  { id: 'net', header: 'Net', role: 'trailing', numeric: true, cell: (a) => formatUgx(a.net_ugx) },
  {
    id: 'shares',
    header: 'Shares at record date',
    numeric: true,
    cell: (a) => Number(a.shares_at_record_date).toLocaleString('en-US'),
  },
  {
    id: 'percent',
    header: 'Ownership',
    numeric: true,
    cell: (a) => `${Number(a.ownership_percent_at_record_date).toFixed(2)}%`,
  },
  { id: 'gross', header: 'Gross', numeric: true, cell: (a) => formatUgx(a.gross_ugx) },
  {
    id: 'status',
    header: 'Payment',
    role: 'status',
    cell: (a) => <StatusBadge status={a.payment_status} />,
  },
];

export function AllocationsTable({ rows }: { rows: AllocationRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={allocationColumns}
      rowKey={(a) => a.id}
      caption="Dividend allocations"
      empty="Nothing has been calculated yet."
    />
  );
}
