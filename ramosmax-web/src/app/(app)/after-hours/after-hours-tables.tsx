'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { difference, DISCREPANCY_KIND_LABELS } from '@/lib/format/after-hours';
import type {
  AuthorizationRow, DiscrepancyRow, HandoverRow, HandoverTotals, SessionRow,
} from '@/lib/server/after-hours';

const authorizationColumns: DataColumn<AuthorizationRow>[] = [
  { id: 'staff', header: 'On duty', role: 'primary', cell: (a) => a.staff_name },
  { id: 'number', header: 'Reference', role: 'secondary', cell: (a) => a.authorization_number },
  {
    id: 'until',
    header: 'Until',
    role: 'trailing',
    cell: (a) => formatDateTime(a.expires_at),
  },
  { id: 'from', header: 'From', cell: (a) => formatDateTime(a.starts_at) },
  {
    id: 'float',
    header: 'Float',
    numeric: true,
    cell: (a) => (a.opening_float_ugx > 0 ? formatUgx(a.opening_float_ugx) : '—'),
  },
  { id: 'by', header: 'Authorised by', cell: (a) => a.granted_by_name ?? '—' },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (a) => <StatusBadge status={a.live ? 'in_force' : a.status} />,
  },
];

export function AuthorizationsTable({ rows }: { rows: AuthorizationRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={authorizationColumns}
      rowKey={(a) => a.id}
      caption="After-hours authorisations"
      empty="Nobody has been authorised for after-hours work."
    />
  );
}

const sessionColumns: DataColumn<SessionRow>[] = [
  { id: 'staff', header: 'Worker', role: 'primary', cell: (s) => s.staff_name },
  { id: 'number', header: 'Session', role: 'secondary', cell: (s) => s.session_number },
  {
    id: 'expected',
    header: 'Cash held',
    role: 'trailing',
    numeric: true,
    cell: (s) => formatUgx(s.expected_cash_ugx),
  },
  { id: 'opened', header: 'Opened', cell: (s) => formatDateTime(s.opened_at) },
  {
    id: 'work',
    header: 'Work',
    numeric: true,
    cell: (s) => `${s.invoices_created} inv · ${s.payment_count} pay`,
  },
  {
    id: 'handover',
    header: 'Handover',
    cell: (s) => s.handover_number ?? '—',
  },
  { id: 'status', header: 'Status', role: 'status', cell: (s) => <StatusBadge status={s.status} /> },
];

export function SessionsTable({ rows }: { rows: SessionRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={sessionColumns}
      rowKey={(s) => s.id}
      href={(s) => `/after-hours/session/${s.id}`}
      caption="After-hours sessions"
      empty="No session matches this filter."
    />
  );
}

const handoverColumns: DataColumn<HandoverRow>[] = [
  { id: 'staff', header: 'From', role: 'primary', cell: (h) => h.staff_name },
  { id: 'number', header: 'Handover', role: 'secondary', cell: (h) => h.handover_number },
  {
    id: 'expected',
    header: 'Expected',
    role: 'trailing',
    numeric: true,
    cell: (h) => formatUgx(h.expected_cash_ugx),
  },
  {
    id: 'declared',
    header: 'Declared',
    numeric: true,
    cell: (h) => (h.declared_amount_ugx === null ? '—' : formatUgx(h.declared_amount_ugx)),
  },
  {
    id: 'counted',
    header: 'Counted',
    numeric: true,
    cell: (h) => (h.actual_amount_ugx === null ? '—' : formatUgx(h.actual_amount_ugx)),
  },
  { id: 'difference', header: 'Difference', cell: (h) => difference(h.difference_ugx) },
  { id: 'status', header: 'Status', role: 'status', cell: (h) => <StatusBadge status={h.status} /> },
];

export function HandoversTable({ rows }: { rows: HandoverRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={handoverColumns}
      rowKey={(h) => h.id}
      href={(h) => `/after-hours/handover/${h.id}`}
      caption="Cash handovers"
      empty="No handover matches this filter."
    />
  );
}

const discrepancyColumns: DataColumn<DiscrepancyRow>[] = [
  { id: 'staff', header: 'Worker', role: 'primary', cell: (d) => d.staff_name },
  { id: 'number', header: 'Reference', role: 'secondary', cell: (d) => d.discrepancy_number },
  {
    id: 'difference',
    header: 'Difference',
    role: 'trailing',
    cell: (d) => difference(d.difference_ugx),
  },
  { id: 'kind', header: 'Kind', cell: (d) => DISCREPANCY_KIND_LABELS[d.kind] ?? d.kind },
  {
    id: 'expected',
    header: 'Expected',
    numeric: true,
    cell: (d) => formatUgx(d.expected_cash_ugx),
  },
  { id: 'reported', header: 'Reported', cell: (d) => formatDateTime(d.reported_at) },
  { id: 'status', header: 'Status', role: 'status', cell: (d) => <StatusBadge status={d.status} /> },
];

export function DiscrepanciesTable({ rows }: { rows: DiscrepancyRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={discrepancyColumns}
      rowKey={(d) => d.id}
      href={(d) => `/after-hours/discrepancy/${d.id}`}
      caption="Cash discrepancies"
      empty="No discrepancy matches this filter."
    />
  );
}

const totalsColumns: DataColumn<HandoverTotals>[] = [
  { id: 'staff', header: 'Worker', role: 'primary', cell: (t) => t.staff_name },
  {
    id: 'handovers',
    header: 'Handovers',
    role: 'secondary',
    cell: (t) => `${t.handovers} counted`,
  },
  {
    id: 'shortage',
    header: 'Short',
    role: 'trailing',
    numeric: true,
    cell: (t) => (t.shortage_ugx > 0 ? formatUgx(t.shortage_ugx) : '—'),
  },
  { id: 'expected', header: 'Expected', numeric: true, cell: (t) => formatUgx(t.expected_ugx) },
  { id: 'received', header: 'Received', numeric: true, cell: (t) => formatUgx(t.received_ugx) },
  {
    id: 'excess',
    header: 'Over',
    numeric: true,
    cell: (t) => (t.excess_ugx > 0 ? formatUgx(t.excess_ugx) : '—'),
  },
];

export function HandoverTotalsTable({ rows }: { rows: HandoverTotals[] }) {
  return (
    <DataView
      rows={rows}
      columns={totalsColumns}
      rowKey={(t) => t.staff_uid}
      caption="Handovers by worker"
      empty="No handover has been counted in this period."
    />
  );
}

export function CustodyList({
  rows,
}: {
  rows: Array<{
    id: string;
    entry_number: string;
    kind: string;
    amount_ugx: number;
    cash_delta_ugx: number;
    receipt_number: string | null;
    number_plate: string | null;
    created_at: string;
  }>;
}) {
  return (
    <ul className="space-y-2" aria-label="Custody entries">
      {rows.map((c) => (
        <li key={c.id} className="flex justify-between gap-3 text-sm">
          <span>
            {c.kind === 'opening_float'
              ? 'Opening float'
              : c.kind === 'payment'
                ? `Payment ${c.receipt_number ?? ''}`.trim()
                : 'Payment reversed'}
            <span className="text-muted-foreground block text-xs">
              {c.entry_number}
              {c.number_plate ? ` · ${c.number_plate}` : ''} · {formatDate(c.created_at)}
            </span>
          </span>
          <span className="tabular text-right">
            {formatUgx(c.amount_ugx)}
            <span className="text-muted-foreground block text-xs">
              {c.cash_delta_ugx === 0
                ? 'not in hand'
                : `${c.cash_delta_ugx > 0 ? '+' : '−'}${formatUgx(Math.abs(c.cash_delta_ugx))} in hand`}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
