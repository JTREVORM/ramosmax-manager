'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

/**
 * DataView — one definition, two presentations.
 *
 * RamosMAX is full of data-dense screens: the financial ledger, payroll runs,
 * the share transaction register, stock movements. A horizontally scrolling
 * table on a phone is a failure, and cashiers and workers are on phones.
 *
 * So a screen declares its columns once and gets:
 *   - phone  (<md): a list of CARDS, using the columns marked `primary`,
 *                   `secondary` and `trailing`, tappable through to detail;
 *   - tablet+ (md+): a real TABLE with a sticky header.
 *
 * Nothing is hidden on the phone that is available on desktop — the card shows
 * the identifying and decision-relevant fields, and the detail page has the
 * rest. Columns can opt out of the table with `hideOnDesktop`, or out of the
 * card with `hideOnMobile`.
 */

export interface DataColumn<T> {
  id: string;
  header: string;
  /** Cell content for both presentations. */
  cell: (row: T) => React.ReactNode;
  /** Card slot. Unset columns appear in the card's detail grid. */
  role?: 'primary' | 'secondary' | 'trailing' | 'status';
  /** Right-align and use tabular numerals — for money and counts. */
  numeric?: boolean;
  hideOnMobile?: boolean;
  hideOnDesktop?: boolean;
  className?: string;
}

export interface DataViewProps<T> {
  rows: readonly T[];
  columns: readonly DataColumn<T>[];
  rowKey: (row: T, index: number) => string;
  /** Wraps each row/card in a link when provided. */
  href?: (row: T) => string;
  caption: string;
  empty?: React.ReactNode;
  loading?: boolean;
  /** Shown when the server reports the query hit its bound. */
  truncatedMessage?: string | null;
  className?: string;
}

export function DataView<T>({
  rows,
  columns,
  rowKey,
  href,
  caption,
  empty,
  loading = false,
  truncatedMessage = null,
  className,
}: DataViewProps<T>) {
  const tableColumns = columns.filter((c) => !c.hideOnDesktop);
  const cardColumns = columns.filter((c) => !c.hideOnMobile);

  const slot = (role: DataColumn<T>['role']) => cardColumns.find((c) => c.role === role);
  const primary = slot('primary');
  const secondary = slot('secondary');
  const trailing = slot('trailing');
  const status = slot('status');
  const details = cardColumns.filter((c) => !c.role);

  if (loading) return <DataViewSkeleton columns={tableColumns.length} />;

  if (rows.length === 0) {
    return (
      <Card className="text-muted-foreground px-4 py-10 text-center text-sm">
        {empty ?? 'Nothing to show.'}
      </Card>
    );
  }

  return (
    <div className={className}>
      {truncatedMessage && (
        <p
          role="status"
          className="bg-warning-bg text-warning mb-3 rounded-[var(--radius)] px-3 py-2 text-sm"
        >
          {truncatedMessage}
        </p>
      )}

      {/* ---------------- phone: cards ---------------- */}
      <ul className="space-y-2 md:hidden" aria-label={caption}>
        {rows.map((row, index) => {
          const body = (
            <Card className="active:bg-surface-muted px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {primary && (
                    <div className="text-foreground truncate font-medium">{primary.cell(row)}</div>
                  )}
                  {secondary && (
                    <div className="text-muted-foreground mt-0.5 truncate text-sm">
                      {secondary.cell(row)}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {trailing && (
                    <div
                      className={cn('text-foreground font-medium', trailing.numeric && 'tabular')}
                    >
                      {trailing.cell(row)}
                    </div>
                  )}
                  {status && <div>{status.cell(row)}</div>}
                </div>
              </div>

              {details.length > 0 && (
                <dl className="border-border mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t pt-3">
                  {details.map((column) => (
                    <div key={column.id} className="min-w-0">
                      <dt className="text-muted-foreground text-xs">{column.header}</dt>
                      <dd
                        className={cn(
                          'text-foreground truncate text-sm',
                          column.numeric && 'tabular',
                        )}
                      >
                        {column.cell(row)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </Card>
          );

          return (
            <li key={rowKey(row, index)}>
              {href ? (
                <a href={href(row)} className="block rounded-[var(--radius)]">
                  {body}
                </a>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>

      {/* ---------------- tablet and up: table ---------------- */}
      <Card className="hidden overflow-hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="border-border bg-surface-muted border-b">
                {tableColumns.map((column) => (
                  <th
                    key={column.id}
                    scope="col"
                    className={cn(
                      'text-muted-foreground sticky top-0 px-4 py-2.5 text-left font-medium whitespace-nowrap',
                      column.numeric && 'text-right',
                      column.className,
                    )}
                  >
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={rowKey(row, index)}
                  className="border-border hover:bg-surface-muted border-b last:border-0"
                >
                  {tableColumns.map((column) => (
                    <td
                      key={column.id}
                      className={cn(
                        'text-foreground px-4 py-2.5',
                        column.numeric && 'tabular text-right',
                        column.className,
                      )}
                    >
                      {href && column.role === 'primary' ? (
                        <a href={href(row)} className="font-medium hover:underline">
                          {column.cell(row)}
                        </a>
                      ) : (
                        column.cell(row)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function DataViewSkeleton({ columns }: { columns: number }) {
  return (
    <Card className="divide-border divide-y" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      {Array.from({ length: 5 }).map((_, row) => (
        <div key={row} className="flex gap-4 px-4 py-3">
          {Array.from({ length: Math.min(columns, 4) }).map((__, cell) => (
            <div key={cell} className="bg-surface-muted h-4 flex-1 rounded" />
          ))}
        </div>
      ))}
    </Card>
  );
}
