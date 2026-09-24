import 'server-only';
import { queryAsUser, rpcAsUser } from './db';
import { sessionUserId } from './session';

/**
 * Reads for the Phase C screens.
 *
 * Every query runs AS THE SIGNED-IN USER, so RLS decides what comes back. A
 * page never filters for security — it asks for what it wants and receives
 * only what the caller may see. A Worker asking for "all worker orders" gets
 * their own; a Worker asking for customers gets nothing.
 */

async function requireUser(): Promise<string> {
  const id = await sessionUserId();
  if (!id) throw new Error('Not signed in.');
  return id;
}

export interface CustomerRow {
  id: string;
  customer_number: string;
  full_name: string;
  phone_number: string | null;
  alternative_phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  status: string;
  vehicle_count: number;
  created_at: string;
}

export async function listCustomers(search: string, status: string): Promise<CustomerRow[]> {
  const uid = await requireUser();
  return queryAsUser<CustomerRow>(
    uid,
    `select id, customer_number, full_name, phone_number, alternative_phone, email,
            address, notes, status, vehicle_count, created_at
       from public.customers
      where ($2 = 'all' or status = $2)
        and ($1 = '' or full_name ilike '%' || $1 || '%'
                     or customer_number ilike '%' || $1 || '%'
                     or coalesce(phone_number, '') like '%' || $1 || '%')
      order by created_at desc
      limit 50`,
    [search.trim(), status],
  );
}

export async function getCustomer(id: string): Promise<CustomerRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<CustomerRow>(
    uid,
    `select id, customer_number, full_name, phone_number, alternative_phone, email,
            address, notes, status, vehicle_count, created_at
       from public.customers where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface VehicleRow {
  id: string;
  number_plate: string;
  normalized_plate: string;
  make: string | null;
  model: string;
  colour: string;
  year: number | null;
  vehicle_type: string | null;
  notes: string | null;
  status: string;
  previous_plates: string[];
  customer_id: string | null;
  customer_name: string | null;
  customer_number: string | null;
  last_intake_at: string | null;
}

/**
 * Plate-first search. It runs through app.search_vehicles, which reads the
 * vehicle directory view — a fixed column list carrying the owner's name and
 * never a phone number, so this is safe for a Worker to call.
 */
export async function searchVehicles(query: string): Promise<VehicleRow[]> {
  const uid = await requireUser();
  return queryAsUser<VehicleRow>(uid, `select * from app.search_vehicles($1, 30)`, [query.trim()]);
}

export async function getVehicle(id: string): Promise<VehicleRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<VehicleRow>(
    uid,
    `select * from public.vehicle_directory where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listCustomerVehicles(customerId: string): Promise<VehicleRow[]> {
  const uid = await requireUser();
  return queryAsUser<VehicleRow>(
    uid,
    `select * from public.vehicle_directory where customer_id = $1 order by number_plate`,
    [customerId],
  );
}

export interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  category: string;
  price_ugx: number;
  estimated_duration_minutes: number | null;
  qualifies_for_loyalty: boolean;
  is_active: boolean;
}

export async function listServices(activeOnly = false): Promise<ServiceRow[]> {
  const uid = await requireUser();
  return queryAsUser<ServiceRow>(
    uid,
    `select id, name, description, category, price_ugx, estimated_duration_minutes,
            qualifies_for_loyalty, is_active
       from public.services
      where (not $1 or is_active)
      order by is_active desc, name`,
    [activeOnly],
  );
}

export async function getService(id: string): Promise<ServiceRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<ServiceRow>(
    uid,
    `select id, name, description, category, price_ugx, estimated_duration_minutes,
            qualifies_for_loyalty, is_active from public.services where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface JobRow {
  id: string;
  job_number: string;
  number_plate: string;
  vehicle_summary: string | null;
  customer_name: string | null;
  status: string;
  service_count: number;
  selected_services: { serviceId: string; name: string; priceUgx: number }[];
  orders: {
    workerOrderId: string;
    orderNumber: string;
    serviceName: string;
    workerName: string | null;
    status: string;
  }[];
  notes: string | null;
  created_at: string;
  created_by_name: string | null;
  completed_at: string | null;
  cancel_reason: string | null;
  vehicle_id: string;
}

export async function listJobs(search: string, status: string): Promise<JobRow[]> {
  const uid = await requireUser();
  return queryAsUser<JobRow>(
    uid,
    `select id, job_number, number_plate, vehicle_summary, customer_name, status,
            service_count, selected_services, orders, notes, created_at,
            created_by_name, completed_at, cancel_reason, vehicle_id
       from public.service_intakes
      where ($2 = 'all' or status = $2)
        and ($1 = '' or normalized_plate like app.plate_key($1) || '%'
                     or job_number ilike '%' || $1 || '%')
      order by created_at desc
      limit 50`,
    [search.trim(), status],
  );
}

export async function getJob(id: string): Promise<JobRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<JobRow>(
    uid,
    `select id, job_number, number_plate, vehicle_summary, customer_name, status,
            service_count, selected_services, orders, notes, created_at,
            created_by_name, completed_at, cancel_reason, vehicle_id
       from public.service_intakes where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface OrderRow {
  id: string;
  order_number: string;
  job_number: string;
  service_intake_id: string;
  number_plate: string;
  vehicle_summary: string | null;
  service_name: string;
  category: string;
  status: string;
  worker_id?: string | null;
  worker_name?: string | null;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  total_paused_ms: number;
  pause_reason: string | null;
  notes: string | null;
  completion_notes: string | null;
  assignment_history?: {
    workerName: string;
    assignedAt: string;
    endedAt: string | null;
    reason: string | null;
  }[];
}

export async function listJobOrders(jobId: string): Promise<OrderRow[]> {
  const uid = await requireUser();
  return queryAsUser<OrderRow>(
    uid,
    `select id, order_number, job_number, service_intake_id, number_plate, vehicle_summary,
            service_name, category, status, worker_id, worker_name, assigned_at,
            started_at, completed_at, total_paused_ms, pause_reason, notes,
            completion_notes, assignment_history
       from public.worker_orders where service_intake_id = $1 order by order_number`,
    [jobId],
  );
}

/** A worker's own orders, through the view that carries no customer details. */
export async function listMyOrders(): Promise<OrderRow[]> {
  const uid = await requireUser();
  return queryAsUser<OrderRow>(
    uid,
    `select * from public.my_worker_orders
      order by case status when 'assigned' then 0 when 'in_progress' then 1
                           when 'paused' then 2 when 'accepted' then 3 else 4 end,
               order_number`,
  );
}

export interface WorkerOption {
  id: string;
  full_name: string;
  role: string;
}

/** Staff who may be assigned work: active, and holding jobs.complete. */
export async function listAssignableWorkers(): Promise<WorkerOption[]> {
  const uid = await requireUser();
  return queryAsUser<WorkerOption>(
    uid,
    `select u.id, u.full_name, u.role
       from public.users u
      where u.active
        and 'jobs.complete' = any (app.effective_permissions(u.id))
      order by case when u.role = 'worker' then 0 else 1 end, u.full_name`,
  );
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */
/**
 * Every mutation calls a SECURITY DEFINER function as the signed-in user, so
 * the function re-checks their permissions. Nothing here decides anything.
 */
export async function callRpc<T = Record<string, unknown>>(
  fn: string,
  params: unknown[],
): Promise<T[]> {
  const uid = await requireUser();
  return rpcAsUser<T>(uid, fn, params);
}
