'use client';

import * as React from 'react';
import { WifiOff } from 'lucide-react';

/**
 * The offline banner, ported from docs/OFFLINE.md.
 *
 * The wording is deliberate and must not be softened: cached data is still
 * shown, but the person is told plainly that money actions will not work. The
 * policy behind it is a financial control, not a limitation —
 * "operational reads work offline; money movements do not."
 */
export function OfflineBanner() {
  const [offline, setOffline] = React.useState(false);

  React.useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-warning-bg text-warning flex items-start gap-2 px-4 py-2 text-sm"
    >
      <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        Offline — showing saved data. Payments and other financial actions need a connection.
      </span>
    </div>
  );
}
