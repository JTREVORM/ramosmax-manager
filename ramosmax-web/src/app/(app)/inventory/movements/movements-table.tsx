'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/format/date';
import type { MovementRow } from '@/lib/server/finance';

const TYPE_LABELS: Record<string, string> = {
  stock_in: 'Stock in',
  usage: 'Used',
  stock_out: 'Stock out',
  return: 'Returned',
  adjustment_in: 'Count up',
  adjustment_out: 'Count down',
  reversal: 'Reversal',
};

const columns: DataColumn<MovementRow>[] = [
  { id: 'item', header: 'Item', role: 'primary', cell: (m) => m.item_name },
  { id: 'number', header: 'Movement', role: 'secondary', cell: (m) => m.movement_number },
  {
    id: 'change',
    header: 'Change',
    role: 'trailing',
    numeric: true,
    cell: (m) => `${m.quantity_change > 0 ? '+' : '−'}${Math.abs(m.quantity_change)} ${m.unit}`,
  },
  { id: 'type', header: 'Type', cell: (m) => TYPE_LABELS[m.type] ?? m.type },
  { id: 'after', header: 'After', numeric: true, cell: (m) => String(m.quantity_after) },
  { id: 'reason', header: 'Reason', cell: (m) => m.reason ?? '—' },
  { id: 'when', header: 'Recorded', cell: (m) => formatDateTime(m.created_at) },
  { id: 'by', header: 'By', cell: (m) => m.created_by_name ?? '—' },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (m) =>
      m.status === 'reversed' ? <Badge tone="danger">Reversed</Badge> : <Badge tone="success">Posted</Badge>,
  },
];

export function MovementsTable({ movements }: { movements: MovementRow[] }) {
  return (
    <DataView
      rows={movements}
      columns={columns}
      rowKey={(m) => m.id}
      href={(m) => `/inventory/items/${m.item_id}`}
      caption="Stock movements"
      empty="No movements of this kind."
    />
  );
}
