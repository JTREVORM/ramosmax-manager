import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, makeUser, SEED } from './harness';
import { employ, requestId } from './workforce-helpers';

afterAll(closePool);

/**
 * EVIDENCE.
 *
 * A deposit slip, a reconciliation statement, an expense receipt, a supplier
 * invoice, a sick note, a photograph of a loss. The file itself lives in
 * Supabase Storage; the database holds its PATH, and holds the rules about
 * that path: the shape it must have, the permission needed to attach one, and
 * that it is never replaced and never removed.
 */

const UPLOAD = 'abcd1234efgh';

async function reportedLoss(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) {
  const staff = await employ(db);
  await becomeClient(db, SEED.manager);
  const { rows } = await db.query<{ incident_id: string }>(
    `select * from app.create_loss_incident('damaged_equipment', 120000,
       'A hose was cut', $1, $2, current_date)`,
    [requestId('evidence'), staff]);
  await becomeOwner(db);
  return rows[0].incident_id;
}

async function anExpense(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) {
  await becomeClient(db, SEED.manager);
  const { rows: categories } = await db.query<{ id: string }>(
    `select id from public.expense_categories limit 1`);
  const { rows } = await db.query<{ expense_id: string }>(
    `select * from app.create_expense($1, 'Bought a broom', 20000, current_date, $2)`,
    [categories[0].id, requestId('evidence')]);
  await becomeOwner(db);
  return rows[0].expense_id;
}

describe('evidence: the path', () => {
  it('accepts the shape the reference validates', async () => {
    await asAdminDb(async (db) => {
      const expense = await anExpense(db);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ attach_evidence: string }>(
        `select app.attach_evidence('expenses', $1, $2)`,
        [expense, `finance_uploads/expenses/${UPLOAD}/receipt.jpg`]);
      await becomeOwner(db);
      expect(rows[0].attach_evidence).toBe(`finance_uploads/expenses/${UPLOAD}/receipt.jpg`);

      const { rows: stored } = await db.query<{ attachment_path: string }>(
        `select attachment_path from public.expenses where id = $1`, [expense]);
      expect(stored[0].attachment_path).toContain('receipt.jpg');
    });
  });

  it('refuses a path in the wrong bucket, the wrong kind or with a directory in the file', async () => {
    await asAdminDb(async (db) => {
      const expense = await anExpense(db);
      await becomeClient(db, SEED.manager);
      for (const path of [
        `payroll_uploads/expenses/${UPLOAD}/receipt.jpg`,   // wrong bucket
        `finance_uploads/losses/${UPLOAD}/receipt.jpg`,     // wrong kind
        `finance_uploads/expenses/${UPLOAD}/a/receipt.jpg`, // a directory in the file
        `finance_uploads/expenses/short/receipt.jpg`,       // upload id too short
        `../finance_uploads/expenses/${UPLOAD}/receipt.jpg`,
        `finance_uploads/expenses/${UPLOAD}/../../secret.jpg`,
      ]) {
        expect(await db.expectError(`select app.attach_evidence('expenses', $1, $2)`,
          [expense, path]), path).toMatch(/could not be saved/i);
      }
      await becomeOwner(db);
    });
  });

  it('refuses a kind that is not a record type', async () => {
    await asAdminDb(async (db) => {
      const expense = await anExpense(db);
      await becomeClient(db, SEED.manager);
      expect(await db.expectError(`select app.attach_evidence('payroll', $1, $2)`,
        [expense, `payroll_uploads/payroll/${UPLOAD}/slip.pdf`]))
        .toMatch(/not something evidence can be attached to/i);
      await becomeOwner(db);
    });
  });
});

describe('evidence: never replaced, never removed', () => {
  it('refuses a second attachment on the same record', async () => {
    await asAdminDb(async (db) => {
      const expense = await anExpense(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.attach_evidence('expenses', $1, $2)`,
        [expense, `finance_uploads/expenses/${UPLOAD}/first.jpg`]);
      expect(await db.expectError(`select app.attach_evidence('expenses', $1, $2)`,
        [expense, `finance_uploads/expenses/${UPLOAD}/second.jpg`]))
        .toMatch(/never replaced/i);
      await becomeOwner(db);

      const { rows } = await db.query<{ attachment_path: string }>(
        `select attachment_path from public.expenses where id = $1`, [expense]);
      expect(rows[0].attachment_path).toContain('first.jpg');
    });
  });

  it('refuses an empty path rather than clearing one', async () => {
    await asAdminDb(async (db) => {
      const expense = await anExpense(db);
      await becomeClient(db, SEED.manager);
      expect(await db.expectError(`select app.attach_evidence('expenses', $1, null)`, [expense]))
        .toMatch(/no file to attach/i);
      await becomeOwner(db);
    });
  });

  it('cannot be taken off by a direct update, by anybody', async () => {
    await asAdminDb(async (db) => {
      const expense = await anExpense(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.attach_evidence('expenses', $1, $2)`,
        [expense, `finance_uploads/expenses/${UPLOAD}/kept.jpg`]);
      expect(await db.expectError(
        `update public.expenses set attachment_path = null where id = $1`, [expense]))
        .toBeTruthy();
      await becomeOwner(db);
    });
  });
});

describe('evidence: who may attach it', () => {
  it('needs the permission that records the thing', async () => {
    await asAdminDb(async (db) => {
      const expense = await anExpense(db);
      const outsider = await makeUser(db, { role: 'worker' });
      await becomeClient(db, outsider);
      expect(await db.expectError(`select app.attach_evidence('expenses', $1, $2)`,
        [expense, `finance_uploads/expenses/${UPLOAD}/receipt.jpg`]))
        .toMatch(/do not have permission/i);
      await becomeOwner(db);
    });
  });

  it('takes evidence about a loss into the payroll bucket, not the finance one', async () => {
    await asAdminDb(async (db) => {
      const incident = await reportedLoss(db);
      await becomeClient(db, SEED.manager);
      expect(await db.expectError(`select app.attach_evidence('losses', $1, $2)`,
        [incident, `finance_uploads/losses/${UPLOAD}/photo.jpg`]))
        .toMatch(/could not be saved/i);
      const { rows } = await db.query<{ attach_evidence: string }>(
        `select app.attach_evidence('losses', $1, $2)`,
        [incident, `payroll_uploads/losses/${UPLOAD}/photo.jpg`]);
      await becomeOwner(db);
      expect(rows[0].attach_evidence).toContain('payroll_uploads');
    });
  });

  it('refuses a record that does not exist', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      expect(await db.expectError(
        `select app.attach_evidence('expenses', gen_random_uuid(), $1)`,
        [`finance_uploads/expenses/${UPLOAD}/receipt.jpg`]))
        .toMatch(/could not be found/i);
      await becomeOwner(db);
    });
  });
});

describe('evidence: a profile photo', () => {
  it('belongs to the staff ID', async () => {
    await asAdminDb(async (db) => {
      const person = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_staff($1, 'RMX-STF-9001')`, [person]);
      const { rows } = await db.query<{ set_profile_photo: string }>(
        `select app.set_profile_photo($1, 'staff/RMX-STF-9001/profile/face.jpg')`, [person]);
      await becomeOwner(db);
      expect(rows[0].set_profile_photo).toBe('staff/RMX-STF-9001/profile/face.jpg');
    });
  });

  it('refuses a photo under somebody else’s staff folder', async () => {
    await asAdminDb(async (db) => {
      const person = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_staff($1, 'RMX-STF-9002')`, [person]);
      expect(await db.expectError(
        `select app.set_profile_photo($1, 'staff/RMX-STF-9003/profile/face.jpg')`, [person]))
        .toMatch(/could not be saved/i);
      await becomeOwner(db);
    });
  });

  it('refuses a photo on somebody with no staff record', async () => {
    await asAdminDb(async (db) => {
      const person = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.set_profile_photo($1, 'staff/RMX-STF-9004/profile/face.jpg')`, [person]))
        .toMatch(/link a staff record/i);
      await becomeOwner(db);
    });
  });

  it('is cleared when the staff ID changes, so it never follows anybody', async () => {
    await asAdminDb(async (db) => {
      const person = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_staff($1, 'RMX-STF-9005')`, [person]);
      await db.query(`select app.set_profile_photo($1, 'staff/RMX-STF-9005/profile/face.jpg')`,
        [person]);
      await db.query(`select app.link_staff($1, 'RMX-STF-9006')`, [person]);
      await becomeOwner(db);

      const { rows } = await db.query<{ profile_photo_path: string | null }>(
        `select profile_photo_path from public.users where id = $1`, [person]);
      expect(rows[0].profile_photo_path).toBeNull();
    });
  });

  it('is somebody’s own to set without any permission', async () => {
    await asAdminDb(async (db) => {
      const person = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_staff($1, 'RMX-STF-9007')`, [person]);
      await becomeClient(db, person);
      const { rows } = await db.query<{ set_profile_photo: string }>(
        `select app.set_profile_photo($1, 'staff/RMX-STF-9007/profile/me.jpg')`, [person]);
      await becomeOwner(db);
      expect(rows[0].set_profile_photo).toContain('me.jpg');
    });
  });

  it('refuses somebody else’s photo to a worker', async () => {
    await asAdminDb(async (db) => {
      const person = await makeUser(db, { role: 'worker' });
      const other = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_staff($1, 'RMX-STF-9008')`, [person]);
      await becomeClient(db, other);
      expect(await db.expectError(
        `select app.set_profile_photo($1, 'staff/RMX-STF-9008/profile/face.jpg')`, [person]))
        .toMatch(/do not have permission/i);
      await becomeOwner(db);
    });
  });
});
