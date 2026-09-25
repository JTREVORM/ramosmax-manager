'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { Badge } from '@/components/ui/badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import type { LedgerRow } from '@/lib/server/finance';

export const TYPE_LABELS: Record<string, string> = {
  customer_payment: 'Customer payment',
  expense_payment: 'Expense payment',
  inventory_purchase_payment: 'Stock purchase',
  account_transfer: 'Transfer',
  bank_deposit: 'Bank deposit',
  adjustment: 'Adjustment',
  opening_balance: 'Opening balance',
  reversal: 'Reversal',
};

const columns: DataColumn<LedgerRow>[] = [
  {
    id: 'type',
    header: 'Type',
    role: 'primary',
    cell: (t) =>
      t.entry_type === 'reversal' && t.reversal_of_type
        ? `Reversal · ${TYPE_LABELS[t.reversal_of_type] ?? t.reversal_of_type}`
        : (TYPE_LABELS[t.entry_type] ?? t.entry_type),
  },
  { id: 'number', header: 'Reference', role: 'secondary', cell: (t) => t.transaction_number },
  {
    id: 'amount',
    header: 'Amount',
    role: 'trailing',
    numeric: true,
    cell: (t) => formatUgx(t.amount_ugx),
  },
  {
    id: 'accounts',
    header: 'Accounts',
    cell: (t) =>
      [t.source_account_name, t.destination_account_name].filter(Boolean).join(' → ') || '—',
  },
  { id: 'when', header: 'Posted', cell: (t) => formatDateTime(t.created_at) },
  { id: 'by', header: 'By', cell: (t) => t.created_by_name ?? '—' },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (t) =>
      t.status === 'reversed' ? <Badge tone="danger">Reversed</Badge> : <Badge tone="success">Posted</Badge>,
  },
];

export function LedgerTable({ entries }: { entries: LedgerRow[] }) {
  return (
    <DataView
      rows={entries}
      columns={columns}
      rowKey={(t) => t.id}
      href={(t) => `/transactions/${t.id}`}
      caption="Transactions"
      empty="No transactions of this kind."
    />
  );
}
