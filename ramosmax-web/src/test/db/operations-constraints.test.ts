import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool } from './harness';

afterAll(closePool);

/**
 * Invariants enforced by PostgreSQL itself, not only by the functions above
 * it. These hold even against a bug in an RPC, and they are race-safe where
 * the reference implementation needed a transactional read to be.
 */

describe('unique normalised plate', () => {
  it('refuses a second vehicle with the same plate key', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(`
        insert into public.vehicles (number_plate, normalized_plate, model, colour)
        values ('UBA 100A', 'UBA100A', 'Duplicate', 'Red')`);
      expect(error).toMatch(/vehicles_plate_unique|duplicate key/);
    });
  });

  it('treats differently typed forms of one plate as the SAME vehicle', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select app.plate_key('UBA 100A') as a, app.plate_key('uba-100a') as b,
               app.plate_key('UBA100A')  as c`);
      expect(rows[0].a).toBe('UBA100A');
      expect(rows[0].b).toBe('UBA100A');
      expect(rows[0].c).toBe('UBA100A');
    });
  });

  it('rejects a plate key containing anything but letters and digits', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(`
        insert into public.vehicles (number_plate, normalized_plate, model, colour)
        values ('UBA 999A', 'UBA 999A', 'Bad Key', 'Red')`);
      expect(error).toMatch(/vehicles_plate_key_shape/);
    });
  });
});

describe('unique customer phone', () => {
  it('refuses a second customer with the same primary phone', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(`
        insert into public.customers (customer_number, full_name, phone_number)
        values ('RMX-CUS-999999', 'Duplicate Phone', '+256772100001')`);
      expect(error).toMatch(/customers_phone_unique|duplicate key/);
    });
  });

  it('ALLOWS several customers with no phone at all', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(`
        insert into public.customers (customer_number, full_name) values
          ('RMX-CUS-999001', 'Walk In One'),
          ('RMX-CUS-999002', 'Walk In Two')`);
      expect(error).toBeNull();
    });
  });

  it('refuses a phone that is not E.164', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(`
        insert into public.customers (customer_number, full_name, phone_number)
        values ('RMX-CUS-999003', 'Bad Phone', '0772100003')`);
      expect(error).toMatch(/customers_phone_e164/);
    });
  });
});

describe('unique service name', () => {
  it('refuses a duplicate name regardless of case', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(`
        insert into public.services (name, category, price_ugx)
        values ('body wash', 'washing', 15000)`);
      expect(error).toMatch(/services_name_unique|duplicate key/);
    });
  });

  it('refuses a price outside the permitted range', async () => {
    await asAdminDb(async (db) => {
      expect(
        await db.expectError(`
        insert into public.services (name, category, price_ugx)
        values ('Negative', 'washing', -1)`),
      ).toMatch(/services_price/);
      expect(
        await db.expectError(`
        insert into public.services (name, category, price_ugx)
        values ('Enormous', 'washing', 100000001)`),
      ).toMatch(/services_price/);
    });
  });

  it('refuses an unknown category', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(`
        insert into public.services (name, category, price_ugx)
        values ('Odd', 'teleportation', 1000)`);
      expect(error).toMatch(/services_category/);
    });
  });
});

describe('one open job per vehicle', () => {
  it('refuses a second OPEN intake for the same vehicle', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `select id from public.vehicles where normalized_plate = 'UBA100A'`,
      );
      const vehicle = rows[0].id;
      const { rows: service } = await db.query(`select id from public.services limit 1`);

      const insert = `
        insert into public.service_intakes
          (job_number, vehicle_id, number_plate, normalized_plate, status,
           selected_services, service_ids, service_count)
        values ($1, $2, 'UBA 100A', 'UBA100A', 'open', '[]'::jsonb, array[$3::uuid], 1)`;

      expect(await db.expectError(insert, ['RMX-JOB-900001', vehicle, service[0].id])).toBeNull();
      const second = await db.expectError(insert, ['RMX-JOB-900002', vehicle, service[0].id]);
      expect(second).toMatch(/intakes_one_open_per_vehicle|duplicate key/);
    });
  });

  it('ALLOWS a new job once the previous one is completed', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `select id from public.vehicles where normalized_plate = 'UBB200B'`,
      );
      const vehicle = rows[0].id;
      const { rows: service } = await db.query(`select id from public.services limit 1`);
      const insert = `
        insert into public.service_intakes
          (job_number, vehicle_id, number_plate, normalized_plate, status,
           selected_services, service_ids, service_count)
        values ($1, $2, 'UBB 200B', 'UBB200B', $4, '[]'::jsonb, array[$3::uuid], 1)`;

      await db.query(insert, ['RMX-JOB-900010', vehicle, service[0].id, 'completed']);
      expect(
        await db.expectError(insert, ['RMX-JOB-900011', vehicle, service[0].id, 'open']),
      ).toBeNull();
    });
  });

  it('ALLOWS a new job once the previous one is cancelled', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `select id from public.vehicles where normalized_plate = 'UCD300C'`,
      );
      const vehicle = rows[0].id;
      const { rows: service } = await db.query(`select id from public.services limit 1`);
      const insert = `
        insert into public.service_intakes
          (job_number, vehicle_id, number_plate, normalized_plate, status,
           selected_services, service_ids, service_count)
        values ($1, $2, 'UCD 300C', 'UCD300C', $4, '[]'::jsonb, array[$3::uuid], 1)`;

      await db.query(insert, ['RMX-JOB-900020', vehicle, service[0].id, 'cancelled']);
      expect(
        await db.expectError(insert, ['RMX-JOB-900021', vehicle, service[0].id, 'open']),
      ).toBeNull();
    });
  });
});

describe('referential integrity', () => {
  it('refuses a vehicle pointing at a customer that does not exist', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(`
        insert into public.vehicles (number_plate, normalized_plate, model, colour, customer_id)
        values ('UBZ 777Z', 'UBZ777Z', 'Ghost', 'Grey', gen_random_uuid())`);
      expect(error).toMatch(/vehicles_customer_id_fkey|foreign key/);
    });
  });

  it('refuses a worker order pointing at a user that does not exist', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select o.id from public.worker_orders o limit 1`);
      if (!rows[0]) {
        // No orders yet in a fresh database; assert the constraint exists.
        const { rows: constraints } = await db.query(`
          select conname from pg_constraint
           where conrelid = 'public.worker_orders'::regclass and contype = 'f'`);
        expect(constraints.map((r) => r.conname)).toContain('worker_orders_worker_id_fkey');
        return;
      }
      const error = await db.expectError(
        `update public.worker_orders set worker_id = gen_random_uuid() where id = $1`,
        [rows[0].id],
      );
      expect(error).toMatch(/worker_id_fkey|foreign key/);
    });
  });

  it('refuses an order in a working state with no worker', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`select id from public.vehicles limit 1`);
      const { rows: service } = await db.query(`select id from public.services limit 1`);
      const { rows: intake } = await db.query(
        `
        insert into public.service_intakes
          (job_number, vehicle_id, number_plate, normalized_plate, status,
           selected_services, service_ids, service_count)
        values ('RMX-JOB-900030', $1, 'X', 'X', 'completed', '[]'::jsonb, array[$2::uuid], 1)
        returning id`,
        [rows[0].id, service[0].id],
      );

      const error = await db.expectError(
        `
        insert into public.worker_orders
          (order_number, service_intake_id, job_number, vehicle_id, number_plate,
           service_id, service_name, category, status, worker_id)
        values ('RMX-JOB-900030/1', $1, 'RMX-JOB-900030', $2, 'X', $3, 'S', 'washing',
                'in_progress', null)`,
        [intake[0].id, rows[0].id, service[0].id],
      );
      expect(error).toMatch(/orders_worker_required/);
    });
  });
});

describe('nothing is deleted', () => {
  const tables = ['customers', 'vehicles', 'services', 'service_intakes', 'worker_orders'];

  it('has a delete-blocking trigger on every operational table', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select c.relname as table_name
          from pg_trigger t
          join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and not t.tgisinternal
           and t.tgname like '%_no_delete'`);
      const guarded = rows.map((r) => r.table_name);
      for (const table of tables) expect(guarded).toContain(table);
    });
  });

  // The trigger is FOR EACH ROW, so a DELETE against an empty table would
  // trivially succeed. Each case below deletes a row that actually exists.
  it('refuses to delete a real customer, vehicle or service', async () => {
    await asAdminDb(async (db) => {
      for (const table of ['customers', 'vehicles', 'services']) {
        const error = await db.expectError(
          `delete from public.${table} where id = (select id from public.${table} limit 1)`,
        );
        expect(error, `delete from ${table}`).toMatch(/never deletes/);
      }
    });
  });

  it('refuses to delete a real job or worker order', async () => {
    await asAdminDb(async (db) => {
      const { rows: vehicle } = await db.query(
        `select id from public.vehicles where normalized_plate = 'UG1234'`,
      );
      const { rows: service } = await db.query(`select id, name, category, price_ugx
                                                  from public.services limit 1`);
      const { rows: intake } = await db.query(
        `
        insert into public.service_intakes
          (job_number, vehicle_id, number_plate, normalized_plate, status,
           selected_services, service_ids, service_count)
        values ('RMX-JOB-900040', $1, 'UG 1234', 'UG1234', 'open', '[]'::jsonb, array[$2::uuid], 1)
        returning id`,
        [vehicle[0].id, service[0].id],
      );

      await db.query(
        `
        insert into public.worker_orders
          (order_number, service_intake_id, job_number, vehicle_id, number_plate,
           service_id, service_name, category)
        values ('RMX-JOB-900040/1', $1, 'RMX-JOB-900040', $2, 'UG 1234', $3, $4, $5)`,
        [intake[0].id, vehicle[0].id, service[0].id, service[0].name, service[0].category],
      );

      expect(
        await db.expectError(`delete from public.worker_orders where service_intake_id = $1`, [
          intake[0].id,
        ]),
      ).toMatch(/never deletes/);
      expect(
        await db.expectError(`delete from public.service_intakes where id = $1`, [intake[0].id]),
      ).toMatch(/never deletes/);
    });
  });
});

describe('number plate parsing matches the reference implementation', () => {
  const cases: [string, string | null][] = [
    ['UGB 123A', 'UGB 123A'],
    ['UGB123A', 'UGB 123A'],
    ['ugb 123a', 'UGB 123A'],
    ['UGB-123A', 'UGB 123A'],
    ['UAA 123', 'UAA 123'],
    ['ug 1234', 'UG 1234'],
    ['UP 1234', 'UP 1234'],
    ['UPDF 1234', 'UPDF 1234'],
    ['cd 123 45', 'CD 123 45'],
    ['UN 123 45', 'UN 123 45'],
    ['', null],
    ['nonsense', null],
    ['123', null],
    ['ZZZ 999Z', null],
  ];

  it('parses every case the same way', async () => {
    await asAdminDb(async (db) => {
      const mismatches: string[] = [];
      for (const [input, expected] of cases) {
        const { rows } = await db.query(`select app.parse_plate($1) as plate`, [input]);
        if (rows[0].plate !== expected) {
          mismatches.push(`"${input}": got ${rows[0].plate}, expected ${expected}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  });
});
