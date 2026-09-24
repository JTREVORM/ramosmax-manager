import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS, primaryItems, visibleSections } from './nav-config';
import {
  PERMISSIONS,
  effectivePermissions,
  type AccessProfile,
  type Role,
} from '@/lib/permissions';

const profile = (role: Role): AccessProfile => ({
  role,
  active: true,
  mustChangePassword: false,
  permissions: [],
  deniedPermissions: [],
  temporaryGrants: [],
});

const navFor = (role: Role) =>
  visibleSections(effectivePermissions(profile(role)) as ReadonlySet<string>);

const hrefsFor = (role: Role) => navFor(role).flatMap((s) => s.items.map((i) => i.href));

describe('navigation config', () => {
  it('only references permissions that exist in the catalogue', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        for (const p of item.anyOf) expect(known.has(p)).toBe(true);
      }
    }
  });

  it('has no duplicate destinations', () => {
    const hrefs = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('shows an admin every section', () => {
    expect(navFor('admin').length).toBe(NAV_SECTIONS.length);
  });

  it('shows a worker only their own work, never the register or payroll', () => {
    const hrefs = hrefsFor('worker');
    expect(hrefs).toContain('/my-jobs');
    expect(hrefs).toContain('/attendance');
    expect(hrefs).toContain('/my-after-hours');
    expect(hrefs).not.toContain('/jobs');
    expect(hrefs).not.toContain('/payroll');
    expect(hrefs).not.toContain('/finance');
    expect(hrefs).not.toContain('/reports');
    expect(hrefs).not.toContain('/users');
  });

  it('shows a shareholder their own shareholding but never the register', () => {
    const hrefs = hrefsFor('shareholder');
    expect(hrefs).toContain('/my-shares');
    expect(hrefs).not.toContain('/shareholders');
    expect(hrefs).not.toContain('/shares');
  });

  it('shows a cashier sales but not finance or payroll', () => {
    const hrefs = hrefsFor('cashier');
    expect(hrefs).toContain('/invoices');
    expect(hrefs).toContain('/payments');
    expect(hrefs).toContain('/expenses');
    expect(hrefs).not.toContain('/finance');
    expect(hrefs).not.toContain('/payroll');
  });

  it('opens extra destinations when an after-hours grant is live', () => {
    const now = Date.now();
    const authorised: AccessProfile = {
      ...profile('worker'),
      temporaryGrants: [
        {
          permissionKey: 'jobs.create',
          startsAt: new Date(now - 1000),
          expiresAt: new Date(now + 3_600_000),
        },
      ],
    };
    const granted = effectivePermissions(authorised, now) as ReadonlySet<string>;
    const hrefs = visibleSections(granted).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/new-service');
  });

  it('gives every role a bottom bar that fits a phone', () => {
    for (const role of [
      'admin',
      'manager',
      'cashier',
      'worker',
      'shareholder',
      'auditor',
    ] as Role[]) {
      const bar = primaryItems(effectivePermissions(profile(role)) as ReadonlySet<string>);
      expect(bar.length).toBeGreaterThan(0);
      expect(bar.length).toBeLessThanOrEqual(5);
      expect(bar.some((i) => i.href === '/')).toBe(true);
    }
  });

  it('leaves no destination unreachable: the drawer holds everything', () => {
    for (const role of [
      'admin',
      'manager',
      'cashier',
      'worker',
      'shareholder',
      'auditor',
    ] as Role[]) {
      const granted = effectivePermissions(profile(role)) as ReadonlySet<string>;
      const drawer = new Set(visibleSections(granted).flatMap((s) => s.items.map((i) => i.href)));
      for (const item of primaryItems(granted)) expect(drawer.has(item.href)).toBe(true);
    }
  });
});
