import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool, makeUser } from './harness';
import { becomeClient, becomeOwner, completedJob, SEED } from './billing-helpers';

afterAll(closePool);

/**
 * THE FOUR CALLABLES THE PARITY REVIEW FOUND MISSING.
 *
 * Each is checked against the rule the reference enforces, not merely that it
 * runs: who may call it, what it refuses, and what it leaves alone.
 */
describe('update_user_profile', () => {
  it('edits the parts of a profile that are not access', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      await db.query(
        `select app.update_user_profile($1, 'Renamed Person', 'person@example.com',
           'Bay attendant', 'Operations', 'Interior detailing')`, [target]);
      await becomeOwner(db);

      const { rows } = await db.query<{
        full_name: string; email: string; position: string; department: string;
        specialization: string;
      }>(`select full_name, email, position, department, specialization
            from public.users where id = $1`, [target]);
      expect(rows[0].full_name).toBe('Renamed Person');
      expect(rows[0].email).toBe('person@example.com');
      expect(rows[0].position).toBe('Bay attendant');
      expect(rows[0].specialization).toBe('Interior detailing');
    });
  });

  it('refuses to change the sign-in phone number', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.update_user_profile($1, null, null, null, null, null, '0772909090')`,
        [target])).toMatch(/use "change phone number"/i);
      await becomeOwner(db);
    });
  });

  it('refuses a specialisation on somebody who is not a worker', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'cashier' });
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.update_user_profile($1, null, null, null, null, 'Detailing')`, [target]))
        .toMatch(/only a worker has a specialisation/i);
      await becomeOwner(db);
    });
  });

  it('refuses when nothing has changed', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      const { rows } = await db.query<{ full_name: string }>(
        `select full_name from public.users where id = $1`, [target]);
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.update_user_profile($1, $2)`,
        [target, rows[0].full_name])).toMatch(/nothing has changed/i);
      await becomeOwner(db);
    });
  });

  it('lets somebody edit their own profile, and nobody edit upwards', async () => {
    await asAdminDb(async (db) => {
      const manager = await makeUser(db, { role: 'manager', permissions: ['users.edit'] });
      const administrator = await makeUser(db, { role: 'admin' });

      await becomeClient(db, manager);
      expect(await db.expectError(`select app.update_user_profile($1, 'My New Name')`,
        [manager])).toBeNull();
      expect(await db.expectError(`select app.update_user_profile($1, 'Their New Name')`,
        [administrator])).toMatch(/only an administrator can manage/i);
      await becomeOwner(db);
    });
  });

  it('refuses somebody without users.edit', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.cashier);
      expect(await db.expectError(`select app.update_user_profile($1, 'Nope')`, [target]))
        .toMatch(/do not have permission/i);
      await becomeOwner(db);
    });
  });
});

describe('change_user_phone', () => {
  it('changes the sign-in number and ends every existing session', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.change_user_phone($1, '0772909091', 'Lost the handset')`,
        [target]);
      await becomeOwner(db);

      const { rows } = await db.query<{ phone_number: string; sessions_valid_from: string }>(
        `select phone_number, sessions_valid_from from public.users where id = $1`, [target]);
      expect(rows[0].phone_number).toBe('+256772909091');
      expect(rows[0].sessions_valid_from).not.toBeNull();
    });
  });

  it('nobody changes their own', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.change_user_phone($1, '0772909092')`, [SEED.admin]))
        .toMatch(/another administrator/i);
      await becomeOwner(db);
    });
  });

  it('refuses a number another account already uses', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.change_user_phone($1, '0772000002')`, [target]))
        .toMatch(/already used by another account/i);
      await becomeOwner(db);
    });
  });

  it('records MASKED numbers in the audit trail', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.change_user_phone($1, '0772909093', 'New handset')`, [target]);
      await becomeOwner(db);

      const { rows } = await db.query<{ previous_value: unknown; new_value: unknown }>(
        `select previous_value, new_value from public.audit_logs
          where action = 'user.phone_changed' and target_user_id = $1`, [target]);
      const text = JSON.stringify(rows[0]);
      // Masked: the middle is gone, so the trail records THAT it changed
      // without handing anybody a working phone number.
      expect(text).not.toContain('772909093');
      expect(text).toContain('...');
    });
  });
});

describe('link_staff', () => {
  it('links and unlinks a staff reference', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_staff($1, 'RMX-STF-0099')`, [target]);
      await becomeOwner(db);
      const { rows: linked } = await db.query<{ staff_id: string }>(
        `select staff_id from public.users where id = $1`, [target]);
      expect(linked[0].staff_id).toBe('RMX-STF-0099');

      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_staff($1, null)`, [target]);
      await becomeOwner(db);
      const { rows: cleared } = await db.query<{ staff_id: string | null }>(
        `select staff_id from public.users where id = $1`, [target]);
      expect(cleared[0].staff_id).toBeNull();
    });
  });

  it('refuses a reference another person already holds', async () => {
    await asAdminDb(async (db) => {
      const first = await makeUser(db, { role: 'worker' });
      const second = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_staff($1, 'RMX-STF-0100')`, [first]);
      expect(await db.expectError(`select app.link_staff($1, 'RMX-STF-0100')`, [second]))
        .toMatch(/already linked to another user/i);
      await becomeOwner(db);
    });
  });

  it('refuses a reference that is not shaped like one', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.link_staff($1, 'not a staff id!')`, [target]))
        .toMatch(/capital letters, digits and dashes/i);
      await becomeOwner(db);
    });
  });

  it('does not carry a profile photo to a different reference', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await db.query(
        `update public.users set staff_id = 'RMX-STF-0101',
           profile_photo_path = 'staff/RMX-STF-0101/profile/a.jpg' where id = $1`, [target]);
      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_staff($1, 'RMX-STF-0102')`, [target]);
      await becomeOwner(db);
      const { rows } = await db.query<{ profile_photo_path: string | null }>(
        `select profile_photo_path from public.users where id = $1`, [target]);
      expect(rows[0].profile_photo_path).toBeNull();
    });
  });
});

describe('update_service_intake', () => {
  it('adds a service to a job nobody has started', async () => {
    await asAdminDb(async (db) => {
      const { rows: vehicle } = await db.query<{ id: string }>(
        `insert into public.vehicles (number_plate, normalized_plate, model, colour, customer_id)
         values ('UPG 101A', app.plate_key('UPG 101A'), 'Model', 'Colour',
                 (select id from public.customers order by customer_number limit 1))
         returning id`);
      await becomeClient(db, SEED.cashier);
      const { rows: services } = await db.query<{ id: string; name: string }>(
        `select id, name from public.services where name in ('Body Wash', 'Tyre Polish')
          order by name`);
      const { rows: intake } = await db.query<{ id: string }>(
        `select app.create_service_intake($1, array[$2::uuid]) as id`,
        [vehicle[0].id, services[0].id]);

      await db.query(`select app.update_service_intake($1, $2::uuid[])`,
        [intake[0].id, services.map((s) => s.id)]);
      await becomeOwner(db);

      const { rows: orders } = await db.query<{ service_name: string; status: string }>(
        `select service_name, status from public.worker_orders
          where service_intake_id = $1 order by order_number`, [intake[0].id]);
      expect(orders).toHaveLength(2);
      expect(orders.every((o) => o.status === 'pending')).toBe(true);

      const { rows: refreshed } = await db.query<{ service_count: number }>(
        `select service_count from public.service_intakes where id = $1`, [intake[0].id]);
      expect(Number(refreshed[0].service_count)).toBe(2);
    });
  });

  it('removes a service nobody has started', async () => {
    await asAdminDb(async (db) => {
      const { rows: vehicle } = await db.query<{ id: string }>(
        `insert into public.vehicles (number_plate, normalized_plate, model, colour, customer_id)
         values ('UPG 102A', app.plate_key('UPG 102A'), 'Model', 'Colour',
                 (select id from public.customers order by customer_number limit 1))
         returning id`);
      await becomeClient(db, SEED.cashier);
      const { rows: services } = await db.query<{ id: string }>(
        `select id from public.services where name in ('Body Wash', 'Tyre Polish') order by name`);
      const { rows: intake } = await db.query<{ id: string }>(
        `select app.create_service_intake($1, $2::uuid[]) as id`,
        [vehicle[0].id, services.map((s) => s.id)]);

      await db.query(`select app.update_service_intake($1, array[$2::uuid])`,
        [intake[0].id, services[0].id]);
      await becomeOwner(db);

      const { rows: live } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.worker_orders
          where service_intake_id = $1 and status <> 'cancelled'`, [intake[0].id]);
      expect(Number(live[0].n)).toBe(1);
      // Nothing is deleted: the removed order is cancelled with a reason.
      const { rows: cancelled } = await db.query<{ cancel_reason: string }>(
        `select cancel_reason from public.worker_orders
          where service_intake_id = $1 and status = 'cancelled'`, [intake[0].id]);
      expect(cancelled[0].cancel_reason).toMatch(/removed from the job/i);
    });
  });

  it('refuses to remove work that has started', async () => {
    await asAdminDb(async (db) => {
      const job = await completedJob(db, 'UPG 103A');
      const { rows: services } = await db.query<{ id: string }>(
        `select id from public.services where name = 'Tyre Polish'`);
      await becomeClient(db, SEED.cashier);
      expect(await db.expectError(`select app.update_service_intake($1, array[$2::uuid])`,
        [job.intake, services[0].id])).toMatch(/already being worked on/i);
      await becomeOwner(db);
    });
  });

  it('refuses to touch a job that has been invoiced', async () => {
    await asAdminDb(async (db) => {
      const job = await completedJob(db, 'UPG 104A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select app.create_invoice($1) as id`, [job.intake]);
      const { rows: services } = await db.query<{ id: string }>(
        `select id from public.services where name = 'Tyre Polish'`);
      expect(await db.expectError(`select app.update_service_intake($1, array[$2::uuid])`,
        [job.intake, services[0].id])).toMatch(/has been invoiced/i);
      await becomeOwner(db);
    });
  });

  it('refuses somebody who may not create jobs', async () => {
    await asAdminDb(async (db) => {
      const job = await completedJob(db, 'UPG 105A');
      await becomeClient(db, SEED.worker);
      expect(await db.expectError(`select app.update_service_intake($1, null, true)`,
        [job.intake])).toMatch(/do not have permission/i);
      await becomeOwner(db);
    });
  });
});
