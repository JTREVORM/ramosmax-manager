'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDateTime } from '@/lib/format/date';
import type { JobRow } from '@/lib/server/operations';

const columns: DataColumn<JobRow>[] = [
  { id: 'plate', header: 'Plate', role: 'primary', cell: (j) => j.number_plate },
  { id: 'job', header: 'Job', role: 'secondary', cell: (j) => j.job_number },
  {
    id: 'services',
    header: 'Services',
    numeric: true,
    cell: (j) => j.service_count,
  },
  {
    id: 'workers',
    header: 'Workers',
    cell: (j) => {
      const names = [...new Set(j.orders.map((o) => o.workerName).filter(Boolean))];
      return names.length > 0 ? names.join(', ') : 'Unassigned';
    },
  },
  { id: 'started', header: 'Started', cell: (j) => formatDateTime(j.created_at) },
  {
    id: 'status',
    header: 'Status',
    role: 'status',
    cell: (j) => <StatusBadge status={j.status} />,
  },
];

export function JobsTable({ jobs }: { jobs: JobRow[] }) {
  return (
    <DataView
      rows={jobs}
      columns={columns}
      rowKey={(j) => j.id}
      href={(j) => `/jobs/${j.id}`}
      caption="Jobs"
      empty="No jobs match this filter."
    />
  );
}
