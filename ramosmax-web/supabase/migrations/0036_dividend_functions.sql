-- ===========================================================================
-- RamosMAX Web — Final phase — 0036: dividends
-- ===========================================================================
-- Ports `functions/src/dividends.js`.
--
--   draft ──calculate──► draft + allocations ──declare──► declared ──approve──► approved
--     ▲ (recalculate: earlier allocations kept, superseded)   │
--     └─────────────── return (reason) ◄──────────────────────┘
--   approved ──pay──► partially_paid ──pay the rest──► paid
--   paid / partially_paid ──reverse one payment──► partially_paid / approved
--   nothing paid ──cancel (reason)──► cancelled
--
-- RamosMAX does NOT work out profit or what is legally distributable, and
-- applies NO tax or other deduction: `deductions_ugx` exists and is always 0.
-- An authorised person enters the amount the business approved.
--
-- Eligibility is OWNERSHIP AT THE END OF THE RECORD DATE, read from the
-- immutable share ledger — never today's holdings. Once calculated, the
-- allocations are frozen and the record date is locked, so no later share
-- transaction can move them.
-- ===========================================================================

create or replace function app.read_dividend(p_id uuid)
returns public.dividends
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare v public.dividends%rowtype;
begin
  select * into v from public.dividends where id = p_id;
  if v.id is null then
    raise exception 'That dividend could not be found.'
      using errcode = 'no_data_found', detail = 'dividend_not_found';
  end if;
  return v;
end;
$$;

/* Every payable allocation paid → paid; some → partially_paid; none → approved. */
create or replace function app.dividend_status_after(p_paid_count integer, p_payable_count integer)
returns text
language sql
immutable
as $$
  select case when p_paid_count = 0 then 'approved'
              when p_paid_count >= p_payable_count then 'paid'
              else 'partially_paid' end;
$$;

create or replace function app.create_dividend(
  p_financial_period text,
  p_record_date      date,
  p_request_id       text,
  p_method           text default 'pool',
  p_total_distributable_ugx bigint default null,
  p_dividend_per_share_ugx  bigint default null,
  p_declaration_date date default null,
  p_payment_date     date default null,
  p_class            text default null,
  p_notes            text default null
)
returns table (dividend_id uuid, dividend_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_cls     public.share_classes%rowtype;
  v_number  text;
  v_id      uuid;
  v_record  date;
  v_declare date;
  v_pay     date;
begin
  perform app.require_permission('dividends.create');
  perform app.require_request_id(p_request_id);
  if p_method not in ('pool', 'per_share') then
    raise exception 'Choose a total amount or an amount per share.'
      using errcode = 'invalid_parameter_value', detail = 'method';
  end if;
  -- A dividend may be declared for a future record date; it cannot be
  -- calculated until that date has been reached.
  v_record  := app.require_business_date(p_record_date, 'record date', 366);
  v_declare := app.require_business_date(p_declaration_date, 'declaration date', 366);
  v_pay     := case when p_payment_date is null then null
                    else app.require_business_date(p_payment_date, 'payment date', 366) end;
  if v_pay is not null and v_pay < v_record then
    raise exception 'The payment date cannot be before the record date.'
      using errcode = 'invalid_parameter_value', detail = 'payment_date';
  end if;
  if p_method = 'pool' then
    perform app.require_amount(p_total_distributable_ugx, 'distributable amount', 1, app.max_capital_ugx());
  else
    perform app.require_amount(p_dividend_per_share_ugx, 'dividend per share', 1, app.max_share_value_ugx());
  end if;

  v_earlier := app.claim_request(p_request_id, 'dividend_create',
    jsonb_build_object('period', p_financial_period, 'record', v_record));
  if v_earlier is not null then
    return query select (v_earlier ->> 'dividend_id')::uuid, v_earlier ->> 'dividend_number';
    return;
  end if;

  if p_class is not null then v_cls := app.read_share_class(p_class); end if;

  v_number := app.next_reference('dividend_number_seq', 'RMX-DIV-');
  insert into public.dividends
    (dividend_number, financial_period, declaration_date, record_date, payment_date,
     calculation_method, class_id, class_code, notes, total_distributable_ugx,
     dividend_per_share_ugx, request_id, created_by, created_by_name, updated_by)
  values
    (v_number, app.require_text(p_financial_period, 'Financial period', 60), v_declare, v_record,
     v_pay, p_method, v_cls.id, v_cls.code, app.optional_text(p_notes, 'Notes', 500),
     case when p_method = 'pool' then p_total_distributable_ugx end,
     case when p_method = 'per_share' then p_dividend_per_share_ugx end,
     p_request_id, auth.uid(), (select full_name from public.users where id = auth.uid()), auth.uid())
  returning id into v_id;

  perform app.audit('dividend.created', 'shareholders', v_id::text, null, v_number, null, null,
    jsonb_build_object('dividendNumber', v_number, 'financialPeriod', p_financial_period,
                       'recordDate', v_record, 'calculationMethod', p_method,
                       'totalDistributableUgx', p_total_distributable_ugx,
                       'dividendPerShareUgx', p_dividend_per_share_ugx, 'classCode', v_cls.code));

  perform app.complete_request(p_request_id,
    jsonb_build_object('dividend_id', v_id, 'dividend_number', v_number));
  return query select v_id, v_number;
end;
$$;

/* Changes a draft. Any calculation is discarded: allocations kept, superseded. */
create or replace function app.update_dividend(
  p_dividend uuid,
  p_financial_period text default null,
  p_record_date      date default null,
  p_method           text default null,
  p_total_distributable_ugx bigint default null,
  p_dividend_per_share_ugx  bigint default null,
  p_declaration_date date default null,
  p_payment_date     date default null,
  p_notes            text default null,
  p_reason           text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_d      public.dividends%rowtype;
  v_method text;
  v_record date;
begin
  perform app.require_permission('dividends.create');
  select * into v_d from public.dividends where id = p_dividend for update;
  if v_d.id is null then
    raise exception 'That dividend could not be found.'
      using errcode = 'no_data_found', detail = 'dividend_not_found';
  end if;
  if v_d.status <> 'draft' then
    raise exception 'Only a draft dividend can be changed.'
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;
  v_method := coalesce(p_method, v_d.calculation_method);
  v_record := coalesce(app.require_business_date(p_record_date, 'record date', 366), v_d.record_date);

  -- Every earlier allocation is kept and marked superseded; nothing is deleted.
  update public.dividend_allocations
     set current = false, dividend_status = 'superseded'
   where dividend_id = p_dividend and current;

  update public.dividends
     set financial_period = case when p_financial_period is null then financial_period
                                 else app.require_text(p_financial_period, 'Financial period', 60) end,
         record_date = v_record,
         declaration_date = coalesce(p_declaration_date, declaration_date),
         payment_date = coalesce(p_payment_date, payment_date),
         calculation_method = v_method,
         total_distributable_ugx = case when v_method = 'pool'
                                        then coalesce(p_total_distributable_ugx, total_distributable_ugx) end,
         dividend_per_share_ugx = case when v_method = 'per_share'
                                       then coalesce(p_dividend_per_share_ugx, dividend_per_share_ugx) end,
         notes = case when p_notes is null then notes else app.optional_text(p_notes, 'Notes', 500) end,
         -- The calculation is discarded with the change.
         calculated_at = null, calculated_by = null, calculated_by_name = null, record_locked = false,
         eligible_shares = 0, eligible_shareholder_count = 0, allocated_ugx = 0, unallocated_ugx = 0,
         allocation_count = 0, payable_count = 0, outstanding_ugx = 0, snapshot = null,
         updated_by = auth.uid()
   where id = p_dividend;

  perform app.audit('dividend.updated', 'shareholders', p_dividend::text, null, v_d.dividend_number,
    app.optional_text(p_reason, 'Reason', 300),
    jsonb_build_object('financialPeriod', v_d.financial_period, 'recordDate', v_d.record_date,
                       'calculationMethod', v_d.calculation_method),
    jsonb_build_object('financialPeriod', coalesce(p_financial_period, v_d.financial_period),
                       'recordDate', v_record, 'calculationMethod', v_method));
  return 'draft';
end;
$$;

-- ---------------------------------------------------------------------------
-- Calculation: the record-date snapshot
-- ---------------------------------------------------------------------------

create or replace function app.calculate_dividend(p_dividend uuid)
returns table (dividend_id uuid, eligible_shares bigint, allocation_count integer,
               allocated_ugx bigint, unallocated_ugx bigint, per_share_rate numeric)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_d          public.dividends%rowtype;
  v_total      bigint;
  v_pool       bigint;
  v_per_share  numeric;
  v_allocated  bigint := 0;
  v_count      integer := 0;
  v_payable    integer := 0;
  v_version    integer;
  v_h          record;
  v_gross      bigint;
  v_holders    jsonb := '[]'::jsonb;
begin
  perform app.require_permission('dividends.calculate');
  select * into v_d from public.dividends where id = p_dividend for update;
  if v_d.id is null then
    raise exception 'That dividend could not be found.'
      using errcode = 'no_data_found', detail = 'dividend_not_found';
  end if;
  if v_d.status <> 'draft' then
    raise exception 'Only a draft dividend can be calculated.'
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;
  if v_d.record_date > app.eat_day() then
    raise exception 'Allocations can be calculated once the record date (%) has been reached.',
      v_d.record_date
      using errcode = 'raise_exception', detail = 'record_date_future';
  end if;

  -- Ownership at the END of the record date, from the immutable ledger.
  select coalesce(sum(h.shares), 0)::bigint into v_total
    from app.holdings_as_of(v_d.record_date, v_d.class_id) h where h.shares > 0;
  if v_total = 0 then
    raise exception 'Nobody held eligible shares at the end of the record date.'
      using errcode = 'raise_exception', detail = 'no_eligible_shares';
  end if;

  if v_d.calculation_method = 'per_share' then
    v_per_share := v_d.dividend_per_share_ugx;
    if v_per_share * v_total > app.max_capital_ugx() then
      raise exception 'That dividend is too large.'
        using errcode = 'invalid_parameter_value', detail = 'amount';
    end if;
    v_pool := (v_per_share * v_total)::bigint;
  else
    v_pool := v_d.total_distributable_ugx;
    -- For display only; each allocation below is exact integer arithmetic.
    v_per_share := round(v_pool::numeric / v_total, 4);
  end if;

  -- Aliased: `dividend_id` is also an OUT parameter of this function.
  update public.dividend_allocations a
     set current = false, dividend_status = 'superseded'
   where a.dividend_id = p_dividend and a.current;
  v_version := v_d.version + 1;

  for v_h in
    select h.shareholder_id, h.shares, s.shareholder_number, s.full_name, s.linked_uid
      from app.holdings_as_of(v_d.record_date, v_d.class_id) h
      join public.shareholders s on s.id = h.shareholder_id
     where h.shares > 0
     order by h.shares desc, s.shareholder_number
  loop
    -- Pool: floor to the shilling. The few shillings left over are reported,
    -- never invented and never paid.
    v_gross := case when v_d.calculation_method = 'per_share'
                    then (v_per_share * v_h.shares)::bigint
                    else floor(v_pool::numeric * v_h.shares / v_total)::bigint end;

    insert into public.dividend_allocations
      (allocation_number, dividend_id, dividend_number, financial_period, record_date,
       class_id, class_code, shareholder_id, shareholder_number, shareholder_name, linked_uid,
       shares_at_record_date, total_shares_at_record_date, ownership_percent_at_record_date,
       dividend_per_share_ugx, per_share_rate, gross_ugx, deductions_ugx, net_ugx, payment_status,
       dividend_status, version)
    values
      (app.next_reference('allocation_number_seq', 'RMX-DIV-PAY-'), p_dividend, v_d.dividend_number,
       v_d.financial_period, v_d.record_date, v_d.class_id, v_d.class_code,
       v_h.shareholder_id, v_h.shareholder_number, v_h.full_name, v_h.linked_uid,
       v_h.shares, v_total, app.ownership_percent(v_h.shares, v_total),
       case when v_d.calculation_method = 'per_share' then v_d.dividend_per_share_ugx end,
       v_per_share, v_gross, 0, v_gross,
       case when v_gross > 0 then 'unpaid' else 'not_payable' end, 'draft', v_version);

    v_allocated := v_allocated + v_gross;
    v_count := v_count + 1;
    if v_gross > 0 then v_payable := v_payable + 1; end if;
    v_holders := v_holders || jsonb_build_array(jsonb_build_object(
      'shareholderId', v_h.shareholder_id, 'shareholderNumber', v_h.shareholder_number,
      'shares', v_h.shares, 'ownershipPercent', app.ownership_percent(v_h.shares, v_total)));
  end loop;

  update public.dividends
     set total_distributable_ugx = v_pool,
         per_share_rate          = v_per_share,
         eligible_shares         = v_total,
         eligible_shareholder_count = v_count,
         allocated_ugx           = v_allocated,
         unallocated_ugx         = v_pool - v_allocated,
         outstanding_ugx         = v_allocated,
         allocation_count        = v_count,
         payable_count           = v_payable,
         -- From here, ownership on or before the record date is FROZEN.
         record_locked           = true,
         snapshot                = jsonb_build_object('asOf', v_d.record_date,
                                                      'totalShares', v_total, 'holders', v_holders),
         calculated_at           = now(),
         calculated_by           = auth.uid(),
         calculated_by_name      = (select full_name from public.users where id = auth.uid()),
         version                 = v_version,
         updated_by              = auth.uid()
   where id = p_dividend;

  perform app.audit('dividend.calculated', 'shareholders', p_dividend::text, null,
    v_d.dividend_number, null, null,
    jsonb_build_object('recordDate', v_d.record_date, 'eligibleShares', v_total,
                       'eligibleShareholders', v_count, 'totalDistributableUgx', v_pool,
                       'perShareRate', v_per_share, 'allocatedUgx', v_allocated,
                       'unallocatedUgx', v_pool - v_allocated, 'version', v_version));

  return query select p_dividend, v_total, v_count, v_allocated, v_pool - v_allocated, v_per_share;
end;
$$;

-- ---------------------------------------------------------------------------
-- Declare / return / approve
-- ---------------------------------------------------------------------------

create or replace function app.update_dividend_status(
  p_dividend uuid, p_action text, p_reason text default null)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_d      public.dividends%rowtype;
  v_reason text;
  v_status text;
  v_policy jsonb;
  v_holders uuid[];
begin
  if p_action not in ('declare', 'return', 'approve') then
    raise exception 'Choose a valid action.'
      using errcode = 'invalid_parameter_value', detail = 'action';
  end if;
  perform app.require_permission(case when p_action = 'declare' then 'dividends.declare'
                                      else 'dividends.approve' end);
  v_reason := case when p_action = 'return' then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;

  select * into v_d from public.dividends where id = p_dividend for update;
  if v_d.id is null then
    raise exception 'That dividend could not be found.'
      using errcode = 'no_data_found', detail = 'dividend_not_found';
  end if;

  if p_action = 'declare' then
    if v_d.status <> 'draft' then
      raise exception 'Only a draft dividend can be declared.'
        using errcode = 'raise_exception', detail = 'invalid_status';
    end if;
    if v_d.calculated_at is null or v_d.allocation_count = 0 then
      raise exception 'Calculate the allocations before declaring.'
        using errcode = 'raise_exception', detail = 'not_calculated';
    end if;
    v_status := 'declared';
    update public.dividends
       set status = v_status, declared_by = auth.uid(),
           declared_by_name = (select full_name from public.users where id = auth.uid()),
           declared_at = now(), returned_reason = null, updated_by = auth.uid()
     where id = p_dividend;
    insert into public.ownership_events (type, reference_type, reference_id, audience, payload)
    values ('dividend_declared', 'dividend', p_dividend, 'dividends.approve',
            jsonb_build_object('dividendNumber', v_d.dividend_number));

  elsif p_action = 'return' then
    if v_d.status <> 'declared' then
      raise exception 'Only a declared dividend can be returned to draft.'
        using errcode = 'raise_exception', detail = 'invalid_status';
    end if;
    v_status := 'draft';
    update public.dividends
       set status = v_status, declared_by = null, declared_by_name = null, declared_at = null,
           returned_reason = v_reason, updated_by = auth.uid()
     where id = p_dividend;

  else
    if v_d.status = 'approved' then
      raise exception 'This dividend is already approved.'
        using errcode = 'raise_exception', detail = 'already_approved';
    end if;
    if v_d.status <> 'declared' then
      raise exception 'Only a declared dividend can be approved.'
        using errcode = 'raise_exception', detail = 'invalid_status';
    end if;
    v_policy := app.dividend_policy();
    if (v_policy ->> 'requireAdminApproval')::boolean and app.current_role_id() <> 'admin' then
      raise exception 'Dividends must be approved by an Administrator.'
        using errcode = 'insufficient_privilege', detail = 'admin_approval_required';
    end if;
    if v_d.declared_by = auth.uid() and app.current_role_id() <> 'admin' then
      raise exception 'Another person must approve a dividend you declared.'
        using errcode = 'insufficient_privilege', detail = 'self_approval';
    end if;
    select array_agg(distinct a.shareholder_id) into v_holders
      from public.dividend_allocations a where a.dividend_id = p_dividend and a.current;
    perform app.require_not_own_shareholding(coalesce(v_holders, '{}'), 'approve a dividend that pays');
    v_status := 'approved';
    update public.dividends
       set status = v_status, approved_by = auth.uid(),
           approved_by_name = (select full_name from public.users where id = auth.uid()),
           approved_at = now(), updated_by = auth.uid()
     where id = p_dividend;
    insert into public.ownership_events (type, reference_type, reference_id, audience, payload)
    values ('dividend_approved', 'dividend', p_dividend, 'dividends.pay',
            jsonb_build_object('dividendNumber', v_d.dividend_number));
  end if;

  update public.dividend_allocations
     set dividend_status = v_status where dividend_id = p_dividend and current;

  perform app.audit('dividend.' || case p_action when 'declare' then 'declared'
                                                 when 'return' then 'returned'
                                                 else 'approved' end,
    'shareholders', p_dividend::text, null, v_d.dividend_number, v_reason,
    jsonb_build_object('status', v_d.status),
    jsonb_build_object('status', v_status, 'allocatedUgx', v_d.allocated_ugx));
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payment and reversal
-- ---------------------------------------------------------------------------

/*
 * Pays approved allocations from one account: ONE `dividend_payment` entry per
 * allocation. The ledger refuses an overdraft, so if the money is not there
 * nothing at all is paid.
 */
create or replace function app.pay_dividend(
  p_dividend uuid, p_allocations uuid[], p_account uuid, p_request_id text,
  p_reference text default null, p_payment_date date default null)
returns table (dividend_id uuid, status text, amount_ugx bigint, allocations_paid integer,
               balance_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_d       public.dividends%rowtype;
  v_a       public.dividend_allocations%rowtype;
  v_acct    public.financial_accounts%rowtype;
  v_id      uuid;
  v_txn     uuid;
  v_number  text;
  v_total   bigint := 0;
  v_count   integer := 0;
  v_status  text;
  v_date    date;
  v_holders uuid[];
begin
  perform app.require_permission('dividends.pay');
  perform app.require_request_id(p_request_id);
  if p_allocations is null or coalesce(array_length(p_allocations, 1), 0) not between 1 and 50 then
    raise exception 'Choose between one and 50 allocations.'
      using errcode = 'invalid_parameter_value', detail = 'allocations';
  end if;
  v_date := app.require_business_date(p_payment_date, 'payment date');

  v_earlier := app.claim_request(p_request_id, 'dividend_payment',
    jsonb_build_object('dividend', p_dividend, 'account', p_account,
                       'allocations', to_jsonb(p_allocations)));
  if v_earlier is not null then
    return query select (v_earlier ->> 'dividend_id')::uuid, v_earlier ->> 'status',
                        (v_earlier ->> 'amount_ugx')::bigint,
                        (v_earlier ->> 'allocations_paid')::integer,
                        (v_earlier ->> 'balance_ugx')::bigint;
    return;
  end if;

  select * into v_d from public.dividends where id = p_dividend for update;
  if v_d.id is null then
    raise exception 'That dividend could not be found.'
      using errcode = 'no_data_found', detail = 'dividend_not_found';
  end if;
  if v_d.status = 'paid' then
    raise exception 'This dividend has already been paid in full.'
      using errcode = 'raise_exception', detail = 'already_paid';
  end if;
  if v_d.status not in ('approved', 'partially_paid') then
    raise exception 'Only an approved dividend can be paid.'
      using errcode = 'raise_exception', detail = 'not_approved';
  end if;

  -- Check every allocation before paying any of them.
  foreach v_id in array p_allocations loop
    select * into v_a from public.dividend_allocations a where a.id = v_id for update;
    if v_a.id is null or v_a.dividend_id <> p_dividend or not v_a.current then
      raise exception 'One of the allocations does not belong to this dividend.'
        using errcode = 'no_data_found', detail = 'allocation_not_found';
    end if;
    if v_a.payment_status = 'paid' then
      raise exception '% has already been paid.', v_a.allocation_number
        using errcode = 'raise_exception', detail = 'already_paid';
    end if;
    if v_a.payment_status <> 'unpaid' or v_a.net_ugx <= 0 then
      raise exception '% has nothing to pay.', v_a.allocation_number
        using errcode = 'raise_exception', detail = 'not_payable';
    end if;
  end loop;

  select array_agg(distinct a.shareholder_id) into v_holders
    from public.dividend_allocations a where a.id = any (p_allocations);
  perform app.require_not_own_shareholding(coalesce(v_holders, '{}'), 'pay a dividend to');
  v_acct := app.require_active_account(p_account);

  foreach v_id in array p_allocations loop
    select * into v_a from public.dividend_allocations a where a.id = v_id;
    v_txn := app.post_transaction(
      p_type => 'dividend_payment', p_amount => v_a.net_ugx, p_from => p_account,
      p_reference_type => 'dividend_allocation', p_reference_id => v_id,
      p_description => format('Dividend %s (%s, %s) to %s', v_a.allocation_number,
                              v_d.dividend_number, v_d.financial_period, v_a.shareholder_number),
      -- The request key belongs to the BATCH (claimed above), not to each
      -- entry: one payment can post several entries.
      p_reference => p_reference, p_date => v_date, p_approved_by => v_d.approved_by);
    select t.transaction_number into v_number
      from public.financial_transactions t where t.id = v_txn;

    update public.dividend_allocations a
       set payment_status = 'paid', paid_at = now(), payment_date = v_date,
           payment_reference = p_reference, account_id = p_account, account_name = v_acct.name,
           financial_transaction_id = v_txn, financial_transaction_number = v_number,
           paid_by = auth.uid(),
           paid_by_name = (select full_name from public.users where id = auth.uid())
     where a.id = v_id;

    update public.shareholders
       set dividends_paid_ugx = dividends_paid_ugx + v_a.net_ugx
     where id = v_a.shareholder_id;

    insert into public.ownership_events
      (type, reference_type, reference_id, audience, recipient_uid, payload)
    select 'dividend_paid', 'dividend_allocation', v_id, 'shareholder', s.linked_uid,
           jsonb_build_object('allocationNumber', v_a.allocation_number)
      from public.shareholders s where s.id = v_a.shareholder_id and s.linked_uid is not null;

    perform app.audit('dividend.allocation_paid', 'shareholders', v_id::text, null,
      v_a.allocation_number, null, null,
      jsonb_build_object('allocationNumber', v_a.allocation_number,
                         'dividendNumber', v_d.dividend_number, 'netUgx', v_a.net_ugx,
                         'transactionNumber', v_number));

    v_total := v_total + v_a.net_ugx;
    v_count := v_count + 1;
  end loop;

  v_status := app.dividend_status_after(v_d.paid_count + v_count, v_d.payable_count);
  update public.dividends
     set status = v_status, paid_ugx = v_d.paid_ugx + v_total, paid_count = v_d.paid_count + v_count,
         outstanding_ugx = v_d.allocated_ugx - (v_d.paid_ugx + v_total), updated_by = auth.uid()
   where id = p_dividend;

  perform app.audit('dividend.paid', 'shareholders', p_dividend::text, null, v_d.dividend_number,
    null, jsonb_build_object('status', v_d.status, 'paidUgx', v_d.paid_ugx),
    jsonb_build_object('status', v_status, 'paidUgx', v_d.paid_ugx + v_total,
                       'amountUgx', v_total, 'allocations', v_count));

  select a.balance_ugx into v_acct.balance_ugx
    from public.financial_accounts a where a.id = p_account;
  perform app.complete_request(p_request_id, jsonb_build_object(
    'dividend_id', p_dividend, 'status', v_status, 'amount_ugx', v_total,
    'allocations_paid', v_count, 'balance_ugx', v_acct.balance_ugx));

  return query select p_dividend, v_status, v_total, v_count, v_acct.balance_ugx;
end;
$$;

create or replace function app.reverse_dividend_payment(p_allocation uuid, p_reason text)
returns table (allocation_id uuid, dividend_status text, transaction_id uuid,
               transaction_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_a      public.dividend_allocations%rowtype;
  v_d      public.dividends%rowtype;
  v_reason text;
  v_rev    record;
  v_status text;
begin
  perform app.require_permission('dividends.adjust');
  v_reason := app.require_reason(p_reason);

  select * into v_a from public.dividend_allocations where id = p_allocation for update;
  if v_a.id is null then
    raise exception 'That allocation could not be found.'
      using errcode = 'no_data_found', detail = 'allocation_not_found';
  end if;
  if v_a.payment_status <> 'paid' then
    raise exception 'Only a paid allocation can be reversed.'
      using errcode = 'raise_exception', detail = 'not_paid';
  end if;
  select * into v_d from public.dividends where id = v_a.dividend_id for update;

  select * into v_rev from app.post_ownership_reversal(
    v_a.financial_transaction_id, v_reason, 'dividend_allocation', p_allocation);

  -- The allocation is unpaid again and KEEPS a record of the reversal. The
  -- record-date snapshot and the amount never move.
  update public.dividend_allocations
     set payment_status = 'unpaid', paid_at = null, payment_date = null, payment_reference = null,
         account_id = null, account_name = null, financial_transaction_id = null,
         financial_transaction_number = null, paid_by = null, paid_by_name = null,
         reversals = reversals || jsonb_build_array(jsonb_build_object(
           'financialTransactionId', v_a.financial_transaction_id,
           'financialTransactionNumber', v_a.financial_transaction_number,
           'reversalTransactionId', v_rev.transaction_id,
           'reversalTransactionNumber', v_rev.transaction_number,
           'amountUgx', v_a.net_ugx, 'reversedAt', now(), 'reversedBy', auth.uid(),
           'reason', v_reason))
   where id = p_allocation;

  update public.shareholders
     set dividends_paid_ugx = dividends_paid_ugx - v_a.net_ugx
   where id = v_a.shareholder_id;

  v_status := app.dividend_status_after(v_d.paid_count - 1, v_d.payable_count);
  update public.dividends
     set status = v_status, paid_count = v_d.paid_count - 1, paid_ugx = v_d.paid_ugx - v_a.net_ugx,
         outstanding_ugx = v_d.allocated_ugx - (v_d.paid_ugx - v_a.net_ugx), updated_by = auth.uid()
   where id = v_d.id;

  perform app.audit('dividend.payment_reversed', 'shareholders', p_allocation::text, null,
    v_a.allocation_number, v_reason,
    jsonb_build_object('paymentStatus', 'paid', 'transactionNumber', v_a.financial_transaction_number),
    jsonb_build_object('paymentStatus', 'unpaid', 'reversalTransactionNumber', v_rev.transaction_number,
                       'netUgx', v_a.net_ugx, 'dividendStatus', v_status));

  return query select p_allocation, v_status, v_rev.transaction_id, v_rev.transaction_number;
end;
$$;

/* Cancels a dividend on which nothing is paid. Its allocations are kept. */
create or replace function app.cancel_dividend(p_dividend uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_d      public.dividends%rowtype;
  v_reason text;
begin
  perform app.require_permission('dividends.adjust');
  v_reason := app.require_reason(p_reason);
  select * into v_d from public.dividends where id = p_dividend for update;
  if v_d.id is null then
    raise exception 'That dividend could not be found.'
      using errcode = 'no_data_found', detail = 'dividend_not_found';
  end if;
  if v_d.status = 'cancelled' then
    raise exception 'This dividend is already cancelled.'
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;
  if v_d.paid_ugx > 0 or v_d.status not in ('draft', 'declared', 'approved') then
    raise exception 'Reverse the payments made on this dividend before cancelling it.'
      using errcode = 'raise_exception', detail = 'reverse_payments_first';
  end if;

  update public.dividend_allocations
     set dividend_status = 'cancelled' where dividend_id = p_dividend and current;
  -- Cancelling releases the record-date lock.
  update public.dividends
     set status = 'cancelled', record_locked = false, cancelled_by = auth.uid(),
         cancelled_by_name = (select full_name from public.users where id = auth.uid()),
         cancelled_at = now(), cancel_reason = v_reason, updated_by = auth.uid()
   where id = p_dividend;

  perform app.audit('dividend.cancelled', 'shareholders', p_dividend::text, null,
    v_d.dividend_number, v_reason,
    jsonb_build_object('status', v_d.status), jsonb_build_object('status', 'cancelled'));
  return 'cancelled';
end;
$$;
