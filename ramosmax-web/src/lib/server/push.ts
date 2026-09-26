import 'server-only';
import webpush from 'web-push';
import { serviceDb } from './db';

/**
 * Web Push delivery.
 *
 * The business functions never push. They write an event; a delivery run
 * turns events into in-app notices and then pushes the ones that may be
 * pushed. Nothing here can fail a payment, because nothing here is inside a
 * payment's transaction.
 *
 * WHAT TRAVELS. Only the type, the record and the server's own generic title
 * and body. No name, no amount, no permission — a push payload ends up on a
 * lock screen.
 *
 * The VAPID private key and the subscription keys never leave the server:
 * `app.pending_push` is not callable from a browser session at all, and the
 * subscriptions table grants nothing to `authenticated`.
 */

export interface DeliveryResult {
  eventsDelivered: number;
  noticesWritten: number;
  muted: number;
  pushed: number;
  failed: number;
  devicesDropped: number;
  configured: boolean;
}

interface PendingPush {
  notification_id: string;
  recipient_id: string;
  type: string;
  title: string;
  body: string;
  record_type: string | null;
  record_id: string | null;
  subscriptions: Array<{ endpoint: string; p256dh: string; auth: string }>;
}

export function pushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function configure(): void {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? 'mailto:admin@ramosmax.example',
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
}

/**
 * One delivery run: events → in-app notices → push.
 *
 * Safe to run again at any time. Notices are deduplicated by the database and
 * each push is marked as it is attempted, so an overlapping or retried run
 * never sends the same notice twice.
 */
export async function deliverNotifications(limit = 100): Promise<DeliveryResult> {
  const db = await serviceDb();

  const [events] = await db.rpc<{ events_delivered: number; notices_written: number }>(
    'deliver_events', [500]);
  const [muted] = await db.rpc<{ skip_muted_push: number }>('skip_muted_push', [500]);

  const result: DeliveryResult = {
    eventsDelivered: Number(events?.events_delivered ?? 0),
    noticesWritten: Number(events?.notices_written ?? 0),
    muted: Number(muted?.skip_muted_push ?? 0),
    pushed: 0,
    failed: 0,
    devicesDropped: 0,
    configured: pushConfigured(),
  };

  if (!result.configured) {
    // No VAPID keys: the in-app inbox still works, and nothing is lost —
    // the notices simply stay 'pending' until push is configured.
    return result;
  }
  configure();

  const pending = await db.rpc<PendingPush>('pending_push', [limit]);
  for (const notice of pending) {
    const payload = JSON.stringify({
      type: notice.type,
      title: notice.title,
      body: notice.body,
      recordType: notice.record_type,
      recordId: notice.record_id,
      notificationId: notice.notification_id,
    });

    if (notice.subscriptions.length === 0) {
      await db.rpc('record_push', [
        notice.notification_id,
        JSON.stringify({ status: 'skipped', reason: 'no_device' }),
      ]);
      continue;
    }

    let sent = 0;
    let failed = 0;
    for (const subscription of notice.subscriptions) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
          { TTL: 3600, urgency: 'normal' },
        );
        sent += 1;
      } catch (e) {
        failed += 1;
        const status = (e as { statusCode?: number }).statusCode;
        // 404 / 410: the browser threw this subscription away. Stop
        // addressing a device that no longer exists.
        if (status === 404 || status === 410) {
          await db.rpc('drop_push_subscription', [subscription.endpoint]);
          result.devicesDropped += 1;
        }
      }
    }

    result.pushed += sent > 0 ? 1 : 0;
    result.failed += sent === 0 ? 1 : 0;
    await db.rpc('record_push', [
      notice.notification_id,
      JSON.stringify({
        status: sent > 0 ? (failed > 0 ? 'partial' : 'sent') : 'failed',
        successCount: sent,
        failureCount: failed,
      }),
    ]);
  }

  return result;
}
