import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, makeUser, SEED } from './harness';
import { requestId, shareClass, shareholder, shareholderRow, ugx } from './ownership-helpers';

afterAll(closePool);

/**
 * WHO OWNS THE BUSINESS.
 *
 * A shareholder record is a person or a company, their contact details and
 * their identification. Nothing here is ever deleted: a shareholder who leaves
 * becomes `exited` and keeps their entire history.
 */

describe('shareholders: the register', () => {
  it('creates one with a reference number and empty totals', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{ shareholder_id: string; shareholder_number: string }>(
        `select * from app.create_shareholder('Grace Owner', $1, '0772500001', 'grace@example.com')`,
        [requestId('sh')]);
      await becomeOwner(db);

      expect(rows[0].shareholder_number).toMatch(/^RMX-SHR-\d{6,}$/);
      const row = await shareholderRow(db, rows[0].shareholder_id);
      expect(row.status).toBe('active');
      expect(ugx(row.total_shares)).toBe(0);
      expect(ugx(row.ownership_percent)).toBe(0);
      expect(row.phone_number).toBe('+256772500001');
      expect(row.linked_uid).toBeNull();
    });
  });

  it('creates once for a repeated request id', async () => {
    await asAdminDb(async (db) => {
      const key = requestId('sh-retry');
      await becomeClient(db, SEED.admin);
      const first = await db.query<{ shareholder_id: string }>(
        `select * from app.create_shareholder('Repeat Owner', $1, '0772500002')`, [key]);
      const again = await db.query<{ shareholder_id: string }>(
        `select * from app.create_shareholder('Repeat Owner', $1, '0772500002')`, [key]);
      expect(again.rows[0].shareholder_id).toBe(first.rows[0].shareholder_id);
    });
  });

  it('refuses a duplicate phone number', async () => {
    await asAdminDb(async (db) => {
      await shareholder(db, 'First Owner', '0772500003');
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select * from app.create_shareholder('Second Owner', $1, '0772500003')`,
        [requestId('sh-dup')])).toMatch(/phone number already exists/i);
    });
  });

  it('refuses a duplicate identification number', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      await db.query(
        `select * from app.create_shareholder('ID Owner', $1, null, null, null, 'national_id', 'CM90210')`,
        [requestId('sh-id')]);
      expect(await db.expectError(
        `select * from app.create_shareholder('Other Owner', $1, null, null, null, 'national_id', 'cm 90210')`,
        [requestId('sh-id2')])).toMatch(/identification number already exists/i);
    });
  });

  it('insists on both the identification type and number, or neither', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select * from app.create_shareholder('Half Owner', $1, null, null, null, 'passport', null)`,
        [requestId('sh-half')])).toMatch(/both the identification type and number/i);
    });
  });

  it('masks the phone number and identification in the audit trail', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{ shareholder_id: string }>(
        `select * from app.create_shareholder('Audited Owner', $1, '0772500004', null, null,
                                              'national_id', 'CM12345')`, [requestId('sh-audit')]);
      await becomeOwner(db);
      const { rows: audit } = await db.query<{ new_value: Record<string, string> }>(
        `select new_value from public.audit_logs
          where action = 'shareholder.created' and record_id = $1`, [rows[0].shareholder_id]);
      expect(audit[0].new_value.phoneNumber).not.toContain('500004');
      expect(audit[0].new_value.idNumber).toBe('••345');
    });
  });

  it('refuses to delete a shareholder, ever', async () => {
    await asAdminDb(async (db) => {
      const id = await shareholder(db, 'Permanent Owner', '0772500005');
      expect(await db.expectError(`delete from public.shareholders where id = $1`, [id]))
        .toMatch(/never deletes/i);
    });
  });

  it('will not let a manager create one', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      expect(await db.denied(
        `select * from app.create_shareholder('Sneaky Owner', $1)`, [requestId('sh-denied')]))
        .toBe(true);
    });
  });
});

describe('shareholders: status', () => {
  it('changes status with a reason, and records it', async () => {
    await asAdminDb(async (db) => {
      const id = await shareholder(db, 'Suspended Owner', '0772500006');
      await becomeClient(db, SEED.admin);
      await db.query(`select app.set_shareholder_status($1, 'suspended', 'Under investigation')`, [id]);
      await becomeOwner(db);
      const row = await shareholderRow(db, id);
      expect(row.status).toBe('suspended');
      expect(row.status_reason).toBe('Under investigation');
    });
  });

  it('always needs a reason', async () => {
    await asAdminDb(async (db) => {
      const id = await shareholder(db, 'Reasonless Owner', '0772500007');
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.set_shareholder_status($1, 'inactive', null)`, [id]))
        .toMatch(/reason/i);
    });
  });

  it('refuses to exit a shareholder who still holds shares', async () => {
    await asAdminDb(async (db) => {
      await shareClass(db);
      const id = await shareholder(db, 'Holding Owner', '0772500008');
      await db.query(`update public.shareholders set total_shares = 10 where id = $1`, [id]);
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.set_shareholder_status($1, 'exited', 'Leaving')`, [id]))
        .toMatch(/shares to zero before/i);
    });
  });

  it('refuses to exit a shareholder with an unpaid commitment', async () => {
    await asAdminDb(async (db) => {
      const id = await shareholder(db, 'Owing Owner', '0772500009');
      await db.query(
        `update public.shareholders set committed_ugx = 100000, outstanding_ugx = 100000 where id = $1`,
        [id]);
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.set_shareholder_status($1, 'exited', 'Leaving')`, [id]))
        .toMatch(/unpaid share commitment/i);
    });
  });
});

describe('shareholders: linking a sign-in', () => {
  it('links and unlinks the person who IS the shareholder', async () => {
    await asAdminDb(async (db) => {
      const id = await shareholder(db, 'Linked Owner', '0772500010');
      const uid = await makeUser(db, { role: 'shareholder' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_shareholder_account($1, $2)`, [id, uid]);
      await becomeOwner(db);
      expect((await shareholderRow(db, id)).linked_uid).toBe(uid);

      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_shareholder_account($1, null, 'They sold out')`, [id]);
      await becomeOwner(db);
      expect((await shareholderRow(db, id)).linked_uid).toBeNull();
    });
  });

  it('refuses to link one sign-in to two shareholders', async () => {
    await asAdminDb(async (db) => {
      const a = await shareholder(db, 'Owner A', '0772500011');
      const b = await shareholder(db, 'Owner B', '0772500012');
      const uid = await makeUser(db, { role: 'shareholder' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_shareholder_account($1, $2)`, [a, uid]);
      expect(await db.expectError(`select app.link_shareholder_account($1, $2)`, [b, uid]))
        .toMatch(/already linked to another shareholder/i);
    });
  });

  it('refuses a second link at the DATABASE, not only in the function', async () => {
    await asAdminDb(async (db) => {
      const a = await shareholder(db, 'Owner C', '0772500013');
      const b = await shareholder(db, 'Owner D', '0772500014');
      const uid = await makeUser(db, { role: 'shareholder' });
      await db.query(`update public.shareholders set linked_uid = $1 where id = $2`, [uid, a]);
      expect(await db.expectError(
        `update public.shareholders set linked_uid = $1 where id = $2`, [uid, b]))
        .toMatch(/shareholders_linked_uid_key|duplicate key/i);
    });
  });
});

describe('share classes', () => {
  /** No class and no share price exists that somebody did not create. */
  it('has no share price the system invented', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ code: string }>(
        `select code from public.share_classes where created_by is null`);
      expect(rows).toEqual([]);
    });
  });

  it('creates a class with its own value per share', async () => {
    await asAdminDb(async (db) => {
      const code = `CLASS${Math.floor(Math.random() * 900000) + 100000}`;
      await shareClass(db, code, 50_000);
      const { rows } = await db.query<Record<string, string>>(
        `select * from public.share_classes where id = $1`, [code.toLowerCase()]);
      expect(rows[0].code).toBe(code);
      expect(ugx(rows[0].value_per_share_ugx)).toBe(50_000);
      expect(rows[0].active).toBe(true);
      expect(ugx(rows[0].issued_shares)).toBe(0);
    });
  });

  it('refuses a badly formed code and a duplicate', async () => {
    await asAdminDb(async (db) => {
      const code = `CLASS${Math.floor(Math.random() * 900000) + 100000}`;
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.create_share_class('a', 'Bad', 1000)`))
        .toMatch(/capital letters, digits or underscores/i);
      await db.query(`select app.create_share_class($1, 'A class', 1000)`, [code]);
      expect(await db.expectError(`select app.create_share_class($1, 'Again', 1000)`,
        [code.toLowerCase()])).toMatch(/already exists/i);
    });
  });

  it('needs a reason to change the price or retire a class', async () => {
    await asAdminDb(async (db) => {
      const code = `CLASS${Math.floor(Math.random() * 900000) + 100000}`;
      const id = await shareClass(db, code, 100_000);
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.update_share_class($1, null, null, 200000)`, [id])).toMatch(/reason/i);
      expect(await db.expectError(
        `select app.update_share_class($1, null, null, null, false)`, [id])).toMatch(/reason/i);
      // A rename needs none.
      await db.query(`select app.update_share_class($1, 'Renamed class')`, [id]);
    });
  });

  it('will not let a manager configure a class', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      expect(await db.denied(`select app.create_share_class('PREFERENCE', 'Preference', 1000)`))
        .toBe(true);
    });
  });
});

describe('the share and dividend policies', () => {
  it('defaults to second-person approval and shares paid in full', async () => {
    await asAdminDb(async (db) => {
      // The DEFAULTS, read with nothing stored. The committing suites leave a
      // saved policy behind, so this asks what the defaults are.
      await db.query(`delete from public.settings where key in ('share_policy', 'dividend_policy')`);
      const { rows } = await db.query<{ share: Record<string, boolean>; dividend: Record<string, boolean> }>(
        `select app.share_policy() as share, app.dividend_policy() as dividend`);
      expect(rows[0].share).toEqual({
        requireApproval: true, allowUnpaidShares: false, allowPartialPayment: false,
      });
      expect(rows[0].dividend).toEqual({ requireAdminApproval: true });
    });
  });

  it('changes with a reason, and refuses an unknown setting', async () => {
    await asAdminDb(async (db) => {
      await db.query(`delete from public.settings where key = 'share_policy'`);
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.update_shareholding_policy('share', '{"requireApproval":false}'::jsonb, null)`))
        .toMatch(/reason/i);
      expect(await db.expectError(
        `select app.update_shareholding_policy('share', '{"somethingElse":true}'::jsonb, 'Why')`))
        .toMatch(/not recognised/i);
      await db.query(
        `select app.update_shareholding_policy('share', '{"requireApproval":false}'::jsonb, 'Small business')`);
      await becomeOwner(db);
      const { rows } = await db.query<{ p: Record<string, boolean> }>(
        `select app.share_policy() as p`);
      expect(rows[0].p.requireApproval).toBe(false);
    });
  });

  it('is an Administrator’s setting', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      expect(await db.denied(
        `select app.update_shareholding_policy('share', '{"requireApproval":false}'::jsonb, 'Why')`))
        .toBe(true);
    });
  });
});
