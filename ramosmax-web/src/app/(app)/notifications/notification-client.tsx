'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import {
  markNotificationReadAction, registerPushAction, removePushAction,
  setNotificationPreferencesAction,
} from '@/lib/server/notification-actions';
import type { NotificationCategory } from '@/lib/server/notifications';

const CATEGORY_LABELS: Record<string, string> = {
  access: 'Your account and access',
  jobs: 'Jobs assigned to you',
  sales: 'Loyalty and rewards',
  finance: 'Expenses, stock and reconciliation',
  workforce: 'Attendance, allowances and payroll approvals',
  pay: 'Your own pay',
  shareholding: 'Shares and dividends',
  after_hours: 'After-hours work and cash',
};

/**
 * Turning push on for this browser.
 *
 * The permission prompt only ever appears after a deliberate tap: a page that
 * asks the moment it loads gets refused once and then never asked again.
 */
export function PushCard({ vapidKey }: { vapidKey: string | null }) {
  const [state, setState] = React.useState<'unknown' | 'off' | 'on' | 'blocked' | 'unsupported'>(
    'unknown',
  );
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof window === 'undefined' || !('serviceWorker' in navigator)
        || !('PushManager' in window)) {
        if (!cancelled) setState('unsupported');
        return;
      }
      if (Notification.permission === 'denied') {
        if (!cancelled) setState('blocked');
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      const existing = await registration?.pushManager.getSubscription();
      if (!cancelled) setState(existing ? 'on' : 'off');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setBusy(true);
    setMessage(undefined);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'blocked' : 'off');
        return;
      }
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey!),
      });
      const json = subscription.toJSON();
      const result = await registerPushAction({
        endpoint: subscription.endpoint,
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
        userAgent: navigator.userAgent.slice(0, 200),
      });
      if (!result.ok) {
        setMessage(result.message ?? 'That could not be saved.');
        return;
      }
      setState('on');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await removePushAction(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState('off');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notices on this device</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        {!vapidKey && (
          <p className="text-muted-foreground text-sm">
            Push is not configured for this deployment. Notices still arrive in the list below.
          </p>
        )}
        {state === 'unsupported' && (
          <p className="text-muted-foreground text-sm">
            This browser cannot show push notices. On an iPhone, add RamosMAX to the home screen
            first.
          </p>
        )}
        {state === 'blocked' && (
          <p className="text-muted-foreground text-sm">
            Notices are blocked for this site in your browser settings. Allow them there, then come
            back.
          </p>
        )}
        {vapidKey && (state === 'off' || state === 'on') && (
          <>
            <p className="text-muted-foreground text-sm">
              {state === 'on'
                ? 'This device shows RamosMAX notices.'
                : 'Get told about jobs, approvals and cash without opening the app.'}
            </p>
            <Button size="sm" disabled={busy} onClick={state === 'on' ? disable : enable}>
              {busy ? 'Working…' : state === 'on' ? 'Turn off on this device' : 'Turn on'}
            </Button>
          </>
        )}
        {message && (
          <p role="alert" className="bg-danger-bg text-danger rounded-[var(--radius)] px-3 py-2 text-sm">
            {message}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          A notice never carries a name, an amount or anybody&apos;s pay — only that there is
          something to look at.
        </p>
      </CardBody>
    </Card>
  );
}

export function PreferencesCard({
  categories,
  preferences,
}: {
  categories: NotificationCategory[];
  preferences: Record<string, boolean>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What to be told about</CardTitle>
      </CardHeader>
      <CardBody>
        <ActionForm action={setNotificationPreferencesAction} submitLabel="Save">
          <div className="space-y-3">
            {categories.map((c) => (
              <label key={c.category} className="flex items-start justify-between gap-3 text-sm">
                <span>
                  {CATEGORY_LABELS[c.category] ?? c.category}
                  {!c.mutable && (
                    <span className="text-muted-foreground block text-xs">
                      Always sent: this is about your own access or your own pay.
                    </span>
                  )}
                </span>
                {c.mutable ? (
                  <>
                    <input type="hidden" name="category" value={c.category} />
                    <input
                      type="checkbox"
                      name={`push_${c.category}`}
                      defaultChecked={preferences[c.category] !== false}
                    />
                  </>
                ) : (
                  <span className="text-muted-foreground text-xs">On</span>
                )}
              </label>
            ))}
          </div>
          <p className="text-muted-foreground mt-3 text-xs">
            Turning one off stops the notice reaching your device. It is still in this list when you
            open RamosMAX.
          </p>
        </ActionForm>
      </CardBody>
    </Card>
  );
}

export function MarkAllRead({ unread }: { unread: number }) {
  if (unread === 0) return null;
  return (
    <ActionForm action={markNotificationReadAction} submitLabel={`Mark all ${unread} as read`}>
      <input type="hidden" name="notification_id" value="" />
    </ActionForm>
  );
}

/**
 * A live inbox.
 *
 * Supabase Realtime pushes new rows straight into the list when the project
 * is configured for it; otherwise the page refreshes itself on a timer. Both
 * paths show the same rows, because both read the same table under the same
 * policy.
 */
export function LiveInbox({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  React.useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => router.refresh(), 60_000);
    const onFocus = () => router.refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, router]);
  return null;
}

/** The VAPID public key, as the Push API wants it. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalised);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}
