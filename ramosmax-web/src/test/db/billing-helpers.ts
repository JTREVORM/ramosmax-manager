import { asAdminDb, becomeClient, becomeOwner, type Session, SEED } from './harness';

/** Builds a completed job ready to invoice, and returns its ids. */
export async function completedJob(
  db: Session,
  plate: string,
  serviceNames: string[] = ['Body Wash'],
): Promise<{ vehicle: string; intake: string; orders: string[] }> {
  const { rows: services } = await db.query<{ id: string }>(
    `select id from public.services where name = any($1) order by name`, [serviceNames]);

  const { rows: vehicle } = await db.query<{ id: string }>(
    `insert into public.vehicles (number_plate, normalized_plate, model, colour, customer_id)
     values ($1, app.plate_key($1), 'Model', 'Colour',
             (select id from public.customers order by customer_number limit 1))
     returning id`, [plate]);

  await becomeClient(db, SEED.cashier);
  const { rows: intake } = await db.query<{ id: string }>(
    `select app.create_service_intake($1, $2::uuid[]) as id`,
    [vehicle[0].id, services.map((s) => s.id)]);

  await becomeOwner(db);
  const { rows: orders } = await db.query<{ id: string }>(
    `select id from public.worker_orders where service_intake_id = $1 order by order_number`,
    [intake[0].id]);

  await becomeClient(db, SEED.manager);
  for (const order of orders) {
    await db.query(`select app.assign_worker_order($1, $2)`, [order.id, SEED.worker]);
  }
  await becomeClient(db, SEED.worker);
  for (const order of orders) {
    for (const action of ['accept', 'start', 'complete']) {
      await db.query(`select app.update_worker_order_status($1, $2)`, [order.id, action]);
    }
  }
  await becomeOwner(db);

  return { vehicle: vehicle[0].id, intake: intake[0].id, orders: orders.map((o) => o.id) };
}

/** A completed job, invoiced, returned with its invoice id and totals. */
export async function invoicedJob(
  db: Session,
  plate: string,
  serviceNames?: string[],
): Promise<{ vehicle: string; intake: string; invoice: string; subtotal: number }> {
  const job = await completedJob(db, plate, serviceNames);
  await becomeClient(db, SEED.cashier);
  const { rows } = await db.query<{ id: string }>(
    `select app.create_invoice($1) as id`, [job.intake]);
  await becomeOwner(db);
  const { rows: invoice } = await db.query<{ subtotal_ugx: string }>(
    `select subtotal_ugx from public.invoices where id = $1`, [rows[0].id]);
  return { ...job, invoice: rows[0].id, subtotal: Number(invoice[0].subtotal_ugx) };
}

export const requestId = (label: string) => `test-${label}-${Math.random().toString(36).slice(2)}`;

export { asAdminDb, becomeClient, becomeOwner, SEED };
