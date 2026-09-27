import 'server-only';
import { queryAsUser } from './db';
import { sessionUserId } from './session';

/**
 * Reports.
 *
 * The page sends a report name and a period. Everything else — which sections
 * exist, which figures they carry and what this caller may see — is decided
 * by `app.business_report`, which runs as the signed-in user.
 */

async function requireUser(): Promise<string> {
  const id = await sessionUserId();
  if (!id) throw new Error('Not signed in.');
  return id;
}

export interface ReportFigure {
  key: string;
  label: string;
  value: number;
  kind: 'money' | 'count' | 'percent' | 'text';
}

export interface ReportColumn {
  key: string;
  label: string;
  kind: 'money' | 'count' | 'percent' | 'date' | 'text';
}

export interface ReportTable {
  key: string;
  title: string;
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
}

export interface ReportSection {
  key: string;
  title: string;
  note?: string;
  figures: ReportFigure[];
  tables: ReportTable[];
}

export interface BusinessReport {
  report: string;
  from: string;
  to: string;
  days: number;
  generatedAt: string;
  truncated: boolean;
  sections: ReportSection[];
}

export const REPORT_LABELS: Record<string, string> = {
  executive: 'Executive summary',
  financial: 'Money in and out',
  revenue: 'Revenue',
  payment_methods: 'Payment methods',
  outstanding: 'Outstanding and credit',
  expenses: 'Expenses',
  inventory: 'Inventory',
  workforce: 'Workforce',
  shareholders: 'Shareholders',
  after_hours: 'After-hours',
};

/** The reports this caller may open. */
export async function myReports(): Promise<string[]> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ r: string[] }>(uid, `select app.my_reports() as r`);
  return rows[0].r ?? [];
}

export async function businessReport(
  report: string,
  from: string,
  to: string,
): Promise<BusinessReport> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ r: BusinessReport }>(
    uid, `select app.business_report($1, $2::date, $3::date) as r`, [report, from, to]);
  return rows[0].r;
}

/** The named periods the screen offers, as East Africa Time business days. */
export async function reportPeriods(): Promise<
  Array<{ key: string; label: string; from: string; to: string }>
> {
  const uid = await requireUser();
  const rows = await queryAsUser<{
    today: string; yesterday: string; week_start: string; month_start: string;
    previous_start: string; previous_end: string;
  }>(
    uid,
    `select app.eat_day()::text as today,
            (app.eat_day() - 1)::text as yesterday,
            (app.eat_day() - ((app.iso_weekday(app.eat_day()) - 1)))::text as week_start,
            date_trunc('month', app.eat_day())::date::text as month_start,
            (date_trunc('month', app.eat_day()) - interval '1 month')::date::text
              as previous_start,
            (date_trunc('month', app.eat_day()) - interval '1 day')::date::text as previous_end`,
  );
  const d = rows[0];
  return [
    { key: 'today', label: 'Today', from: d.today, to: d.today },
    { key: 'yesterday', label: 'Yesterday', from: d.yesterday, to: d.yesterday },
    { key: 'this_week', label: 'This week', from: d.week_start, to: d.today },
    { key: 'this_month', label: 'This month', from: d.month_start, to: d.today },
    { key: 'last_month', label: 'Last month', from: d.previous_start, to: d.previous_end },
  ];
}
