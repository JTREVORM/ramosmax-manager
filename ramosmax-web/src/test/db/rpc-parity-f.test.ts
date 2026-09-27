import { afterAll, describe, expect, it } from 'vitest';
import { closePool, SEED } from './harness';
import { asAdminDb, becomeClient, becomeOwner, requestId } from './billing-helpers';
import { accountId, fund } from './finance-helpers';
import { attend, calculateAllowances, employ, verify } from './workforce-helpers';
import { effectivePermissions, ROLES, type AccessProfile, type Role } from '@/lib/permissions';

afterAll(closePool);

/**
 * RPC PERMISSION PARITY for attendance, allowances, payroll and losses.
 *
 * Knowing the name of a function is not permission to call it. Every role
 * calls every Phase F RPC directly against the database, and the outcome is
 * compared with the Phase 9 permission catalogue.
 */

const profile = (role: Role): AccessProfile => ({
  role,
  active: true,
  mustChangePassword: false,
  permissions: [],
  deniedPermissions: [],
  temporaryGrants: [],
});

interface Fixtures {
  staff: string;
  account: string;
  attendance: string;
  allowance: string;
  payroll: string;
  earning: string;
  incident: string;
  deduction: string;
  day: string;
}

interface RpcCase {
  name: string;
  /** Any ONE of these is enough. */
  requires: string[];
  call: (f: Fixtures) => [string, unknown[]];
}

const RPCS: RpcCase[] = [
  // --- policy ---
  {
    name: 'update_payroll_policy',
    requires: ['settings.manage'],
    call: () => [
      `select app.update_payroll_policy('{"gracePeriodMinutes":20}'::jsonb, 'Parity')`,
      [],
    ],
  },

  // --- attendance ---
  {
    name: 'record_attendance (own)',
    requires: ['attendance.mark', 'attendance.record'],
    call: () => [`select * from app.record_attendance()`, []],
  },
  {
    name: 'record_attendance (another)',
    requires: ['attendance.record'],
    call: ({ staff, day }) => [
      `select * from app.record_attendance($1, 'present', $2::date,
         (($2::date + time '08:00') at time zone 'Africa/Kampala'))`,
      [staff, day],
    ],
  },
  {
    name: 'clock_out',
    requires: ['attendance.record'],
    call: ({ attendance }) => [`select app.clock_out($1, now())`, [attendance]],
  },
  {
    name: 'verify_attendance (approve)',
    requires: ['attendance.approve'],
    call: ({ attendance }) => [
      `select app.verify_attendance(array[$1]::uuid[], 'approve')`,
      [attendance],
    ],
  },
  {
    name: 'verify_attendance (reject)',
    requires: ['attendance.review', 'attendance.approve'],
    call: ({ attendance }) => [
      `select app.verify_attendance(array[$1]::uuid[], 'reject', 'Parity')`,
      [attendance],
    ],
  },
  {
    name: 'correct_attendance',
    requires: ['attendance.correct'],
    call: ({ attendance }) => [
      `select * from app.correct_attendance($1, 'Parity reason', 'absent')`,
      [attendance],
    ],
  },

  // --- allowances ---
  {
    name: 'calculate_allowances',
    requires: ['allowances.calculate'],
    call: ({ day }) => [`select * from app.calculate_allowances($1::date)`, [day]],
  },
  {
    name: 'review_allowance',
    requires: ['allowances.approve', 'allowances.adjust'],
    call: ({ allowance }) => [
      `select app.review_allowance(array[$1]::uuid[], 'full', 'Parity')`,
      [allowance],
    ],
  },
  {
    name: 'pay_allowances',
    requires: ['allowances.pay'],
    call: ({ allowance, account }) => [
      `select * from app.pay_allowances(array[$1]::uuid[], $2, $3)`,
      [allowance, account, requestId('parity')],
    ],
  },
  {
    name: 'reverse_allowance_payment',
    requires: ['allowances.adjust'],
    call: () => [`select * from app.reverse_allowance_payment(gen_random_uuid(), 'Parity')`, []],
  },
  {
    name: 'cancel_allowance',
    requires: ['allowances.adjust'],
    call: ({ allowance }) => [
      `select app.cancel_allowance(array[$1]::uuid[], 'Parity reason')`,
      [allowance],
    ],
  },

  // --- salary ---
  {
    name: 'set_salary_profile',
    requires: ['salary.manage'],
    call: ({ staff }) => [
      `select * from app.set_salary_profile($1, 700000, app.eat_day(), 'monthly', null, null,
                                            true, 'Parity reason')`,
      [staff],
    ],
  },

  // --- payroll ---
  {
    name: 'create_payroll',
    requires: ['payroll.prepare', 'payroll.process'],
    call: () => [
      `select * from app.create_payroll('weekly', null, null,
                    (date_trunc('week', app.eat_day() - 24))::date)`,
      [],
    ],
  },
  {
    name: 'prepare_payroll',
    requires: ['payroll.prepare', 'payroll.process'],
    call: ({ payroll }) => [`select * from app.prepare_payroll($1)`, [payroll]],
  },
  {
    name: 'correct_payroll',
    requires: ['payroll.adjust'],
    call: ({ payroll }) => [`select * from app.correct_payroll($1, 'Parity reason')`, [payroll]],
  },
  {
    name: 'add_payroll_earning',
    requires: ['payroll.adjust'],
    call: ({ payroll, staff }) => [
      `select app.add_payroll_earning($1, $2, 'Parity', 1000, 'Parity reason')`,
      [payroll, staff],
    ],
  },
  {
    name: 'remove_payroll_earning',
    requires: ['payroll.adjust'],
    call: ({ earning }) => [`select app.remove_payroll_earning($1, 'Parity reason')`, [earning]],
  },
  {
    name: 'update_payroll_status (submit)',
    requires: ['payroll.prepare', 'payroll.process'],
    call: ({ payroll }) => [`select app.update_payroll_status($1, 'submit')`, [payroll]],
  },
  {
    name: 'update_payroll_status (review)',
    requires: ['payroll.review'],
    call: ({ payroll }) => [`select app.update_payroll_status($1, 'review')`, [payroll]],
  },
  {
    name: 'update_payroll_status (approve)',
    requires: ['payroll.approve'],
    call: ({ payroll }) => [`select app.update_payroll_status($1, 'approve')`, [payroll]],
  },
  {
    name: 'pay_payroll',
    requires: ['payroll.pay'],
    call: ({ payroll, account }) => [
      `select * from app.pay_payroll($1, $2, $3)`,
      [payroll, account, requestId('parity')],
    ],
  },
  {
    name: 'reverse_payroll_payment',
    requires: ['payroll.adjust'],
    call: ({ payroll }) => [
      `select * from app.reverse_payroll_payment($1, 'Parity reason')`,
      [payroll],
    ],
  },
  {
    name: 'lock_payroll',
    requires: ['payroll.approve'],
    call: ({ payroll }) => [`select app.lock_payroll($1)`, [payroll]],
  },
  {
    name: 'cancel_payroll',
    requires: ['payroll.adjust'],
    call: ({ payroll }) => [`select app.cancel_payroll($1, 'Parity reason')`, [payroll]],
  },

  // --- losses and deductions ---
  {
    name: 'create_loss_incident',
    requires: ['losses.create'],
    call: ({ staff }) => [
      `select * from app.create_loss_incident('other', 10000, 'Parity incident', $1, $2)`,
      [requestId('parity'), staff],
    ],
  },
  {
    name: 'review_loss_incident',
    requires: ['losses.review'],
    call: ({ incident }) => [`select app.review_loss_incident($1, 'Parity')`, [incident]],
  },
  {
    name: 'decide_loss_incident',
    requires: ['losses.approve'],
    call: ({ incident }) => [
      `select app.decide_loss_incident($1, 'reject', 'Parity reason')`,
      [incident],
    ],
  },
  {
    name: 'schedule_loss_recovery',
    requires: ['losses.schedule'],
    call: ({ incident }) => [
      `select * from app.schedule_loss_recovery($1, 10000, app.eat_day() - 30)`,
      [incident],
    ],
  },
  {
    name: 'cancel_loss_incident',
    requires: ['losses.adjust'],
    call: ({ incident }) => [`select app.cancel_loss_incident($1, 'Parity reason')`, [incident]],
  },
  {
    name: 'create_salary_deduction',
    requires: ['deductions.manage'],
    call: ({ staff }) => [
      `select * from app.create_salary_deduction($1, 'other', 100000, 'Parity reason',
         'AGR-PARITY', $2, 100000, app.eat_day() - 30)`,
      [staff, requestId('parity')],
    ],
  },
  {
    name: 'decide_salary_deduction',
    requires: ['payroll.approve'],
    call: ({ deduction }) => [
      `select app.decide_salary_deduction($1, 'reject', 'Parity reason')`,
      [deduction],
    ],
  },
  {
    name: 'cancel_salary_deduction',
    requires: ['deductions.manage', 'losses.adjust'],
    call: ({ deduction }) => [
      `select app.cancel_salary_deduction($1, 'Parity reason')`,
      [deduction],
    ],
  },
];

/** Everything a parity call might need, set up as the people who may. */
async function fixtures(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]): Promise<Fixtures> {
  const account = await accountId(db, 'cash_at_hand');
  await fund(db, 'cash_at_hand', 2_000_000);

  const staff = await employ(db, { salaryUgx: 600_000 });
  const { rows: when } = await db.query<{ d: string; year: number; month: number }>(`
    select g.d::text as d, extract(year from m.first)::int as year,
           extract(month from m.first)::int as month
      from (select max(x)::date as d from generate_series(app.eat_day() - 12, app.eat_day() - 2,
                                                          interval '1 day') s(x)
             where extract(isodow from x) between 1 and 6) g,
           -- A month no payroll has claimed: the workflow scripts commit, so
           -- this suite must not assume the current month is free.
           (select max(d)::date as first
              from generate_series(date_trunc('month', app.eat_day())::date - interval '300 months',
                                   date_trunc('month', app.eat_day())::date - interval '1 month',
                                   interval '1 month') g2(d)
             where not exists (select 1 from public.payroll p
                                where p.period_key = to_char(g2.d, 'YYYY-MM')
                                  and p.status <> 'cancelled')) m`);
  const day = when[0].d;

  const record = await attend(db, staff, day, '09:30');
  await verify(db, [record.attendance_id]);
  await calculateAllowances(db, day);
  const { rows: allowance } = await db.query<{ id: string }>(
    `select id from public.worker_allowances where staff_uid = $1 and business_day = $2::date`,
    [staff, day],
  );

  await becomeClient(db, SEED.manager);
  const { rows: payroll } = await db.query<{ payroll_id: string }>(
    `select * from app.create_payroll('monthly', $1, $2)`,
    [when[0].year, when[0].month],
  );
  await db.query(`select * from app.prepare_payroll($1)`, [payroll[0].payroll_id]);
  const { rows: incident } = await db.query<{ incident_id: string }>(
    `select * from app.create_loss_incident('other', 50000, 'Parity fixture', $1, $2)`,
    [requestId('fixture'), staff],
  );

  await becomeClient(db, SEED.admin);
  const { rows: earning } = await db.query<{ add_payroll_earning: string }>(
    `select app.add_payroll_earning($1, $2, 'Parity fixture', 1000, 'Parity')`,
    [payroll[0].payroll_id, staff],
  );
  const { rows: deduction } = await db.query<{ deduction_id: string }>(
    `select * from app.create_salary_deduction($1, 'other', 100000, 'Parity fixture',
       'AGR-FIXTURE', $2, 100000, app.eat_day() - 30)`,
    [staff, requestId('fixture')],
  );

  await becomeOwner(db);
  return {
    staff,
    account,
    day,
    attendance: record.attendance_id,
    allowance: allowance[0].id,
    payroll: payroll[0].payroll_id,
    earning: earning[0].add_payroll_earning,
    incident: incident[0].incident_id,
    deduction: deduction[0].deduction_id,
  };
}

describe('every Phase F RPC refuses every role that lacks its permission', () => {
  for (const rpc of RPCS) {
    for (const role of ROLES) {
      const granted = effectivePermissions(profile(role));
      const allowed = rpc.requires.some((p) => granted.has(p as never));

      it(`${role} ${allowed ? 'MAY' : 'may NOT'} call ${rpc.name} (${rpc.requires.join(' / ')})`, async () => {
        await asAdminDb(async (db) => {
          const f = await fixtures(db);
          const [sql, params] = rpc.call(f);

          await becomeClient(db, SEED[role]);
          const error = await db.expectError(sql, params);

          if (allowed) {
            // It may fail on a business rule, but NEVER on permission.
            expect(error ?? '', `${role} -> ${rpc.name}`).not.toMatch(/do not have permission/);
          } else {
            expect(error, `${role} -> ${rpc.name}`).toMatch(/do not have permission|not active/);
          }
        });
      });
    }
  }
});
