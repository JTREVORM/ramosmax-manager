'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import { lossType } from '@/lib/format/workforce';
import type { LossRow } from '@/lib/server/workforce';

const columns: DataColumn<LossRow>[] = [
  { id: 'description', header: 'Incident', role: 'primary', cell: (l) => l.description },
  { id: 'number', header: 'Number', role: 'secondary', cell: (l) => l.loss_number },
  {
    id: 'amount',
    header: 'Loss',
    role: 'trailing',
    numeric: true,
    cell: (l) => formatUgx(l.amount_ugx),
  },
  { id: 'staff', header: 'Staff', cell: (l) => l.staff_name ?? '—' },
  { id: 'type', header: 'Type', cell: (l) => lossType(l) },
  { id: 'date', header: 'Dated', cell: (l) => formatDate(l.incident_date) },
  {
    id: 'outstanding',
    header: 'Outstanding',
    numeric: true,
    cell: (l) => (l.outstanding_ugx > 0 ? formatUgx(l.outstanding_ugx) : '—'),
  },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (l) => <StatusBadge status={l.status} />,
  },
];

export function LossesTable({ rows }: { rows: LossRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={columns}
      rowKey={(l) => l.id}
      href={(l) => `/losses/${l.id}`}
      caption="Loss incidents"
      empty="No loss incidents match this filter."
    />
  );
}
