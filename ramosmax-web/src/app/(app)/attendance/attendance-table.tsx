'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDate, formatTime } from '@/lib/format/date';
import { lateness } from '@/lib/format/workforce';
import type { AttendanceRow } from '@/lib/server/workforce';

const columns: DataColumn<AttendanceRow>[] = [
  { id: 'staff', header: 'Staff', role: 'primary', cell: (r) => r.staff_name ?? '—' },
  { id: 'number', header: 'Number', role: 'secondary', cell: (r) => r.attendance_number },
  {
    id: 'in',
    header: 'Clock in',
    role: 'trailing',
    cell: (r) => (r.clock_in_at ? formatTime(r.clock_in_at) : '—'),
  },
  {
    id: 'out',
    header: 'Clock out',
    cell: (r) => (r.clock_out_at ? formatTime(r.clock_out_at) : '—'),
  },
  { id: 'late', header: 'Arrival', cell: (r) => lateness(r) },
  { id: 'day', header: 'Day', cell: (r) => formatDate(r.business_day) },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (r) => <StatusBadge status={r.status} />,
  },
];

export function AttendanceTable({ rows, caption }: { rows: AttendanceRow[]; caption: string }) {
  return (
    <DataView
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      href={(r) => `/attendance/${r.id}`}
      caption={caption}
      empty="No attendance for this day."
    />
  );
}
