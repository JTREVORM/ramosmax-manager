import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, closePool, makeUser, SEED } from './harness';
import { normalizePhone } from '@/lib/auth/phone';
import { passwordProblems } from '@/lib/auth/password-policy';

afterAll(closePool);

describe('phone normalisation — PostgreSQL matches the TypeScript port', () => {
  const cases = [
    '0772123456',
    '256772123456',
    '+256772123456',
    '0772 123 456',
    '0392123456',
    '0412123456',
    '0552123456',
    '+256552123456',
    '077212345',
    '07721234567',
    '+254712345678',
    '',
    'not a phone',
    '+',
    '++256772123456',
    '+256772123456 ',
    '(0772) 123-456',
  ];

  it('agrees with the TypeScript port on every case', async () => {
    await asAdminDb(async (db) => {
      const mismatches: string[] = [];
      for (const input of cases) {
        const { rows } = await db.query(`select app.normalize_phone($1) as normalized`, [input]);
        const fromDb = rows[0].normalized as string | null;
        const fromTs = normalizePhone(input);
        if (fromDb !== fromTs) {
          mismatches.push(`"${input}": postgres=${fromDb} typescript=${fromTs}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  it('normalises every Ugandan form to one E.164 number', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select app.normalize_phone('0772123456')    as a,
               app.normalize_phone('256772123456')  as b,
               app.normalize_phone('+256772123456') as c,
               app.normalize_phone('0772 123 456')  as d`);
      expect(Object.values(rows[0])).toEqual(Array(4).fill('+256772123456'));
    });
  });

  it('rejects an invalid Ugandan prefix', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`select app.normalize_phone('0552123456') as n`);
      expect(rows[0].n).toBeNull();
    });
  });

  it('masks a phone number for the audit trail', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`select app.mask_phone('+256772123456') as masked`);
      expect(rows[0].masked).toBe('+256772...456');
      expect(String(rows[0].masked)).not.toContain('123');
    });
  });
});

describe('East Africa Time business day', () => {
  it('rolls over at EAT midnight, not UTC midnight', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select app.eat_day(timestamptz '2026-03-10 22:30:00+00')::text as late_utc,
               app.eat_day(timestamptz '2026-03-10 06:00:00+00')::text as early_utc,
               app.eat_day(timestamptz '2026-03-10 20:59:00+00')::text as just_before,
               app.eat_day(timestamptz '2026-03-10 21:00:00+00')::text as just_after`);
      // 21:00 UTC is 00:00 EAT the following day.
      expect(rows[0].late_utc).toBe('2026-03-11');
      expect(rows[0].early_utc).toBe('2026-03-10');
      expect(rows[0].just_before).toBe('2026-03-10');
      expect(rows[0].just_after).toBe('2026-03-11');
    });
  });
});

describe('password policy — PostgreSQL matches the TypeScript port', () => {
  const cases: [string, Record<string, string | null>][] = [
    ['Str0ng!Pass', {}],
    ['alllower1!', {}],
    ['ALLUPPER1!', {}],
    ['NoDigits!!', {}],
    ['NoSymbol12', {}],
    ['Aa1!', {}],
    ['Password1!', {}],
    ['RamosMax1!', {}],
    ['Ab!123456xy', { phone: '+256772123456' }],
    ['Xy!rmxstf0001', { staffId: 'RMX-STF-0001' }],
    ['Musoke!99x', { fullName: 'John Musoke' }],
    ['Str0ng!Pass', { fullName: 'Jo Li' }],
  ];

  it('produces the same problem list for every case', async () => {
    await asAdminDb(async (db) => {
      const mismatches: string[] = [];
      for (const [password, ctx] of cases) {
        const { rows } = await db.query(
          `select app.password_problems($1, $2, $3, $4) as problems`,
          [password, ctx.phone ?? null, ctx.staffId ?? null, ctx.fullName ?? null],
        );
        const fromDb = ((rows[0].problems as string[]) ?? []).slice().sort();
        const fromTs = passwordProblems(password, {
          phoneNumber: ctx.phone ?? null,
          staffId: ctx.staffId ?? null,
          fullName: ctx.fullName ?? null,
        })
          .slice()
          .sort();
        if (JSON.stringify(fromDb) !== JSON.stringify(fromTs)) {
          mismatches.push(
            `"${password}": postgres=${JSON.stringify(fromDb)} typescript=${JSON.stringify(fromTs)}`,
          );
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  it('accepts a compliant password', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`select app.password_problems('Str0ng!Pass') as p`);
      expect(rows[0].p).toEqual([]);
    });
  });

  it('rejects a password over 128 characters', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`select app.password_problems(repeat('Aa1!', 40)) as p`);
      expect(rows[0].p).toContain('Use at most 128 characters.');
    });
  });
});

describe('temporary password generation', () => {
  it('always satisfies the policy and avoids look-alike characters', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select app.generate_password(12) as password from generate_series(1, 40)`);
      for (const row of rows) {
        const password = row.password as string;
        expect(password).toHaveLength(12);
        expect(passwordProblems(password)).toEqual([]);
        // No 0/O/o or 1/l/I, so it can be read aloud without ambiguity.
        expect(password).not.toMatch(/[0O o1lI]/);
      }
      // Cryptographically random: 40 draws should not repeat.
      expect(new Set(rows.map((r) => r.password)).size).toBe(40);
    });
  });
});

describe('the hidden sign-in identity', () => {
  it('is random and on the reserved .invalid domain', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `select app.new_sign_in_identity() as email from generate_series(1, 5)`,
      );
      for (const row of rows) {
        expect(String(row.email)).toMatch(/^[0-9a-f]{32}@users\.ramosmax\.invalid$/);
      }
      expect(new Set(rows.map((r) => r.email)).size).toBe(5);
    });
  });

  it('cannot be derived from a phone number', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `select a.email from auth.users a join public.users u on u.id = a.id
          where u.phone_number = '+256772000001'`,
      );
      expect(String(rows[0].email)).not.toContain('256772000001');
      expect(String(rows[0].email)).toMatch(/@users\.ramosmax\.invalid$/);
    });
  });

  it('recognises only its own identities', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select app.is_sign_in_identity('abc@users.ramosmax.invalid') as ours,
               app.is_sign_in_identity('someone@gmail.com')          as theirs,
               app.is_sign_in_identity(null)                         as nothing`);
      expect(rows[0].ours).toBe(true);
      expect(rows[0].theirs).toBe(false);
      expect(rows[0].nothing).toBe(false);
    });
  });
});

describe('sign-in throttle', () => {
  it('locks out after 5 failures within the window', async () => {
    await asAdminDb(async (db) => {
      const phone = '+256772555001';
      for (let i = 0; i < 4; i += 1) {
        await db.query(`select app.record_sign_in_failure($1)`, [phone]);
        const { rows } = await db.query(`select app.throttle_remaining_minutes($1) as m`, [phone]);
        expect(Number(rows[0].m), `after ${i + 1} failures`).toBe(0);
      }
      await db.query(`select app.record_sign_in_failure($1)`, [phone]);
      const { rows } = await db.query(`select app.throttle_remaining_minutes($1) as m`, [phone]);
      expect(Number(rows[0].m)).toBeGreaterThan(0);
      expect(Number(rows[0].m)).toBeLessThanOrEqual(15);
    });
  });

  it('stores a hash, never the phone number', async () => {
    await asAdminDb(async (db) => {
      const phone = '+256772555002';
      await db.query(`select app.record_sign_in_failure($1)`, [phone]);
      const { rows } = await db.query(`select phone_hash from app.login_throttle`);
      for (const row of rows) {
        expect(String(row.phone_hash)).toMatch(/^[0-9a-f]{64}$/);
        expect(String(row.phone_hash)).not.toContain('256772');
      }
    });
  });

  it('clears the counter on a successful sign-in', async () => {
    await asAdminDb(async (db) => {
      const phone = '+256772555003';
      for (let i = 0; i < 5; i += 1)
        await db.query(`select app.record_sign_in_failure($1)`, [phone]);
      expect(
        Number(
          (await db.query(`select app.throttle_remaining_minutes($1) as m`, [phone])).rows[0].m,
        ),
      ).toBeGreaterThan(0);
      await db.query(`select app.clear_sign_in_failures($1)`, [phone]);
      expect(
        Number(
          (await db.query(`select app.throttle_remaining_minutes($1) as m`, [phone])).rows[0].m,
        ),
      ).toBe(0);
    });
  });

  it('starts a fresh window after 15 minutes of quiet', async () => {
    await asAdminDb(async (db) => {
      const phone = '+256772555004';
      for (let i = 0; i < 4; i += 1)
        await db.query(`select app.record_sign_in_failure($1)`, [phone]);
      await db.query(
        `update app.login_throttle set first_failure_at = now() - interval '20 minutes'
          where phone_hash = app.phone_hash($1)`,
        [phone],
      );
      await db.query(`select app.record_sign_in_failure($1)`, [phone]);
      const { rows } = await db.query(
        `select failures from app.login_throttle where phone_hash = app.phone_hash($1)`,
        [phone],
      );
      expect(Number(rows[0].failures)).toBe(1);
    });
  });
});

describe('resolve_sign_in — the account decision', () => {
  it('admits an active account and records the sign-in', async () => {
    await asAdminDb(async (db) => {
      const baseline = Number(
        (
          await db.query(
            `select count(*)::int as n from public.audit_logs
              where target_user_id = $1 and action = 'session.sign_in'`,
            [SEED.worker],
          )
        ).rows[0].n,
      );

      const { rows } = await db.query(`select * from app.resolve_sign_in($1)`, [SEED.worker]);
      expect(rows[0].outcome).toBe('ok');
      expect(rows[0].must_change_password).toBe(false);

      // Counted relatively: the end-to-end browser checks commit real sign-ins
      // against this same development database, so an absolute count would
      // fail depending on what ran before it.
      const audit = await db.query(
        `select count(*)::int as n from public.audit_logs
          where target_user_id = $1 and action = 'session.sign_in'`,
        [SEED.worker],
      );
      expect(Number(audit.rows[0].n)).toBe(baseline + 1);

      const login = await db.query(`select last_login_at from public.users where id = $1`, [
        SEED.worker,
      ]);
      expect(login.rows[0].last_login_at).not.toBeNull();
    });
  });

  it('reports a pending password change without blocking sign-in', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'cashier', mustChangePassword: true });
      const { rows } = await db.query(`select * from app.resolve_sign_in($1)`, [uid]);
      expect(rows[0].outcome).toBe('ok');
      expect(rows[0].must_change_password).toBe(true);
    });
  });

  it('refuses a deactivated account with the reference message', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'cashier', active: false });
      const { rows } = await db.query(`select * from app.resolve_sign_in($1)`, [uid]);
      expect(rows[0].outcome).toBe('inactive');
      expect(rows[0].message).toBe(
        'Your RamosMAX account is inactive. Please contact an administrator.',
      );
    });
  });

  it('distinguishes an ENDED ACCESS PERIOD from a deactivation', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, {
        role: 'cashier',
        accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const { rows } = await db.query(`select * from app.resolve_sign_in($1)`, [uid]);
      expect(rows[0].outcome).toBe('expired');
      expect(rows[0].message).toBe(
        'Your RamosMAX access period has ended. Please contact an administrator.',
      );
    });
  });

  it('refuses an authenticated identity with no RamosMAX profile', async () => {
    await asAdminDb(async (db) => {
      const { rows: auth } = await db.query(
        `insert into auth.users (email) values (app.new_sign_in_identity()) returning id`,
      );
      const { rows } = await db.query(`select * from app.resolve_sign_in($1)`, [auth[0].id]);
      expect(rows[0].outcome).toBe('not_registered');
      expect(rows[0].message).toMatch(/not registered for RamosMAX access/);
    });
  });

  it('does not record a sign-in for a refused account', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'cashier', active: false });
      await db.query(`select * from app.resolve_sign_in($1)`, [uid]);
      const { rows } = await db.query(
        `select count(*)::int as n from public.audit_logs
          where target_user_id = $1 and action = 'session.sign_in'`,
        [uid],
      );
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});

describe('identity lookup by phone number', () => {
  it('finds the hidden identity for a registered number', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `select app.sign_in_identity_for_phone('0772000001') as email`,
      );
      expect(String(rows[0].email)).toMatch(/@users\.ramosmax\.invalid$/);
    });
  });

  it('returns NULL for an unknown number rather than raising', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `select app.sign_in_identity_for_phone('0772999999') as email`,
      );
      expect(rows[0].email).toBeNull();
    });
  });

  it('returns NULL for an unparseable number', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`select app.sign_in_identity_for_phone('nonsense') as email`);
      expect(rows[0].email).toBeNull();
    });
  });
});

describe('completing a password change', () => {
  it('clears the forced change and audits it', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'worker', mustChangePassword: true });
      await db.query(`select app.complete_password_change($1)`, [uid]);

      const { rows } = await db.query(
        `select must_change_password, password_set, password_changed_at
           from public.users where id = $1`,
        [uid],
      );
      expect(rows[0].must_change_password).toBe(false);
      expect(rows[0].password_set).toBe(true);
      expect(rows[0].password_changed_at).not.toBeNull();

      const audit = await db.query(
        `select description from public.audit_logs
          where target_user_id = $1 and action = 'password.changed'`,
        [uid],
      );
      expect(audit.rows[0].description).toBe('Temporary password replaced at sign-in');
    });
  });

  it('distinguishes a voluntary change from a forced one', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'worker', mustChangePassword: false });
      await db.query(`select app.complete_password_change($1)`, [uid]);
      const audit = await db.query(
        `select description from public.audit_logs
          where target_user_id = $1 and action = 'password.changed'`,
        [uid],
      );
      expect(audit.rows[0].description).toBe('Password changed by the user');
    });
  });
});

describe('the audit helper', () => {
  it('attributes an entry to the caller and marks it server-written', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      await db.query(`select app.audit('test.action', 'test', 'rec-1')`);
      await db.query('reset role');
      const { rows } = await db.query(
        `select user_id, user_role, source from public.audit_logs where action = 'test.action'`,
      );
      expect(rows[0].user_id).toBe(SEED.admin);
      expect(rows[0].user_role).toBe('admin');
      expect(rows[0].source).toBe('server');
    });
  });
});
