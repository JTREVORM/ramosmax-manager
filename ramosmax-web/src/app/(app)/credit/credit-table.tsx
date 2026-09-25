'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import type { InvoiceRow } from '@/lib/server/operations';

type CreditRow = InvoiceRow & { days_owed: number };

const columns: DataColumn<CreditRow>[] = [
  { id: 'customer', header: 'Customer', role: 'primary', cell: (i) => i.customer_name ?? 'Walk-in' },
  { id: 'plate', header: 'Plate', role: 'secondary', cell: (i) => i.number_plate },
  {
    id: 'owing',
    header: 'Owing',
    role: 'trailing',
    numeric: true,
    cell: (i) => formatUgx(i.outstanding_ugx),
  },
  { id: 'invoice', header: 'Invoice', cell: (i) => i.invoice_number },
  {
    id: 'age',
    header: 'Owed for',
    cell: (i) => (Number(i.days_owed) === 0 ? 'Today' : `${i.days_owed} day${Number(i.days_owed) === 1 ? '' : 's'}`),
  },
  { id: 'status', header: 'Status', role: 'status', cell: (i) => <StatusBadge status={i.payment_status} /> },
];

export function CreditTable({ invoices }: { invoices: CreditRow[] }) {
  return (
    <DataView
      rows={invoices}
      columns={columns}
      rowKey={(i) => i.id}
      href={(i) => `/invoices/${i.id}`}
      caption="Outstanding invoices"
      empty="Nothing is owed."
    />
  );
}
