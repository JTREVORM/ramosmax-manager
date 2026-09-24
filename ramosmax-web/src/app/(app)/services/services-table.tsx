'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatAmount } from '@/lib/format/money';
import type { ServiceRow } from '@/lib/server/operations';

const columns: DataColumn<ServiceRow>[] = [
  { id: 'name', header: 'Service', role: 'primary', cell: (s) => s.name },
  { id: 'category', header: 'Category', role: 'secondary', cell: (s) => s.category },
  {
    id: 'price',
    header: 'Price (UGX)',
    role: 'trailing',
    numeric: true,
    cell: (s) => formatAmount(s.price_ugx),
  },
  {
    id: 'duration',
    header: 'Duration',
    cell: (s) => (s.estimated_duration_minutes ? `${s.estimated_duration_minutes} min` : '—'),
  },
  {
    id: 'loyalty',
    header: 'Loyalty',
    cell: (s) => (s.qualifies_for_loyalty ? <Badge tone="info">Qualifies</Badge> : '—'),
  },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (s) => <StatusBadge status={s.is_active ? 'active' : 'inactive'} />,
  },
];

export function ServicesTable({
  services,
  canManage,
}: {
  services: ServiceRow[];
  canManage: boolean;
}) {
  return (
    <DataView
      rows={services}
      columns={columns}
      rowKey={(s) => s.id}
      href={canManage ? (s) => `/services/${s.id}` : undefined}
      caption="Service catalogue"
      empty="No services in the catalogue yet."
    />
  );
}
