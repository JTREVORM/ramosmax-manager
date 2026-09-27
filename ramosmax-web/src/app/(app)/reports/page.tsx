import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAnyPermission } from '@/lib/server/guard';
import {
  businessReport, myReports, REPORT_LABELS, reportPeriods,
} from '@/lib/server/reports';
import { ReportSections } from './report-view';

export const metadata: Metadata = { title: 'Reports' };

/**
 * Reports.
 *
 * The page chooses a name and a period and asks the server. It totals
 * nothing, and there is no figure on this screen that the browser worked out.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string; from?: string; to?: string; period?: string }>;
}) {
  await requireAnyPermission(
    'reports.operational.view', 'reports.financial.view', 'reports.payroll.view',
    'finance.view', 'credit.view', 'expenses.view', 'inventory.view', 'inventory.reports.view',
    'attendance.view', 'payroll.view', 'shareholders.reports.view', 'shares.view',
    'shareholders.view', 'after_hours.view',
  );

  const params = await searchParams;
  const [available, periods] = await Promise.all([myReports(), reportPeriods()]);
  const report = available.includes(params.report ?? '') ? params.report! : available[0];
  const chosen = periods.find((p) => p.key === params.period) ?? periods[3];
  const from = params.from ?? chosen.from;
  const to = params.to ?? chosen.to;

  if (!report) {
    return (
      <div className="space-y-4">
        <PageHeader title="Reports" />
        <Card>
          <CardBody>
            <p className="text-muted-foreground text-sm">No report is open to you.</p>
          </CardBody>
        </Card>
      </div>
    );
  }

  let data;
  let error: string | null = null;
  try {
    data = await businessReport(report, from, to);
  } catch (e) {
    error = ((e as Error).message ?? 'That report could not be built.').replace(/^error:\s*/i, '');
  }

  const query = new URLSearchParams({ report, from, to });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reports"
        subtitle={`${REPORT_LABELS[report] ?? report} · ${from} to ${to}`}
        action={
          data ? (
            <a
              href={`/api/reports/csv?${query.toString()}`}
              className="border-border text-foreground rounded-[var(--radius)] border px-3 py-2 text-sm"
            >
              Export CSV
            </a>
          ) : undefined
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Choose a report</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {available.map((name) => (
              <Link
                key={name}
                href={`/reports?report=${name}&from=${from}&to=${to}`}
                className={`rounded-full border px-3 py-2 text-sm ${
                  name === report
                    ? 'bg-primary text-primary-foreground border-transparent'
                    : 'border-border text-foreground'
                }`}
              >
                {REPORT_LABELS[name] ?? name}
              </Link>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {periods.map((p) => (
              <Link
                key={p.key}
                href={`/reports?report=${report}&from=${p.from}&to=${p.to}&period=${p.key}`}
                className={`rounded-full border px-3 py-2 text-sm ${
                  p.from === from && p.to === to
                    ? 'bg-surface-muted border-border'
                    : 'border-border text-muted-foreground'
                }`}
              >
                {p.label}
              </Link>
            ))}
          </div>

          <form method="get" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="report" value={report} />
            <label className="text-sm">
              <span className="text-muted-foreground block">From</span>
              <input
                type="date"
                name="from"
                defaultValue={from}
                className="border-border bg-surface text-foreground h-12 rounded-[var(--radius)] border px-3"
              />
            </label>
            <label className="text-sm">
              <span className="text-muted-foreground block">To</span>
              <input
                type="date"
                name="to"
                defaultValue={to}
                className="border-border bg-surface text-foreground h-12 rounded-[var(--radius)] border px-3"
              />
            </label>
            <button
              type="submit"
              className="bg-primary text-primary-foreground h-12 rounded-[var(--radius)] px-4 text-sm font-medium"
            >
              Show
            </button>
          </form>
        </CardBody>
      </Card>

      {error && (
        <Card>
          <CardBody>
            <p role="alert" className="bg-danger-bg text-danger rounded-[var(--radius)] px-3 py-2 text-sm">
              {error}
            </p>
          </CardBody>
        </Card>
      )}

      {data?.truncated && (
        <Card className="bg-surface-muted">
          <CardBody>
            <p className="text-muted-foreground text-sm">
              Some lists were cut at the limit. The totals above still cover the whole period;
              choose a shorter one to see every line.
            </p>
          </CardBody>
        </Card>
      )}

      {data && <ReportSections sections={data.sections} />}
    </div>
  );
}
