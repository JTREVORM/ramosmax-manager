'use server';

import { revalidatePath } from 'next/cache';
import { callRpc } from './operations';
import type { ActionResult } from './operations-actions';

/**
 * Server Actions for the inbox, the notification settings and this browser's
 * push subscription.
 *
 * None of them sends any text: what a notice says comes from the server's own
 * catalogue, so a modified client cannot put an amount or a name on somebody's
 * lock screen.
 */

async function run(fn: string, params: unknown[], revalidate: string[]): Promise<ActionResult> {
  try {
    await callRpc<Record<string, unknown>>(fn, params);
    for (const path of revalidate) revalidatePath(path);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: ((e as Error).message ?? 'Something went wrong.').replace(/^error:\s*/i, ''),
    };
  }
}

export async function markNotificationReadAction(form: FormData): Promise<ActionResult> {
  const id = form.get('notification_id');
  return run('mark_notification_read', [id ? String(id) : null],
    ['/notifications', '/settings']);
}

export async function setNotificationPreferencesAction(form: FormData): Promise<ActionResult> {
  const changes: Record<string, boolean> = {};
  for (const category of form.getAll('category').map(String)) {
    changes[category] = form.get(`push_${category}`) === 'on';
  }
  return run('set_notification_preferences', [JSON.stringify(changes)],
    ['/notifications', '/settings']);
}

/** Registers THIS browser for push. The endpoint and keys come from the browser. */
export async function registerPushAction(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}): Promise<ActionResult> {
  return run('register_push_subscription',
    [input.endpoint, input.p256dh, input.auth, input.userAgent ?? null], []);
}

export async function removePushAction(endpoint: string): Promise<ActionResult> {
  return run('remove_push_subscription', [endpoint], []);
}
