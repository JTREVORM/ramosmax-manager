'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import type { VehicleRow } from '@/lib/server/operations';

/**
 * The vehicle list shows the owner's NAME. It never shows a phone number —
 * the directory this reads from does not carry one, which is what keeps plate
 * look-up safe for a Worker.
 */
const columns: DataColumn<VehicleRow>[] = [
  { id: 'plate', header: 'Plate', role: 'primary', cell: (v) => v.number_plate },
  {
    id: 'vehicle',
    header: 'Vehicle',
    role: 'secondary',
    cell: (v) => [v.make, v.model, v.colour].filter(Boolean).join(' · '),
  },
  { id: 'owner', header: 'Owner', cell: (v) => v.customer_name ?? 'Walk-in' },
  { id: 'type', header: 'Type', cell: (v) => v.vehicle_type ?? '—' },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (v) => <StatusBadge status={v.status} />,
  },
];

export function VehiclesTable({
  vehicles,
  empty,
  hrefPrefix = '/vehicles',
}: {
  vehicles: VehicleRow[];
  empty?: string;
  hrefPrefix?: string;
}) {
  return (
    <DataView
      rows={vehicles}
      columns={columns}
      rowKey={(v) => v.id}
      href={(v) => `${hrefPrefix}/${v.id}`}
      caption="Vehicles"
      empty={empty ?? 'No vehicles match this plate.'}
    />
  );
}
