import { NextResponse } from 'next/server';
import { businessReport } from '@/lib/server/reports';
import { reportToCsv } from '@/lib/format/report-csv';

/**
 * A report as a CSV file.
 *
 * It asks for the report exactly as the screen does — as the signed-in user,
 * through `app.business_report` — so the file contains what that person was
 * allowed to see and nothing else. There is no second query here and no way
 * to widen it from the URL.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const report = url.searchParams.get('report') ?? '';
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';

  try {
    const data = await businessReport(report, from, to);
    const csv = reportToCsv(data);
    return new NextResponse(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition':
          `attachment; filename="ramosmax-${data.report}-${data.from}-to-${data.to}.csv"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    const message = ((e as Error).message ?? 'That report could not be built.')
      .replace(/^error:\s*/i, '');
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
