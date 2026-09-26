-- ===========================================================================
-- RamosMAX Web — Final phase — 0041: tagging the ordinary flows
-- ===========================================================================
-- THERE IS NO AFTER-HOURS BILLING SYSTEM. A job, an invoice and a payment
-- taken at nine at night are the same job, invoice and payment taken at nine
-- in the morning, by the same functions, into the same ledger. All that
-- changes is that they carry the session that produced them, and that the
-- cash a worker physically holds is tracked in a custody sub-ledger until it
-- is handed over.
--
-- The tagging is done by triggers rather than by editing each business
-- function. That is not a shortcut: it means a record CANNOT be written
-- untagged, whichever function writes it, now or later, and the tag is
-- decided by the server from the caller's own open session — never by
-- anything the client sends.
--
-- `record_payment` itself changes in exactly two ways: who may call it, and
-- which methods are allowed while a session is open.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The tag
-- ---------------------------------------------------------------------------

/*
 * Stamps the caller's LIVE session onto a new record. A session whose
 * authorisation has ended tags nothing: the work stops, even though the
 * session stays open until the cash is handed over.
 */
create or replace function app.tag_after_hours()
returns trigger
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare v_ah record;
begin
  select * into v_ah from app.after_hours_context();
  if v_ah.session_id is null or not v_ah.live then
    new.is_after_hours := false;
    new.after_hours_session_id := null;
    new.after_hours_session_number := null;
    new.after_hours_worker_uid := null;
    return new;
  end if;
  new.is_after_hours := true;
  new.after_hours_session_id := v_ah.session_id;
  new.after_hours_session_number := v_ah.session_number;
  new.after_hours_worker_uid := v_ah.staff_uid;
  return new;
end;
$$;

drop trigger if exists tag_after_hours on public.service_intakes;
create trigger tag_after_hours before insert on public.service_intakes
  for each row execute function app.tag_after_hours();

drop trigger if exists tag_after_hours on public.invoices;
create trigger tag_after_hours before insert on public.invoices
  for each row execute function app.tag_after_hours();

drop trigger if exists tag_after_hours on public.payments;
create trigger tag_after_hours before insert on public.payments
  for each row execute function app.tag_after_hours();

/* A worker order is tagged when it is COMPLETED, which is the event that counts. */
create or replace function app.tag_completed_order()
returns trigger
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare v_ah record;
begin
  if new.status <> 'completed' or old.status = 'completed' then return new; end if;
  select * into v_ah from app.after_hours_context();
  if v_ah.session_id is null or not v_ah.live then return new; end if;
  new.is_after_hours := true;
  new.after_hours_session_id := v_ah.session_id;
  new.after_hours_session_number := v_ah.session_number;
  new.after_hours_worker_uid := v_ah.staff_uid;
  return new;
end;
$$;

drop trigger if exists tag_after_hours on public.worker_orders;
create trigger tag_after_hours before update on public.worker_orders
  for each row execute function app.tag_completed_order();

-- ---------------------------------------------------------------------------
-- The counters
-- ---------------------------------------------------------------------------

create or replace function app.count_on_session()
returns trigger
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare v_field text := tg_argv[0];
begin
  if new.after_hours_session_id is null then return null; end if;
  execute format(
    'update public.after_hours_sessions set %I = %I + 1, last_activity_at = now()
      where id = $1', v_field, v_field) using new.after_hours_session_id;
  return null;
end;
$$;

drop trigger if exists count_on_session on public.service_intakes;
create trigger count_on_session after insert on public.service_intakes
  for each row execute function app.count_on_session('intakes_created');

drop trigger if exists count_on_session on public.invoices;
create trigger count_on_session after insert on public.invoices
  for each row execute function app.count_on_session('invoices_created');

create or replace function app.count_completed_order()
returns trigger
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed'
     and new.after_hours_session_id is not null then
    update public.after_hours_sessions
       set jobs_completed = jobs_completed + 1, last_activity_at = now()
     where id = new.after_hours_session_id;
  end if;
  return null;
end;
$$;

drop trigger if exists count_on_session on public.worker_orders;
create trigger count_on_session after update on public.worker_orders
  for each row execute function app.count_completed_order();

-- ---------------------------------------------------------------------------
-- Custody
-- ---------------------------------------------------------------------------

/*
 * One custody entry per after-hours payment, and the session's running
 * figures.
 *
 * Only CASH enters the worker's custody. Mobile money goes straight to the
 * merchant account, so it is recorded on the session and contributes nothing
 * to what has to be handed over.
 */
create or replace function app.record_payment_custody()
returns trigger
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_s    public.after_hours_sessions%rowtype;
  v_cash bigint;
  v_inv  record;
begin
  if new.after_hours_session_id is null then return null; end if;
  select * into v_s from public.after_hours_sessions where id = new.after_hours_session_id;
  v_cash := case when new.method = 'cash' then new.amount_ugx else 0 end;
  select i.invoice_number, i.number_plate into v_inv
    from public.invoices i where i.id = new.invoice_id;

  insert into public.after_hours_cash
    (entry_number, kind, session_id, session_number, staff_uid, staff_name, payment_id,
     receipt_number, invoice_number, number_plate, method, amount_ugx, cash_delta_ugx,
     affects_expected, created_by)
  values
    (app.next_reference('custody_number_seq', 'RMX-AHC-'), 'payment', v_s.id, v_s.session_number,
     v_s.staff_uid, v_s.staff_name, new.id,
     (select r.receipt_number from public.receipts r where r.payment_id = new.id),
     v_inv.invoice_number, v_inv.number_plate, new.method, new.amount_ugx, v_cash,
     v_cash > 0, auth.uid());

  update public.after_hours_sessions
     set payment_count = payment_count + 1,
         cash_collected_ugx = cash_collected_ugx + v_cash,
         non_cash_collected_ugx = non_cash_collected_ugx + (new.amount_ugx - v_cash),
         expected_cash_ugx = expected_cash_ugx + v_cash,
         last_activity_at = now()
   where id = v_s.id;

  perform app.audit('after_hours.payment_linked', 'after_hours', new.id::text, null,
    v_s.session_number, null, null,
    jsonb_build_object('sessionNumber', v_s.session_number, 'method', new.method,
                       'amountUgx', new.amount_ugx));
  return null;
end;
$$;

drop trigger if exists record_payment_custody on public.payments;
create trigger record_payment_custody after insert on public.payments
  for each row execute function app.record_payment_custody();

/*
 * Reversing an after-hours payment.
 *
 * While the session is OPEN the refund came out of the cash the worker is
 * holding, so the expected amount falls. Once the session has CLOSED the
 * expected amount is frozen on the handover and must not move: the refund
 * comes out of Cash at Hand, not the worker's pocket. The entry is still
 * written, so the trail is complete.
 */
create or replace function app.record_reversal_custody()
returns trigger
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_s    public.after_hours_sessions%rowtype;
  v_cash bigint;
  v_open boolean;
  v_inv  record;
begin
  if new.after_hours_session_id is null
     or new.status <> 'reversed' or old.status = 'reversed' then
    return null;
  end if;
  select * into v_s from public.after_hours_sessions where id = new.after_hours_session_id;
  v_open := v_s.status = 'open';
  v_cash := case when new.method = 'cash' then new.amount_ugx else 0 end;
  select i.invoice_number, i.number_plate into v_inv
    from public.invoices i where i.id = new.invoice_id;

  insert into public.after_hours_cash
    (entry_number, kind, session_id, session_number, staff_uid, staff_name, payment_id,
     receipt_number, invoice_number, number_plate, method, amount_ugx, cash_delta_ugx,
     affects_expected, after_session_closed, reason, created_by)
  values
    (app.next_reference('custody_number_seq', 'RMX-AHC-'), 'payment_reversal', v_s.id,
     v_s.session_number, v_s.staff_uid, v_s.staff_name, new.id,
     (select r.receipt_number from public.receipts r where r.payment_id = new.id),
     v_inv.invoice_number, v_inv.number_plate, new.method, -new.amount_ugx,
     case when v_open then -v_cash else 0 end, v_open and v_cash > 0, not v_open,
     new.reversal_reason, auth.uid());

  if v_open then
    update public.after_hours_sessions
       set reversal_count = reversal_count + 1,
           cash_reversed_ugx = cash_reversed_ugx + v_cash,
           non_cash_reversed_ugx = non_cash_reversed_ugx + (new.amount_ugx - v_cash),
           expected_cash_ugx = expected_cash_ugx - v_cash
     where id = v_s.id;
  else
    update public.after_hours_sessions
       set post_close_reversals_ugx = post_close_reversals_ugx + new.amount_ugx
     where id = v_s.id;
  end if;

  perform app.audit('after_hours.payment_reversal_linked', 'after_hours', new.id::text, null,
    v_s.session_number, new.reversal_reason, null,
    jsonb_build_object('sessionNumber', v_s.session_number, 'amountUgx', new.amount_ugx,
                       'method', new.method, 'affectsExpected', v_open and v_cash > 0));
  return null;
end;
$$;

drop trigger if exists record_reversal_custody on public.payments;
create trigger record_reversal_custody after update on public.payments
  for each row execute function app.record_reversal_custody();

-- ---------------------------------------------------------------------------
-- record_payment: who may call it, and by what method
-- ---------------------------------------------------------------------------

create or replace function app.record_payment(
  p_invoice    uuid,
  p_amount     bigint,
  p_method     text,
  p_request_id text,
  p_reference  text default null,
  p_notes      text default null,
  p_account    uuid default null
)
returns table (payment_id uuid, receipt_number text, outstanding_ugx bigint,
               payment_status text, points_earned integer)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_cached    jsonb;
  v_invoice   public.invoices%rowtype;
  v_account   uuid;
  v_ledger    uuid;
  v_payment   uuid;
  v_receipt   text;
  v_actor     text;
  v_points    integer := 0;
  v_paid      bigint;
  v_snapshot  jsonb;
  v_ah        record;
begin
  /*
   * Who may take this payment.
   *
   * Ordinarily `payments.record`. A worker on an after-hours session collects
   * with `after_hours.cash.collect` instead — and only while their
   * authorisation is still in force, and only by a method the policy allows.
   * There is no second payment function: this is the same one, taken at night.
   */
  perform app.require_permission('payments.record', 'after_hours.cash.collect');
  select * into v_ah from app.after_hours_context();
  if v_ah.session_id is null then
    -- Someone who may only collect AFTER HOURS has nothing to collect into.
    if not app.has_permission('payments.record') then
      raise exception 'Open your after-hours session before collecting payments.'
        using errcode = 'insufficient_privilege', detail = 'after_hours_session_required';
    end if;
  else
    if not v_ah.live then
      raise exception 'Your after-hours authorisation has ended or was revoked. Close your session and hand over the cash.'
        using errcode = 'invalid_parameter_value', detail = 'after_hours_expired';
    end if;
    if not (p_method = any (app.after_hours_methods())) then
      raise exception 'This payment method is not allowed after hours.'
        using errcode = 'insufficient_privilege', detail = 'method_not_allowed';
    end if;
  end if;

  v_cached := app.claim_request(p_request_id, 'record_payment',
    jsonb_build_object('invoice', p_invoice, 'amount', p_amount, 'method', p_method));
  if v_cached is not null then
    -- A retry of a request that already succeeded: return the first result.
    return query select (v_cached->>'paymentId')::uuid, v_cached->>'receiptNumber',
                        (v_cached->>'outstandingUgx')::bigint, v_cached->>'paymentStatus',
                        (v_cached->>'pointsEarned')::integer;
    return;
  end if;

  -- Locking the invoice serialises concurrent payments against one balance.
  select * into v_invoice from public.invoices where id = p_invoice for update;
  if v_invoice.id is null then
    raise exception 'That invoice could not be found.'
      using errcode = 'no_data_found', detail = 'invoice';
  end if;
  if v_invoice.status = 'cancelled' then
    raise exception 'This invoice was cancelled.'
      using errcode = 'invalid_parameter_value', detail = 'cancelled';
  end if;
  if v_invoice.outstanding_ugx = 0 then
    raise exception 'This invoice is already fully paid.'
      using errcode = 'invalid_parameter_value', detail = 'already_paid';
  end if;

  if p_amount is null or p_amount < 1 then
    raise exception 'Enter a payment amount.'
      using errcode = 'invalid_parameter_value', detail = 'amount';
  end if;
  if p_amount > v_invoice.outstanding_ugx then
    raise exception 'That is more than the outstanding balance of %.', v_invoice.outstanding_ugx
      using errcode = 'invalid_parameter_value', detail = 'overpayment',
            hint = v_invoice.outstanding_ugx::text;
  end if;
  if p_method <> 'cash' and (p_reference is null or btrim(p_reference) = '') then
    raise exception 'Enter the transaction reference for this payment.'
      using errcode = 'invalid_parameter_value', detail = 'reference';
  end if;

  v_account := app.resolve_payment_account(p_method, p_account);
  select full_name into v_actor from public.users where id = auth.uid();

  -- The money moves first: if the account cannot take it, nothing else happens.
  v_ledger := app.post_ledger_entry(
    v_account, 'customer_payment', 'in', p_amount,
    'invoice', p_invoice, 'Customer payment ' || v_invoice.invoice_number, null);

  insert into public.payments
    (invoice_id, amount_ugx, method, reference, notes, financial_account_id,
     financial_transaction_id, request_id, created_by, created_by_name)
  values
    (p_invoice, p_amount, p_method, app.optional_text(p_reference, 'Reference', 120),
     app.optional_text(p_notes, 'Notes', 500), v_account, v_ledger, p_request_id,
     auth.uid(), v_actor)
  returning id into v_payment;

  update public.invoices
     set paid_ugx = paid_ugx + p_amount, updated_by = auth.uid()
   where id = p_invoice
  returning paid_ugx into v_paid;

  -- Re-read so the generated columns reflect this payment.
  select * into v_invoice from public.invoices where id = p_invoice;

  -- Loyalty is earned when the invoice becomes FULLY PAID, once per invoice.
  if v_invoice.outstanding_ugx = 0 and not v_invoice.loyalty_earned then
    v_points := app.award_invoice_loyalty(p_invoice);
  end if;

  v_receipt := app.next_reference('receipt_number_seq', 'RMX-RCP-');
  select jsonb_build_object(
    'businessName', 'RamosMAX Automotive Care (U) Ltd',
    'receiptNumber', v_receipt,
    'invoiceNumber', v_invoice.invoice_number,
    'jobNumber', v_invoice.job_number,
    'numberPlate', v_invoice.number_plate,
    'customerName', v_invoice.customer_name,
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
                'name', i.service_name, 'priceUgx', i.price_ugx) order by i.service_name)
              from public.invoice_items i where i.invoice_id = p_invoice), '[]'::jsonb),
    'subtotalUgx', v_invoice.subtotal_ugx,
    'discountUgx', v_invoice.discount_ugx,
    'totalUgx', v_invoice.total_ugx,
    'paymentUgx', p_amount,
    'method', p_method,
    'reference', p_reference,
    'paidUgx', v_invoice.paid_ugx,
    'balanceUgx', v_invoice.outstanding_ugx,
    'pointsEarned', v_points,
    'pointsBalance', coalesce((select points_balance from public.loyalty_accounts
                                where vehicle_id = v_invoice.vehicle_id), 0),
    'cashier', v_actor,
    'issuedAt', now()
  ) into v_snapshot;

  insert into public.receipts (receipt_number, payment_id, invoice_id, snapshot, created_by)
  values (v_receipt, v_payment, p_invoice, v_snapshot, auth.uid());

  perform app.audit('payment.recorded', 'billing', v_invoice.invoice_number, null, null, null,
    jsonb_build_object('paidUgx', v_paid - p_amount),
    jsonb_build_object('amountUgx', p_amount, 'method', p_method,
                       'paidUgx', v_paid, 'outstandingUgx', v_invoice.outstanding_ugx,
                       'receiptNumber', v_receipt));

  perform app.complete_request(p_request_id, jsonb_build_object(
    'paymentId', v_payment, 'receiptNumber', v_receipt,
    'outstandingUgx', v_invoice.outstanding_ugx, 'paymentStatus', v_invoice.payment_status,
    'pointsEarned', v_points));

  return query select v_payment, v_receipt, v_invoice.outstanding_ugx,
                      v_invoice.payment_status, v_points;
end;
$$;
-- ---------------------------------------------------------------------------
-- The receipt number on the custody entry
-- ---------------------------------------------------------------------------
-- `record_payment` writes the payment first and its receipt a few statements
-- later, so the custody entry cannot know the receipt number when it is
-- written. Rather than defer the custody entry — which would leave the
-- session's running figures wrong for the rest of the transaction — the
-- receipt fills its own number in. This is the ONLY change a custody entry
-- ever accepts, and only from null.

create or replace function app.stamp_custody_receipt()
returns trigger
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
begin
  update public.after_hours_cash
     set receipt_number = new.receipt_number
   where payment_id = new.payment_id and kind = 'payment' and receipt_number is null;
  return null;
end;
$$;

create or replace function app.guard_custody()
returns trigger
language plpgsql
as $$
begin
  if old.receipt_number is null and new.receipt_number is not null
     and to_jsonb(new) - 'receipt_number' = to_jsonb(old) - 'receipt_number' then
    return new;
  end if;
  raise exception 'A custody entry cannot be changed.'
    using errcode = 'restrict_violation', detail = 'custody_immutable';
end;
$$;

drop trigger if exists stamp_custody_receipt on public.receipts;
create trigger stamp_custody_receipt after insert on public.receipts
  for each row execute function app.stamp_custody_receipt();
