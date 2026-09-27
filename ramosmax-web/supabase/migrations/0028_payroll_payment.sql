-- ===========================================================================
-- RamosMAX Web — Phase F — 0028: paying, reversing, locking a payroll
-- ===========================================================================
-- ONE `payroll_payment` ledger entry for the whole payroll, so Finance shows a
-- single outflow while every employee still has their own payslip.
--
-- Everything the payment touches is RE-CHECKED here: an allowance that is no
-- longer approved, a deduction that has changed, an incident that has been
-- cancelled or already recovered — any of them refuses the payment with
-- `stale_payroll` rather than paying something that no longer adds up.
-- ===========================================================================

/* The status of a loss incident after its amounts change. Ports incidentStatus(). */
create or replace function app.incident_status(
  p_current text, p_approved bigint, p_recovered bigint, p_outstanding bigint, p_scheduled boolean)
returns text
language sql
immutable
as $$
  select case
    when p_current = 'cancelled' then 'cancelled'
    when p_approved > 0 and p_outstanding = 0 then 'recovered'
    when p_recovered > 0 then 'partially_recovered'
    when p_scheduled then 'recovery_scheduled'
    else 'approved' end;
$$;

create or replace function app.pay_payroll(
  p_payroll    uuid,
  p_account    uuid,
  p_request_id text,
  p_reference  text default null,
  p_date       date default null
)
returns table (payroll_id uuid, transaction_id uuid, transaction_number text,
               total_net_ugx bigint, balance_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_pay     public.payroll%rowtype;
  v_item    public.payroll_items%rowtype;
  v_line    jsonb;
  v_ded     public.salary_deductions%rowtype;
  v_inc     public.loss_incidents%rowtype;
  v_a       public.worker_allowances%rowtype;
  v_id      uuid;
  v_txn     uuid;
  v_number  text;
  v_date    date;
  v_ref     text;
  v_account public.financial_accounts%rowtype;
  v_take    bigint;
  v_status  text;
  v_result  jsonb;
begin
  perform app.require_permission('payroll.pay');
  perform app.require_request_id(p_request_id);
  v_date := app.require_business_date(p_date, 'payment date');
  v_ref  := app.optional_text(p_reference, 'Payment reference', 60);

  v_earlier := app.claim_request(p_request_id, 'payroll_payment',
    jsonb_build_object('payroll', p_payroll, 'account', p_account));
  if v_earlier is not null then
    return query select (v_earlier ->> 'payroll_id')::uuid, (v_earlier ->> 'transaction_id')::uuid,
                        v_earlier ->> 'transaction_number', (v_earlier ->> 'total_net_ugx')::bigint,
                        (v_earlier ->> 'balance_ugx')::bigint;
    return;
  end if;

  select * into v_pay from public.payroll where id = p_payroll for update;
  if v_pay.id is null then
    raise exception 'That payroll could not be found.'
      using errcode = 'no_data_found', detail = 'payroll';
  end if;
  if v_pay.status in ('paid', 'locked') then
    raise exception 'This payroll has already been paid.'
      using errcode = 'raise_exception', detail = 'already_paid';
  end if;
  if v_pay.status <> 'approved' then
    raise exception 'Only an approved payroll can be paid.'
      using errcode = 'raise_exception', detail = 'not_approved';
  end if;
  if v_pay.employee_count = 0 then
    raise exception 'This payroll has nobody to pay.'
      using errcode = 'raise_exception', detail = 'empty_payroll';
  end if;

  -- ---- re-check everything the payment will touch -------------------------
  -- Aliased: `payroll_id` is also an OUT parameter of this function.
  for v_item in select i.* from public.payroll_items i where i.payroll_id = p_payroll and i.current loop
    foreach v_id in array v_item.allowance_ids loop
      select * into v_a from public.worker_allowances where id = v_id for update;
      if v_a.id is null or v_a.status <> 'approved' then
        raise exception 'Allowance % is no longer approved and unpaid. Correct the payroll first.',
          coalesce(v_a.allowance_number, v_id::text)
          using errcode = 'raise_exception', detail = 'stale_payroll';
      end if;
    end loop;

    for v_line in select * from jsonb_array_elements(v_item.deduction_lines) loop
      if (v_line ->> 'amountUgx')::bigint <= 0 then continue; end if;
      select * into v_ded from public.salary_deductions
       where id = (v_line ->> 'deductionId')::uuid for update;
      if v_ded.id is null or v_ded.status <> 'active'
         or v_ded.remaining_ugx < (v_line ->> 'amountUgx')::bigint
         or exists (select 1 from public.deduction_applications ap
                     where ap.deduction_id = v_ded.id and ap.payroll_id = p_payroll and not ap.reversed) then
        raise exception 'Deduction % has changed since the payroll was prepared. Correct the payroll first.',
          coalesce(v_ded.deduction_number, v_line ->> 'deductionId')
          using errcode = 'raise_exception', detail = 'stale_payroll';
      end if;
      if v_line ->> 'lossIncidentId' is not null then
        select * into v_inc from public.loss_incidents
         where id = (v_line ->> 'lossIncidentId')::uuid for update;
        if v_inc.id is null or v_inc.status = 'cancelled'
           or v_inc.outstanding_ugx < (v_line ->> 'amountUgx')::bigint then
          raise exception 'Loss % cannot be recovered as planned. Correct the payroll first.',
            coalesce(v_inc.loss_number, v_line ->> 'lossIncidentId')
            using errcode = 'raise_exception', detail = 'stale_payroll';
        end if;
      end if;
    end loop;
  end loop;

  -- ---- post the money -----------------------------------------------------
  -- A payroll whose total net pay is zero is marked paid without a ledger entry.
  if v_pay.total_net_ugx > 0 then
    if p_account is null then
      raise exception 'Choose the account to pay from.'
        using errcode = 'invalid_parameter_value', detail = 'account';
    end if;
    v_account := app.require_active_account(p_account);
    v_txn := app.post_transaction(
      p_type => 'payroll_payment', p_amount => v_pay.total_net_ugx, p_from => p_account,
      p_reference_type => 'payroll', p_reference_id => p_payroll,
      p_description => format('Payroll %s (%s): %s staff', v_pay.payroll_number,
                              v_pay.period_label, v_pay.employee_count),
      p_reference => v_ref, p_request_id => p_request_id, p_date => v_date,
      p_approved_by => v_pay.approved_by);
    select t.transaction_number into v_number from public.financial_transactions t where t.id = v_txn;
  end if;

  -- ---- apply it -----------------------------------------------------------
  -- Aliased: `payroll_id` is also an OUT parameter of this function.
  for v_item in select i.* from public.payroll_items i where i.payroll_id = p_payroll and i.current loop
    update public.payroll_items
       set status = 'paid', payment_status = 'paid',
           -- The payslip becomes visible to its employee only now.
           visible_to_staff = true, paid_at = now(), financial_transaction_id = v_txn
     where id = v_item.id;

    foreach v_id in array v_item.allowance_ids loop
      update public.worker_allowances
         set status = 'paid', paid_via = 'payroll', payroll_id = p_payroll,
             payroll_number = v_pay.payroll_number, paid_by = auth.uid(),
             paid_by_name = (select full_name from public.users where id = auth.uid()),
             paid_at = now(), paid_from_account_id = p_account,
             paid_from_account_name = v_account.name,
             financial_transaction_id = v_txn, financial_transaction_number = v_number,
             updated_by = auth.uid()
       where id = v_id;
    end loop;

    insert into public.workforce_events (type, reference_type, reference_id, audience, recipient_uid, payload)
    values ('payroll_paid', 'payroll_item', v_item.id, 'staff', v_item.staff_uid,
            jsonb_build_object('payrollNumber', v_pay.payroll_number));
    if v_item.total_deductions_ugx > 0 then
      insert into public.workforce_events (type, reference_type, reference_id, audience, recipient_uid, payload)
      values ('deduction_applied', 'payroll_item', v_item.id, 'staff', v_item.staff_uid,
              jsonb_build_object('payrollNumber', v_pay.payroll_number));
    end if;
  end loop;

  -- Deductions: taken once per payroll, recorded as an application.
  for v_line in
    select jsonb_array_elements(i.deduction_lines) from public.payroll_items i
     where i.payroll_id = p_payroll and i.current
  loop
    v_take := (v_line ->> 'amountUgx')::bigint;
    if v_take <= 0 then continue; end if;

    select * into v_ded from public.salary_deductions where id = (v_line ->> 'deductionId')::uuid;
    update public.salary_deductions
       set recovered_ugx = recovered_ugx + v_take,
           remaining_ugx = remaining_ugx - v_take,
           status = case when remaining_ugx - v_take = 0 then 'completed' else 'active' end,
           updated_by = auth.uid()
     where id = v_ded.id;

    insert into public.deduction_applications
      (deduction_id, payroll_id, payroll_number, period_key, amount_ugx)
    values (v_ded.id, p_payroll, v_pay.payroll_number, v_pay.period_key, v_take);

    perform app.audit('deduction.applied', 'payroll', v_ded.id::text, v_ded.staff_uid,
      v_ded.deduction_number, null,
      jsonb_build_object('remainingUgx', v_ded.remaining_ugx),
      jsonb_build_object('amountUgx', v_take, 'remainingUgx', v_ded.remaining_ugx - v_take,
                         'payrollNumber', v_pay.payroll_number));

    if v_ded.loss_incident_id is not null then
      select * into v_inc from public.loss_incidents where id = v_ded.loss_incident_id;
      v_status := app.incident_status(v_inc.status, v_inc.approved_recovery_ugx,
        v_inc.recovered_ugx + v_take, v_inc.outstanding_ugx - v_take, true);
      update public.loss_incidents
         set recovered_ugx = recovered_ugx + v_take,
             outstanding_ugx = outstanding_ugx - v_take,
             status = v_status, updated_by = auth.uid()
       where id = v_inc.id;
      perform app.audit('loss.recovered', 'losses', v_inc.id::text, v_inc.staff_uid,
        v_inc.loss_number, null,
        jsonb_build_object('status', v_inc.status, 'outstandingUgx', v_inc.outstanding_ugx),
        jsonb_build_object('status', v_status, 'amountUgx', v_take,
                           'outstandingUgx', v_inc.outstanding_ugx - v_take,
                           'payrollNumber', v_pay.payroll_number));
    end if;
  end loop;

  update public.payroll
     set status = 'paid', paid_by = auth.uid(),
         paid_by_name = (select full_name from public.users where id = auth.uid()),
         paid_at = now(), payment_date = v_date, payment_reference = v_ref,
         paid_from_account_id = p_account, paid_from_account_name = v_account.name,
         financial_transaction_id = v_txn, financial_transaction_number = v_number,
         payment_reversed_at = null, payment_reversal_reason = null, updated_by = auth.uid()
   where id = p_payroll;

  perform app.audit('payroll.paid', 'payroll', p_payroll::text, null, v_pay.payroll_number, null,
    jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', 'paid', 'totalNetUgx', v_pay.total_net_ugx,
                       'accountId', p_account, 'transactionNumber', v_number,
                       'employeeCount', v_pay.employee_count));

  v_result := jsonb_build_object('payroll_id', p_payroll, 'transaction_id', v_txn,
    'transaction_number', v_number, 'total_net_ugx', v_pay.total_net_ugx,
    'balance_ugx', (select a.balance_ugx from public.financial_accounts a where a.id = p_account));
  perform app.complete_request(p_request_id, v_result);

  return query select p_payroll, v_txn, v_number, v_pay.total_net_ugx,
    (select a.balance_ugx from public.financial_accounts a where a.id = p_account);
end;
$$;

/*
 * After payment, before locking: the ledger entry is reversed and everything
 * the payment applied is undone — allowances back to approved, deduction
 * applications marked reversed with their balances restored, loss recoveries
 * given back. The payroll returns to approved.
 */
create or replace function app.reverse_payroll_payment(p_payroll uuid, p_reason text)
returns table (payroll_id uuid, transaction_id uuid, transaction_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_pay    public.payroll%rowtype;
  v_reason text;
  v_txn    uuid;
  v_number text;
  v_app    public.deduction_applications%rowtype;
  v_ded    public.salary_deductions%rowtype;
  v_inc    public.loss_incidents%rowtype;
  v_status text;
begin
  perform app.require_permission('payroll.adjust');
  v_reason := app.require_reason(p_reason);

  select * into v_pay from public.payroll where id = p_payroll for update;
  if v_pay.id is null then
    raise exception 'That payroll could not be found.'
      using errcode = 'no_data_found', detail = 'payroll';
  end if;
  if v_pay.status = 'locked' then
    raise exception 'A locked payroll cannot be reversed. Adjust the next payroll instead.'
      using errcode = 'raise_exception', detail = 'locked';
  end if;
  if v_pay.status <> 'paid' then
    raise exception 'Only a paid payroll can be reversed.'
      using errcode = 'raise_exception', detail = 'not_paid';
  end if;

  if v_pay.financial_transaction_id is not null then
    v_txn := app.post_transaction(
      p_type => 'reversal', p_amount => v_pay.total_net_ugx,
      p_to => (select source_account_id from public.financial_transactions
                where id = v_pay.financial_transaction_id),
      p_reference_type => 'payroll', p_reference_id => p_payroll,
      p_description => 'Reversal of ' || v_pay.financial_transaction_number,
      p_reason => v_reason, p_reverses => v_pay.financial_transaction_id,
      p_reversal_of => 'payroll_payment', p_approved_by => auth.uid());
    select t.transaction_number into v_number from public.financial_transactions t where t.id = v_txn;
  end if;

  -- Give back every deduction this payroll took.
  for v_app in
    select ap.* from public.deduction_applications ap
     where ap.payroll_id = p_payroll and not ap.reversed for update
  loop
    select * into v_ded from public.salary_deductions where id = v_app.deduction_id for update;
    update public.salary_deductions
       set recovered_ugx = recovered_ugx - v_app.amount_ugx,
           remaining_ugx = remaining_ugx + v_app.amount_ugx,
           status = case when status = 'completed' then 'active' else status end,
           updated_by = auth.uid()
     where id = v_ded.id;
    update public.deduction_applications
       set reversed = true, reversed_at = now(), reversal_reason = v_reason
     where id = v_app.id;
    perform app.audit('deduction.reversed', 'payroll', v_ded.id::text, v_ded.staff_uid,
      v_ded.deduction_number, v_reason,
      jsonb_build_object('remainingUgx', v_ded.remaining_ugx),
      jsonb_build_object('remainingUgx', v_ded.remaining_ugx + v_app.amount_ugx,
                         'payrollNumber', v_pay.payroll_number));

    if v_ded.loss_incident_id is not null then
      select * into v_inc from public.loss_incidents where id = v_ded.loss_incident_id for update;
      v_status := app.incident_status(v_inc.status, v_inc.approved_recovery_ugx,
        v_inc.recovered_ugx - v_app.amount_ugx, v_inc.outstanding_ugx + v_app.amount_ugx,
        v_ded.status <> 'cancelled');
      update public.loss_incidents
         set recovered_ugx = recovered_ugx - v_app.amount_ugx,
             outstanding_ugx = outstanding_ugx + v_app.amount_ugx,
             status = v_status, updated_by = auth.uid()
       where id = v_inc.id;
      perform app.audit('loss.recovery_reversed', 'losses', v_inc.id::text, v_inc.staff_uid,
        v_inc.loss_number, v_reason,
        jsonb_build_object('status', v_inc.status, 'outstandingUgx', v_inc.outstanding_ugx),
        jsonb_build_object('status', v_status,
                           'outstandingUgx', v_inc.outstanding_ugx + v_app.amount_ugx));
    end if;
  end loop;

  update public.worker_allowances a
     set status = 'approved', paid_via = null, payroll_id = null, payroll_number = null,
         paid_by = null, paid_by_name = null, paid_at = null, paid_from_account_id = null,
         paid_from_account_name = null, financial_transaction_id = null,
         financial_transaction_number = null, payment_reversed_at = now(),
         payment_reversal_reason = v_reason, updated_by = auth.uid()
   where a.payroll_id = p_payroll and a.status = 'paid';

  update public.payroll_items i
     set status = 'approved', payment_status = 'unpaid', paid_at = null,
         payment_reversed_at = now(), visible_to_staff = false
   where i.payroll_id = p_payroll and i.current;

  update public.payroll
     set status = 'approved', paid_by = null, paid_by_name = null, paid_at = null,
         payment_date = null, paid_from_account_id = null, paid_from_account_name = null,
         financial_transaction_id = null, financial_transaction_number = null,
         payment_reversed_at = now(), payment_reversal_reason = v_reason,
         payment_reversal_transaction_id = v_txn, updated_by = auth.uid()
   where id = p_payroll;

  perform app.audit('payroll.payment_reversed', 'payroll', p_payroll::text, null,
    v_pay.payroll_number, v_reason,
    jsonb_build_object('status', 'paid', 'transactionNumber', v_pay.financial_transaction_number),
    jsonb_build_object('status', 'approved', 'reversalTransactionNumber', v_number,
                       'totalNetUgx', v_pay.total_net_ugx));

  return query select p_payroll, v_txn, v_number;
end;
$$;

create or replace function app.lock_payroll(p_payroll uuid)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_pay public.payroll%rowtype;
begin
  perform app.require_permission('payroll.approve');
  select * into v_pay from public.payroll where id = p_payroll for update;
  if v_pay.id is null then
    raise exception 'That payroll could not be found.'
      using errcode = 'no_data_found', detail = 'payroll';
  end if;
  if v_pay.status = 'locked' then
    raise exception 'This payroll is already locked.'
      using errcode = 'raise_exception', detail = 'already_locked';
  end if;
  if v_pay.status <> 'paid' then
    raise exception 'Only a paid payroll can be locked.'
      using errcode = 'raise_exception', detail = 'not_paid';
  end if;

  update public.payroll_items set status = 'locked' where payroll_id = p_payroll and current;
  update public.payroll set status = 'locked', locked_by = auth.uid(), locked_at = now(),
         updated_by = auth.uid() where id = p_payroll;

  perform app.audit('payroll.locked', 'payroll', p_payroll::text, null, v_pay.payroll_number, null,
    jsonb_build_object('status', 'paid'), jsonb_build_object('status', 'locked'));
  return 'locked';
end;
$$;

create or replace function app.cancel_payroll(p_payroll uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_pay    public.payroll%rowtype;
  v_reason text;
begin
  perform app.require_permission('payroll.adjust');
  v_reason := app.require_reason(p_reason);
  select * into v_pay from public.payroll where id = p_payroll for update;
  if v_pay.id is null then
    raise exception 'That payroll could not be found.'
      using errcode = 'no_data_found', detail = 'payroll';
  end if;
  if v_pay.status not in ('draft', 'prepared', 'pending_review', 'approved') then
    raise exception '%', case when v_pay.status = 'cancelled'
      then 'This payroll is already cancelled.'
      else 'A paid payroll cannot be cancelled. Reverse the payment first.' end
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;

  update public.payroll_items set current = false, status = 'cancelled'
   where payroll_id = p_payroll and current;
  -- The partial index on (frequency, period_key) excludes cancelled payrolls,
  -- so the period is free again.
  update public.payroll set status = 'cancelled', cancelled_by = auth.uid(),
         cancelled_at = now(), cancel_reason = v_reason, updated_by = auth.uid()
   where id = p_payroll;

  perform app.audit('payroll.cancelled', 'payroll', p_payroll::text, null, v_pay.payroll_number,
    v_reason, jsonb_build_object('status', v_pay.status),
    jsonb_build_object('status', 'cancelled'));
  return 'cancelled';
end;
$$;
