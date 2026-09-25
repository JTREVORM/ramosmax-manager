'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import { TXN_LABELS } from '@/lib/format/ownership';
import type { ContributionRow, ShareClassRow, ShareTransactionRow } from '@/lib/server/ownership';

const columns: DataColumn<ShareTransactionRow>[] = [
  {
    id: 'type',
    header: 'Entry',
    role: 'primary',
    cell: (t) => `${TXN_LABELS[t.type] ?? t.type}${t.reversal_of_number ? ` of ${t.reversal_of_number}` : ''}`,
  },
  { id: 'number', header: 'Number', role: 'secondary', cell: (t) => t.transaction_number },
  {
    id: 'shares',
    header: 'Shares',
    role: 'trailing',
    numeric: true,
    cell: (t) => (t.adjustment_shares !== null
      ? `${t.adjustment_shares > 0 ? '+' : ''}${Number(t.adjustment_shares).toLocaleString('en-US')}`
      : Number(t.shares).toLocaleString('en-US')),
  },
  { id: 'class', header: 'Class', cell: (t) => t.class_code },
  {
    id: 'committed',
    header: 'Commitment',
    numeric: true,
    cell: (t) => (t.committed_ugx === null ? '—' : formatUgx(t.committed_ugx)),
  },
  { id: 'effective', header: 'Effective', cell: (t) => formatDate(t.effective_date) },
  { id: 'status', header: 'Status', role: 'status', cell: (t) => <StatusBadge status={t.status} /> },
];

export function ShareTransactionsTable({ rows }: { rows: ShareTransactionRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={columns}
      rowKey={(t) => t.id}
      href={(t) => `/shares/txn/${t.id}`}
      caption="Share transactions"
      empty="No share transactions match this filter."
    />
  );
}

const classColumns: DataColumn<ShareClassRow>[] = [
  { id: 'code', header: 'Class', role: 'primary', cell: (c) => c.code },
  { id: 'name', header: 'Name', role: 'secondary', cell: (c) => c.name },
  {
    id: 'value',
    header: 'Value per share',
    role: 'trailing',
    numeric: true,
    cell: (c) => formatUgx(c.value_per_share_ugx),
  },
  {
    id: 'issued',
    header: 'Issued',
    numeric: true,
    cell: (c) => Number(c.issued_shares).toLocaleString('en-US'),
  },
  { id: 'paid', header: 'Received', numeric: true, cell: (c) => formatUgx(c.paid_ugx) },
  { id: 'outstanding', header: 'Outstanding', numeric: true, cell: (c) => formatUgx(c.outstanding_ugx) },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (c) => <StatusBadge status={c.active ? 'active' : 'inactive'} />,
  },
];

export function ShareClassesTable({ rows }: { rows: ShareClassRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={classColumns}
      rowKey={(c) => c.id}
      caption="Share classes"
      empty="No share class has been created yet."
    />
  );
}

const contributionColumns: DataColumn<ContributionRow>[] = [
  { id: 'shareholder', header: 'Shareholder', role: 'primary', cell: (c) => c.shareholder_name ?? '—' },
  { id: 'number', header: 'Number', role: 'secondary', cell: (c) => c.contribution_number },
  { id: 'amount', header: 'Amount', role: 'trailing', numeric: true, cell: (c) => formatUgx(c.amount_ugx) },
  {
    id: 'source',
    header: 'Source',
    cell: (c) => (c.source === 'prior_record' ? 'Paid before RamosMAX' : (c.account_name ?? 'Account')),
  },
  { id: 'entry', header: 'For', cell: (c) => c.share_transaction_number ?? '—' },
  { id: 'date', header: 'Received', cell: (c) => formatDate(c.payment_date) },
  { id: 'status', header: 'Status', role: 'status', cell: (c) => <StatusBadge status={c.status} /> },
];

export function ContributionsTable({ rows }: { rows: ContributionRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={contributionColumns}
      rowKey={(c) => c.id}
      caption="Contributions"
      empty="No contributions recorded."
    />
  );
}
