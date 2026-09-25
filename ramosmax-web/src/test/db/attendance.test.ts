import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, makeUser, SEED } from './harness';
import { attend, employ, verify } from './workforce-helpers';

afterAll(closePool);

/** A day comfortably inside the backdating window, and a Wednesday. */
async function recentDay(
  db: Awaited<ReturnType<typeof asAdminDb>> extends never
    ? never
    : Parameters<Parameters<typeof asAdminDb>[0]>[0],
) {
  const { rows } = await db.query<{ d: string }>(`select (app.eat_day() - 3)::text as d`);
  return rows[0].d;
}

describe('attendance: one record per person per business day', () => {
  it('refuses a second record through the function', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      await attend(db, staff, day, '08:00');
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.record_attendance($1, 'present', $2::date, (($2::date + time '09:00') at time zone 'Africa/Kampala'))`,
        [staff, day],
      );
      expect(error).toMatch(/already has attendance/i);
    });
  });

  it('refuses a second record at the DATABASE, not only in the function', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      const first = await attend(db, staff, day, '08:00');
      // Full privileges, RLS off, no function in the way: the constraint is
      // the only thing standing between two records for the same day.
      const error = await db.expectError(
        `insert into public.attendance
           (attendance_number, staff_uid, staff_name, business_day, working_day,
            reporting_time, grace_period_minutes, late_threshold_minutes,
            expected_reporting_at, arrival_status, recorded_via, recorded_by, updated_by)
         select 'RMX-ATT-DUP', staff_uid, staff_name, business_day, working_day,
                reporting_time, grace_period_minutes, late_threshold_minutes,
                expected_reporting_at, 'absent', 'manager', recorded_by, updated_by
           from public.attendance where id = $1`,
        [first.attendance_id],
      );
      expect(error).toMatch(/attendance_one_per_day|duplicate key/i);
    });
  });

  it('allows the same person on a different day', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const { rows } = await db.query<{ a: string; b: string }>(
        `select (app.eat_day() - 4)::text as a, (app.eat_day() - 5)::text as b`,
      );
      await attend(db, staff, rows[0].a, '08:00');
      await attend(db, staff, rows[0].b, '08:00');
      const { rows: count } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.attendance where staff_uid = $1`,
        [staff],
      );
      expect(Number(count[0].n)).toBe(2);
    });
  });

  it('allows two different people on the same day', async () => {
    await asAdminDb(async (db) => {
      const a = await employ(db);
      const b = await employ(db);
      const day = await recentDay(db);
      await attend(db, a, day, '08:00');
      await attend(db, b, day, '08:20');
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.attendance
          where business_day = $1::date and staff_uid = any($2::uuid[])`,
        [day, [a, b]],
      );
      expect(Number(rows[0].n)).toBe(2);
    });
  });
});

describe('attendance: the server decides lateness', () => {
  it('computes it from the clock-in time, not from what was sent', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      const record = await attend(db, staff, day, '08:40');
      expect(record).toMatchObject({ arrival_status: 'late', minutes_late: 40, late: true });
    });
  });

  it('treats the last minute of grace as on time', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      expect((await attend(db, staff, day, '08:15')).arrival_status).toBe('on_time');
    });
  });

  it('copies the policy onto the record', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      const record = await attend(db, staff, day, '08:30');
      const { rows } = await db.query<Record<string, string>>(
        `select reporting_time::text, grace_period_minutes::text, late_threshold_minutes::text
           from public.attendance where id = $1`,
        [record.attendance_id],
      );
      expect(rows[0]).toEqual({
        reporting_time: '08:00:00',
        grace_period_minutes: '15',
        late_threshold_minutes: '120',
      });
    });
  });

  /**
   * THE POINT OF THE SNAPSHOT. A business that moves reporting to 09:00 next
   * month must not thereby declare that last month's 08:30 arrivals were on
   * time. History is what happened under the rules that were in force.
   */
  it('does not rewrite an existing record when the policy changes', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      const record = await attend(db, staff, day, '08:30');

      await becomeClient(db, SEED.admin);
      await db.query(`select app.update_payroll_policy($1::jsonb, 'Opening an hour later')`, [
        JSON.stringify({ reportingTime: '09:00' }),
      ]);
      await becomeOwner(db);

      const { rows } = await db.query<{
        minutes_late: number;
        late: boolean;
        reporting_time: string;
      }>(`select minutes_late, late, reporting_time::text from public.attendance where id = $1`, [
        record.attendance_id,
      ]);
      expect(rows[0]).toMatchObject({ minutes_late: 30, late: true, reporting_time: '08:00:00' });

      // And the next day's record uses the new policy.
      const other = await employ(db);
      const next = await attend(db, other, day, '08:30');
      expect(next).toMatchObject({ arrival_status: 'on_time', minutes_late: 0 });
    });
  });

  it("applies the record's own policy when it is corrected, not today's", async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      const record = await attend(db, staff, day, '08:05');

      await becomeClient(db, SEED.admin);
      await db.query(`select app.update_payroll_policy($1::jsonb, 'Opening later')`, [
        JSON.stringify({ reportingTime: '10:00' }),
      ]);
      await db.query(
        `select * from app.correct_attendance($1, 'They actually arrived at 08:45',
                                              'present', (($2::date + time '08:45') at time zone 'Africa/Kampala'))`,
        [record.attendance_id, day],
      );
      await becomeOwner(db);

      const { rows } = await db.query<{ minutes_late: number; late: boolean }>(
        `select minutes_late, late from public.attendance where id = $1`,
        [record.attendance_id],
      );
      // Under the 08:00 policy the record was made with, 08:45 is 45 minutes
      // late. Under today's 10:00 policy it would be none.
      expect(rows[0]).toMatchObject({ minutes_late: 45, late: true });
    });
  });
});

describe('attendance: what may be recorded', () => {
  it('refuses a future day', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.record_attendance($1, 'absent', app.eat_day() + 1)`,
        [staff],
      );
      expect(error).toMatch(/future day/i);
    });
  });

  it('refuses a day older than the backdating window', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.record_attendance($1, 'absent', app.eat_day() - 200)`,
        [staff],
      );
      expect(error).toMatch(/last 62 days/i);
    });
  });

  it('refuses a clock-in that is not on the attendance day', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.record_attendance($1, 'present', app.eat_day() - 3,
           ((app.eat_day() - 4 + time '08:00') at time zone 'Africa/Kampala'))`,
        [staff],
      );
      expect(error).toMatch(/on the attendance day/i);
    });
  });

  it('refuses a clock-in in the future', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.record_attendance($1, 'present', app.eat_day(), now() + interval '2 hours')`,
        [staff],
      );
      expect(error).toMatch(/future/i);
    });
  });

  it('refuses clock times on an absence', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.record_attendance($1, 'absent', app.eat_day() - 2,
           ((app.eat_day() - 2 + time '08:00') at time zone 'Africa/Kampala'))`,
        [staff],
      );
      expect(error).toMatch(/absence has no clock/i);
    });
  });

  it('asks why an absence is excused', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.record_attendance($1, 'excused', app.eat_day() - 2)`,
        [staff],
      );
      expect(error).toMatch(/why the absence is excused/i);
    });
  });

  it('uses the SERVER clock for a self clock-in', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      await becomeClient(db, staff);
      // A browser sending 04:00 gets the server's time anyway.
      const { rows } = await db.query<{ attendance_id: string }>(
        `select * from app.record_attendance(null, 'present', app.eat_day() - 5,
           timestamptz '2001-01-01 04:00+03')`,
      );
      await becomeOwner(db);
      const { rows: saved } = await db.query<{ same: boolean; day: string }>(
        `select clock_in_at between now() - interval '1 minute' and now() as same,
                business_day::text as day
           from public.attendance where id = $1`,
        [rows[0].attendance_id],
      );
      expect(saved[0].same).toBe(true);
      // And the day is today, not the day that was sent.
      const { rows: today } = await db.query<{ d: string }>(`select app.eat_day()::text as d`);
      expect(saved[0].day).toBe(today[0].d);
    });
  });

  it('will not let someone mark themselves absent', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      await becomeClient(db, staff);
      expect(await db.expectError(`select * from app.record_attendance(null, 'absent')`)).toMatch(
        /Ask a manager/i,
      );
    });
  });

  it('will not let a worker record someone else', async () => {
    await asAdminDb(async (db) => {
      const worker = await employ(db);
      const other = await employ(db);
      await becomeClient(db, worker);
      expect(
        await db.denied(
          `select * from app.record_attendance($1, 'present', app.eat_day() - 2,
           ((app.eat_day() - 2 + time '08:00') at time zone 'Africa/Kampala'))`,
          [other],
        ),
      ).toBe(true);
    });
  });
});

describe('attendance: verification', () => {
  it('sets the status from the arrival', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      const record = await attend(db, staff, day, '08:40');
      await verify(db, [record.attendance_id]);
      const { rows } = await db.query<{ status: string; verification_status: string }>(
        `select status, verification_status from public.attendance where id = $1`,
        [record.attendance_id],
      );
      expect(rows[0]).toEqual({ status: 'late', verification_status: 'approved' });
    });
  });

  it('refuses to verify the same record twice', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      const record = await attend(db, staff, day, '08:00');
      await verify(db, [record.attendance_id]);
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(`select app.verify_attendance(array[$1]::uuid[], 'approve')`, [
          record.attendance_id,
        ]),
      ).toMatch(/already been approved/i);
    });
  });

  it('refuses to let anyone verify their own attendance', async () => {
    await asAdminDb(async (db) => {
      // A manager who holds attendance.approve, attending themselves.
      const manager = await makeUser(db, { role: 'manager' });
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.set_salary_profile($1, 600000, '2020-01-01')`, [manager]);
      await becomeClient(db, manager);
      const { rows } = await db.query<{ attendance_id: string }>(
        `select * from app.record_attendance(null, 'present')`,
      );
      expect(
        await db.expectError(`select app.verify_attendance(array[$1]::uuid[], 'approve')`, [
          rows[0].attendance_id,
        ]),
      ).toMatch(/cannot verify your own/i);
    });
  });

  it('needs a reason to reject', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      const record = await attend(db, staff, day, '08:00');
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(`select app.verify_attendance(array[$1]::uuid[], 'reject')`, [
          record.attendance_id,
        ]),
      ).toMatch(/reason/i);
    });
  });

  it('refuses a batch larger than 50', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(
          `select app.verify_attendance(
           (select array_agg(gen_random_uuid()) from generate_series(1, 51)), 'approve')`,
        ),
      ).toMatch(/at most 50/i);
    });
  });

  it('changes nothing when one record in the batch is not verifiable', async () => {
    await asAdminDb(async (db) => {
      const a = await employ(db);
      const b = await employ(db);
      const day = await recentDay(db);
      const first = await attend(db, a, day, '08:00');
      const second = await attend(db, b, day, '08:00');
      await verify(db, [second.attendance_id]);

      await becomeClient(db, SEED.manager);
      await db.expectError(`select app.verify_attendance($1::uuid[], 'approve')`, [
        [first.attendance_id, second.attendance_id],
      ]);
      await becomeOwner(db);
      const { rows } = await db.query<{ verification_status: string }>(
        `select verification_status from public.attendance where id = $1`,
        [first.attendance_id],
      );
      expect(rows[0].verification_status).toBe('pending');
    });
  });
});

describe('attendance: corrections keep history', () => {
  it('writes what it was and what it became, and never deletes', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      const record = await attend(db, staff, day, '08:05');
      await verify(db, [record.attendance_id]);

      await becomeClient(db, SEED.manager);
      await db.query(
        `select * from app.correct_attendance($1, 'The clock was wrong', 'present',
                                              (($2::date + time '09:30') at time zone 'Africa/Kampala'))`,
        [record.attendance_id, day],
      );
      await becomeOwner(db);

      const { rows } = await db.query<Record<string, unknown>>(
        `select * from public.attendance_corrections where attendance_id = $1`,
        [record.attendance_id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBe('The clock was wrong');
      // The same snapshot the reference keeps: what it was and what it became.
      const previous = rows[0].previous_value as Record<string, unknown>;
      const next = rows[0].new_value as Record<string, unknown>;
      expect(previous.arrivalStatus).toBe('on_time');
      expect(next.arrivalStatus).toBe('late');
      expect(previous.status).toBe('present');
      expect(next.status).toBe('pending_verification');
      expect(previous.clockInAt).not.toBe(next.clockInAt);
      expect(rows[0].changed_fields).toContain('clockInAt');

      const { rows: now } = await db.query<{
        minutes_late: number;
        verification_status: string;
        correction_count: number;
      }>(
        `select minutes_late, verification_status, correction_count
           from public.attendance where id = $1`,
        [record.attendance_id],
      );
      expect(now[0]).toMatchObject({
        minutes_late: 90,
        verification_status: 'pending',
        correction_count: 1,
      });
    });
  });

  it('refuses to delete an attendance record', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      const record = await attend(db, staff, day, '08:00');
      expect(
        await db.expectError(`delete from public.attendance where id = $1`, [record.attendance_id]),
      ).toMatch(/never deletes/i);
    });
  });

  it('refuses to delete a correction', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      const record = await attend(db, staff, day, '08:05');
      await becomeClient(db, SEED.manager);
      await db.query(
        `select * from app.correct_attendance($1, 'Fixing the time', 'present',
                        (($2::date + time '08:30') at time zone 'Africa/Kampala'))`,
        [record.attendance_id, day],
      );
      await becomeOwner(db);
      expect(await db.expectError(`delete from public.attendance_corrections`)).toMatch(
        /never deletes/i,
      );
    });
  });

  it('will not let anyone correct their own attendance', async () => {
    await asAdminDb(async (db) => {
      const manager = await makeUser(db, { role: 'manager' });
      await becomeClient(db, manager);
      const { rows } = await db.query<{ attendance_id: string }>(
        `select * from app.record_attendance(null, 'present')`,
      );
      expect(
        await db.expectError(`select * from app.correct_attendance($1, 'I was actually on time')`, [
          rows[0].attendance_id,
        ]),
      ).toMatch(/cannot correct your own/i);
    });
  });

  it('needs a reason', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await recentDay(db);
      const record = await attend(db, staff, day, '08:05');
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(`select * from app.correct_attendance($1, null)`, [
          record.attendance_id,
        ]),
      ).toMatch(/reason/i);
    });
  });
});
