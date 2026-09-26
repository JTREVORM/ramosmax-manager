import 'server-only';
import { queryAsUser } from './db';
import { sessionUserId } from './session';

/**
 * Reads for the notification inbox and the notification settings.
 *
 * Everything runs AS THE SIGNED-IN USER: `app.my_notifications()` serves the
 * caller's own inbox from their sign-in, and the table itself is closed to
 * everybody else's rows.
 */

async function requireUser(): Promise<string> {
  const id = await sessionUserId();
  if (!id) throw new Error('Not signed in.');
  return id;
}

export interface NotificationRow {
  id: string;
  type: string;
  category: string;
  critical: boolean;
  record_type: string | null;
  record_id: string | null;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
}

export async function myNotifications(
  limit = 50,
  unreadOnly = false,
): Promise<NotificationRow[]> {
  const uid = await requireUser();
  return queryAsUser<NotificationRow>(
    uid, `select * from app.my_notifications($1, $2)`, [limit, unreadOnly]);
}

export async function unreadCount(): Promise<number> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ n: number }>(
    uid, `select app.unread_notification_count() as n`);
  return Number(rows[0].n);
}

export interface NotificationCategory {
  category: string;
  mutable: boolean;
  types: number;
}

export async function notificationCategories(): Promise<NotificationCategory[]> {
  const uid = await requireUser();
  return queryAsUser<NotificationCategory>(uid, `select * from app.notification_categories()`);
}

export async function notificationPreferences(): Promise<Record<string, boolean>> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ p: Record<string, boolean> }>(
    uid, `select app.notification_preferences() as p`);
  return rows[0].p ?? {};
}

/** Where a notice about this record lives. */
export function notificationHref(row: NotificationRow): string {
  const id = row.record_id;
  if (!id) return notificationSection(row.record_type);
  switch (row.record_type) {
    case 'handover':
      return `/after-hours/handover/${id}`;
    case 'discrepancy':
      return `/after-hours/discrepancy/${id}`;
    case 'share_transaction':
      return `/shares/txn/${id}`;
    case 'dividend':
      return `/dividends/${id}`;
    case 'loss':
      return `/losses/${id}`;
    case 'attendance':
      return `/attendance/${id}`;
    case 'payroll':
      return `/payroll/run/${id}`;
    default:
      return notificationSection(row.record_type);
  }
}

function notificationSection(recordType: string | null): string {
  switch (recordType) {
    case 'allowance':
      return '/allowances';
    case 'payroll':
    case 'deduction':
      return '/payroll';
    case 'authorization':
      return '/my-after-hours';
    case 'dividend_allocation':
    case 'shareholder':
      return '/my-shares';
    default:
      return '/';
  }
}
