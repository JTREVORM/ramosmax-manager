/*
 * RamosMAX service worker.
 *
 * It does two things and nothing else:
 *
 *   * receives Web Push and shows the notice. The payload carries only a
 *     title, a body and a record to open — the same generic text the server
 *     stores, because this appears on a locked screen where anybody standing
 *     nearby can read it;
 *   * opens the app at the right place when the notice is tapped, reusing a
 *     window that is already open rather than piling up tabs.
 *
 * It deliberately does NOT cache business data. RamosMAX reads are online
 * reads: a cached invoice balance or a cached payroll total is a figure
 * somebody could act on after it stopped being true.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const PATHS = {
  attendance: '/attendance',
  allowance: '/allowances',
  payroll: '/payroll',
  loss: '/losses',
  deduction: '/payroll',
  share_transaction: '/shares',
  dividend: '/dividends',
  dividend_allocation: '/my-shares',
  shareholder: '/my-shares',
  authorization: '/my-after-hours',
  handover: '/after-hours?tab=handovers',
  discrepancy: '/after-hours?tab=discrepancies',
  users: '/',
};

function target(data) {
  if (!data) return '/';
  const base = PATHS[data.recordType] ?? '/';
  if (!data.recordId) return base;
  switch (data.recordType) {
    case 'handover':
      return `/after-hours/handover/${data.recordId}`;
    case 'discrepancy':
      return `/after-hours/discrepancy/${data.recordId}`;
    case 'share_transaction':
      return `/shares/txn/${data.recordId}`;
    case 'dividend':
      return `/dividends/${data.recordId}`;
    case 'loss':
      return `/losses/${data.recordId}`;
    case 'attendance':
      return `/attendance/${data.recordId}`;
    default:
      return base;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'RamosMAX';
  const body = data.body || 'Open RamosMAX for details.';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // One notice per record: a repeat replaces it rather than stacking.
      tag: `${data.type || 'ramosmax'}:${data.recordId || 'none'}`,
      renotify: Boolean(data.critical),
      requireInteraction: Boolean(data.critical),
      data: { url: target(data) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
