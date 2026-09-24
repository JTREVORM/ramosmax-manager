import { afterAll, describe, expect, it } from 'vitest';
import {
  asAdminDb,
  asClient,
  becomeClient,
  becomeOwner,
  closePool,
  makeUser,
  SEED,
} from './harness';
import { effectivePermissions, ROLES, type AccessProfile, type Role } from '@/lib/permissions';

afterAll(closePool);

/**
 * Phase C security. Two things are proved here:
 *
 *   1. the generated matrix: for every role, read access to every Phase C
 *      table and view matches what the permission catalogue says it should be;
 *   2. worker isolation, and in particular the customer-phone boundary, which
 *      is the single most important privacy rule in this phase.
 */

const PHASE_C_TABLES: { name: string; anyOf: string[] }[] = [
  { name: 'customers', anyOf: ['customers.view'] },
  { name: 'vehicles', anyOf: ['vehicles.view'] },
  { name: 'services', anyOf: ['services.view'] },
  { name: 'vehicle_directory', anyOf: ['vehicles.view'] },
];

const profile = (role: Role): AccessProfile => ({
  role,
  active: true,
  mustChangePassword: false,
  permissions: [],
  deniedPermissions: [],
  temporaryGrants: [],
});

// ---------------------------------------------------------------------------
// Generated read matrix
// ---------------------------------------------------------------------------

describe('read access matrix, generated from the permission catalogue', () => {
  for (const role of ROLES) {
    const granted = effectivePermissions(profile(role));

    for (const table of PHASE_C_TABLES) {
      const shouldRead = table.anyOf.some((p) => granted.has(p as never));

      it(`${role} ${shouldRead ? 'CAN' : 'cannot'} read ${table.name}`, async () => {
        await asClient(SEED[role], async (session) => {
          const { rows } = await session.query(
            `select count(*)::int as n from public.${table.name}`,
          );
          if (shouldRead) {
            expect(Number(rows[0].n)).toBeGreaterThan(0);
          } else {
            expect(Number(rows[0].n)).toBe(0);
          }
        });
      });
    }
  }
});

describe('shareholders reach nothing operational', () => {
  it('sees no customer, vehicle, service, job or order', async () => {
    await asClient(SEED.shareholder, async (session) => {
      for (const table of [
        'customers',
        'vehicles',
        'services',
        'service_intakes',
        'worker_orders',
      ]) {
        const { rows } = await session.query(`select count(*)::int as n from public.${table}`);
        expect(Number(rows[0].n), table).toBe(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// THE CUSTOMER-PHONE BOUNDARY
// ---------------------------------------------------------------------------

describe('a worker can never reach a customer phone number', () => {
  it('holds vehicles.view and services.view but NOT customers.view', async () => {
    await asClient(SEED.worker, async (session) => {
      const { rows } = await session.query(`
        select app.has_permission('vehicles.view')  as vehicles,
               app.has_permission('services.view')  as services,
               app.has_permission('customers.view') as customers`);
      expect(rows[0].vehicles).toBe(true);
      expect(rows[0].services).toBe(true);
      expect(rows[0].customers).toBe(false);
    });
  });

  it('reads no row of public.customers at all', async () => {
    await asClient(SEED.worker, async (session) => {
      const { rows } = await session.query(`select count(*)::int as n from public.customers`);
      expect(Number(rows[0].n)).toBe(0);
    });
  });

  it('cannot reach a phone number by joining from a vehicle', async () => {
    await asClient(SEED.worker, async (session) => {
      const { rows } = await session.query(`
        select count(c.phone_number)::int as leaked
          from public.vehicles v
          left join public.customers c on c.id = v.customer_id`);
      expect(Number(rows[0].leaked)).toBe(0);
    });
  });

  it('cannot reach a phone number by naming a customer id directly', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `select id from public.customers where phone_number is not null limit 1`,
      );
      await becomeClient(db, SEED.worker);
      const { rows: found } = await db.query(
        `select phone_number from public.customers where id = $1`,
        [rows[0].id],
      );
      expect(found).toEqual([]);
    });
  });

  // The structural guarantee: there is nothing to leak.
  it('public.vehicles HAS NO PHONE COLUMN', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'vehicles'`);
      const columns = rows.map((r) => String(r.column_name));
      expect(columns.filter((c) => /phone|contact|email/i.test(c))).toEqual([]);
      // What it DOES carry for the job card:
      expect(columns).toContain('customer_name');
      expect(columns).toContain('customer_number');
    });
  });

  it('the vehicle directory exposes no contact column', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'vehicle_directory'`);
      const columns = rows.map((r) => String(r.column_name));
      expect(columns.filter((c) => /phone|email|address/i.test(c))).toEqual([]);
    });
  });

  it('a worker CAN still search by plate and see the vehicle', async () => {
    await asClient(SEED.worker, async (session) => {
      const { rows } = await session.query(
        `select number_plate, customer_name from app.search_vehicles('uba-100a')`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].number_plate).toBe('UBA 100A');
      // The owner's NAME is legitimately visible on a job card.
      expect(rows[0].customer_name).toBe('Test Customer One');
    });
  });

  it('plate search through the RPC leaks nothing extra to a worker', async () => {
    await asClient(SEED.worker, async (session) => {
      const { rows } = await session.query(`select * from app.search_vehicles('uba')`);
      for (const row of rows) {
        expect(Object.keys(row).filter((k) => /phone|email|address/i.test(k))).toEqual([]);
      }
    });
  });

  it('a cashier, who holds customers.view, DOES see phone numbers', async () => {
    await asClient(SEED.cashier, async (session) => {
      const { rows } = await session.query(
        `select count(phone_number)::int as n from public.customers`,
      );
      expect(Number(rows[0].n)).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Worker order isolation
// ---------------------------------------------------------------------------

describe('a worker sees only the orders assigned to them', () => {
  async function twoAssignedJobs(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) {
    const { rows: services } = await db.query(`select id from public.services limit 1`);
    const { rows: vehicles } = await db.query(
      `select id from public.vehicles order by normalized_plate limit 2`,
    );

    const otherWorker = await makeUser(db, { role: 'worker' });

    await becomeClient(db, SEED.admin);
    const jobs: string[] = [];
    for (const vehicle of vehicles) {
      const { rows } = await db.query(
        `select app.create_service_intake($1, array[$2::uuid]) as id`,
        [vehicle.id, services[0].id],
      );
      jobs.push(rows[0].id as string);
    }

    const assignTo = [SEED.worker, otherWorker];
    for (let i = 0; i < jobs.length; i += 1) {
      const { rows: orders } = await db.query(
        `select id from public.worker_orders where service_intake_id = $1`,
        [jobs[i]],
      );
      await db.query(`select app.assign_worker_order($1, $2)`, [orders[0].id, assignTo[i]]);
    }
    await becomeOwner(db);
    return { jobs, otherWorker };
  }

  it("reads its own order and not another worker's", async () => {
    await asAdminDb(async (db) => {
      await twoAssignedJobs(db);
      await becomeClient(db, SEED.worker);
      const { rows } = await db.query(`select worker_id from public.worker_orders`);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.worker_id === SEED.worker)).toBe(true);
    });
  });

  it("cannot read another worker's order by naming its id", async () => {
    await asAdminDb(async (db) => {
      const { otherWorker } = await twoAssignedJobs(db);
      const { rows: theirs } = await db.query(
        `select id from public.worker_orders where worker_id = $1`,
        [otherWorker],
      );

      await becomeClient(db, SEED.worker);
      const { rows } = await db.query(
        `select count(*)::int as n from public.worker_orders where id = $1`,
        [theirs[0].id],
      );
      expect(Number(rows[0].n)).toBe(0);
    });
  });

  it("cannot act on another worker's order", async () => {
    await asAdminDb(async (db) => {
      const { otherWorker } = await twoAssignedJobs(db);
      const { rows: theirs } = await db.query(
        `select id from public.worker_orders where worker_id = $1`,
        [otherWorker],
      );

      await becomeClient(db, SEED.worker);
      const error = await db.expectError(`select app.update_worker_order_status($1, 'accept')`, [
        theirs[0].id,
      ]);
      expect(error).toMatch(/could not be found|not assigned to you/);
    });
  });

  it('sees only its own rows through my_worker_orders', async () => {
    await asAdminDb(async (db) => {
      await twoAssignedJobs(db);
      await becomeClient(db, SEED.worker);
      const { rows } = await db.query(`select count(*)::int as n from public.my_worker_orders`);
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it('my_worker_orders carries no customer identifier at all', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'my_worker_orders'`);
      const columns = rows.map((r) => String(r.column_name));
      expect(columns.filter((c) => /customer|phone|email/i.test(c))).toEqual([]);
    });
  });

  it('reads the header of a job it is working on, but no other job', async () => {
    await asAdminDb(async (db) => {
      const { jobs } = await twoAssignedJobs(db);
      await becomeClient(db, SEED.worker);
      const { rows } = await db.query(`select id from public.service_intakes`);
      expect(rows.map((r) => r.id)).toEqual([jobs[0]]);
    });
  });
});

// ---------------------------------------------------------------------------
// Direct write attempts
// ---------------------------------------------------------------------------

describe('no client can write any operational table directly', () => {
  const attacks: [string, string][] = [
    [
      'insert a customer',
      `insert into public.customers (customer_number, full_name)
                           values ('RMX-CUS-000999', 'Intruder')`,
    ],
    ['edit a customer', `update public.customers set full_name = 'Renamed'`],
    [
      'insert a vehicle',
      `insert into public.vehicles (number_plate, normalized_plate, model, colour)
                          values ('UZZ 999Z', 'UZZ999Z', 'Ghost', 'Grey')`,
    ],
    ['change a plate', `update public.vehicles set number_plate = 'UZZ 999Z'`],
    ['change a price', `update public.services set price_ugx = 1`],
    [
      'insert a service',
      `insert into public.services (name, category, price_ugx)
                          values ('Free Wash', 'washing', 0)`,
    ],
    [
      'create a job',
      `insert into public.service_intakes
                        (job_number, vehicle_id, number_plate, normalized_plate,
                         selected_services, service_ids, service_count)
                      values ('RMX-JOB-000999', gen_random_uuid(), 'X', 'X',
                              '[]'::jsonb, '{}', 1)`,
    ],
    ['complete an order', `update public.worker_orders set status = 'completed'`],
    ['assign an order', `update public.worker_orders set worker_id = auth.uid()`],
  ];

  for (const role of ['admin', 'manager', 'cashier', 'worker', 'auditor'] as const) {
    it(`${role} is refused every direct write`, async () => {
      await asClient(SEED[role], async (session) => {
        for (const [label, sql] of attacks) {
          expect(await session.denied(sql), `${role}: ${label}`).toBe(true);
        }
      });
    });
  }

  it('anonymous callers are refused every read and write', async () => {
    await asClient(null, async (session) => {
      for (const table of [
        'customers',
        'vehicles',
        'services',
        'service_intakes',
        'worker_orders',
      ]) {
        expect(await session.denied(`select * from public.${table}`), table).toBe(true);
      }
      expect(await session.denied(`select * from public.vehicle_directory`)).toBe(true);
      expect(
        await session.denied(
          `insert into public.services (name, category, price_ugx) values ('x','washing',0)`,
        ),
      ).toBe(true);
    });
  });
});

describe('inactive and locked-out accounts reach nothing', () => {
  for (const state of [
    { name: 'inactive', fields: { active: false } },
    { name: 'must_change_password', fields: { mustChangePassword: true } },
    { name: 'expired', fields: { accessExpiresAt: new Date(Date.now() - 60_000).toISOString() } },
  ]) {
    it(`an ${state.name} manager reads no operational data`, async () => {
      await asAdminDb(async (db) => {
        const uid = await makeUser(db, { role: 'manager', ...(state.fields as object) } as never);
        await becomeClient(db, uid);
        for (const table of ['customers', 'vehicles', 'services']) {
          const { rows } = await db.query(`select count(*)::int as n from public.${table}`);
          expect(Number(rows[0].n), table).toBe(0);
        }
      });
    });
  }
});
