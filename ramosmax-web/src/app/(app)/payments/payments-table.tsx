'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { Badge } from '@/components/ui/badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import type { PaymentRow } from '@/lib/server/operations';

const columns: DataColumn<PaymentRow>[] = [
  { id: 'plate', header: 'Plate', role: 'primary', cell: (p) => p.number_plate ?? '—' },
  { id: 'invoice', header: 'Invoice', role: 'secondary', cell: (p) => p.invoice_number ?? '—' },
  {
    id: 'amount',
    header: 'Amount',
    role: 'trailing',
    numeric: true,
    cell: (p) => formatUgx(p.amount_ugx),
  },
  { id: 'method', header: 'Method', cell: (p) => p.method.replace(/_/g, ' ') },
  { id: 'when', header: 'Received', cell: (p) => formatDateTime(p.created_at) },
  { id: 'by', header: 'Cashier', cell: (p) => p.created_by_name ?? '—' },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (p) =>
      p.status === 'reversed' ? <Badge tone="danger">Reversed</Badge> : <Badge tone="success">Received</Badge>,
  },
];

export function PaymentsTable({ payments }: { payments: PaymentRow[] }) {
  return (
    <DataView
      rows={payments}
      columns={columns}
      rowKey={(p) => p.id}
      href={(p) => `/invoices/${p.invoice_id}`}
      caption="Payments"
      empty="No payments in this period."
    />
  );
}
