import { describe, expect, it } from 'vitest';
import { reportToCsv } from './report-csv';
import type { BusinessReport } from '@/lib/server/reports';

const report = (overrides: Partial<BusinessReport> = {}): BusinessReport => ({
  report: 'revenue',
  from: '2026-01-01',
  to: '2026-01-31',
  days: 31,
  generatedAt: '2026-02-01T08:00:00+03:00',
  truncated: false,
  sections: [
    {
      key: 'revenue',
      title: 'Revenue',
      note: 'Only customer payments are operating revenue.',
      figures: [
        { key: 'operating_revenue', label: 'Operating revenue', value: 1_250_000, kind: 'money' },
        { key: 'count', label: 'Payments', value: 12, kind: 'count' },
      ],
      tables: [
        {
          key: 'not_revenue',
          title: 'Money that is NOT operating revenue',
          columns: [
            { key: 'item', label: 'Item', kind: 'text' },
            { key: 'amountUgx', label: 'Amount', kind: 'money' },
          ],
          rows: [{ item: 'Share capital received (owners)', amountUgx: 500_000 }],
        },
      ],
    },
  ],
  ...overrides,
});

describe('report CSV', () => {
  it('writes amounts as whole shillings with no separators', () => {
    const csv = reportToCsv(report());
    expect(csv).toContain('Operating revenue,1250000');
    expect(csv).not.toContain('1,250,000');
    expect(csv).not.toContain('UGX');
  });

  it('carries every figure and every table', () => {
    const csv = reportToCsv(report());
    expect(csv).toContain('Revenue');
    expect(csv).toContain('Money that is NOT operating revenue');
    expect(csv).toContain('Share capital received (owners),500000');
    expect(csv).toContain('Only customer payments are operating revenue.');
  });

  it('defuses a value a spreadsheet would run as a formula', () => {
    const csv = reportToCsv(report({
      sections: [{
        key: 'x', title: 'X', figures: [],
        tables: [{
          key: 't', title: 'T',
          columns: [{ key: 'name', label: 'Name', kind: 'text' }],
          rows: [
            { name: '=cmd|/c calc' },
            { name: '+1+1' },
            { name: '-2+3' },
            { name: '@SUM(A1)' },
            { name: 'Ordinary name' },
          ],
        }],
      }],
    }));
    expect(csv).toContain("'=cmd|/c calc");
    expect(csv).toContain("'+1+1");
    expect(csv).toContain("'-2+3");
    expect(csv).toContain("'@SUM(A1)");
    expect(csv).toContain('Ordinary name');
    // And never the live formula on its own.
    expect(csv).not.toMatch(/(^|\r\n|,)=cmd/);
  });

  it('quotes a value containing a comma, a quote or a newline', () => {
    const csv = reportToCsv(report({
      sections: [{
        key: 'x', title: 'X', figures: [],
        tables: [{
          key: 't', title: 'T',
          columns: [{ key: 'name', label: 'Name', kind: 'text' }],
          rows: [{ name: 'Nakato, Amina "A"' }],
        }],
      }],
    }));
    expect(csv).toContain('"Nakato, Amina ""A"""');
  });

  it('says when a list was cut short', () => {
    expect(reportToCsv(report({ truncated: true }))).toContain('cut at the limit');
    expect(reportToCsv(report())).not.toContain('cut at the limit');
  });

  it('carries only what the report carried', () => {
    // A section the caller could not see is not in the report, so it cannot be
    // in the file: the export works from the report, never from the database.
    const csv = reportToCsv(report({ sections: [] }));
    expect(csv).not.toContain('Revenue\r\n');
    expect(csv).toContain('RamosMAX report,revenue');
  });

  it('starts with a byte order mark so a spreadsheet reads UTF-8', () => {
    expect(reportToCsv(report()).charCodeAt(0)).toBe(0xfeff);
  });
});
