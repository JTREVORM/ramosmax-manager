-- ===========================================================================
-- RamosMAX Web — Phase F — 0025: daily allowances
-- ===========================================================================
-- Ports `functions/src/allowances.js`.
--
--   approved attendance ──calculate──► calculated ──decide──► approved ──pay──► paid
--                                          └──reject (reason)──► rejected
--
-- AN ALLOWANCE EXISTS ONLY FOR APPROVED ATTENDANCE of an eligible staff
-- member, and MONEY MOVES ONLY WHEN IT IS PAID. The amount is the salary
-- profile's own allowance or the policy default — decided here, never sent by
-- the browser. Being late never removes the allowance by itself: a manager
-- applies FULL, DEDUCT or REJECT.
-- ===========================================================================

/*
 * Why an attendance record earns no allowance, or null when it does. Ports
 * ineligibility() in order, because the order decides which reason is shown.
 */
create or replace function app.allowance_ineligibility(
  p_attendance public.attendance,
  p_policy     jsonb,
  p_version    public.salary_history
)
returns text
language sql
immutable
as $$
  select case
    when p_attendance.verification_status = 'rejected' then 'rejected'
    when p_attendance.verification_status <> 'approved' then 'not_verified'
    when p_attendance.status not in ('present', 'late') then 'not_present'
    when p_attendance.allowance_id is not null then 'already_calculated'
    when not p_attendance.working_day
         and not (p_policy ->> 'allowanceOnNonWorkingDays')::boolean then 'non_working_day'
    when (p_policy ->> 'requireClockOut')::boolean
         and p_attendance.clock_out_at is null then 'no_clock_out'
    when p_version.id is null or not p_version.active then 'no_salary_profile'
    when not p_version.allowance_eligible then 'not_eligible'
    when coalesce(p_version.allowance_amount_ugx,
                  (p_policy ->> 'defaultDailyAllowanceUgx')::bigint) <= 0 then 'no_allowance_amount'
    else null end;
$$;

create or replace function app.allowance_amount(p_version public.salary_history, p_policy jsonb)
returns bigint
language sql
immutable
as $$
  select coalesce(p_version.allowance_amount_ugx, (p_policy ->> 'defaultDailyAllowanceUgx')::bigint);
$$;

/* What the POLICY suggests for a late arrival. The manager still decides. */
create or replace function app.allowance_suggestion(
  p_late boolean, p_severely_late boolean, p_policy jsonb, p_amount bigint)
returns table (decision text, deduction_ugx bigint)
language sql
immutable
as $$
  select d, case when d = 'deduct' then least((p_policy ->> 'lateDeductionUgx')::bigint, p_amount)
                 when d = 'reject' then p_amount else 0::bigint end
    from (select case when not p_late then 'full'
                      when p_severely_late then 'reject'
                      else p_policy ->> 'lateAllowancePolicy' end as d) q;
$$;

/*
 * Creates at most one allowance per approved attendance record of one EAT
 * day. Calculating twice creates nothing new, because the record then carries
 * its allowance id.
 */
create or replace function app.calculate_allowances(p_day date default null)
returns table (allowance_id uuid, allowance_number text, staff_name text,
               amount_ugx bigint, status text, skipped_reason text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_day     date := coalesce(p_day, app.eat_day());
  v_policy  jsonb := app.payroll_policy();
  v_rec     public.attendance%rowtype;
  v_version public.salary_history%rowtype;
  v_why     text;
  v_amount  bigint;
  v_sugg    record;
  v_auto    boolean;
  v_number  text;
  v_id      uuid;
begin
  perform app.require_permission('allowances.calculate');
  if v_day > app.eat_day() then
    raise exception 'Allowances cannot be calculated for a future day.'
      using errcode = 'invalid_parameter_value', detail = 'date';
  end if;

  for v_rec in
    select * from public.attendance where business_day = v_day order by staff_name
  loop
    v_version := app.salary_version_on(v_rec.staff_uid, v_day);
    v_why := app.allowance_ineligibility(v_rec, v_policy, v_version);
    if v_why is not null then
      return query select null::uuid, null::text, v_rec.staff_name, null::bigint, null::text, v_why;
      continue;
    end if;

    v_amount := app.allowance_amount(v_version, v_policy);
    select * into v_sugg from app.allowance_suggestion(v_rec.late, v_rec.severely_late, v_policy, v_amount);
    -- On-time allowances may be approved on the spot when the policy says so;
    -- a late one always waits for a decision.
    v_auto := not v_rec.late and not (v_policy ->> 'allowanceApprovalRequired')::boolean;
    v_number := app.next_reference('allowance_number_seq', 'RMX-ALL-');

    insert into public.worker_allowances
      (allowance_number, staff_uid, staff_id, staff_name, staff_role, attendance_id,
       attendance_number, business_day, late, severely_late, minutes_late, salary_history_id,
       calculated_amount_ugx, suggested_decision, suggested_deduction_ugx,
       decision, approved_amount_ugx, status, auto_approved,
       approved_by, approved_by_name, approved_at, created_by, created_by_name, updated_by)
    values
      (v_number, v_rec.staff_uid, v_rec.staff_id, v_rec.staff_name, v_rec.staff_role, v_rec.id,
       v_rec.attendance_number, v_day, v_rec.late, v_rec.severely_late, v_rec.minutes_late, v_version.id,
       v_amount, v_sugg.decision, v_sugg.deduction_ugx,
       case when v_auto then 'full' end, case when v_auto then v_amount end,
       case when v_auto then 'approved' else 'calculated' end, v_auto,
       case when v_auto then auth.uid() end,
       case when v_auto then (select full_name from public.users where id = auth.uid()) end,
       case when v_auto then now() end,
       auth.uid(), (select full_name from public.users where id = auth.uid()), auth.uid())
    returning id into v_id;

    update public.attendance set allowance_id = v_id, updated_by = auth.uid() where id = v_rec.id;

    perform app.audit('allowance.calculated', 'payroll', v_id::text, v_rec.staff_uid, v_number, null, null,
      jsonb_build_object('allowanceNumber', v_number, 'staffUid', v_rec.staff_uid, 'day', v_day,
                         'calculatedAmountUgx', v_amount, 'late', v_rec.late,
                         'status', case when v_auto then 'approved' else 'calculated' end,
                         'suggestedDecision', v_sugg.decision));

    if v_auto then
      insert into public.workforce_events (type, reference_type, reference_id, audience, recipient_uid, payload)
      values ('allowance_approved', 'allowance', v_id, 'staff', v_rec.staff_uid,
              jsonb_build_object('allowanceNumber', v_number));
    else
      insert into public.workforce_events (type, reference_type, reference_id, audience, payload)
      values ('allowance_awaiting_approval', 'allowance', v_id, 'allowances.approve',
              jsonb_build_object('allowanceNumber', v_number));
    end if;

    return query select v_id, v_number, v_rec.staff_name, v_amount,
                        case when v_auto then 'approved' else 'calculated' end, null::text;
  end loop;
end;
$$;

/* Throws when any of these allowances is in a live payroll. */
create or replace function app.require_allowance_not_in_payroll(p_ids uuid[])
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_number text;
begin
  select i.payroll_number into v_number
    from public.payroll_items i
   where i.current and i.allowance_ids && p_ids
   limit 1;
  if v_number is not null then
    raise exception 'Payroll % already includes one of these allowances.', v_number
      using errcode = 'raise_exception', detail = 'allowance_in_payroll';
  end if;
end;
$$;

/*
 * The decision: FULL, DEDUCT or REJECT. With `allowances.approve` it is
 * final; with only `allowances.adjust` it waits as a proposal. Nobody decides
 * their own allowance.
 */
create or replace function app.review_allowance(
  p_allowances uuid[],
  p_decision   text,
  p_reason     text default null,
  p_deduction  bigint default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_policy jsonb := app.payroll_policy();
  v_final  boolean;
  v_reason text;
  v_a      public.worker_allowances%rowtype;
  v_deduction bigint;
  v_count  integer := 0;
begin
  perform app.require_permission('allowances.approve', 'allowances.adjust');
  v_final := 'allowances.approve' = any (app.effective_permissions());

  if p_decision not in ('full', 'deduct', 'reject') then
    raise exception 'Choose full, deduct or reject.'
      using errcode = 'invalid_parameter_value', detail = 'decision';
  end if;
  v_reason := case when p_decision = 'full' then app.optional_text(p_reason, 'Reason', 300)
                   else app.require_reason(p_reason) end;
  if p_allowances is null or coalesce(array_length(p_allowances, 1), 0) not between 1 and 50 then
    raise exception 'Choose between one and 50 allowances.'
      using errcode = 'invalid_parameter_value', detail = 'ids';
  end if;

  for v_a in select * from public.worker_allowances where id = any (p_allowances) for update loop
    perform app.require_not_own(v_a.staff_uid, 'You cannot decide your own allowance.');
    if v_a.status not in ('calculated', 'pending_approval') then
      raise exception '% is %.', v_a.allowance_number, replace(v_a.status, '_', ' ')
        using errcode = 'raise_exception', detail = 'invalid_status';
    end if;
    v_count := v_count + 1;
  end loop;
  if v_count <> array_length(p_allowances, 1) then
    raise exception 'That allowance could not be found.'
      using errcode = 'no_data_found', detail = 'allowance';
  end if;

  for v_a in select * from public.worker_allowances where id = any (p_allowances) loop
    v_deduction := 0;
    if p_decision = 'deduct' then
      v_deduction := coalesce(p_deduction,
        least((v_policy ->> 'lateDeductionUgx')::bigint, v_a.calculated_amount_ugx));
      if v_deduction > (v_policy ->> 'maxLateDeductionUgx')::bigint then
        raise exception 'The deduction cannot exceed UGX %.',
          to_char((v_policy ->> 'maxLateDeductionUgx')::bigint, 'FM999,999,999')
          using errcode = 'invalid_parameter_value', detail = 'deduction_too_large';
      end if;
      if v_deduction <= 0 or v_deduction >= v_a.calculated_amount_ugx then
        raise exception 'The deduction must leave part of the allowance. Use reject to pay nothing.'
          using errcode = 'invalid_parameter_value', detail = 'deduction_range';
      end if;
    elsif p_decision = 'reject' then
      v_deduction := v_a.calculated_amount_ugx;
    end if;

    if not v_final then
      -- A proposal, for someone who may approve.
      update public.worker_allowances
         set status = 'pending_approval', proposed_decision = p_decision,
             proposed_deduction_ugx = v_deduction, proposed_by = auth.uid(),
             proposed_by_name = (select full_name from public.users where id = auth.uid()),
             proposed_at = now(), proposal_reason = v_reason, updated_by = auth.uid()
       where id = v_a.id;
      perform app.audit('allowance.adjusted', 'payroll', v_a.id::text, v_a.staff_uid,
        v_a.allowance_number, v_reason,
        jsonb_build_object('status', v_a.status),
        jsonb_build_object('status', 'pending_approval', 'decision', p_decision,
                           'deductionUgx', v_deduction));
      continue;
    end if;

    update public.worker_allowances
       set status = case when p_decision = 'reject' then 'rejected' else 'approved' end,
           decision = p_decision,
           deduction_ugx = v_deduction,
           deduction_reason = case when p_decision <> 'full' then v_reason end,
           approved_amount_ugx = case when p_decision = 'reject' then 0
                                      else v_a.calculated_amount_ugx - v_deduction end,
           approved_by = case when p_decision <> 'reject' then auth.uid() end,
           approved_by_name = case when p_decision <> 'reject'
                                   then (select full_name from public.users where id = auth.uid()) end,
           approved_at = case when p_decision <> 'reject' then now() end,
           rejected_by = case when p_decision = 'reject' then auth.uid() end,
           rejected_at = case when p_decision = 'reject' then now() end,
           rejection_reason = case when p_decision = 'reject' then v_reason end,
           updated_by = auth.uid()
     where id = v_a.id;

    perform app.audit(
      case when p_decision = 'reject' then 'allowance.rejected' else 'allowance.approved' end,
      'payroll', v_a.id::text, v_a.staff_uid, v_a.allowance_number, v_reason,
      jsonb_build_object('status', v_a.status, 'calculatedAmountUgx', v_a.calculated_amount_ugx),
      jsonb_build_object('status', case when p_decision = 'reject' then 'rejected' else 'approved' end,
                         'decision', p_decision, 'deductionUgx', v_deduction,
                         'approvedAmountUgx', case when p_decision = 'reject' then 0
                                                   else v_a.calculated_amount_ugx - v_deduction end));

    if p_decision <> 'reject' then
      insert into public.workforce_events (type, reference_type, reference_id, audience, recipient_uid, payload)
      values ('allowance_approved', 'allowance', v_a.id, 'staff', v_a.staff_uid,
              jsonb_build_object('allowanceNumber', v_a.allowance_number));
    end if;
  end loop;

  return v_count;
end;
$$;

/*
 * Pays approved allowances from one account: ONE `allowance_payment` ledger
 * entry for the batch, every allowance marked paid, in one transaction. A
 * retried request with the same id pays once.
 */
create or replace function app.pay_allowances(
  p_allowances uuid[],
  p_account    uuid,
  p_request_id text,
  p_reference  text default null,
  p_date       date default null
)
returns table (transaction_id uuid, transaction_number text, count integer,
               total_ugx bigint, balance_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_a       public.worker_allowances%rowtype;
  v_total   bigint := 0;
  v_count   integer := 0;
  v_txn     uuid;
  v_number  text;
  v_date    date;
  v_ref     text;
  v_account public.financial_accounts%rowtype;
  v_result  jsonb;
  v_numbers text[] := '{}';
begin
  perform app.require_permission('allowances.pay');
  perform app.require_request_id(p_request_id);
  v_date := app.require_business_date(p_date, 'payment date');
  v_ref  := app.optional_text(p_reference, 'Payment reference', 60);

  if p_allowances is null or coalesce(array_length(p_allowances, 1), 0) not between 1 and 100 then
    raise exception 'Choose between one and 100 allowances.'
      using errcode = 'invalid_parameter_value', detail = 'ids';
  end if;

  v_earlier := app.claim_request(p_request_id, 'allowance_payment',
    jsonb_build_object('allowances', to_jsonb(p_allowances), 'account', p_account));
  if v_earlier is not null then
    return query select (v_earlier ->> 'transaction_id')::uuid, v_earlier ->> 'transaction_number',
                        (v_earlier ->> 'count')::integer, (v_earlier ->> 'total_ugx')::bigint,
                        (v_earlier ->> 'balance_ugx')::bigint;
    return;
  end if;

  for v_a in select * from public.worker_allowances where id = any (p_allowances) for update loop
    perform app.require_not_own(v_a.staff_uid, 'Someone else must pay your allowance.');
    if v_a.status = 'paid' then
      raise exception '% has already been paid.', v_a.allowance_number
        using errcode = 'raise_exception', detail = 'already_paid';
    end if;
    if v_a.status <> 'approved' then
      raise exception '% is not approved.', v_a.allowance_number
        using errcode = 'raise_exception', detail = 'not_approved';
    end if;
    if coalesce(v_a.approved_amount_ugx, 0) <= 0 then
      raise exception '% has nothing to pay.', v_a.allowance_number
        using errcode = 'raise_exception', detail = 'nothing_to_pay';
    end if;
    v_total := v_total + v_a.approved_amount_ugx;
    v_count := v_count + 1;
    v_numbers := v_numbers || v_a.allowance_number;
  end loop;
  if v_count <> array_length(p_allowances, 1) then
    raise exception 'That allowance could not be found.'
      using errcode = 'no_data_found', detail = 'allowance';
  end if;

  perform app.require_allowance_not_in_payroll(p_allowances);
  v_account := app.require_active_account(p_account);

  -- One ledger entry for the batch, as the reference posts it.
  v_txn := app.post_transaction(
    p_type => 'allowance_payment', p_amount => v_total, p_from => p_account,
    p_reference_type => 'allowance_batch', p_reference_id => null,
    p_description => case when v_count = 1
      then format('Daily allowance %s', v_numbers[1])
      else format('Daily allowances: %s (%s … %s)', v_count, v_numbers[1], v_numbers[array_length(v_numbers, 1)]) end,
    p_reference => v_ref, p_request_id => p_request_id, p_date => v_date,
    p_approved_by => auth.uid());

  select t.transaction_number into v_number from public.financial_transactions t where t.id = v_txn;

  for v_a in select * from public.worker_allowances where id = any (p_allowances) loop
    update public.worker_allowances
       set status = 'paid', paid_via = 'direct', paid_by = auth.uid(),
           paid_by_name = (select full_name from public.users where id = auth.uid()),
           paid_at = now(), paid_from_account_id = p_account,
           paid_from_account_name = v_account.name, payment_reference = v_ref,
           financial_transaction_id = v_txn, financial_transaction_number = v_number,
           updated_by = auth.uid()
     where id = v_a.id;
    perform app.audit('allowance.paid', 'payroll', v_a.id::text, v_a.staff_uid,
      v_a.allowance_number, null,
      jsonb_build_object('status', 'approved'),
      jsonb_build_object('status', 'paid', 'amountUgx', v_a.approved_amount_ugx,
                         'accountId', p_account, 'transactionNumber', v_number));
  end loop;

  v_result := jsonb_build_object('transaction_id', v_txn, 'transaction_number', v_number,
    'count', v_count, 'total_ugx', v_total,
    'balance_ugx', (select a.balance_ugx from public.financial_accounts a where a.id = p_account));
  perform app.complete_request(p_request_id, v_result);

  return query select v_txn, v_number, v_count, v_total,
    (select a.balance_ugx from public.financial_accounts a where a.id = p_account);
end;
$$;

/*
 * Reverses a direct allowance payment: the money goes back and every
 * allowance of that payment returns to approved. Finance's generic reversal
 * refuses allowance payments, so the two can never disagree.
 */
create or replace function app.reverse_allowance_payment(p_transaction uuid, p_reason text)
returns table (transaction_id uuid, transaction_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_original public.financial_transactions%rowtype;
  v_reason   text;
  v_txn      uuid;
  v_number   text;
  v_a        public.worker_allowances%rowtype;
begin
  perform app.require_permission('allowances.adjust');
  v_reason := app.require_reason(p_reason);

  select * into v_original from public.financial_transactions where id = p_transaction for update;
  if v_original.id is null then
    raise exception 'That transaction could not be found.'
      using errcode = 'no_data_found', detail = 'transaction';
  end if;
  if v_original.entry_type <> 'allowance_payment' then
    raise exception 'That is not an allowance payment.'
      using errcode = 'invalid_parameter_value', detail = 'wrong_type';
  end if;
  if v_original.status = 'reversed' then
    raise exception 'This payment has already been reversed.'
      using errcode = 'raise_exception', detail = 'already_reversed';
  end if;

  v_txn := app.post_transaction(
    p_type => 'reversal', p_amount => v_original.amount_ugx,
    p_to => v_original.source_account_id,
    p_reference_type => v_original.reference_type, p_reference_id => v_original.reference_id,
    p_description => 'Reversal of ' || v_original.transaction_number,
    p_reason => v_reason, p_reverses => p_transaction, p_reversal_of => v_original.entry_type,
    p_approved_by => auth.uid());
  select t.transaction_number into v_number from public.financial_transactions t where t.id = v_txn;

  for v_a in
    select * from public.worker_allowances
     where financial_transaction_id = p_transaction and status = 'paid' for update
  loop
    update public.worker_allowances
       set status = 'approved', paid_via = null, paid_by = null, paid_by_name = null, paid_at = null,
           paid_from_account_id = null, paid_from_account_name = null, payment_reference = null,
           financial_transaction_id = null, financial_transaction_number = null,
           payment_reversed_at = now(), payment_reversal_reason = v_reason, updated_by = auth.uid()
     where id = v_a.id;
    perform app.audit('allowance.payment_reversed', 'payroll', v_a.id::text, v_a.staff_uid,
      v_a.allowance_number, v_reason,
      jsonb_build_object('status', 'paid', 'transactionNumber', v_original.transaction_number),
      jsonb_build_object('status', 'approved', 'reversalTransactionNumber', v_number));
  end loop;

  return query select v_txn, v_number;
end;
$$;

/* Cancels allowances that are not paid and not in a payroll. */
create or replace function app.cancel_allowance(p_allowances uuid[], p_reason text)
returns integer
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_reason text;
  v_a      public.worker_allowances%rowtype;
  v_count  integer := 0;
begin
  perform app.require_permission('allowances.adjust');
  v_reason := app.require_reason(p_reason);

  for v_a in select * from public.worker_allowances where id = any (p_allowances) for update loop
    perform app.require_not_own(v_a.staff_uid, 'You cannot cancel your own allowance.');
    if v_a.status not in ('calculated', 'pending_approval', 'approved') then
      raise exception '% is % and cannot be cancelled.', v_a.allowance_number,
        replace(v_a.status, '_', ' ')
        using errcode = 'raise_exception', detail = 'invalid_status';
    end if;
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then
    raise exception 'Choose at least one allowance.'
      using errcode = 'invalid_parameter_value', detail = 'ids';
  end if;

  perform app.require_allowance_not_in_payroll(p_allowances);

  for v_a in select * from public.worker_allowances where id = any (p_allowances) loop
    update public.worker_allowances
       set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
           cancel_reason = v_reason, updated_by = auth.uid()
     where id = v_a.id;
    -- The day becomes calculable again.
    update public.attendance set allowance_id = null, updated_by = auth.uid()
     where id = v_a.attendance_id and allowance_id = v_a.id;
    perform app.audit('allowance.cancelled', 'payroll', v_a.id::text, v_a.staff_uid,
      v_a.allowance_number, v_reason,
      jsonb_build_object('status', v_a.status), jsonb_build_object('status', 'cancelled'));
  end loop;

  return v_count;
end;
$$;
