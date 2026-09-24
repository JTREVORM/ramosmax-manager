'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { primaryItems, visibleSections, type NavItem } from '@/lib/navigation/nav-config';
import { NavIcon } from './nav-icon';
import { OfflineBanner } from './offline-banner';

/**
 * AppShell — one navigation config, three presentations.
 *
 *   phone  (<lg): bottom tab bar with the role's top destinations, plus a
 *                 slide-over drawer holding everything else. Nothing is
 *                 unreachable on a small screen.
 *   laptop (lg+): persistent grouped sidebar.
 *
 * Mobile is the primary target: cashiers and workers use this on the forecourt,
 * one-handed, in sunlight. The desktop sidebar is the enhancement.
 */
export interface ShellUser {
  fullName: string;
  role: string;
  staffId?: string | null;
}

interface AppShellProps {
  user: ShellUser;
  /** Effective permissions. Drives what is SHOWN — never a security boundary. */
  granted: ReadonlySet<string>;
  children: React.ReactNode;
}

export function AppShell({ user, granted, children }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const pathname = usePathname();
  const sections = React.useMemo(() => visibleSections(granted), [granted]);
  const bottom = React.useMemo(() => primaryItems(granted), [granted]);

  const closeDrawer = React.useCallback(() => setDrawerOpen(false), []);

  // While the drawer is open: Escape closes it, the page behind must not
  // scroll, and a Back gesture closes it rather than leaving it over the
  // previous page. All three are subscriptions to the browser, not state
  // derived from the route.
  React.useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('popstate', closeDrawer);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', closeDrawer);
      document.body.style.overflow = '';
    };
  }, [drawerOpen, closeDrawer]);

  return (
    <div className="bg-background min-h-dvh">
      <a
        href="#main"
        className="focus:bg-primary focus:text-primary-foreground sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded focus:px-4 focus:py-2"
      >
        Skip to content
      </a>

      {/* ---------------- desktop sidebar ---------------- */}
      <aside className="border-border bg-surface fixed inset-y-0 left-0 hidden w-64 flex-col border-r lg:flex">
        <BrandMark />
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-4">
          {sections.map((section) => (
            <div key={section.id} className="mb-5">
              <h2 className="text-muted-foreground px-3 pb-1.5 text-xs font-semibold tracking-wide uppercase">
                {section.label}
              </h2>
              <ul className="space-y-0.5">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <NavLink item={item} active={isActive(pathname, item.href)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <UserCard user={user} />
      </aside>

      {/* ---------------- phone top bar ---------------- */}
      <header className="border-border bg-surface sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-3 lg:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          aria-controls="nav-drawer"
          className="hover:bg-surface-muted flex h-11 w-11 items-center justify-center rounded-[var(--radius)]"
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
        <span className="text-foreground font-semibold">RamosMAX</span>
      </header>

      {/* ---------------- phone drawer ---------------- */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/50"
          />
          <div
            id="nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="bg-surface absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col shadow-xl"
          >
            <div className="border-border flex items-center justify-between border-b px-4 py-3">
              <span className="text-foreground font-semibold">Menu</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
                className="hover:bg-surface-muted flex h-11 w-11 items-center justify-center rounded-[var(--radius)]"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            <nav aria-label="All destinations" className="flex-1 overflow-y-auto px-3 py-4">
              {sections.map((section) => (
                <div key={section.id} className="mb-5">
                  <h2 className="text-muted-foreground px-3 pb-1.5 text-xs font-semibold tracking-wide uppercase">
                    {section.label}
                  </h2>
                  <ul className="space-y-0.5">
                    {section.items.map((item) => (
                      <li key={item.href}>
                        <NavLink
                          item={item}
                          active={isActive(pathname, item.href)}
                          onNavigate={closeDrawer}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
            <UserCard user={user} />
          </div>
        </div>
      )}

      {/* ---------------- content ---------------- */}
      <div className="lg:pl-64">
        <OfflineBanner />
        <main id="main" className="mx-auto w-full max-w-7xl px-4 py-4 pb-24 sm:px-6 lg:pb-8">
          {children}
        </main>
      </div>

      {/* ---------------- phone bottom bar ---------------- */}
      <nav
        aria-label="Primary"
        className="border-border bg-surface fixed inset-x-0 bottom-0 z-30 border-t pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="flex">
          {bottom.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  data-nav
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-16 flex-col items-center justify-center gap-1 px-1 text-[11px]',
                    active ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  <NavIcon name={item.icon} className="size-5" />
                  <span className="max-w-full truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={item.href}
      data-nav
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-[var(--radius)] px-3 py-2.5 text-sm transition-colors',
        active
          ? 'bg-primary/10 text-primary font-medium'
          : 'text-foreground hover:bg-surface-muted',
      )}
    >
      <NavIcon name={item.icon} className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function BrandMark() {
  return (
    <div className="border-border flex items-center gap-3 border-b px-4 py-4">
      <div className="bg-brand-purple text-brand-gold flex size-9 shrink-0 items-center justify-center rounded-[var(--radius)] text-sm font-bold">
        RM
      </div>
      <div className="min-w-0">
        <div className="text-foreground truncate text-sm font-semibold">RamosMAX</div>
        <div className="text-muted-foreground truncate text-xs">Automotive Care</div>
      </div>
    </div>
  );
}

function UserCard({ user }: { user: ShellUser }) {
  return (
    <div className="border-border border-t px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-foreground truncate text-sm font-medium">{user.fullName}</div>
          <div className="text-muted-foreground truncate text-xs capitalize">
            {user.role}
            {user.staffId ? ` · ${user.staffId}` : ''}
          </div>
        </div>
        <Link
          href="/profile"
          aria-label="Profile and sign out"
          className="hover:bg-surface-muted flex size-9 shrink-0 items-center justify-center rounded-[var(--radius)]"
        >
          <LogOut className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

/** `/` matches only itself; every other item matches its subtree. */
function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
