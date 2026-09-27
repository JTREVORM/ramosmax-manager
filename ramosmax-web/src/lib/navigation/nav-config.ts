/**
 * The single navigation source of truth.
 *
 * Ports the per-role menus from lib/features/dashboard/application/role_navigation.dart
 * (documented in docs/ROADMAP.md "Role menus"). There is ONE config; the
 * desktop sidebar, the tablet rail and the phone bottom bar + drawer are three
 * presentations of it, so a destination can never appear in one and not another.
 *
 * Every item is gated by permission, not by role. That is deliberate: the
 * reference implementation grants access through the effective-permission set,
 * so a Cashier who has been given `finance.view` sees Finance without anyone
 * editing a role menu. It also means an after-hours temporary grant opens the
 * extra Worker destinations automatically, exactly as Phase 8 does today.
 */
import type { Permission } from '@/lib/permissions';

export interface NavItem {
  href: string;
  label: string;
  /** Visible when the user holds ANY of these. Empty = always visible. */
  anyOf: readonly Permission[];
  /** Lucide icon name, resolved in the shell. */
  icon: string;
  /** Candidate for the phone bottom bar (highest priority wins). */
  primary?: number;
}

export interface NavSection {
  id: string;
  label: string;
  items: readonly NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'today',
    label: 'Today',
    items: [
      { href: '/', label: 'Dashboard', anyOf: [], icon: 'LayoutDashboard', primary: 100 },
      {
        href: '/new-service',
        label: 'New Service',
        anyOf: ['jobs.create'],
        icon: 'Plus',
        primary: 95,
      },
      {
        href: '/my-jobs',
        label: 'My Jobs',
        anyOf: ['jobs.view.own'],
        icon: 'ClipboardList',
        primary: 94,
      },
      { href: '/jobs', label: 'Jobs', anyOf: ['jobs.view'], icon: 'Wrench', primary: 80 },
    ],
  },
  {
    id: 'customers',
    label: 'Customers & vehicles',
    items: [
      { href: '/vehicles', label: 'Vehicles', anyOf: ['vehicles.view'], icon: 'Car', primary: 85 },
      { href: '/customers', label: 'Customers', anyOf: ['customers.view'], icon: 'Users' },
      { href: '/services', label: 'Services', anyOf: ['services.view'], icon: 'SprayCan' },
    ],
  },
  {
    id: 'sales',
    label: 'Sales',
    items: [
      {
        href: '/invoices',
        label: 'Invoices',
        anyOf: ['invoices.view'],
        icon: 'FileText',
        primary: 75,
      },
      {
        href: '/payments',
        label: 'Payments',
        anyOf: ['payments.view'],
        icon: 'Banknote',
        primary: 78,
      },
      {
        href: '/receipts',
        label: 'Receipts',
        anyOf: ['payments.view', 'invoices.view'],
        icon: 'Receipt',
      },
      { href: '/credit', label: 'Credit', anyOf: ['credit.view'], icon: 'HandCoins' },
      { href: '/loyalty', label: 'Loyalty', anyOf: ['loyalty.view'], icon: 'Star' },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      { href: '/finance', label: 'Finance', anyOf: ['finance.view'], icon: 'Wallet' },
      {
        href: '/transactions',
        label: 'Transactions',
        anyOf: ['finance.transactions.view'],
        icon: 'ArrowLeftRight',
      },
      {
        href: '/reconciliation',
        label: 'Reconciliation',
        anyOf: ['finance.reconcile'],
        icon: 'Scale',
      },
      { href: '/expenses', label: 'Expenses', anyOf: ['expenses.view'], icon: 'ReceiptText' },
      { href: '/inventory', label: 'Inventory', anyOf: ['inventory.view'], icon: 'Package' },
    ],
  },
  {
    id: 'workforce',
    label: 'Workforce',
    items: [
      {
        href: '/attendance',
        label: 'Attendance',
        anyOf: ['attendance.view', 'attendance.view.own'],
        icon: 'CalendarCheck',
        primary: 90,
      },
      {
        href: '/allowances',
        label: 'Allowances & pay',
        anyOf: ['allowances.view', 'allowances.view.own', 'payroll.view.own'],
        icon: 'Coins',
        primary: 88,
      },
      {
        href: '/payroll',
        label: 'Payroll',
        anyOf: ['payroll.view', 'reports.payroll.view'],
        icon: 'Landmark',
      },
      { href: '/losses', label: 'Loss Incidents', anyOf: ['losses.view'], icon: 'TriangleAlert' },
    ],
  },
  {
    id: 'ownership',
    label: 'Ownership',
    items: [
      {
        href: '/shareholders',
        label: 'Shareholders',
        anyOf: ['shareholders.view', 'shareholders.reports.view'],
        icon: 'UsersRound',
      },
      { href: '/shares', label: 'Shares', anyOf: ['shares.view'], icon: 'PieChart' },
      { href: '/dividends', label: 'Dividends', anyOf: ['dividends.view'], icon: 'Gift' },
      {
        href: '/my-shares',
        label: 'My Shareholding',
        anyOf: ['shareholders.view.own'],
        icon: 'PiggyBank',
        primary: 92,
      },
    ],
  },
  {
    id: 'afterhours',
    label: 'After-hours',
    items: [
      {
        href: '/after-hours',
        label: 'After-Hours',
        anyOf: [
          'after_hours.view',
          'after_hours.approve',
          'cash_handover.approve',
          'after_hours.discrepancy.review',
        ],
        icon: 'MoonStar',
      },
      {
        href: '/my-after-hours',
        label: 'My After-Hours',
        anyOf: ['after_hours.request'],
        icon: 'Moon',
      },
    ],
  },
  {
    id: 'insight',
    label: 'Insight',
    items: [
      {
        href: '/reports',
        label: 'Reports',
        anyOf: ['reports.operational.view', 'reports.financial.view', 'reports.payroll.view'],
        icon: 'ChartColumn',
      },
      { href: '/audit', label: 'Audit Logs', anyOf: ['audit.view'], icon: 'ScrollText' },
      // Everybody has an inbox: notices are about your own work, your own
      // access and your own pay, so there is no permission to hold for it.
      { href: '/notifications', label: 'Notices', anyOf: [], icon: 'Bell' },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [
      { href: '/users', label: 'User Management', anyOf: ['users.view'], icon: 'ShieldCheck' },
      { href: '/settings', label: 'Settings', anyOf: ['settings.view'], icon: 'Settings' },
    ],
  },
];

/** Sections and items the holder of `granted` may see, empties removed. */
export function visibleSections(granted: ReadonlySet<string>): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => item.anyOf.length === 0 || item.anyOf.some((p) => granted.has(p)),
    ),
  })).filter((section) => section.items.length > 0);
}

/**
 * The phone bottom bar: at most `limit` destinations, highest priority first,
 * always including the Dashboard. Everything else lives in the drawer, so no
 * destination is ever unreachable on a small screen.
 */
export function primaryItems(granted: ReadonlySet<string>, limit = 5): NavItem[] {
  return visibleSections(granted)
    .flatMap((s) => s.items)
    .filter((i) => i.primary !== undefined)
    .sort((a, b) => (b.primary ?? 0) - (a.primary ?? 0))
    .slice(0, limit);
}
