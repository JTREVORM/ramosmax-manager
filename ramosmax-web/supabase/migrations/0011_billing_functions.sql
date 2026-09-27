-- ===========================================================================
-- RamosMAX Web — Phase D — 0011: invoicing, discounts, payments, reversals
-- ===========================================================================
-- Ports functions/src/billing.js.
--
-- The client never sends a total, a balance, a status or a computed amount. It
-- sends an intent — "invoice this job", "10% off, promotional", "pay UGX
-- 10,000 by MTN" — and the server derives everything else from authoritative
-- records.
--
-- Each function body is ONE transaction. Either every part of a money movement
-- lands, or none of it does.
-- ===========================================================================

-- Half-up whole-shilling percentage. Ports percentOf() exactly, including the
-- rounding, so a preview in the browser and the charge in the database agree.
create or replace function app.percent_of(p_amount bigint, p_percent bigint)
returns bigint
language sql
immutable
as $$
  select ((p_amount * p_percent + 50) / 100)::bigint;
$$;

-- Discounts above this share of the subtotal need a manager's approval.
-- Taken from APPROVAL_THRESHOLD_PERCENT in billing.js — not invented here.
create or replace function app.discount_approval_threshold_percent()
returns integer
language sql
immutable
as $$ select 25; $$;

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------
-- One logical request, however many times the client retries it.
--
-- claim_request returns the STORED RESULT when this request has already
-- succeeded, so a retry recovers the original outcome rather than charging
-- again. It returns null when the caller now owns the request and should do
-- the work.
--
-- Concurrency: two identical requests arriving together both attempt the
-- insert. One wins; the other blocks on the primary key until the winner
-- commits, then finds the committed row and returns its result. Neither can
-- perform the work twice.
--
-- The payload is fingerprinted. Re-using a request id with DIFFERENT arguments
-- is a bug or an attack, not a retry, and is refused.

create or replace function app.claim_request(
  p_request_id text,
  p_kind       text,
  p_payload    jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_existing app.request_keys%rowtype;
  v_fingerprint text := encode(digest(p_kind || ':' || p_payload::text, 'sha256'), 'hex');
begin
  if p_request_id is null or btrim(p_request_id) = '' then
    raise exception 'A request id is required for this operation.'
      using errcode = 'invalid_parameter_value', detail = 'request_id';
  end if;

  insert into app.request_keys (request_id, actor_id, kind, result)
  values (p_request_id, auth.uid(), p_kind,
          jsonb_build_object('fingerprint', v_fingerprint, 'status', 'in_progress'))
  on conflict (request_id) do nothing;

  select * into v_existing from app.request_keys where request_id = p_request_id;

  -- We inserted it: it is ours to do.
  if v_existing.result->>'status' = 'in_progress'
     and v_existing.actor_id = auth.uid()
     and v_existing.result->>'fingerprint' = v_fingerprint
     and v_existing.claimed_at >= now() - interval '1 second' then
    return null;
  end if;

  if v_existing.kind is distinct from p_kind
     or v_existing.result->>'fingerprint' is distinct from v_fingerprint then
    raise exception 'This request id was already used for a different request.'
      using errcode = 'invalid_parameter_value', detail = 'request_conflict';
  end if;

  if v_existing.result->>'status' = 'in_progress' then
    raise exception 'That request is still being processed. It may already have been saved.'
      using errcode = 'lock_not_available', detail = 'in_progress';
  end if;

  return v_existing.result;
end;
$$;

create or replace function app.complete_request(p_request_id text, p_result jsonb)
returns void
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  update app.request_keys
     set result = result || p_result || jsonb_build_object('status', 'done')
   where request_id = p_request_id;
$$;

-- ---------------------------------------------------------------------------
-- Ledger posting
-- ---------------------------------------------------------------------------
-- Moves money into or out of an account, writes the immutable ledger entry and
-- updates the day's totals. Called only from inside a money transaction.

create or replace function app.post_ledger_entry(
  p_account    uuid,
  p_entry_type text,
  p_direction  text,
  p_amount     bigint,
  p_reference_type text,
  p_reference_id   uuid,
  p_description    text,
  p_reverses       uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_balance bigint;
  v_id      uuid;
  v_day     date := app.eat_day();
  v_number  text;
begin
  -- Locking the account serialises concurrent postings to it, so the running
  -- balance can never interleave.
  update public.financial_accounts
     set balance_ugx = balance_ugx + case when p_direction = 'in' then p_amount else -p_amount end
   where id = p_account
  returning balance_ugx into v_balance;

  if v_balance is null then
    raise exception 'That financial account could not be found.'
      using errcode = 'no_data_found', detail = 'account';
  end if;

  v_number := app.next_reference('transaction_number_seq', 'RMX-TXN-');

  insert into public.financial_transactions
    (transaction_number, account_id, entry_type, direction, amount_ugx, balance_after_ugx,
     reference_type, reference_id, description, reverses_id, business_day, created_by)
  values
    (v_number, p_account, p_entry_type, p_direction, p_amount, v_balance,
     p_reference_type, p_reference_id, p_description, p_reverses, v_day, auth.uid())
  returning id into v_id;

  if p_reverses is not null then
    update public.financial_transactions set reversed_by_id = v_id where id = p_reverses;
  end if;

  insert into public.finance_daily_summaries (business_day, payments_in_ugx, reversals_ugx)
  values (v_day,
          case when p_entry_type = 'customer_payment' then p_amount else 0 end,
          case when p_entry_type = 'reversal' then p_amount else 0 end)
  on conflict (business_day) do update
    set payments_in_ugx = public.finance_daily_summaries.payments_in_ugx
                          + case when p_entry_type = 'customer_payment' then p_amount else 0 end,
        reversals_ugx   = public.finance_daily_summaries.reversals_ugx
                          + case when p_entry_type = 'reversal' then p_amount else 0 end,
        updated_at      = now();

  return v_id;
end;
$$;

-- The account a payment method posts to. Ports PAYMENT_ACCOUNTS.
create or replace function app.resolve_payment_account(p_method text, p_account uuid default null)
returns uuid
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_method = 'bank' then
    if p_account is not null then
      select id into v_id from public.financial_accounts
       where id = p_account and type = 'bank' and is_active;
    else
      -- The only active bank account, when there is exactly one.
      select id into v_id from public.financial_accounts
       where type = 'bank' and is_active
       limit 2;
      if (select count(*) from public.financial_accounts where type = 'bank' and is_active) <> 1 then
        raise exception 'Choose the bank account this payment went to.'
          using errcode = 'invalid_parameter_value', detail = 'account';
      end if;
    end if;
  else
    select id into v_id from public.financial_accounts
     where payment_method = p_method and is_active;
  end if;

  if v_id is null then
    raise exception 'No active account is set up for this payment method.'
      using errcode = 'raise_exception', detail = 'account';
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_invoice
-- ---------------------------------------------------------------------------
-- Allowed only for a COMPLETED job with no invoice. One line per COMPLETED
-- worker order, priced from the job's snapshot, so a catalogue price change
-- after the visit can never alter it. Cancelled services are left off.

create or replace function app.create_invoice(p_intake uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_intake   public.service_intakes%rowtype;
  v_invoice  uuid;
  v_number   text;
  v_subtotal bigint;
  v_existing uuid;
  v_actor    text;
begin
  perform app.require_permission('invoices.create');

  select * into v_intake from public.service_intakes where id = p_intake for update;
  if v_intake.id is null then
    raise exception 'That job could not be found.' using errcode = 'no_data_found', detail = 'job';
  end if;

  select id into v_existing from public.invoices
   where service_intake_id = p_intake and status <> 'cancelled';
  if v_existing is not null then
    raise exception 'This job has already been invoiced.'
      using errcode = 'unique_violation', detail = 'already_invoiced', hint = v_existing::text;
  end if;

  if v_intake.status <> 'completed' then
    raise exception 'This job is not complete yet.'
      using errcode = 'invalid_parameter_value', detail = 'not_completed';
  end if;

  -- The price comes from the job's snapshot, matched to the COMPLETED orders.
  select coalesce(sum((s->>'priceUgx')::bigint), 0)
    into v_subtotal
    from public.worker_orders o
    join lateral jsonb_array_elements(v_intake.selected_services) s
      on (s->>'serviceId')::uuid = o.service_id
   where o.service_intake_id = p_intake and o.status = 'completed';

  if v_subtotal is null then v_subtotal := 0; end if;

  v_number := app.next_reference('invoice_number_seq', 'RMX-INV-');
  select full_name into v_actor from public.users where id = auth.uid();

  insert into public.invoices
    (invoice_number, service_intake_id, job_number, vehicle_id, number_plate,
     customer_id, customer_name, subtotal_ugx, created_by, created_by_name, updated_by)
  values
    (v_number, p_intake, v_intake.job_number, v_intake.vehicle_id, v_intake.number_plate,
     v_intake.customer_id, v_intake.customer_name, v_subtotal, auth.uid(), v_actor, auth.uid())
  returning id into v_invoice;

  insert into public.invoice_items
    (invoice_id, worker_order_id, service_id, service_name, category,
     price_ugx, qualifies_for_loyalty)
  select v_invoice, o.id, o.service_id, o.service_name, o.category,
         (s->>'priceUgx')::bigint,
         coalesce((s->>'qualifiesForLoyalty')::boolean, false)
    from public.worker_orders o
    join lateral jsonb_array_elements(v_intake.selected_services) s
      on (s->>'serviceId')::uuid = o.service_id
   where o.service_intake_id = p_intake and o.status = 'completed';

  perform app.audit('invoice.created', 'billing', v_number, null, null, null, null,
    jsonb_build_object('jobNumber', v_intake.job_number, 'subtotalUgx', v_subtotal));

  return v_invoice;
end;
$$;

-- ---------------------------------------------------------------------------
-- apply_invoice_discount
-- ---------------------------------------------------------------------------

create or replace function app.apply_invoice_discount(
  p_invoice     uuid,
  p_type        text,
  p_value       bigint,
  p_reason_code text,
  p_description text default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_invoice    public.invoices%rowtype;
  v_amount     bigint;
  v_can_approve boolean;
  v_threshold  integer := app.discount_approval_threshold_percent();
begin
  perform app.require_permission('discounts.apply');

  select * into v_invoice from public.invoices where id = p_invoice for update;
  if v_invoice.id is null then
    raise exception 'That invoice could not be found.'
      using errcode = 'no_data_found', detail = 'invoice';
  end if;
  if v_invoice.status = 'cancelled' then
    raise exception 'This invoice was cancelled.'
      using errcode = 'invalid_parameter_value', detail = 'cancelled';
  end if;
  if v_invoice.paid_ugx > 0 then
    raise exception 'A discount cannot be applied once a payment has been recorded.'
      using errcode = 'invalid_parameter_value', detail = 'payments_exist';
  end if;
  if exists (select 1 from public.discounts where invoice_id = p_invoice and status = 'active') then
    raise exception 'This invoice already has a discount.'
      using errcode = 'invalid_parameter_value', detail = 'discount_exists';
  end if;

  if p_reason_code not in ('manager_approval', 'promotional', 'service_issue', 'other') then
    raise exception 'Choose a valid reason for this discount.'
      using errcode = 'invalid_parameter_value', detail = 'reason_code';
  end if;
  if p_reason_code = 'other'
     and (p_description is null or btrim(p_description) = '') then
    raise exception 'Describe the reason for this discount.'
      using errcode = 'invalid_parameter_value', detail = 'description';
  end if;

  if p_type = 'percentage' then
    if p_value < 1 or p_value > 100 then
      raise exception 'A percentage discount must be between 1 and 100.'
        using errcode = 'invalid_parameter_value', detail = 'discount_value';
    end if;
    v_amount := app.percent_of(v_invoice.subtotal_ugx, p_value);
  elsif p_type = 'fixed' then
    if p_value < 1 then
      raise exception 'Enter a discount amount.'
        using errcode = 'invalid_parameter_value', detail = 'discount_value';
    end if;
    if p_value > v_invoice.subtotal_ugx then
      raise exception 'The discount cannot be more than the invoice subtotal.'
        using errcode = 'invalid_parameter_value', detail = 'discount_value';
    end if;
    v_amount := p_value;
  else
    raise exception 'Choose a percentage or a fixed discount.'
      using errcode = 'invalid_parameter_value', detail = 'discount_type';
  end if;

  if v_amount <= 0 then
    raise exception 'That discount rounds to nothing on this invoice.'
      using errcode = 'invalid_parameter_value', detail = 'discount_value';
  end if;

  -- Above the threshold, a manager must approve. The AMOUNT is compared, not
  -- the typed percentage, so a large fixed discount is caught too.
  v_can_approve := app.has_permission('discounts.approve');
  if not v_can_approve and v_amount * 100 > v_invoice.subtotal_ugx * v_threshold then
    raise exception 'Discounts above %%% need a manager''s approval.', v_threshold
      using errcode = 'insufficient_privilege', detail = 'approval_required';
  end if;

  insert into public.discounts
    (invoice_id, source, discount_type, discount_value, discount_amount_ugx,
     reason_code, description, approved_by, created_by)
  values
    (p_invoice, 'manual', p_type, p_value, v_amount,
     p_reason_code, app.optional_text(p_description, 'Description', 300),
     case when v_can_approve then auth.uid() end, auth.uid());

  update public.invoices
     set discount_ugx = v_amount, updated_by = auth.uid()
   where id = p_invoice;

  perform app.audit('discount.applied', 'billing', v_invoice.invoice_number, null, null, p_reason_code,
    jsonb_build_object('discountUgx', v_invoice.discount_ugx),
    jsonb_build_object('discountUgx', v_amount, 'type', p_type, 'value', p_value,
                       'approved', v_can_approve));

  return v_amount;
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_invoice_credit — the customer left owing the balance
-- ---------------------------------------------------------------------------
-- CREDIT IS MONEY OWED, NOT CASH RECEIVED. It posts nothing to any financial
-- account and creates no payment; it only records that the balance is owed.

create or replace function app.mark_invoice_credit(p_invoice uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_reason  text := app.require_reason(p_reason);
begin
  perform app.require_permission('credit.manage');

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
  if v_invoice.on_credit then
    raise exception 'This invoice is already on credit.'
      using errcode = 'invalid_parameter_value', detail = 'no_changes';
  end if;

  update public.invoices
     set on_credit = true, credit_reason = v_reason,
         credit_marked_at = now(), credit_marked_by = auth.uid(), updated_by = auth.uid()
   where id = p_invoice;

  perform app.audit('invoice.marked_credit', 'billing', v_invoice.invoice_number, null, null, v_reason,
    jsonb_build_object('onCredit', false),
    jsonb_build_object('onCredit', true, 'outstandingUgx', v_invoice.outstanding_ugx));
end;
$$;

-- ---------------------------------------------------------------------------
-- record_payment — ONE transaction, every part or none
-- ---------------------------------------------------------------------------
-- Atomically: claims the request id, locks the invoice, validates the amount
-- against the SERVER's outstanding balance, writes the ledger entry and the
-- day's totals, writes the payment, issues the receipt, awards loyalty if the
-- invoice becomes fully paid, and writes the audit entry.
--
-- If any part raises, the whole thing rolls back. There is no state in which
-- a payment exists without its ledger entry, or a receipt without its payment.

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
begin
  perform app.require_permission('payments.record');

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
-- reverse_payment
-- ---------------------------------------------------------------------------
-- The payment and its receipt are KEPT and marked reversed. The money is taken
-- back out of the account it was posted to, and any loyalty the invoice earned
-- is taken back. Refused if the account no longer holds the money.

create or replace function app.reverse_payment(p_payment uuid, p_reason text)
returns table (outstanding_ugx bigint, payment_status text, points_removed integer)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_reason  text := app.require_reason(p_reason);
  v_ledger  uuid;
  v_points  integer := 0;
  v_balance bigint;
begin
  perform app.require_permission('payments.reverse');

  select * into v_payment from public.payments where id = p_payment for update;
  if v_payment.id is null then
    raise exception 'That payment could not be found.'
      using errcode = 'no_data_found', detail = 'payment';
  end if;
  if v_payment.status = 'reversed' then
    raise exception 'This payment has already been reversed.'
      using errcode = 'invalid_parameter_value', detail = 'already_reversed';
  end if;

  select * into v_invoice from public.invoices where id = v_payment.invoice_id for update;

  -- The money must still be in the account it went into.
  select balance_ugx into v_balance from public.financial_accounts
   where id = v_payment.financial_account_id for update;
  if v_balance < v_payment.amount_ugx then
    raise exception 'That account no longer holds this money, so the payment cannot be reversed.'
      using errcode = 'invalid_parameter_value', detail = 'insufficient_account_balance';
  end if;

  v_ledger := app.post_ledger_entry(
    v_payment.financial_account_id, 'reversal', 'out', v_payment.amount_ugx,
    'payment', p_payment, 'Reversal of payment on ' || v_invoice.invoice_number,
    v_payment.financial_transaction_id);

  update public.payments
     set status = 'reversed', reversed_at = now(), reversed_by = auth.uid(),
         reversal_reason = v_reason, reversal_transaction_id = v_ledger
   where id = p_payment;

  update public.receipts set status = 'reversed' where payment_id = p_payment;

  update public.invoices
     set paid_ugx = paid_ugx - v_payment.amount_ugx, updated_by = auth.uid()
   where id = v_payment.invoice_id;

  -- Points earned by this invoice are taken back, because it is no longer paid.
  if v_invoice.loyalty_earned then
    v_points := app.take_back_invoice_loyalty(v_invoice.id, 'Payment reversed: ' || v_reason);
  end if;

  select * into v_invoice from public.invoices where id = v_payment.invoice_id;

  perform app.audit('payment.reversed', 'billing', v_invoice.invoice_number, null, null, v_reason,
    jsonb_build_object('status', 'active', 'amountUgx', v_payment.amount_ugx),
    jsonb_build_object('status', 'reversed', 'outstandingUgx', v_invoice.outstanding_ugx,
                       'pointsRemoved', v_points));

  return query select v_invoice.outstanding_ugx, v_invoice.payment_status, v_points;
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_invoice
-- ---------------------------------------------------------------------------
-- Allowed only when no ACTIVE payment exists: reverse the payments first. The
-- invoice is kept and marked cancelled, its discount is cancelled, the job is
-- freed to be invoiced again, and a redeemed loyalty reward is given back.

create or replace function app.cancel_invoice(p_invoice uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_reason  text := app.require_reason(p_reason);
begin
  perform app.require_permission('invoices.void');

  select * into v_invoice from public.invoices where id = p_invoice for update;
  if v_invoice.id is null then
    raise exception 'That invoice could not be found.'
      using errcode = 'no_data_found', detail = 'invoice';
  end if;
  if v_invoice.status = 'cancelled' then
    raise exception 'This invoice was already cancelled.'
      using errcode = 'invalid_parameter_value', detail = 'cancelled';
  end if;
  if exists (select 1 from public.payments
              where invoice_id = p_invoice and status = 'active') then
    raise exception 'Reverse this invoice''s payments before cancelling it.'
      using errcode = 'invalid_parameter_value', detail = 'payments_exist';
  end if;

  -- Points earned on this invoice go back.
  if v_invoice.loyalty_earned then
    perform app.take_back_invoice_loyalty(p_invoice, 'Invoice cancelled: ' || v_reason);
  end if;

  -- A redeemed loyalty reward is returned to the vehicle.
  perform app.return_loyalty_reward(p_invoice, v_reason);

  update public.discounts set status = 'cancelled'
   where invoice_id = p_invoice and status = 'active';

  update public.invoices
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = v_reason, discount_ugx = 0, updated_by = auth.uid()
   where id = p_invoice;

  perform app.audit('invoice.cancelled', 'billing', v_invoice.invoice_number, null, null, v_reason,
    jsonb_build_object('status', 'active'), jsonb_build_object('status', 'cancelled'));
end;
$$;

grant execute on function
  app.create_invoice(uuid),
  app.apply_invoice_discount(uuid, text, bigint, text, text),
  app.mark_invoice_credit(uuid, text),
  app.record_payment(uuid, bigint, text, text, text, text, uuid),
  app.reverse_payment(uuid, text),
  app.cancel_invoice(uuid, text),
  app.percent_of(bigint, bigint),
  app.discount_approval_threshold_percent()
to authenticated;

-- Internal only: these are building blocks of a money transaction, never
-- callable on their own.
revoke all on function
  app.post_ledger_entry(uuid, text, text, bigint, text, uuid, text, uuid),
  app.claim_request(text, text, jsonb),
  app.complete_request(text, jsonb)
from anon, authenticated;
