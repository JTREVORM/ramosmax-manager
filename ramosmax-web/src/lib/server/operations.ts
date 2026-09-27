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

/**
 * Staff who may be assigned work: active, and holding jobs.complete.
 *
 * This goes through a function rather than a query so the client never needs
 * app.effective_permissions, which would let anyone read anyone's access.
 */
export async function listAssignableWorkers(): Promise<WorkerOption[]> {
  const uid = await requireUser();
  return queryAsUser<WorkerOption>(uid, `select * from app.assignable_workers()`);
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

/* -------------------------------------------------------------------------- */
/* Phase D — invoices, payments, receipts, credit, loyalty                     */
/* -------------------------------------------------------------------------- */

export interface InvoiceRow {
  id: string;
  invoice_number: string;
  job_number: string;
  service_intake_id: string;
  vehicle_id: string;
  number_plate: string;
  customer_id: string | null;
  customer_name: string | null;
  subtotal_ugx: number;
  discount_ugx: number;
  total_ugx: number;
  paid_ugx: number;
  outstanding_ugx: number;
  status: string;
  payment_status: string;
  on_credit: boolean;
  credit_reason: string | null;
  cancel_reason: string | null;
  loyalty_points_earned: number;
  created_at: string;
  created_by_name: string | null;
}

const INVOICE_COLUMNS = `
  id, invoice_number, job_number, service_intake_id, vehicle_id, number_plate,
  customer_id, customer_name, subtotal_ugx, discount_ugx, total_ugx, paid_ugx,
  outstanding_ugx, status, payment_status, on_credit, credit_reason,
  cancel_reason, loyalty_points_earned, created_at, created_by_name`;

export async function listInvoices(search: string, status: string): Promise<InvoiceRow[]> {
  const uid = await requireUser();
  return queryAsUser<InvoiceRow>(
    uid,
    `select ${INVOICE_COLUMNS} from public.invoices
      where ($2 = 'all' or payment_status = $2)
        and ($1 = '' or number_plate ilike '%' || $1 || '%'
                     or invoice_number ilike '%' || $1 || '%'
                     or coalesce(customer_name, '') ilike '%' || $1 || '%')
      order by created_at desc limit 50`,
    [search.trim(), status],
  );
}

export async function getInvoice(id: string): Promise<InvoiceRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<InvoiceRow>(
    uid, `select ${INVOICE_COLUMNS} from public.invoices where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getInvoiceForJob(intakeId: string): Promise<InvoiceRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<InvoiceRow>(
    uid,
    `select ${INVOICE_COLUMNS} from public.invoices
      where service_intake_id = $1 and status <> 'cancelled'`,
    [intakeId],
  );
  return rows[0] ?? null;
}

/** Invoices with money still owed, for the receivables screen. */
export async function listCredit(): Promise<(InvoiceRow & { days_owed: number })[]> {
  const uid = await requireUser();
  return queryAsUser<InvoiceRow & { days_owed: number }>(
    uid,
    `select ${INVOICE_COLUMNS},
            (current_date - created_at::date) as days_owed
       from public.invoices
      where status = 'active' and outstanding_ugx > 0
      order by created_at limit 100`,
  );
}

export interface InvoiceItemRow {
  id: string;
  service_name: string;
  category: string;
  price_ugx: number;
  qualifies_for_loyalty: boolean;
}

export async function listInvoiceItems(invoiceId: string): Promise<InvoiceItemRow[]> {
  const uid = await requireUser();
  return queryAsUser<InvoiceItemRow>(
    uid,
    `select id, service_name, category, price_ugx, qualifies_for_loyalty
       from public.invoice_items where invoice_id = $1 order by service_name`,
    [invoiceId],
  );
}

export interface DiscountRow {
  id: string;
  source: string;
  discount_type: string;
  discount_value: number;
  discount_amount_ugx: number;
  reason_code: string;
  description: string | null;
  approved_by: string | null;
  status: string;
}

export async function getInvoiceDiscount(invoiceId: string): Promise<DiscountRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<DiscountRow>(
    uid,
    `select id, source, discount_type, discount_value, discount_amount_ugx,
            reason_code, description, approved_by, status
       from public.discounts where invoice_id = $1 and status = 'active'`,
    [invoiceId],
  );
  return rows[0] ?? null;
}

export interface PaymentRow {
  id: string;
  invoice_id: string;
  invoice_number?: string;
  number_plate?: string;
  amount_ugx: number;
  method: string;
  reference: string | null;
  status: string;
  reversal_reason: string | null;
  created_at: string;
  created_by_name: string | null;
  receipt_number?: string | null;
}

export async function listInvoicePayments(invoiceId: string): Promise<PaymentRow[]> {
  const uid = await requireUser();
  return queryAsUser<PaymentRow>(
    uid,
    `select p.id, p.invoice_id, p.amount_ugx, p.method, p.reference, p.status,
            p.reversal_reason, p.created_at, p.created_by_name,
            (select r.receipt_number from public.receipts r where r.payment_id = p.id)
              as receipt_number
       from public.payments p where p.invoice_id = $1 order by p.created_at`,
    [invoiceId],
  );
}

export async function listPayments(period: string, method: string): Promise<PaymentRow[]> {
  const uid = await requireUser();
  return queryAsUser<PaymentRow>(
    uid,
    `select p.id, p.invoice_id, p.amount_ugx, p.method, p.reference, p.status,
            p.reversal_reason, p.created_at, p.created_by_name,
            i.invoice_number, i.number_plate,
            (select r.receipt_number from public.receipts r where r.payment_id = p.id)
              as receipt_number
       from public.payments p
       join public.invoices i on i.id = p.invoice_id
      where ($2 = 'all' or p.method = $2)
        and p.created_at >= case $1
              when 'today'  then date_trunc('day', now())
              when 'week'   then now() - interval '7 days'
              when 'month'  then now() - interval '30 days'
              else timestamptz '1970-01-01' end
      order by p.created_at desc limit 100`,
    [period, method],
  );
}

export interface ReceiptRow {
  id: string;
  receipt_number: string;
  payment_id: string;
  invoice_id: string;
  status: string;
  created_at: string;
  snapshot: Record<string, unknown>;
}

export async function getReceipt(receiptNumber: string): Promise<ReceiptRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<ReceiptRow>(
    uid,
    `select id, receipt_number, payment_id, invoice_id, status, created_at, snapshot
       from public.receipts where receipt_number = $1`,
    [receiptNumber],
  );
  return rows[0] ?? null;
}

export async function listReceipts(): Promise<ReceiptRow[]> {
  const uid = await requireUser();
  return queryAsUser<ReceiptRow>(
    uid,
    `select id, receipt_number, payment_id, invoice_id, status, created_at, snapshot
       from public.receipts order by created_at desc limit 50`,
  );
}

export interface PaymentAccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  payment_method: string | null;
}

export async function listPaymentAccounts(): Promise<PaymentAccountRow[]> {
  const uid = await requireUser();
  return queryAsUser<PaymentAccountRow>(
    uid, `select id, code, name, type, payment_method from public.payment_accounts order by name`);
}

export interface VehicleLoyalty {
  points_balance: number;
  lifetime_points: number;
  rewards_unlocked: number;
  rewards_redeemed: number;
  reward_available: boolean;
  reward_percent: number;
  reward_threshold: number;
  points_to_next: number;
}

export async function getVehicleLoyalty(vehicleId: string): Promise<VehicleLoyalty | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<VehicleLoyalty>(
    uid, `select * from app.vehicle_loyalty($1)`, [vehicleId]);
  return rows[0] ?? null;
}

export interface LoyaltyEntry {
  id: string;
  type: string;
  points: number;
  balance_before: number;
  balance_after: number;
  reason: string | null;
  reversed_by_id: string | null;
  created_at: string;
}

export async function listLoyaltyLedger(vehicleId: string): Promise<LoyaltyEntry[]> {
  const uid = await requireUser();
  return queryAsUser<LoyaltyEntry>(
    uid,
    `select id, type, points, balance_before, balance_after, reason,
            reversed_by_id, created_at
       from public.loyalty_transactions where vehicle_id = $1
      order by created_at desc limit 100`,
    [vehicleId],
  );
}

/** Vehicles with the most points, for the loyalty overview. */
export async function listLoyaltyLeaders(): Promise<
  { vehicle_id: string; number_plate: string; points_balance: number; reward_available: boolean }[]
> {
  const uid = await requireUser();
  return queryAsUser(
    uid,
    `select a.vehicle_id, v.number_plate, a.points_balance,
            exists (select 1 from public.loyalty_rewards r
                     where r.vehicle_id = a.vehicle_id and r.status = 'available')
              as reward_available
       from public.loyalty_accounts a
       join public.vehicles v on v.id = a.vehicle_id
      where a.points_balance > 0
      order by a.points_balance desc limit 50`,
  );
}
