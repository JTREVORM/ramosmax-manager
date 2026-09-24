import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, makeUser, SEED } from './harness';

afterAll(closePool);

/**
 * Business rules, executed against the real functions.
 * Ports the cases in functions/test/operations.test.js and jobs.test.js.
 */

type Db = Parameters<Parameters<typeof asAdminDb>[0]>[0];

async function serviceIds(db: Db, n = 1): Promise<string[]> {
  const { rows } = await db.query(
    `select id from public.services where is_active order by name limit $1`,
    [n],
  );
  return rows.map((r) => r.id as string);
}

async function freshVehicle(
  db: Db,
  plate: string,
  customer: string | null = null,
): Promise<string> {
  const { rows } = await db.query(
    `insert into public.vehicles (number_plate, normalized_plate, model, colour, customer_id)
     values ($1, app.plate_key($1), 'Model', 'Colour', $2) returning id`,
    [plate, customer],
  );
  return rows[0].id as string;
}

// ---------------------------------------------------------------------------
describe('customers', () => {
  it('allocates a reference number and audits creation', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query(
        `select app.create_customer('New Customer', '0772500001') as id`,
      );
      await becomeOwner(db);
      const { rows: customer } = await db.query(
        `select customer_number, phone_number, status from public.customers where id = $1`,
        [rows[0].id],
      );
      expect(String(customer[0].customer_number)).toMatch(/^RMX-CUS-\d{6}$/);
      expect(customer[0].phone_number).toBe('+256772500001');
      expect(customer[0].status).toBe('active');

      const { rows: audit } = await db.query<{ new_value: { phoneNumber: string } }>(
        `select new_value from public.audit_logs where action = 'customer.created'
          and record_id = $1`,
        [customer[0].customer_number],
      );
      expect(audit).toHaveLength(1);
      // The audit trail masks the phone number.
      expect(String(audit[0].new_value.phoneNumber)).toContain('...');
    });
  });

  it('normalises the phone number server-side', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query(
        `select app.create_customer('Normalised', '0772 500 002') as id`,
      );
      await becomeOwner(db);
      const { rows: customer } = await db.query(
        `select phone_number from public.customers where id = $1`,
        [rows[0].id],
      );
      expect(customer[0].phone_number).toBe('+256772500002');
    });
  });

  it('refuses a duplicate phone number and points at the existing customer', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      await db.query(`select app.create_customer('First', '0772500003')`);
      const error = await db.expectError(`select app.create_customer('Second', '0772500003')`);
      expect(error).toMatch(/A customer with this phone number already exists/);
    });
  });

  it('refuses a caller without customers.manage', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.worker);
      expect(await db.expectError(`select app.create_customer('Nope', '0772500004')`)).toMatch(
        /do not have permission/,
      );
      await becomeClient(db, SEED.auditor);
      expect(await db.expectError(`select app.create_customer('Nope', '0772500005')`)).toMatch(
        /do not have permission/,
      );
    });
  });

  it('deactivates rather than deletes, and requires a reason', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query(`select app.create_customer('To Deactivate') as id`);
      expect(
        await db.expectError(`select app.set_customer_status($1, false, '')`, [rows[0].id]),
      ).toMatch(/Enter a reason/);
      expect(
        await db.expectError(`select app.set_customer_status($1, false, 'Moved away')`, [
          rows[0].id,
        ]),
      ).toBeNull();

      await becomeOwner(db);
      const { rows: after } = await db.query(
        `select status, status_reason from public.customers where id = $1`,
        [rows[0].id],
      );
      expect(after[0].status).toBe('inactive');
      expect(after[0].status_reason).toBe('Moved away');
    });
  });

  it('keeps vehicle display copies in step when a customer is renamed', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query(
        `select app.create_customer('Original Name', '0772500006') as id`,
      );
      await db.query(
        `select app.create_vehicle('UBC 501A', 'Model', 'Blue', null, null, 'car', $1)`,
        [rows[0].id],
      );
      await db.query(`select app.update_customer($1, 'Renamed Person', '0772500006')`, [
        rows[0].id,
      ]);

      await becomeOwner(db);
      const { rows: vehicle } = await db.query(
        `select customer_name from public.vehicles where normalized_plate = 'UBC501A'`,
      );
      expect(vehicle[0].customer_name).toBe('Renamed Person');
    });
  });
});

// ---------------------------------------------------------------------------
describe('vehicles', () => {
  it('stores both plate forms and refuses a duplicate however it is typed', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      await db.query(`select app.create_vehicle('ubd-502a', 'Vitz', 'Red')`);
      await becomeOwner(db);
      const { rows } = await db.query(
        `select number_plate, normalized_plate from public.vehicles where normalized_plate = 'UBD502A'`,
      );
      expect(rows[0].number_plate).toBe('UBD 502A');

      await becomeClient(db, SEED.manager);
      const error = await db.expectError(`select app.create_vehicle('UBD 502A', 'Other', 'Blue')`);
      expect(error).toMatch(/UBD 502A is already registered/);
    });
  });

  it('refuses an invalid plate', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(`select app.create_vehicle('nonsense', 'Model', 'Red')`);
      expect(error).toMatch(/valid number plate/);
    });
  });

  it('refuses linking to an INACTIVE customer', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query(`select app.create_customer('Inactive Owner') as id`);
      await db.query(`select app.set_customer_status($1, false, 'Left the country')`, [rows[0].id]);
      const error = await db.expectError(
        `select app.create_vehicle('UBE 503A', 'Model', 'Red', null, null, 'car', $1)`,
        [rows[0].id],
      );
      expect(error).toMatch(/customer is inactive/);
    });
  });

  it('keeps the previous plate and requires a reason when a plate changes', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query(
        `select app.create_vehicle('UBF 504A', 'Model', 'Red') as id`,
      );
      expect(
        await db.expectError(`select app.change_vehicle_plate($1, 'UBG 505A', '')`, [rows[0].id]),
      ).toMatch(/Enter a reason/);
      await db.query(`select app.change_vehicle_plate($1, 'UBG 505A', 'Plate replaced by URA')`, [
        rows[0].id,
      ]);

      await becomeOwner(db);
      const { rows: after } = await db.query(
        `select number_plate, previous_plates from public.vehicles where id = $1`,
        [rows[0].id],
      );
      expect(after[0].number_plate).toBe('UBG 505A');
      expect(after[0].previous_plates).toEqual(['UBF 504A']);
    });
  });

  it('refuses a plate change that collides with another vehicle', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query(
        `select app.create_vehicle('UBH 506A', 'Model', 'Red') as id`,
      );
      const error = await db.expectError(
        `select app.change_vehicle_plate($1, 'UBA 100A', 'Typo')`,
        [rows[0].id],
      );
      expect(error).toMatch(/UBA 100A is already registered/);
    });
  });

  it('lets a cashier register a vehicle but not a worker', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.cashier);
      expect(
        await db.expectError(`select app.create_vehicle('UBJ 507A', 'Model', 'Red')`),
      ).toBeNull();
      await becomeClient(db, SEED.worker);
      expect(await db.expectError(`select app.create_vehicle('UBK 508A', 'Model', 'Red')`)).toMatch(
        /do not have permission/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
describe('services', () => {
  it('refuses a duplicate name regardless of case', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      const error = await db.expectError(
        `select app.create_service('BODY WASH', 'washing', 15000)`,
      );
      expect(error).toMatch(/already exists/);
    });
  });

  it('refuses a price outside the permitted range', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.create_service('Negative', 'washing', -1)`)).toMatch(
        /whole price between/,
      );
      expect(
        await db.expectError(`select app.create_service('Huge', 'washing', 100000001)`),
      ).toMatch(/whole price between/);
    });
  });

  it('audits a price change with the old and new price', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      const { rows } = await db.query(
        `select app.create_service('Priced Service', 'washing', 15000) as id`,
      );
      await db.query(
        `select app.update_service($1, 'Priced Service', 'washing', 18000, null, null, false, 'Annual review')`,
        [rows[0].id],
      );

      await becomeOwner(db);
      const { rows: audit } = await db.query<{
        previous_value: { priceUgx: number };
        new_value: { priceUgx: number };
        reason: string;
      }>(`select previous_value, new_value, reason from public.audit_logs
           where action = 'service.price_changed' and record_id = 'Priced Service'`);
      expect(audit).toHaveLength(1);
      expect(Number(audit[0].previous_value.priceUgx)).toBe(15000);
      expect(Number(audit[0].new_value.priceUgx)).toBe(18000);
      expect(audit[0].reason).toBe('Annual review');
    });
  });

  it('refuses a price change by anyone without services.manage', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`select id, name, category from public.services limit 1`);
      for (const role of ['cashier', 'worker', 'auditor'] as const) {
        await becomeClient(db, SEED[role]);
        const error = await db.expectError(`select app.update_service($1, $2, $3, 1)`, [
          rows[0].id,
          rows[0].name,
          rows[0].category,
        ]);
        expect(error, role).toMatch(/do not have permission/);
      }
    });
  });

  it('deactivates rather than deletes', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      const { rows } = await db.query(
        `select app.create_service('Retired Service', 'other', 5000) as id`,
      );
      await db.query(`select app.set_service_active($1, false)`, [rows[0].id]);
      await becomeOwner(db);
      const { rows: after } = await db.query(
        `select is_active from public.services where id = $1`,
        [rows[0].id],
      );
      expect(after[0].is_active).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
describe('service intake', () => {
  it('snapshots the price, so a later catalogue change cannot rewrite the visit', async () => {
    await asAdminDb(async (db) => {
      const [service] = await serviceIds(db);
      const { rows: before } = await db.query(
        `select price_ugx, name, category from public.services where id = $1`,
        [service],
      );
      const vehicle = await freshVehicle(db, 'UBL 601A');

      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query(
        `select app.create_service_intake($1, array[$2::uuid]) as id`,
        [vehicle, service],
      );

      // The catalogue price changes AFTER the visit started.
      await becomeClient(db, SEED.admin);
      await db.query(`select app.update_service($1, $2, $3, 99000)`, [
        service,
        before[0].name,
        before[0].category,
      ]);

      await becomeOwner(db);
      const { rows: intake } = await db.query<{ selected_services: { priceUgx: number }[] }>(
        `select selected_services from public.service_intakes where id = $1`,
        [rows[0].id],
      );
      expect(Number(intake[0].selected_services[0].priceUgx)).toBe(Number(before[0].price_ugx));
    });
  });

  it('takes the price from the CATALOGUE, never from the caller', async () => {
    await asAdminDb(async (db) => {
      const { rows: fn } = await db.query(`
        select pg_get_function_arguments(p.oid) as args
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app' and p.proname = 'create_service_intake'`);
      // There is simply no price parameter to abuse.
      expect(String(fn[0].args)).not.toMatch(/price/i);
    });
  });

  it('allocates a gap-free job number and one order per service', async () => {
    await asAdminDb(async (db) => {
      const services = await serviceIds(db, 3);
      const vehicle = await freshVehicle(db, 'UBM 602A');
      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query(`select app.create_service_intake($1, $2::uuid[]) as id`, [
        vehicle,
        services,
      ]);

      await becomeOwner(db);
      const { rows: intake } = await db.query(
        `select job_number, service_count, status from public.service_intakes where id = $1`,
        [rows[0].id],
      );
      expect(String(intake[0].job_number)).toMatch(/^RMX-JOB-\d{6}$/);
      expect(Number(intake[0].service_count)).toBe(3);
      expect(intake[0].status).toBe('open');

      const { rows: orders } = await db.query(
        `select order_number, status from public.worker_orders
          where service_intake_id = $1 order by order_number`,
        [rows[0].id],
      );
      expect(orders).toHaveLength(3);
      expect(orders.map((o) => o.order_number)).toEqual([
        `${intake[0].job_number}/1`,
        `${intake[0].job_number}/2`,
        `${intake[0].job_number}/3`,
      ]);
      expect(orders.every((o) => o.status === 'pending')).toBe(true);
    });
  });

  it('refuses a second open job for the same vehicle', async () => {
    await asAdminDb(async (db) => {
      const [service] = await serviceIds(db);
      const vehicle = await freshVehicle(db, 'UBN 603A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select app.create_service_intake($1, array[$2::uuid])`, [vehicle, service]);
      const error = await db.expectError(`select app.create_service_intake($1, array[$2::uuid])`, [
        vehicle,
        service,
      ]);
      expect(error).toMatch(/already has a service in progress/);
    });
  });

  it('refuses an INACTIVE vehicle', async () => {
    await asAdminDb(async (db) => {
      const [service] = await serviceIds(db);
      const vehicle = await freshVehicle(db, 'UBP 604A');
      await becomeClient(db, SEED.manager);
      await db.query(`select app.set_vehicle_status($1, false, 'Off the road')`, [vehicle]);
      const error = await db.expectError(`select app.create_service_intake($1, array[$2::uuid])`, [
        vehicle,
        service,
      ]);
      expect(error).toMatch(/is inactive. Reactivate it/);
    });
  });

  it('refuses an inactive or unknown service', async () => {
    await asAdminDb(async (db) => {
      const [service] = await serviceIds(db);
      const vehicle = await freshVehicle(db, 'UBQ 605A');
      await becomeClient(db, SEED.admin);
      await db.query(`select app.set_service_active($1, false)`, [service]);
      expect(
        await db.expectError(`select app.create_service_intake($1, array[$2::uuid])`, [
          vehicle,
          service,
        ]),
      ).toMatch(/unavailable/);
      expect(
        await db.expectError(`select app.create_service_intake($1, array[gen_random_uuid()])`, [
          vehicle,
        ]),
      ).toMatch(/unavailable/);
    });
  });

  it('collapses duplicate service ids', async () => {
    await asAdminDb(async (db) => {
      const [service] = await serviceIds(db);
      const vehicle = await freshVehicle(db, 'UBR 606A');
      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query(
        `select app.create_service_intake($1, array[$2::uuid, $2::uuid, $2::uuid]) as id`,
        [vehicle, service],
      );
      await becomeOwner(db);
      const { rows: intake } = await db.query(
        `select service_count from public.service_intakes where id = $1`,
        [rows[0].id],
      );
      expect(Number(intake[0].service_count)).toBe(1);
    });
  });

  it('refuses more than 20 services', async () => {
    await asAdminDb(async (db) => {
      const vehicle = await freshVehicle(db, 'UBS 607A');
      const { rows } = await db.query(
        `select array_agg(gen_random_uuid()) as ids from generate_series(1, 21)`,
      );
      await becomeClient(db, SEED.cashier);
      const error = await db.expectError(`select app.create_service_intake($1, $2::uuid[])`, [
        vehicle,
        rows[0].ids,
      ]);
      expect(error).toMatch(/between 1 and 20 services/);
    });
  });

  it('refuses a caller without jobs.create', async () => {
    await asAdminDb(async (db) => {
      const [service] = await serviceIds(db);
      const vehicle = await freshVehicle(db, 'UBT 608A');
      for (const role of ['worker', 'auditor'] as const) {
        await becomeClient(db, SEED[role]);
        expect(
          await db.expectError(`select app.create_service_intake($1, array[$2::uuid])`, [
            vehicle,
            service,
          ]),
          role,
        ).toMatch(/do not have permission/);
      }
    });
  });

  // The reference has no requestId for intake creation: the one-open-job-per-
  // vehicle rule is itself the replay guard, and it is enforced by a unique
  // index rather than by a re-read.
  it('is replay-safe: a repeated request cannot create a second job', async () => {
    await asAdminDb(async (db) => {
      const [service] = await serviceIds(db);
      const vehicle = await freshVehicle(db, 'UBU 609A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select app.create_service_intake($1, array[$2::uuid])`, [vehicle, service]);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(
          await db.expectError(`select app.create_service_intake($1, array[$2::uuid])`, [
            vehicle,
            service,
          ]),
        ).toMatch(/already has a service in progress/);
      }
      await becomeOwner(db);
      const { rows } = await db.query(
        `select count(*)::int as n from public.service_intakes where vehicle_id = $1`,
        [vehicle],
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
describe('worker orders', () => {
  async function openJob(db: Db, plate: string) {
    const [service] = await serviceIds(db);
    const vehicle = await freshVehicle(db, plate);
    await becomeClient(db, SEED.cashier);
    const { rows } = await db.query(`select app.create_service_intake($1, array[$2::uuid]) as id`, [
      vehicle,
      service,
    ]);
    await becomeOwner(db);
    const { rows: orders } = await db.query(
      `select id from public.worker_orders where service_intake_id = $1`,
      [rows[0].id],
    );
    return { intake: rows[0].id as string, order: orders[0].id as string };
  }

  it('assigns only to an active worker holding jobs.complete', async () => {
    await asAdminDb(async (db) => {
      const { order } = await openJob(db, 'UBV 701A');
      await becomeClient(db, SEED.manager);
      // A cashier does not hold jobs.complete.
      expect(
        await db.expectError(`select app.assign_worker_order($1, $2)`, [order, SEED.cashier]),
      ).toMatch(/active worker who can carry out jobs/);
      expect(
        await db.expectError(`select app.assign_worker_order($1, $2)`, [order, SEED.worker]),
      ).toBeNull();
    });
  });

  it('refuses assigning to a deactivated worker', async () => {
    await asAdminDb(async (db) => {
      const { order } = await openJob(db, 'UBW 702A');
      const inactive = await makeUser(db, { role: 'worker', active: false });
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(`select app.assign_worker_order($1, $2)`, [order, inactive]),
      ).toMatch(/active worker who can carry out jobs/);
    });
  });

  it('refuses a second assign, directing the caller to reassign', async () => {
    await asAdminDb(async (db) => {
      const { order } = await openJob(db, 'UBX 703A');
      await becomeClient(db, SEED.manager);
      await db.query(`select app.assign_worker_order($1, $2)`, [order, SEED.worker]);
      expect(
        await db.expectError(`select app.assign_worker_order($1, $2)`, [order, SEED.worker]),
      ).toMatch(/already assigned. Use Reassign/);
    });
  });

  it('reassigns with a reason, closing the previous history entry', async () => {
    await asAdminDb(async (db) => {
      const { order } = await openJob(db, 'UBY 704A');
      const other = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      await db.query(`select app.assign_worker_order($1, $2)`, [order, SEED.worker]);

      expect(
        await db.expectError(`select app.reassign_worker_order($1, $2, '')`, [order, other]),
      ).toMatch(/Enter a reason/);
      expect(
        await db.expectError(`select app.reassign_worker_order($1, $2, 'Shift ended')`, [
          order,
          SEED.worker,
        ]),
      ).toMatch(/Choose a different worker/);
      await db.query(`select app.reassign_worker_order($1, $2, 'Shift ended')`, [order, other]);

      await becomeOwner(db);
      const { rows } = await db.query(
        `select worker_id, assignment_history from public.worker_orders where id = $1`,
        [order],
      );
      expect(rows[0].worker_id).toBe(other);
      const history = rows[0].assignment_history as Record<string, unknown>[];
      expect(history).toHaveLength(2);
      expect(history[0].endedAt).not.toBeNull();
      expect(history[0].reason).toBe('Shift ended');
      expect(history[1].endedAt).toBeNull();
    });
  });

  it('resets progress timestamps on reassignment', async () => {
    await asAdminDb(async (db) => {
      const { order } = await openJob(db, 'UBZ 705A');
      const other = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      await db.query(`select app.assign_worker_order($1, $2)`, [order, SEED.worker]);
      await becomeClient(db, SEED.worker);
      await db.query(`select app.update_worker_order_status($1, 'accept')`, [order]);
      await db.query(`select app.update_worker_order_status($1, 'start')`, [order]);

      await becomeClient(db, SEED.manager);
      await db.query(`select app.reassign_worker_order($1, $2, 'Worker went home')`, [
        order,
        other,
      ]);

      await becomeOwner(db);
      const { rows } = await db.query(
        `select status, accepted_at, started_at from public.worker_orders where id = $1`,
        [order],
      );
      expect(rows[0].status).toBe('assigned');
      expect(rows[0].accepted_at).toBeNull();
      expect(rows[0].started_at).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
describe('status transitions', () => {
  async function assignedOrder(db: Db, plate: string) {
    const [service] = await serviceIds(db);
    const vehicle = await freshVehicle(db, plate);
    await becomeClient(db, SEED.cashier);
    const { rows } = await db.query(`select app.create_service_intake($1, array[$2::uuid]) as id`, [
      vehicle,
      service,
    ]);
    await becomeOwner(db);
    const { rows: orders } = await db.query(
      `select id from public.worker_orders where service_intake_id = $1`,
      [rows[0].id],
    );
    await becomeClient(db, SEED.manager);
    await db.query(`select app.assign_worker_order($1, $2)`, [orders[0].id, SEED.worker]);
    return { intake: rows[0].id as string, order: orders[0].id as string };
  }

  it('walks the permitted path assigned → accepted → in_progress → completed', async () => {
    await asAdminDb(async (db) => {
      const { order } = await assignedOrder(db, 'UCA 801A');
      await becomeClient(db, SEED.worker);
      for (const [action, expected] of [
        ['accept', 'accepted'],
        ['start', 'in_progress'],
        ['complete', 'completed'],
      ] as const) {
        const { rows } = await db.query(`select * from app.update_worker_order_status($1, $2)`, [
          order,
          action,
        ]);
        expect(rows[0].order_status).toBe(expected);
      }
    });
  });

  it('refuses every INVALID transition', async () => {
    await asAdminDb(async (db) => {
      const { order } = await assignedOrder(db, 'UCB 802A');
      await becomeClient(db, SEED.worker);
      // From `assigned`, only `accept` is legal.
      for (const action of ['start', 'pause', 'resume', 'complete']) {
        expect(
          await db.expectError(`select app.update_worker_order_status($1, $2)`, [order, action]),
          action,
        ).toMatch(/cannot be/);
      }
      await db.query(`select app.update_worker_order_status($1, 'accept')`, [order]);
      // From `accepted`, only `start`.
      for (const action of ['accept', 'pause', 'resume', 'complete']) {
        expect(
          await db.expectError(`select app.update_worker_order_status($1, $2)`, [order, action]),
          action,
        ).toMatch(/cannot be/);
      }
    });
  });

  it('refuses an unknown action', async () => {
    await asAdminDb(async (db) => {
      const { order } = await assignedOrder(db, 'UCC 803A');
      await becomeClient(db, SEED.worker);
      expect(
        await db.expectError(`select app.update_worker_order_status($1, 'teleport')`, [order]),
      ).toMatch(/Unknown action/);
    });
  });

  it('requires a reason to pause, and accumulates paused time on resume', async () => {
    await asAdminDb(async (db) => {
      const { order } = await assignedOrder(db, 'UCD 804A');
      await becomeClient(db, SEED.worker);
      await db.query(`select app.update_worker_order_status($1, 'accept')`, [order]);
      await db.query(`select app.update_worker_order_status($1, 'start')`, [order]);

      expect(
        await db.expectError(`select app.update_worker_order_status($1, 'pause')`, [order]),
      ).toMatch(/Enter a reason/);
      await db.query(`select app.update_worker_order_status($1, 'pause', 'Waiting for water')`, [
        order,
      ]);
      await db.query(`select app.update_worker_order_status($1, 'resume')`, [order]);

      await becomeOwner(db);
      const { rows } = await db.query(
        `select status, total_paused_ms, pause_reason from public.worker_orders where id = $1`,
        [order],
      );
      expect(rows[0].status).toBe('in_progress');
      expect(Number(rows[0].total_paused_ms)).toBeGreaterThanOrEqual(0);
      expect(rows[0].pause_reason).toBeNull();
    });
  });

  it("refuses a manager doing the worker's own transitions", async () => {
    await asAdminDb(async (db) => {
      const { order } = await assignedOrder(db, 'UCE 805A');
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(`select app.update_worker_order_status($1, 'accept')`, [
        order,
      ]);
      expect(error).toMatch(/not assigned to you|do not have permission/);
    });
  });

  it('cancels an order with a reason, but never a completed one', async () => {
    await asAdminDb(async (db) => {
      const { order } = await assignedOrder(db, 'UCF 806A');
      await becomeClient(db, SEED.manager);
      expect(await db.expectError(`select app.cancel_worker_order($1, '')`, [order])).toMatch(
        /Enter a reason/,
      );
      await db.query(`select app.cancel_worker_order($1, 'Customer left')`, [order]);
      expect(await db.expectError(`select app.cancel_worker_order($1, 'Again')`, [order])).toMatch(
        /already cancelled/,
      );
    });
  });

  it('refuses cancelling a job once work has started', async () => {
    await asAdminDb(async (db) => {
      const { intake, order } = await assignedOrder(db, 'UCG 807A');
      await becomeClient(db, SEED.worker);
      await db.query(`select app.update_worker_order_status($1, 'accept')`, [order]);
      await db.query(`select app.update_worker_order_status($1, 'start')`, [order]);

      await becomeClient(db, SEED.manager);
      const error = await db.expectError(`select app.cancel_service_intake($1, 'Changed mind')`, [
        intake,
      ]);
      expect(error).toMatch(/Work on this job has already started/);
    });
  });
});

// ---------------------------------------------------------------------------
describe('job status and ready-to-invoice', () => {
  it('stays open until every live order is completed', async () => {
    await asAdminDb(async (db) => {
      const services = await serviceIds(db, 2);
      const vehicle = await freshVehicle(db, 'UCH 901A');
      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query(`select app.create_service_intake($1, $2::uuid[]) as id`, [
        vehicle,
        services,
      ]);
      await becomeOwner(db);
      const { rows: orders } = await db.query(
        `select id from public.worker_orders where service_intake_id = $1 order by order_number`,
        [rows[0].id],
      );

      await becomeClient(db, SEED.manager);
      for (const order of orders) {
        await db.query(`select app.assign_worker_order($1, $2)`, [order.id, SEED.worker]);
      }

      await becomeClient(db, SEED.worker);
      // First order complete: the job is NOT yet ready.
      for (const action of ['accept', 'start', 'complete']) {
        await db.query(`select app.update_worker_order_status($1, $2)`, [orders[0].id, action]);
      }
      let status = await db.query(
        `select app.job_status_for(orders) as s from public.service_intakes where id = $1`,
        [rows[0].id],
      );
      expect(status.rows[0].s).toBe('open');

      // Second order complete: now it is.
      let ready = false;
      for (const action of ['accept', 'start', 'complete']) {
        const result = await db.query(`select * from app.update_worker_order_status($1, $2)`, [
          orders[1].id,
          action,
        ]);
        ready = Boolean(result.rows[0].ready_to_invoice);
      }
      expect(ready).toBe(true);

      status = await db.query(
        `select status, completed_at from public.service_intakes where id = $1`,
        [rows[0].id],
      );
      expect(status.rows[0].status).toBe('completed');
      expect(status.rows[0].completed_at).not.toBeNull();
    });
  });

  it('reports ready_to_invoice exactly ONCE, on the transition', async () => {
    await asAdminDb(async (db) => {
      const [service] = await serviceIds(db);
      const vehicle = await freshVehicle(db, 'UCJ 902A');
      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query(
        `select app.create_service_intake($1, array[$2::uuid]) as id`,
        [vehicle, service],
      );
      await becomeOwner(db);
      const { rows: orders } = await db.query(
        `select id from public.worker_orders where service_intake_id = $1`,
        [rows[0].id],
      );
      await becomeClient(db, SEED.manager);
      await db.query(`select app.assign_worker_order($1, $2)`, [orders[0].id, SEED.worker]);

      await becomeClient(db, SEED.worker);
      const flags: boolean[] = [];
      for (const action of ['accept', 'start', 'complete']) {
        const result = await db.query(`select * from app.update_worker_order_status($1, $2)`, [
          orders[0].id,
          action,
        ]);
        flags.push(Boolean(result.rows[0].ready_to_invoice));
      }
      expect(flags).toEqual([false, false, true]);
    });
  });

  it('counts a job with every order CANCELLED as still open, never completed', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select app.job_status_for('[{"status":"cancelled"},{"status":"cancelled"}]'::jsonb) as s`);
      expect(rows[0].s).toBe('open');
    });
  });

  it('counts completed plus cancelled as completed', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select app.job_status_for('[{"status":"completed"},{"status":"cancelled"}]'::jsonb) as s`);
      expect(rows[0].s).toBe('completed');
    });
  });
});
