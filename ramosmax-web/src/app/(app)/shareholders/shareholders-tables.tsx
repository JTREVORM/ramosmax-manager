'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import type { RegisterRow, ShareholderRow } from '@/lib/server/ownership';

const percent = (v: number) => `${Number(v).toFixed(4)}%`;

const columns: DataColumn<ShareholderRow>[] = [
  { id: 'name', header: 'Shareholder', role: 'primary', cell: (s) => s.full_name },
  { id: 'number', header: 'Number', role: 'secondary', cell: (s) => s.shareholder_number },
  {
    id: 'shares',
    header: 'Shares',
    role: 'trailing',
    numeric: true,
    cell: (s) => Number(s.total_shares).toLocaleString('en-US'),
  },
  { id: 'percent', header: 'Ownership', numeric: true, cell: (s) => percent(s.ownership_percent) },
  { id: 'paid', header: 'Paid', numeric: true, cell: (s) => formatUgx(s.paid_ugx) },
  {
    id: 'outstanding',
    header: 'Outstanding',
    numeric: true,
    cell: (s) => (s.outstanding_ugx > 0 ? formatUgx(s.outstanding_ugx) : '—'),
  },
  { id: 'joined', header: 'Joined', cell: (s) => formatDate(s.join_date) },
  { id: 'status', header: 'Status', role: 'status', cell: (s) => <StatusBadge status={s.status} /> },
];

export function ShareholdersTable({ rows }: { rows: ShareholderRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={columns}
      rowKey={(s) => s.id}
      href={(s) => `/shareholders/${s.id}`}
      caption="Shareholders"
      empty="No shareholders match this filter."
    />
  );
}

/** The register: no contact detail, which is why reporting can read it. */
const registerColumns: DataColumn<RegisterRow>[] = [
  { id: 'name', header: 'Shareholder', role: 'primary', cell: (r) => r.shareholder_name },
  { id: 'number', header: 'Number', role: 'secondary', cell: (r) => r.shareholder_number },
  {
    id: 'shares',
    header: 'Shares',
    role: 'trailing',
    numeric: true,
    cell: (r) => Number(r.total_shares).toLocaleString('en-US'),
  },
  { id: 'percent', header: 'Ownership', numeric: true, cell: (r) => percent(r.ownership_percent) },
  { id: 'committed', header: 'Committed', numeric: true, cell: (r) => formatUgx(r.committed_ugx) },
  { id: 'paid', header: 'Received', numeric: true, cell: (r) => formatUgx(r.paid_ugx) },
  { id: 'status', header: 'Status', role: 'status', cell: (r) => <StatusBadge status={r.status} /> },
];

export function RegisterTable({ rows }: { rows: RegisterRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={registerColumns}
      rowKey={(r) => r.shareholder_id}
      caption="Ownership distribution"
      empty="Nobody holds shares yet."
    />
  );
}
