'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import type { ReportSection, ReportTable } from '@/lib/server/reports';

/** How a figure or a cell is written, by what it is. */
function render(value: unknown, kind: string): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (kind) {
    case 'money':
      return formatUgx(Number(value));
    case 'count':
      return Number(value).toLocaleString('en-US');
    case 'percent':
      return `${Number(value).toFixed(2)}%`;
    case 'date':
      return formatDate(String(value));
    default:
      return String(value);
  }
}

export function ReportSections({ sections }: { sections: ReportSection[] }) {
  if (sections.length === 0) {
    return (
      <Card>
        <CardBody>
          <p className="text-muted-foreground text-sm">
            Nothing in this report is open to you.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <>
      {sections.map((s) => (
        <section key={s.key} className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>{s.title}</CardTitle>
            </CardHeader>
            <CardBody className="space-y-1.5">
              {s.figures.length === 0 ? (
                <p className="text-muted-foreground text-sm">No figures for this period.</p>
              ) : (
                s.figures.map((f) => (
                  <div key={f.key} className="flex justify-between gap-3">
                    <span className="text-muted-foreground text-sm">{f.label}</span>
                    <span className="tabular text-foreground text-sm">
                      {render(f.value, f.kind)}
                    </span>
                  </div>
                ))
              )}
              {s.note && <p className="text-muted-foreground pt-2 text-xs">{s.note}</p>}
            </CardBody>
          </Card>

          {s.tables.map((t) => (
            <ReportDataTable key={t.key} table={t} />
          ))}
        </section>
      ))}
    </>
  );
}

function ReportDataTable({ table }: { table: ReportTable }) {
  const columns: DataColumn<Record<string, unknown>>[] = table.columns.map((c, index) => ({
    id: c.key,
    header: c.label,
    role: index === 0 ? 'primary' : index === 1 ? 'secondary' : undefined,
    numeric: c.kind === 'money' || c.kind === 'count' || c.kind === 'percent',
    cell: (row) => render(row[c.key], c.kind),
  }));

  return (
    <DataView
      rows={table.rows}
      columns={columns}
      rowKey={(_, index) => String(index)}
      caption={table.title}
      empty="Nothing in this period."
    />
  );
}
