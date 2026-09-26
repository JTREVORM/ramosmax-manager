'use server';

import { revalidatePath } from 'next/cache';
import { callRpc } from './operations';

/**
 * Server Actions for the Phase C screens.
 *
 * Each is a thin wrapper: it forwards to a SECURITY DEFINER function and
 * returns the message the database produced. No rule is decided here, and no
 * price, status or assignment is computed here.
 *
 * Errors are returned rather than thrown so the form can show the server's own
 * wording, which is the wording the reference implementation uses.
 */

export interface ActionResult {
  ok: boolean;
  message?: string;
  id?: string;
}

async function run(fn: string, params: unknown[], revalidate: string[]): Promise<ActionResult> {
  try {
    const rows = await callRpc<Record<string, unknown>>(fn, params);
    for (const path of revalidate) revalidatePath(path);
    const first = rows[0] ? Object.values(rows[0])[0] : undefined;
    return { ok: true, id: typeof first === 'string' ? first : undefined };
  } catch (e) {
    // The database raises messages written for the person using the app.
    const message = (e as Error).message ?? 'Something went wrong. Please try again.';
    return { ok: false, message: message.replace(/^error:\s*/i, '') };
  }
}

/* ---- customers ---------------------------------------------------------- */

export async function createCustomerAction(form: FormData): Promise<ActionResult> {
  return run(
    'create_customer',
    [
      form.get('full_name'),
      form.get('phone_number'),
      form.get('alternative_phone'),
      form.get('email'),
      form.get('address'),
      form.get('notes'),
    ],
    ['/customers'],
  );
}

export async function updateCustomerAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('id'));
  return run(
    'update_customer',
    [
      id,
      form.get('full_name'),
      form.get('phone_number'),
      form.get('alternative_phone'),
      form.get('email'),
      form.get('address'),
      form.get('notes'),
    ],
    ['/customers', `/customers/${id}`],
  );
}

export async function setCustomerStatusAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('id'));
  return run(
    'set_customer_status',
    [id, form.get('active') === 'true', form.get('reason')],
    ['/customers', `/customers/${id}`],
  );
}

/* ---- vehicles ----------------------------------------------------------- */

export async function createVehicleAction(form: FormData): Promise<ActionResult> {
  const year = form.get('year');
  const customer = form.get('customer_id');
  return run(
    'create_vehicle',
    [
      form.get('number_plate'),
      form.get('model'),
      form.get('colour'),
      form.get('make'),
      year ? Number(year) : null,
      form.get('vehicle_type') || null,
      customer ? String(customer) : null,
      form.get('notes'),
    ],
    ['/vehicles'],
  );
}

export async function updateVehicleAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('id'));
  const year = form.get('year');
  return run(
    'update_vehicle',
    [
      id,
      form.get('model'),
      form.get('colour'),
      form.get('make'),
      year ? Number(year) : null,
      form.get('vehicle_type') || null,
      form.get('notes'),
    ],
    ['/vehicles', `/vehicles/${id}`],
  );
}

export async function changeVehiclePlateAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('id'));
  return run(
    'change_vehicle_plate',
    [id, form.get('number_plate'), form.get('reason')],
    ['/vehicles', `/vehicles/${id}`],
  );
}

export async function setVehicleStatusAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('id'));
  return run(
    'set_vehicle_status',
    [id, form.get('active') === 'true', form.get('reason')],
    ['/vehicles', `/vehicles/${id}`],
  );
}

/* ---- services ----------------------------------------------------------- */

export async function createServiceAction(form: FormData): Promise<ActionResult> {
  const duration = form.get('duration');
  return run(
    'create_service',
    [
      form.get('name'),
      form.get('category'),
      Number(form.get('price_ugx')),
      form.get('description'),
      duration ? Number(duration) : null,
      form.get('qualifies_for_loyalty') === 'on',
    ],
    ['/services'],
  );
}

export async function updateServiceAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('id'));
  const duration = form.get('duration');
  return run(
    'update_service',
    [
      id,
      form.get('name'),
      form.get('category'),
      Number(form.get('price_ugx')),
      form.get('description'),
      duration ? Number(duration) : null,
      form.get('qualifies_for_loyalty') === 'on',
      form.get('reason'),
    ],
    ['/services', `/services/${id}`],
  );
}

export async function setServiceActiveAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('id'));
  return run('set_service_active', [id, form.get('active') === 'true'], ['/services']);
}

/* ---- jobs --------------------------------------------------------------- */

export async function createServiceIntakeAction(form: FormData): Promise<ActionResult> {
  const services = form.getAll('service_ids').map(String);
  return run(
    'create_service_intake',
    [form.get('vehicle_id'), services, form.get('notes'), false],
    ['/jobs', '/new-service'],
  );
}

/**
 * Changes the services on a job that has not been invoiced yet.
 *
 * The prices are NOT sent: the function re-reads them from the catalogue, the
 * same way the job read them when it was created. A service already being
 * worked on is refused by the database, not hidden here.
 */
export async function updateServiceIntakeAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('id'));
  const services = form.getAll('service_ids').map(String);
  return run(
    'update_service_intake',
    [id, services, false, form.get('reason')],
    ['/jobs', `/jobs/${id}`, '/my-jobs'],
  );
}

export async function cancelServiceIntakeAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('id'));
  return run('cancel_service_intake', [id, form.get('reason')], ['/jobs', `/jobs/${id}`]);
}

export async function assignWorkerOrderAction(form: FormData): Promise<ActionResult> {
  const job = String(form.get('job_id'));
  return run(
    'assign_worker_order',
    [form.get('order_id'), form.get('worker_id'), form.get('notes')],
    ['/jobs', `/jobs/${job}`, '/my-jobs'],
  );
}

export async function reassignWorkerOrderAction(form: FormData): Promise<ActionResult> {
  const job = String(form.get('job_id'));
  return run(
    'reassign_worker_order',
    [form.get('order_id'), form.get('worker_id'), form.get('reason')],
    ['/jobs', `/jobs/${job}`, '/my-jobs'],
  );
}

export async function cancelWorkerOrderAction(form: FormData): Promise<ActionResult> {
  const job = String(form.get('job_id'));
  return run(
    'cancel_worker_order',
    [form.get('order_id'), form.get('reason')],
    ['/jobs', `/jobs/${job}`, '/my-jobs'],
  );
}

export async function updateWorkerOrderStatusAction(form: FormData): Promise<ActionResult> {
  return run(
    'update_worker_order_status',
    [form.get('order_id'), form.get('action'), form.get('reason'), form.get('notes')],
    ['/my-jobs', '/jobs'],
  );
}
