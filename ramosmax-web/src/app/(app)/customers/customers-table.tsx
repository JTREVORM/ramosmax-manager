'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatPhoneForDisplay } from '@/lib/auth/phone';
import type { CustomerRow } from '@/lib/server/operations';

const columns: DataColumn<CustomerRow>[] = [
  { id: 'name', header: 'Customer', role: 'primary', cell: (c) => c.full_name },
  { id: 'number', header: 'Number', role: 'secondary', cell: (c) => c.customer_number },
  {
    id: 'phone',
    header: 'Phone',
    cell: (c) => (c.phone_number ? formatPhoneForDisplay(c.phone_number) : '—'),
  },
  { id: 'vehicles', header: 'Vehicles', numeric: true, cell: (c) => c.vehicle_count },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (c) => <StatusBadge status={c.status} />,
  },
];

export function CustomersTable({ customers }: { customers: CustomerRow[] }) {
  return (
    <DataView
      rows={customers}
      columns={columns}
      rowKey={(c) => c.id}
      href={(c) => `/customers/${c.id}`}
      caption="Customers"
      empty="No customers match this search."
    />
  );
}
