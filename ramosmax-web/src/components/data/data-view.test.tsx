import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataView, type DataColumn } from './data-view';
import { formatAmount } from '@/lib/format/money';

interface Payment {
  id: string;
  reference: string;
  customer: string;
  amountUgx: number;
  method: string;
}

const rows: Payment[] = [
  {
    id: '1',
    reference: 'RMX-RCP-000001',
    customer: 'A. Mugisha',
    amountUgx: 150_000,
    method: 'Cash',
  },
  { id: '2', reference: 'RMX-RCP-000002', customer: 'B. Nakato', amountUgx: 75_000, method: 'MTN' },
];

const columns: DataColumn<Payment>[] = [
  { id: 'ref', header: 'Receipt', role: 'primary', cell: (r) => r.reference },
  { id: 'customer', header: 'Customer', role: 'secondary', cell: (r) => r.customer },
  {
    id: 'amount',
    header: 'Amount (UGX)',
    role: 'trailing',
    numeric: true,
    cell: (r) => formatAmount(r.amountUgx),
  },
  { id: 'method', header: 'Method', cell: (r) => r.method },
];

describe('DataView', () => {
  it('renders BOTH a card list and a table, so one definition serves every screen size', () => {
    render(<DataView rows={rows} columns={columns} rowKey={(r) => r.id} caption="Payments" />);
    // The card list and the table both exist in the DOM; CSS decides which is
    // shown. Each reference therefore appears twice.
    expect(screen.getAllByText('RMX-RCP-000001')).toHaveLength(2);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Payments' })).toBeInTheDocument();
  });

  it('labels the table for screen readers', () => {
    render(<DataView rows={rows} columns={columns} rowKey={(r) => r.id} caption="Payments" />);
    expect(screen.getByRole('table', { name: 'Payments' })).toBeInTheDocument();
  });

  it('renders a header for every column', () => {
    render(<DataView rows={rows} columns={columns} rowKey={(r) => r.id} caption="Payments" />);
    for (const column of columns) {
      expect(screen.getByRole('columnheader', { name: column.header })).toBeInTheDocument();
    }
  });

  it('shows an empty state rather than an empty table', () => {
    render(
      <DataView
        rows={[]}
        columns={columns}
        rowKey={(r) => r.id}
        caption="Payments"
        empty="No payments yet."
      />,
    );
    expect(screen.getByText('No payments yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('announces a truncated result so the user can shorten the period', () => {
    render(
      <DataView
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        caption="Payments"
        truncatedMessage="Showing the first 5,000 records. Choose a shorter period."
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('shorter period');
  });

  it('honours hideOnMobile and hideOnDesktop', () => {
    const scoped: DataColumn<Payment>[] = [
      { id: 'ref', header: 'Receipt', role: 'primary', cell: (r) => r.reference },
      { id: 'desktopOnly', header: 'Method', hideOnMobile: true, cell: (r) => r.method },
    ];
    render(<DataView rows={rows} columns={scoped} rowKey={(r) => r.id} caption="Payments" />);
    // Present once (table only), not twice.
    expect(screen.getAllByText('Cash')).toHaveLength(1);
  });

  it('shows a busy skeleton while loading', () => {
    const { container } = render(
      <DataView rows={[]} columns={columns} rowKey={(r) => r.id} caption="Payments" loading />,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});
