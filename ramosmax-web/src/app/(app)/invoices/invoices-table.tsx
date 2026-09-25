'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import type { InvoiceRow } from '@/lib/server/operations';

const columns: DataColumn<InvoiceRow>[] = [
  { id: 'plate', header: 'Plate', role: 'primary', cell: (i) => i.number_plate },
  { id: 'invoice', header: 'Invoice', role: 'secondary', cell: (i) => i.invoice_number },
  {
    id: 'total',
    header: 'Total',
    role: 'trailing',
    numeric: true,
    cell: (i) => formatUgx(i.total_ugx),
  },
  {
    id: 'outstanding',
    header: 'Owing',
    numeric: true,
    cell: (i) => formatUgx(i.outstanding_ugx),
  },
  { id: 'customer', header: 'Customer', cell: (i) => i.customer_name ?? 'Walk-in' },
  { id: 'date', header: 'Raised', cell: (i) => formatDate(i.created_at) },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (i) => <StatusBadge status={i.payment_status} />,
  },
];

export function InvoicesTable({ invoices }: { invoices: InvoiceRow[] }) {
  return (
    <DataView
      rows={invoices}
      columns={columns}
      rowKey={(i) => i.id}
      href={(i) => `/invoices/${i.id}`}
      caption="Invoices"
      empty="No invoices match this filter."
    />
  );
}
