import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool } from './harness';

afterAll(closePool);

/**
 * THE BUSINESS DAY.
 *
 * Uganda keeps a single offset, UTC+3, with no daylight saving. Every
 * attendance record, allowance and payroll period is anchored to the EAT day,
 * not to the server's clock and not to UTC. These tests pin that down at the
 * boundaries where a mistake would actually hurt: midnight, the end of a
 * month, the end of a year, and the hours where the UTC date and the EAT date
 * disagree.
 */
describe('the EAT business day', () => {
  it('starts at 21:00 UTC the day before', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ start: string }>(
        `select to_char(app.eat_day_start(date '2026-03-15') at time zone 'UTC',
                        'YYYY-MM-DD HH24:MI') as start`,
      );
      expect(rows[0].start).toBe('2026-03-14 21:00');
    });
  });

  it('puts 22:30 UTC into the NEXT EAT day', async () => {
    await asAdminDb(async (db) => {
      // 22:30 UTC on 14 March is 01:30 on 15 March in Kampala.
      const { rows } = await db.query<{ day: string }>(
        `select app.eat_day(timestamptz '2026-03-14 22:30+00')::text as day`,
      );
      expect(rows[0].day).toBe('2026-03-15');
    });
  });

  it('keeps 20:59 UTC in the SAME EAT day', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ day: string }>(
        `select app.eat_day(timestamptz '2026-03-14 20:59+00')::text as day`,
      );
      expect(rows[0].day).toBe('2026-03-14');
    });
  });

  it('crosses midnight in Kampala, not in UTC', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ before: string; after: string }>(`
        select app.eat_day(timestamptz '2026-03-14 20:59:59+00')::text as before,
               app.eat_day(timestamptz '2026-03-14 21:00:00+00')::text as after`);
      expect(rows[0].before).toBe('2026-03-14');
      expect(rows[0].after).toBe('2026-03-15');
    });
  });

  it('crosses the end of a month at Kampala midnight', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ last: string; first: string }>(`
        select app.eat_day(timestamptz '2026-01-31 20:59+00')::text as last,
               app.eat_day(timestamptz '2026-01-31 21:00+00')::text as first`);
      expect(rows[0].last).toBe('2026-01-31');
      expect(rows[0].first).toBe('2026-02-01');
    });
  });

  it('crosses the end of a year at Kampala midnight', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ last: string; first: string }>(`
        select app.eat_day(timestamptz '2025-12-31 20:59+00')::text as last,
               app.eat_day(timestamptz '2025-12-31 21:00+00')::text as first`);
      expect(rows[0].last).toBe('2025-12-31');
      expect(rows[0].first).toBe('2026-01-01');
    });
  });

  it('handles 29 February in a leap year', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ day: string; next: string }>(`
        select app.eat_day(timestamptz '2028-02-29 10:00+03')::text as day,
               app.eat_day(timestamptz '2028-02-29 21:00+00')::text as next`);
      expect(rows[0].day).toBe('2028-02-29');
      expect(rows[0].next).toBe('2028-03-01');
    });
  });

  it('does not move when the server session is in another time zone', async () => {
    await asAdminDb(async (db) => {
      await db.query(`set local timezone = 'America/New_York'`);
      const { rows } = await db.query<{ day: string; start: string }>(`
        select app.eat_day(timestamptz '2026-03-14 22:30+00')::text as day,
               to_char(app.eat_day_start(date '2026-03-15') at time zone 'UTC',
                       'YYYY-MM-DD HH24:MI') as start`);
      expect(rows[0].day).toBe('2026-03-15');
      expect(rows[0].start).toBe('2026-03-14 21:00');
    });
  });

  it('builds a reporting instant in EAT, whatever the session zone', async () => {
    await asAdminDb(async (db) => {
      await db.query(`set local timezone = 'UTC'`);
      const { rows } = await db.query<{ at: string }>(
        `select to_char(app.eat_at(date '2026-03-15', time '08:00') at time zone 'UTC',
                        'YYYY-MM-DD HH24:MI') as at`,
      );
      expect(rows[0].at).toBe('2026-03-15 05:00');
    });
  });

  it('counts ISO weekdays with Monday as 1 and Sunday as 7', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ d: string; w: number }>(`
        select g.d::date::text as d, app.iso_weekday(g.d::date) as w
          from generate_series(date '2026-03-09', date '2026-03-15', interval '1 day') g(d)`);
      expect(rows.map((r) => r.w)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(rows[6].d).toBe('2026-03-15'); // a Sunday
    });
  });
});

/**
 * LATENESS, from the policy in force when the record was made.
 *
 * Reporting at 08:00 with 15 minutes' grace: 08:15 is the last on-time
 * minute. Beyond the threshold (120 minutes) the arrival is severely late,
 * which the allowance rules treat differently.
 */
describe('lateness', () => {
  const at = (hhmm: string) =>
    `app.lateness(date '2026-03-11', app.eat_at(date '2026-03-11', time '${hhmm}'), time '08:00', 15, 120)`;

  it('is not late inside the grace period', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{
        minutes_late: number;
        late: boolean;
        severely_late: boolean;
      }>(`select * from ${at('08:15')}`);
      expect(rows[0]).toMatchObject({ minutes_late: 15, late: false, severely_late: false });
    });
  });

  it('is late one minute after it', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{
        minutes_late: number;
        late: boolean;
        severely_late: boolean;
      }>(`select * from ${at('08:16')}`);
      expect(rows[0]).toMatchObject({ minutes_late: 16, late: true, severely_late: false });
    });
  });

  it('is severely late past the threshold', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ minutes_late: number; severely_late: boolean }>(
        `select * from ${at('10:01')}`,
      );
      expect(rows[0].minutes_late).toBe(121);
      expect(rows[0].severely_late).toBe(true);
    });
  });

  it('never reports negative lateness for an early arrival', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ minutes_late: number; late: boolean }>(
        `select * from ${at('07:20')}`,
      );
      expect(rows[0]).toMatchObject({ minutes_late: 0, late: false });
    });
  });

  it('measures from Kampala 08:00, not from the server zone', async () => {
    await asAdminDb(async (db) => {
      await db.query(`set local timezone = 'Asia/Tokyo'`);
      const { rows } = await db.query<{ minutes_late: number }>(
        `select minutes_late from app.lateness(
           date '2026-03-11', timestamptz '2026-03-11 05:30+00', time '08:00', 15, 120)`,
      );
      // 05:30 UTC is 08:30 in Kampala: 30 minutes.
      expect(rows[0].minutes_late).toBe(30);
    });
  });
});
