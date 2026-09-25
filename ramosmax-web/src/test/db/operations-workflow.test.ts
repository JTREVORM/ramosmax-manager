import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, SEED } from './harness';

afterAll(closePool);

/**
 * The complete Phase C workflow, acted out by the roles that would really
 * perform each step:
 *
 *   Cashier registers the customer and the vehicle
 *     -> Cashier selects services and creates the intake
 *       -> Manager assigns a worker
 *         -> Worker accepts, starts, pauses, resumes and completes
 *           -> the job reports itself ready to invoice
 *             -> and STOPS there: invoicing is Phase D.
 */

describe('customer → vehicle → intake → assign → work → ready to invoice', () => {
  it('runs end to end, with each step done by the right role', async () => {
    await asAdminDb(async (db) => {
      // ---- reception: a new customer and their vehicle -------------------
      await becomeClient(db, SEED.cashier);
      const { rows: customer } = await db.query(
        `select app.create_customer('Workflow Customer', '0772600001', null,
                                    null, 'Ntinda, Kampala') as id`,
      );
      const { rows: vehicle } = await db.query(
        `select app.create_vehicle('ucw-101a', 'Rav4', 'White', 'Toyota', 2018, 'suv', $1) as id`,
        [customer[0].id],
      );

      await becomeOwner(db);
      const { rows: registered } = await db.query(
        `select number_plate, normalized_plate, customer_name, status
           from public.vehicles where id = $1`,
        [vehicle[0].id],
      );
      expect(registered[0].number_plate).toBe('UCW 101A');
      expect(registered[0].normalized_plate).toBe('UCW101A');
      expect(registered[0].customer_name).toBe('Workflow Customer');
      expect(registered[0].status).toBe('active');

      const { rows: counted } = await db.query(
        `select vehicle_count from public.customers where id = $1`,
        [customer[0].id],
      );
      expect(Number(counted[0].vehicle_count)).toBe(1);

      // ---- plate-first look-up finds it ----------------------------------
      await becomeClient(db, SEED.cashier);
      const { rows: found } = await db.query(
        `select id, number_plate from app.search_vehicles('UCW101A')`,
      );
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe(vehicle[0].id);

      // ---- select services and create the intake -------------------------
      await becomeOwner(db);
      const { rows: services } = await db.query(
        `select id, price_ugx from public.services
          where name in ('Body Wash', 'Interior Vacuum') order by name`,
      );
      const expectedTotal = services.reduce((sum, s) => sum + Number(s.price_ugx), 0);

      await becomeClient(db, SEED.cashier);
      const { rows: intake } = await db.query(
        `select app.create_service_intake($1, $2::uuid[], 'Customer waiting') as id`,
        [vehicle[0].id, services.map((s) => s.id)],
      );

      await becomeOwner(db);
      const { rows: job } = await db.query(
        `select job_number, status, service_count, selected_services, customer_name,
                number_plate, created_by_name
           from public.service_intakes where id = $1`,
        [intake[0].id],
      );
      expect(String(job[0].job_number)).toMatch(/^RMX-JOB-\d{6}$/);
      expect(job[0].status).toBe('open');
      expect(Number(job[0].service_count)).toBe(2);
      expect(job[0].customer_name).toBe('Workflow Customer');
      expect(job[0].created_by_name).toBe('Test Cashier');

      // Prices came from the catalogue, snapshotted onto the job.
      const snapshot = job[0].selected_services as { priceUgx: number }[];
      expect(snapshot.reduce((sum, s) => sum + Number(s.priceUgx), 0)).toBe(expectedTotal);

      // ---- the manager assigns both orders to a worker -------------------
      const { rows: orders } = await db.query(
        `select id, order_number, status from public.worker_orders
          where service_intake_id = $1 order by order_number`,
        [intake[0].id],
      );
      expect(orders).toHaveLength(2);
      expect(orders.every((o) => o.status === 'pending')).toBe(true);

      await becomeClient(db, SEED.manager);
      for (const order of orders) {
        await db.query(`select app.assign_worker_order($1, $2)`, [order.id, SEED.worker]);
      }

      // ---- the worker sees exactly these two orders ----------------------
      await becomeClient(db, SEED.worker);
      // Scoped to this job: other suites commit orders for the same worker.
      const { rows: mine } = await db.query<{
        order_number: string; status: string; number_plate: string;
      }>(
        `select order_number, status, number_plate from public.my_worker_orders
          where service_intake_id = $1 order by order_number`,
        [intake[0].id],
      );
      expect(mine).toHaveLength(2);
      expect(mine.every((o) => o.status === 'assigned')).toBe(true);
      expect(mine[0].number_plate).toBe('UCW 101A');

      // ...and still cannot see the customer's phone number.
      const { rows: leak } = await db.query(`select count(*)::int as n from public.customers`);
      expect(Number(leak[0].n)).toBe(0);

      // ---- the worker carries out the first service ----------------------
      await db.query(`select app.update_worker_order_status($1, 'accept')`, [orders[0].id]);
      await db.query(`select app.update_worker_order_status($1, 'start')`, [orders[0].id]);
      await db.query(
        `select app.update_worker_order_status($1, 'pause', 'Waiting for the pressure washer')`,
        [orders[0].id],
      );
      await db.query(`select app.update_worker_order_status($1, 'resume')`, [orders[0].id]);
      const { rows: first } = await db.query(
        `select * from app.update_worker_order_status($1, 'complete', null, 'Body done')`,
        [orders[0].id],
      );
      expect(first[0].order_status).toBe('completed');
      expect(first[0].job_status).toBe('open');
      expect(first[0].ready_to_invoice).toBe(false);

      // ---- and the second, which finishes the job ------------------------
      await db.query(`select app.update_worker_order_status($1, 'accept')`, [orders[1].id]);
      await db.query(`select app.update_worker_order_status($1, 'start')`, [orders[1].id]);
      const { rows: second } = await db.query(
        `select * from app.update_worker_order_status($1, 'complete')`,
        [orders[1].id],
      );
      expect(second[0].order_status).toBe('completed');
      expect(second[0].job_status).toBe('completed');
      expect(second[0].ready_to_invoice).toBe(true);

      // ---- the job is complete and ready for Phase D ---------------------
      await becomeOwner(db);
      const { rows: finished } = await db.query(
        `select status, completed_at, worker_ids, orders
           from public.service_intakes where id = $1`,
        [intake[0].id],
      );
      expect(finished[0].status).toBe('completed');
      expect(finished[0].completed_at).not.toBeNull();
      expect(finished[0].worker_ids).toEqual([SEED.worker]);
      const summary = finished[0].orders as { status: string }[];
      expect(summary.every((o) => o.status === 'completed')).toBe(true);

      // ---- the audit trail records the whole visit -----------------------
      const { rows: trail } = await db.query(
        `select action from public.audit_logs
          where record_id in ($1, $2, $3)
             or record_id = (select customer_number from public.customers where id = $4)
          order by occurred_at`,
        [job[0].job_number, orders[0].order_number, orders[1].order_number, customer[0].id],
      );
      const actions = trail.map((r) => r.action);
      for (const expected of [
        'customer.created',
        'service_intake.created',
        'work_order.assigned',
        'work_order.accepted',
        'work_order.started',
        'work_order.paused',
        'work_order.resumed',
        'work_order.completed',
      ]) {
        expect(actions, expected).toContain(expected);
      }

      // ---- the phase boundary --------------------------------------------
      // Invoicing arrived in Phase D, so a completed job CAN now be invoiced.
      const { rows: invoicing } = await db.query<{ n: string }>(`
        select count(*)::text as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app' and p.proname = 'create_invoice'`);
      expect(Number(invoicing[0].n)).toBe(1);

      // The current boundary is Phase E: expenses, inventory, payroll, shares
      // and after-hours have no functions yet.
      const { rows: later } = await db.query<{ n: string }>(`
        select count(*)::text as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and (p.proname like '%expense%' or p.proname like '%payroll%'
                or p.proname like '%attendance%' or p.proname like '%share%'
                or p.proname like '%dividend%' or p.proname like '%after_hours%'
                or p.proname like '%stock%' or p.proname like '%inventory%')`);
      expect(Number(later[0].n)).toBe(0);

      // The vehicle can start a new job now that this one is finished.
      await becomeClient(db, SEED.cashier);
      expect(
        await db.expectError(`select app.create_service_intake($1, array[$2::uuid])`, [
          vehicle[0].id,
          services[0].id,
        ]),
      ).toBeNull();
    });
  });
});
