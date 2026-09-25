'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { Badge } from '@/components/ui/badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import type { ReceiptRow } from '@/lib/server/operations';

const field = (r: ReceiptRow, key: string) => (r.snapshot as Record<string, unknown>)[key];

const columns: DataColumn<ReceiptRow>[] = [
  { id: 'receipt', header: 'Receipt', role: 'primary', cell: (r) => r.receipt_number },
  { id: 'plate', header: 'Plate', role: 'secondary', cell: (r) => String(field(r, 'numberPlate') ?? '—') },
  {
    id: 'amount',
    header: 'Amount',
    role: 'trailing',
    numeric: true,
    cell: (r) => formatUgx(Number(field(r, 'paymentUgx') ?? 0)),
  },
  { id: 'when', header: 'Issued', cell: (r) => formatDateTime(r.created_at) },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (r) =>
      r.status === 'reversed' ? <Badge tone="danger">Reversed</Badge> : <Badge tone="success">Issued</Badge>,
  },
];

export function ReceiptsTable({ receipts }: { receipts: ReceiptRow[] }) {
  return (
    <DataView
      rows={receipts}
      columns={columns}
      rowKey={(r) => r.id}
      href={(r) => `/receipts/${encodeURIComponent(r.receipt_number)}`}
      caption="Receipts"
      empty="No receipts yet."
    />
  );
}
