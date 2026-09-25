'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import type { ExpenseRow } from '@/lib/server/finance';

const columns: DataColumn<ExpenseRow>[] = [
  { id: 'description', header: 'Description', role: 'primary', cell: (e) => e.description },
  { id: 'number', header: 'Number', role: 'secondary', cell: (e) => e.expense_number },
  {
    id: 'amount',
    header: 'Amount',
    role: 'trailing',
    numeric: true,
    cell: (e) => formatUgx(e.amount_ugx),
  },
  { id: 'category', header: 'Category', cell: (e) => e.category_name },
  { id: 'payee', header: 'Payee', cell: (e) => e.payee ?? '—' },
  { id: 'date', header: 'Dated', cell: (e) => formatDate(e.expense_date) },
  { id: 'status', header: 'Status', role: 'status', cell: (e) => <StatusBadge status={e.status} /> },
];

export function ExpensesTable({ expenses }: { expenses: ExpenseRow[] }) {
  return (
    <DataView
      rows={expenses}
      columns={columns}
      rowKey={(e) => e.id}
      href={(e) => `/expenses/${e.id}`}
      caption="Expenses"
      empty="No expenses match this filter."
    />
  );
}
