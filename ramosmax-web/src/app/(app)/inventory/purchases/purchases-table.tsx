'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import type { PurchaseRow } from '@/lib/server/finance';

const columns: DataColumn<PurchaseRow>[] = [
  { id: 'supplier', header: 'Supplier', role: 'primary', cell: (p) => p.supplier_name },
  { id: 'number', header: 'Number', role: 'secondary', cell: (p) => p.purchase_number },
  {
    id: 'total',
    header: 'Total',
    role: 'trailing',
    numeric: true,
    cell: (p) => formatUgx(p.total_ugx),
  },
  { id: 'lines', header: 'Lines', numeric: true, cell: (p) => String(p.line_count) },
  { id: 'date', header: 'Dated', cell: (p) => formatDate(p.purchase_date) },
  {
    id: 'payment',
    header: 'Payment',
    cell: (p) =>
      p.payment_status === 'paid' ? <Badge tone="success">Paid</Badge> : <Badge tone="warning">Unpaid</Badge>,
  },
  { id: 'status', header: 'Status', role: 'status', cell: (p) => <StatusBadge status={p.status} /> },
];

export function PurchasesTable({ purchases }: { purchases: PurchaseRow[] }) {
  return (
    <DataView
      rows={purchases}
      columns={columns}
      rowKey={(p) => p.id}
      href={(p) => `/inventory/purchases/${p.id}`}
      caption="Purchases"
      empty="No purchases match this filter."
    />
  );
}
