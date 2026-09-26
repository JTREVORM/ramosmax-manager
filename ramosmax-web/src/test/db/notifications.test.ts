import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool, makeUser, type Session } from './harness';
import { becomeClient, becomeOwner, SEED } from './billing-helpers';
import {
  authorize, closeSession, eligibleWorker, openSession, supervisor,
} from './after-hours-helpers';

afterAll(closePool);

const deliver = async (db: Session) =>
  (await db.query<{ events_delivered: number; notices_written: number }>(
    `select * from app.deliver_events()`)).rows[0];

const inboxOf = async (db: Session, uid: string) => {
  await becomeClient(db, uid);
  const { rows } = await db.query<{ type: string; title: string; body: string; critical: boolean }>(
    `select type, title, body, critical from app.my_notifications()`);
  await becomeOwner(db);
  return rows;
};

/**
 * NOTIFICATIONS.
 *
 * What a notice may say is the whole of the design: a type, a record id and
 * text that never names anybody or states an amount, because these are read
 * on locked screens by whoever is standing there.
 */
describe('notifications: what a notice may say', () => {
  it('carries no name, no amount and no role — for every single type', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ type: string; title: string; body: string }>(
        `select type, title, body from app.notification_types`);
      expect(rows.length).toBeGreaterThan(30);
      for (const t of rows) {
        const text = `${t.title} ${t.body}`;
        // No amount, no reference number, no figure of any kind.
        expect(text, t.type).not.toMatch(/UGX|shillings|\d{3,}/i);
        expect(text, t.type).not.toMatch(/RMX-/);
        // A name could only come from data, and the catalogue is static text —
        // which is exactly why the notice reads "a job", "an expense", "your
        // pay" and never who or how much.
        expect(text, t.type).not.toMatch(/%s|\{|\$/);
        expect(text.length, t.type).toBeLessThan(200);
      }
    });
  });

  it('writes only the catalogue text, never anything from the event', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss, floatUgx: 123_456 });
      await deliver(db);

      const inbox = await inboxOf(db, staff);
      const notice = inbox.find((n) => n.type === 'after_hours_authorized');
      expect(notice).toBeDefined();
      expect(notice?.body).not.toContain('123');
      expect(notice?.body).not.toContain('RMX-AH');
      expect(notice?.title).toBe('After-hours work authorised');
    });
  });
});

describe('notifications: one notice per event', () => {
  it('drops a repeat of the same notice inside the window', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const { rows: first } = await db.query<{ notify: string }>(
        `select app.notify($1, 'attendance_review', 'attendance', null) as notify`, [staff]);
      const { rows: again } = await db.query<{ notify: string }>(
        `select app.notify($1, 'attendance_review', 'attendance', null) as notify`, [staff]);
      expect(first[0].notify).toBe('recorded');
      expect(again[0].notify).toBe('duplicate');
      expect((await inboxOf(db, staff)).length).toBe(1);
    });
  });

  it('a delivered event is never delivered twice', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const first = await deliver(db);
      const second = await deliver(db);
      expect(Number(first.events_delivered)).toBeGreaterThan(0);
      expect(Number(second.events_delivered)).toBe(0);
    });
  });

  it('two different records make two notices', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const { rows: a } = await db.query<{ id: string }>(
        `select gen_random_uuid() as id`);
      const { rows: b } = await db.query<{ id: string }>(
        `select gen_random_uuid() as id`);
      await db.query(`select app.notify($1, 'attendance_review', 'attendance', $2)`, [staff, a[0].id]);
      await db.query(`select app.notify($1, 'attendance_review', 'attendance', $2)`, [staff, b[0].id]);
      expect((await inboxOf(db, staff)).length).toBe(2);
    });
  });

  it('skips somebody whose account is off — except the notice that says so', async () => {
    await asAdminDb(async (db) => {
      const gone = await makeUser(db, { role: 'worker', active: false });
      const { rows: skipped } = await db.query<{ notify: string }>(
        `select app.notify($1, 'attendance_review', 'attendance', null) as notify`, [gone]);
      const { rows: allowed } = await db.query<{ notify: string }>(
        `select app.notify($1, 'account_deactivated', 'users', null) as notify`, [gone]);
      expect(skipped[0].notify).toBe('skipped');
      expect(allowed[0].notify).toBe('recorded');
    });
  });
});

describe('notifications: who receives them', () => {
  it('delivers a personal event to its recipient only', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const other = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      await deliver(db);

      expect((await inboxOf(db, staff)).some((n) => n.type === 'after_hours_authorized')).toBe(true);
      expect((await inboxOf(db, other)).length).toBe(0);
    });
  });

  it('expands an audience to whoever holds the permission right now', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const counter = await makeUser(db, {
        role: 'manager', permissions: ['cash_handover.approve'],
      });
      const outsider = await makeUser(db, { role: 'cashier' });
      await authorize(db, { staff, by: boss, floatUgx: 40_000 });
      const session = await openSession(db, staff);
      await closeSession(db, session.session_id, staff);
      await deliver(db);

      expect((await inboxOf(db, counter)).some((n) => n.type === 'cash_handover_pending')).toBe(true);
      expect((await inboxOf(db, outsider)).length).toBe(0);
    });
  });

  it('nobody reads anybody else’s inbox', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const nosy = await makeUser(db, { role: 'manager' });
      await db.query(`select app.notify($1, 'attendance_review', 'attendance', null)`, [staff]);

      await becomeClient(db, nosy);
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.notifications`);
      expect(Number(rows[0].n)).toBe(0);
      const { rows: mine } = await db.query<{ n: string }>(
        `select count(*)::text as n from app.my_notifications()`);
      expect(Number(mine[0].n)).toBe(0);
      await becomeOwner(db);
    });
  });

  it('marks a notice read, and only the caller’s own', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const other = await eligibleWorker(db);
      await db.query(`select app.notify($1, 'attendance_review', 'attendance', null)`, [staff]);
      const { rows: id } = await db.query<{ id: string }>(
        `select id from public.notifications where recipient_id = $1`, [staff]);

      await becomeClient(db, other);
      const { rows: nothing } = await db.query<{ n: number }>(
        `select app.mark_notification_read($1) as n`, [id[0].id]);
      expect(Number(nothing[0].n)).toBe(0);

      await becomeClient(db, staff);
      const { rows: done } = await db.query<{ n: number }>(
        `select app.mark_notification_read($1) as n`, [id[0].id]);
      expect(Number(done[0].n)).toBe(1);
      const { rows: unread } = await db.query<{ n: number }>(
        `select app.unread_notification_count() as n`);
      expect(Number(unread[0].n)).toBe(0);
      await becomeOwner(db);
    });
  });
});

describe('notifications: what may be muted', () => {
  it('turns push off for an ordinary category, and still writes the notice', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      await becomeClient(db, staff);
      await db.query(`select app.set_notification_preferences('{"workforce":false}'::jsonb)`);
      await becomeOwner(db);

      await db.query(`select app.notify($1, 'attendance_review', 'attendance', null)`, [staff]);
      expect((await inboxOf(db, staff)).length).toBe(1);

      const { rows } = await db.query<{ allowed: boolean }>(
        `select app.push_allowed($1, 'attendance_review') as allowed`, [staff]);
      expect(rows[0].allowed).toBe(false);
    });
  });

  it('refuses to mute a person’s own access or pay', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      await becomeClient(db, staff);
      for (const category of ['access', 'pay']) {
        expect(await db.expectError(
          `select app.set_notification_preferences($1::jsonb)`,
          [JSON.stringify({ [category]: false })]), category)
          .toMatch(/cannot be turned off/i);
      }
      await becomeOwner(db);
    });
  });

  it('pushes a critical notice even when its category is muted', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      await becomeClient(db, staff);
      await db.query(`select app.set_notification_preferences('{"after_hours":false}'::jsonb)`);
      await becomeOwner(db);

      const { rows } = await db.query<{ critical: boolean; ordinary: boolean }>(
        `select app.push_allowed($1, 'cash_discrepancy_detected') as critical,
                app.push_allowed($1, 'cash_handover_submitted') as ordinary`, [staff]);
      expect(rows[0].critical).toBe(true);
      expect(rows[0].ordinary).toBe(false);
    });
  });

  it('every access and pay notice is marked critical', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ type: string; critical: boolean; category: string }>(
        `select type, critical, category from app.notification_types
          where category in ('access', 'pay')`);
      expect(rows.length).toBeGreaterThan(5);
      expect(rows.every((r) => r.critical)).toBe(true);
    });
  });
});

describe('notifications: push subscriptions are credentials', () => {
  it('registers this browser and nobody else’s', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      await becomeClient(db, staff);
      await db.query(
        `select app.register_push_subscription('https://push.example/abc', 'key', 'auth', 'Test')`);
      await becomeOwner(db);
      const { rows } = await db.query<{ user_id: string }>(
        `select user_id from public.push_subscriptions where endpoint = 'https://push.example/abc'`);
      expect(rows[0].user_id).toBe(staff);
    });
  });

  it('refuses an endpoint that is not https', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      await becomeClient(db, staff);
      expect(await db.expectError(
        `select app.register_push_subscription('http://push.example/abc', 'k', 'a')`))
        .toMatch(/not valid/i);
      await becomeOwner(db);
    });
  });

  it('is unreadable by anybody but the service role', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      await becomeClient(db, staff);
      await db.query(
        `select app.register_push_subscription('https://push.example/xyz', 'key', 'auth')`);
      // Not even their own: these are keys that address a device.
      expect(await db.expectError(`select * from public.push_subscriptions`))
        .toMatch(/permission denied/i);
      await becomeOwner(db);

      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select * from public.push_subscriptions`))
        .toMatch(/permission denied/i);
      expect(await db.expectError(`select * from app.pending_push()`))
        .toMatch(/permission denied/i);
      await becomeOwner(db);
    });
  });

  it('removes only the caller’s own subscription', async () => {
    await asAdminDb(async (db) => {
      const mine = await eligibleWorker(db);
      const theirs = await eligibleWorker(db);
      await becomeClient(db, theirs);
      await db.query(
        `select app.register_push_subscription('https://push.example/theirs', 'k', 'a')`);
      await becomeClient(db, mine);
      const { rows } = await db.query<{ n: number }>(
        `select app.remove_push_subscription('https://push.example/theirs') as n`);
      expect(Number(rows[0].n)).toBe(0);
      await becomeOwner(db);
      const { rows: still } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.push_subscriptions
          where endpoint = 'https://push.example/theirs'`);
      expect(Number(still[0].n)).toBe(1);
    });
  });
});
