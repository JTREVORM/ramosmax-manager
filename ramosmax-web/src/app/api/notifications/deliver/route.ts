import { NextResponse } from 'next/server';
import { deliverNotifications } from '@/lib/server/push';

/**
 * The delivery run.
 *
 * Called by a scheduler (Vercel Cron, Supabase pg_cron over HTTP, or anything
 * else that can POST), never by a browser: it holds a shared secret that a
 * browser is not given, and it reads push subscriptions, which no client role
 * may read at all.
 *
 * It is safe to call at any interval. Notices are deduplicated in the
 * database and each push is marked as it is attempted, so a missed run or an
 * overlapping one changes nothing except when people are told.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.NOTIFICATION_CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'Notification delivery is not configured (NOTIFICATION_CRON_SECRET).' },
      { status: 503 },
    );
  }
  const offered = request.headers.get('authorization');
  if (offered !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 401 });
  }

  try {
    const result = await deliverNotifications();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
