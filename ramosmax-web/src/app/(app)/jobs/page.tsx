import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { SearchField } from '@/components/ui/search-field';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { JobsTable } from './jobs-table';
import { listJobs } from '@/lib/server/operations';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Jobs' };

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  await requireAnyPermission('jobs.view');
  const params = await searchParams;
  const jobs = await listJobs(params.q ?? '', params.status ?? 'open');

  return (
    <div className="space-y-4">
      <PageHeader title="Jobs" subtitle={`${jobs.length} shown`} />
      <SearchField label="Search jobs" placeholder="Number plate or job number" />
      <FilterTabs
        defaultValue="open"
        options={[
          { value: 'open', label: 'Open' },
          { value: 'completed', label: 'Completed' },
          { value: 'cancelled', label: 'Cancelled' },
          { value: 'all', label: 'All' },
        ]}
      />
      <JobsTable jobs={jobs} />
    </div>
  );
}
