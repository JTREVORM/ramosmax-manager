'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import type { ItemRow } from '@/lib/server/finance';

const columns: DataColumn<ItemRow>[] = [
  { id: 'name', header: 'Item', role: 'primary', cell: (i) => i.name },
  { id: 'sku', header: 'SKU', role: 'secondary', cell: (i) => i.sku },
  {
    id: 'quantity',
    header: 'In stock',
    role: 'trailing',
    numeric: true,
    cell: (i) => `${i.quantity} ${i.unit}`,
  },
  { id: 'category', header: 'Category', cell: (i) => i.category.replace(/_/g, ' ') },
  { id: 'levels', header: 'Reorder at', numeric: true, cell: (i) => String(i.reorder_level) },
  {
    id: 'cost',
    header: 'Last cost',
    numeric: true,
    cell: (i) => (i.last_unit_cost_ugx == null ? '—' : formatUgx(i.last_unit_cost_ugx)),
  },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (i) => <StatusBadge status={i.stock_status} />,
  },
];

export function ItemsTable({ items }: { items: ItemRow[] }) {
  return (
    <DataView
      rows={items}
      columns={columns}
      rowKey={(i) => i.id}
      href={(i) => `/inventory/items/${i.id}`}
      caption="Inventory"
      empty="No items match this search."
    />
  );
}
