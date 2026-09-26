import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { formatDateTime } from '@/lib/format/date';
import { requireSignedIn } from '@/lib/server/guard';
import {
  myNotifications, notificationCategories, notificationHref, notificationPreferences, unreadCount,
} from '@/lib/server/notifications';
import { LiveInbox, MarkAllRead, PreferencesCard, PushCard } from './notification-client';

export const metadata: Metadata = { title: 'Notices' };

/**
 * The inbox.
 *
 * Every notice here is the caller's own: `app.my_notifications()` serves them
 * from the signed-in session, and the table grants nothing else to anybody.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireSignedIn();
  const params = await searchParams;
  const tab = params.tab ?? 'all';

  const [notices, unread, categories, preferences] = await Promise.all([
    myNotifications(100, tab === 'unread'),
    unreadCount(),
    tab === 'settings' ? notificationCategories() : Promise.resolve([]),
    tab === 'settings' ? notificationPreferences() : Promise.resolve({}),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Notices"
        subtitle={unread > 0 ? `${unread} unread` : 'Everything you have been told'}
      />
      <LiveInbox enabled={tab !== 'settings'} />

      <FilterTabs
        param="tab"
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'unread', label: `Unread (${unread})` },
          { value: 'settings', label: 'Settings' },
        ]}
      />

      {tab === 'settings' ? (
        <>
          <PushCard vapidKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null} />
          <PreferencesCard categories={categories} preferences={preferences} />
        </>
      ) : (
        <>
          <MarkAllRead unread={unread} />
          <Card>
            <CardHeader>
              <CardTitle>{tab === 'unread' ? 'Unread' : 'Recent'}</CardTitle>
            </CardHeader>
            <CardBody>
              {notices.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing here.</p>
              ) : (
                <ul className="divide-border divide-y" aria-label="Notices">
                  {notices.map((n) => (
                    <li key={n.id} className="py-3 first:pt-0 last:pb-0">
                      <Link href={notificationHref(n)} className="block">
                        <span
                          className={`text-sm ${n.read ? 'text-muted-foreground' : 'text-foreground font-semibold'}`}
                        >
                          {n.title}
                        </span>
                        <span className="text-muted-foreground block text-sm">{n.body}</span>
                        <span className="text-muted-foreground block text-xs">
                          {formatDateTime(n.created_at)}
                          {n.critical ? ' · important' : ''}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
