import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody } from '@/components/ui/card';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { formatDateTime } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import { auditModules, listAuditLogs, type AuditRow } from '@/lib/server/user-admin';

export const metadata: Metadata = { title: 'Audit logs' };

const PAGE_SIZE = 100;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string; before?: string }>;
}) {
  await requireAnyPermission('audit.view');
  const params = await searchParams;
  const [rows, modules] = await Promise.all([
    listAuditLogs(params.module, params.before, PAGE_SIZE),
    auditModules(),
  ]);

  const older = rows.length === PAGE_SIZE ? rows[rows.length - 1].occurred_at : null;
  const query = (before: string) =>
    `/audit?${new URLSearchParams({ ...(params.module ? { module: params.module } : {}), before }).toString()}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit logs"
        subtitle="Everything that changed, newest first. Nothing here can be edited or removed."
      />

      <FilterTabs
        param="module"
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          ...modules.map((module) => ({ value: module, label: label(module) })),
        ]}
      />

      {rows.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-muted-foreground text-sm">Nothing recorded for this filter.</p>
          </CardBody>
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Entry row={row} />
            </li>
          ))}
        </ul>
      )}

      {older && (
        <div className="flex justify-center">
          <Link
            href={query(older)}
            className="border-border text-foreground inline-flex h-12 items-center rounded-[var(--radius)] border px-4 text-sm"
          >
            Older entries
          </Link>
        </div>
      )}

      {params.before && (
        <div className="flex justify-center">
          <Link href={`/audit${params.module ? `?module=${params.module}` : ''}`}
            className="text-primary text-sm hover:underline">
            Back to the newest
          </Link>
        </div>
      )}
    </div>
  );
}

function Entry({ row }: { row: AuditRow }) {
  const changed = changeSummary(row);
  return (
    <Card>
      <CardBody className="space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-foreground text-sm font-medium">{label(row.action)}</span>
          <span className="text-muted-foreground text-xs">{formatDateTime(row.occurred_at)}</span>
        </div>
        <p className="text-muted-foreground text-sm">
          {row.description ?? `${label(row.module)} · ${row.record_id ?? ''}`}
        </p>
        <p className="text-muted-foreground text-xs">
          {row.user_name ?? 'System'}
          {row.user_role ? ` (${row.user_role})` : ''}
          {row.target_name ? ` → ${row.target_name}` : ''}
          {` · ${label(row.module)}`}
        </p>
        {row.reason && <p className="text-foreground text-sm">Reason: {row.reason}</p>}
        {changed && <p className="text-muted-foreground tabular text-xs">{changed}</p>}
      </CardBody>
    </Card>
  );
}

/**
 * What actually changed, field by field.
 *
 * Only fields whose value moved are shown, and only ones safe to show: an
 * audit entry may carry a whole row, and a whole row can carry a salary or a
 * phone number that the reader is not entitled to.
 */
const HIDDEN = /password|token|secret|salary|net_pay|gross|phone|identity|key$/i;

function changeSummary(row: AuditRow): string | null {
  const before = asObject(row.previous_value);
  const after = asObject(row.new_value);
  if (!after) return null;

  const parts: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (HIDDEN.test(key)) continue;
    const was = before?.[key];
    if (JSON.stringify(was) === JSON.stringify(value)) continue;
    parts.push(
      before === null || was === undefined
        ? `${key}: ${short(value)}`
        : `${key}: ${short(was)} → ${short(value)}`,
    );
    if (parts.length === 6) break;
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function short(value: unknown): string {
  if (value === null || value === undefined) return 'empty';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : `${value.length} items`;
  if (typeof value === 'object') return 'changed';
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

const label = (key: string) =>
  key.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());
