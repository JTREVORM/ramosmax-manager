import type { BusinessReport, ReportTable } from '@/lib/server/reports';

/**
 * A report as CSV.
 *
 * Every figure and every table the caller was allowed to see, and nothing
 * more: this works from the report the server already returned, so it cannot
 * reveal a section the report left out.
 *
 * Amounts are whole shillings with no separators, so a spreadsheet can add
 * them up.
 */
export function reportToCsv(report: BusinessReport): string {
  const lines: string[] = [];
  const row = (...cells: unknown[]) => lines.push(cells.map(cell).join(','));

  row('RamosMAX report', report.report);
  row('Period', `${report.from} to ${report.to}`);
  row('Days', report.days);
  row('Generated', report.generatedAt);
  if (report.truncated) {
    row('Note', 'Some lists were cut at the limit. Choose a shorter period for the full lists.');
  }

  for (const section of report.sections) {
    lines.push('');
    row(section.title);
    if (section.note) row('Note', section.note);
    if (section.figures.length > 0) {
      lines.push('');
      row('Figure', 'Value');
      for (const figure of section.figures) row(figure.label, figure.value);
    }
    for (const table of section.tables) {
      lines.push('');
      row(table.title);
      writeTable(row, table);
    }
  }

  // A BOM, so Excel opens UTF-8 correctly rather than mangling the currency.
  return `﻿${lines.join('\r\n')}\r\n`;
}

function writeTable(row: (...cells: unknown[]) => void, table: ReportTable): void {
  row(...table.columns.map((c) => c.label));
  for (const line of table.rows) {
    row(...table.columns.map((c) => line[c.key] ?? ''));
  }
}

/**
 * One CSV cell.
 *
 * A value that begins with `=`, `+`, `-` or `@` is prefixed with an
 * apostrophe, so a spreadsheet shows it instead of RUNNING it. That is the
 * whole of CSV injection, and a report is exactly the kind of file somebody
 * opens without thinking.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';

  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}
