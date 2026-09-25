-- ===========================================================================
-- RamosMAX Web — Phase E — 0016: finance functions
-- ===========================================================================
-- Ports `functions/src/finance.js`. One posting path for every money movement:
-- `app.post_transaction` moves the balances, writes the immutable ledger entry
-- and its per-account movements, and adds to the day's totals — all in the
-- caller's transaction, so a failure anywhere leaves nothing behind.
--
-- The Phase D entry point `app.post_ledger_entry` is kept and now delegates
-- here, so customer payments and their reversals travel the same road as
-- everything else.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Shared validation (requireAmount, requireRequestId, requireBusinessDate)
-- ---------------------------------------------------------------------------

create or replace function app.max_amount_ugx()
returns bigint language sql immutable as $$ select 2000000000::bigint; $$;

comment on function app.max_amount_ugx() is
  'MAX_AMOUNT_UGX in finance.js: the largest single money movement, UGX 2,000,000,000.';

create or replace function app.require_text(p_input text, p_field text, p_max integer default 200)
returns text
language plpgsql
immutable
as $$
declare
  v text := app.optional_text(p_input, p_field, p_max);
begin
  if v is null then
    raise exception 'Enter the %.', lower(p_field)
      using errcode = 'invalid_parameter_value', detail = 'required';
  end if;
  return v;
end;
$$;

create or replace function app.require_amount(
  p_amount bigint,
  p_field  text default 'amount',
  p_min    bigint default 1,
  p_max    bigint default null
)
returns bigint
language plpgsql
immutable
as $$
declare
  v_max bigint := coalesce(p_max, 2000000000);
begin
  if p_amount is null or p_amount < p_min or p_amount > v_max then
    raise exception 'Enter the % as a whole number of shillings%.',
      p_field, case when p_min > 0 then ' greater than zero' else '' end
      using errcode = 'invalid_parameter_value', detail = 'amount';
  end if;
  return p_amount;
end;
$$;

-- `^[A-Za-z0-9_-]{8,64}$`, exactly as requireRequestId enforces it.
create or replace function app.require_request_id(p_input text)
returns text
language plpgsql
immutable
as $$
begin
  if p_input is null or p_input !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'The request is not valid.'
      using errcode = 'invalid_parameter_value', detail = 'request_id';
  end if;
  return p_input;
end;
$$;

/*
 * A business date. Null means today. Past dates are fine; a future date only
 * up to p_future_days ahead (0 = not after today).
 */
create or replace function app.require_business_date(
  p_input       date,
  p_field       text default 'date',
  p_future_days integer default 0
)
returns date
language plpgsql
stable
as $$
declare
  v_today date := app.eat_day();
  v_date  date := coalesce(p_input, v_today);
begin
  if v_date < date '2020-01-01' then
    raise exception 'Choose a valid %.', p_field
      using errcode = 'invalid_parameter_value', detail = 'date';
  end if;
  if v_date > v_today + p_future_days then
    raise exception '%', case when p_future_days = 0
      then format('The %s cannot be in the future.', p_field)
      else format('The %s is too far in the future.', p_field) end
      using errcode = 'invalid_parameter_value', detail = 'date';
  end if;
  return v_date;
end;
$$;

-- ---------------------------------------------------------------------------
-- The posting path
-- ---------------------------------------------------------------------------

/*
 * Moves money and writes the ledger. `p_from` loses the amount, `p_to` gains
 * it; either may be null for a one-sided entry. Returns the transaction id.
 *
 * Every balance change in RamosMAX goes through here. Nothing else may write
 * `financial_accounts.balance_ugx`.
 */
create or replace function app.post_transaction(
  p_type           text,
  p_amount         bigint,
  p_from           uuid default null,
  p_to             uuid default null,
  p_reference_type text default null,
  p_reference_id   uuid default null,
  p_description    text default null,
  p_reason         text default null,
  p_reference      text default null,
  p_request_id     text default null,
  p_date           date default null,
  p_category       text default null,
  p_reverses       uuid default null,
  p_reversal_of    text default null,
  p_approved_by    uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_kind      text := case when p_type = 'reversal'
                           then 'reversal:' || coalesce(p_reversal_of, '') else p_type end;
  v_day       date := app.eat_day();
  v_id        uuid;
  v_number    text;
  v_primary   uuid;
  v_direction text;
  v_balance   bigint;
  v_from_type text;
  v_to_type   text;
  v_from_after bigint;
  v_to_after   bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'The amount must be above zero.'
      using errcode = 'raise_exception', detail = 'amount';
  end if;
  if p_from is not null and p_from = p_to then
    raise exception 'Choose two different accounts.'
      using errcode = 'invalid_parameter_value', detail = 'same_account';
  end if;
  if p_from is null and p_to is null then
    raise exception 'A ledger entry must touch an account.'
      using errcode = 'invalid_parameter_value', detail = 'account';
  end if;

  select type into v_from_type from public.financial_accounts where id = p_from;
  select type into v_to_type   from public.financial_accounts where id = p_to;

  if p_from is not null then
    v_from_after := app.move_account(p_from, -p_amount, v_kind, v_to_type);
  end if;
  if p_to is not null then
    v_to_after := app.move_account(p_to, p_amount, v_kind, v_from_type);
  end if;

  -- The PRIMARY account of the entry: the source of an outflow, otherwise the
  -- destination. This is what the Phase D columns describe.
  if p_from is not null then
    v_primary := p_from; v_direction := 'out'; v_balance := v_from_after;
  else
    v_primary := p_to;   v_direction := 'in';  v_balance := v_to_after;
  end if;

  v_number := app.next_reference('transaction_number_seq', 'RMX-TXN-');

  insert into public.financial_transactions
    (transaction_number, account_id, entry_type, direction, amount_ugx, balance_after_ugx,
     reference_type, reference_id, description, reverses_id, business_day, created_by,
     reversal_of_type, source_account_id, destination_account_id, status, request_id,
     transaction_date, reference, reason, category_id, approved_by)
  values
    (v_number, v_primary, p_type, v_direction, p_amount, v_balance,
     p_reference_type, p_reference_id, p_description, p_reverses, v_day, auth.uid(),
     p_reversal_of, p_from, p_to, 'posted', p_request_id,
     coalesce(p_date, v_day), p_reference, p_reason, p_category, p_approved_by)
  returning id into v_id;

  if p_from is not null then
    insert into public.financial_transaction_entries (transaction_id, account_id, delta_ugx, balance_after_ugx)
    values (v_id, p_from, -p_amount, v_from_after);
  end if;
  if p_to is not null then
    insert into public.financial_transaction_entries (transaction_id, account_id, delta_ugx, balance_after_ugx)
    values (v_id, p_to, p_amount, v_to_after);
  end if;

  if p_reverses is not null then
    update public.financial_transactions
       set reversed_by_id = v_id, status = 'reversed', reversed_at = now(),
           reversed_by = auth.uid(), reversal_reason = p_reason
     where id = p_reverses;
  end if;

  perform app.summarise_day(v_day, v_kind, p_amount, p_from, p_to, p_category);
  return v_id;
end;
$$;

/*
 * One account's side of a movement. Locks the row, refuses an overdraft and
 * keeps `awaiting_banking_ugx` in step, exactly as `Ledger._move` does.
 */
create or replace function app.move_account(
  p_account      uuid,
  p_delta        bigint,
  p_kind         text,
  p_counterparty text
)
returns bigint
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before  bigint;
  v_after   bigint;
  v_type    text;
  v_name    text;
  v_waiting bigint;
begin
  -- FOR UPDATE serialises concurrent movements on this account, so two
  -- simultaneous outflows can never both see the same balance.
  select balance_ugx, type, name, awaiting_banking_ugx
    into v_before, v_type, v_name, v_waiting
    from public.financial_accounts where id = p_account for update;

  if v_before is null then
    raise exception 'That financial account could not be found.'
      using errcode = 'no_data_found', detail = 'account_not_found';
  end if;

  v_after := v_before + p_delta;
  if v_after < 0 then
    raise exception '% has only UGX % available.', v_name, to_char(v_before, 'FM999,999,999,999')
      using errcode = 'raise_exception', detail = 'insufficient_funds';
  end if;

  -- Cash awaiting banking: takings that have not yet gone to a bank. It grows
  -- with cash customer payments and shrinks when cash moves to a bank.
  if v_type = 'cash' then
    if p_kind in ('customer_payment', 'reversal:customer_payment')
       or (p_counterparty = 'bank'
           and p_kind in ('bank_deposit', 'account_transfer',
                          'reversal:bank_deposit', 'reversal:account_transfer')) then
      v_waiting := v_waiting + p_delta;
    end if;
    v_waiting := greatest(0, least(v_waiting, v_after));
  end if;

  update public.financial_accounts
     set balance_ugx          = v_after,
         awaiting_banking_ugx = case when v_type = 'cash' then v_waiting else awaiting_banking_ugx end,
         transaction_count    = transaction_count + 1,
         last_transaction_at  = now(),
         updated_at           = now()
   where id = p_account;

  return v_after;
end;
$$;

/* The day's totals, added to in the same transaction as the entry itself. */
create or replace function app.summarise_day(
  p_day      date,
  p_kind     text,
  p_amount   bigint,
  p_from     uuid,
  p_to       uuid,
  p_category text
)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_reversal_of text := case when p_kind like 'reversal:%' then substr(p_kind, 10) else null end;
  v_by_account  jsonb := '{}'::jsonb;
begin
  if p_from is not null then
    v_by_account := jsonb_build_object(p_from::text, jsonb_build_object('outUgx', p_amount));
  end if;
  if p_to is not null then
    v_by_account := v_by_account || jsonb_build_object(p_to::text, jsonb_build_object('inUgx', p_amount));
  end if;

  insert into public.finance_daily_summaries as s (business_day) values (p_day)
  on conflict (business_day) do nothing;

  update public.finance_daily_summaries s
     set payments_in_ugx      = s.payments_in_ugx      + case when p_kind = 'customer_payment' then p_amount else 0 end,
         expenses_paid_ugx    = s.expenses_paid_ugx    + case when p_kind = 'expense_payment' then p_amount else 0 end,
         purchases_paid_ugx   = s.purchases_paid_ugx   + case when p_kind = 'inventory_purchase_payment' then p_amount else 0 end,
         transfers_ugx        = s.transfers_ugx        + case when p_kind = 'account_transfer' then p_amount else 0 end,
         deposits_ugx         = s.deposits_ugx         + case when p_kind = 'bank_deposit' then p_amount else 0 end,
         opening_balances_ugx = s.opening_balances_ugx + case when p_kind = 'opening_balance' then p_amount else 0 end,
         adjustments_in_ugx   = s.adjustments_in_ugx   + case when p_kind = 'adjustment' and p_to is not null then p_amount else 0 end,
         adjustments_out_ugx  = s.adjustments_out_ugx  + case when p_kind = 'adjustment' and p_to is null then p_amount else 0 end,
         reversals_ugx        = s.reversals_ugx        + case when v_reversal_of is not null then p_amount else 0 end,
         reversals            = case when v_reversal_of is null then s.reversals
                                     else jsonb_set(s.reversals, array[v_reversal_of],
                                            to_jsonb(coalesce((s.reversals ->> v_reversal_of)::bigint, 0) + p_amount), true) end,
         expenses_by_category = case
             when p_category is null then s.expenses_by_category
             when p_kind = 'expense_payment' then
               jsonb_set(s.expenses_by_category, array[p_category],
                 to_jsonb(coalesce((s.expenses_by_category ->> p_category)::bigint, 0) + p_amount), true)
             when p_kind = 'reversal:expense_payment' then
               jsonb_set(s.expenses_by_category, array[p_category],
                 to_jsonb(coalesce((s.expenses_by_category ->> p_category)::bigint, 0) - p_amount), true)
             else s.expenses_by_category end,
         by_account           = app.merge_account_totals(s.by_account, v_by_account),
         transaction_count    = s.transaction_count + 1,
         updated_at           = now()
   where s.business_day = p_day;
end;
$$;

/* byAccount.{id}.{inUgx,outUgx}: adds the two shapes together. */
create or replace function app.merge_account_totals(p_current jsonb, p_add jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_out jsonb := coalesce(p_current, '{}'::jsonb);
  k text;
  v jsonb;
begin
  for k, v in select * from jsonb_each(coalesce(p_add, '{}'::jsonb)) loop
    v_out := jsonb_set(v_out, array[k], jsonb_build_object(
      'inUgx',  coalesce((v_out -> k ->> 'inUgx')::bigint, 0)  + coalesce((v ->> 'inUgx')::bigint, 0),
      'outUgx', coalesce((v_out -> k ->> 'outUgx')::bigint, 0) + coalesce((v ->> 'outUgx')::bigint, 0)
    ), true);
  end loop;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- The Phase D entry point, now delegating
-- ---------------------------------------------------------------------------
-- Same signature, same behaviour for billing. Customer payments and their
-- reversals now also keep `awaiting_banking_ugx` and the fuller day totals in
-- step, which is what the reference implementation always did.

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
  v_reversal_of text;
begin
  if p_reverses is not null then
    select t.entry_type into v_reversal_of from public.financial_transactions t where t.id = p_reverses;
  end if;

  return app.post_transaction(
    p_type           => p_entry_type,
    p_amount         => p_amount,
    p_from           => case when p_direction = 'out' then p_account end,
    p_to             => case when p_direction = 'in'  then p_account end,
    p_reference_type => p_reference_type,
    p_reference_id   => p_reference_id,
    p_description    => p_description,
    p_reverses       => p_reverses,
    p_reversal_of    => v_reversal_of);
end;
$$;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create or replace function app.account_number_input(p_input text)
returns text
language plpgsql
immutable
as $$
declare
  v text := app.optional_text(p_input, 'Account or merchant number', 40);
begin
  if v is null then return null; end if;
  if v !~ '^[A-Za-z0-9 -]{3,40}$' then
    raise exception 'Use letters, digits, spaces or dashes for the account number.'
      using errcode = 'invalid_parameter_value', detail = 'account_number';
  end if;
  return upper(v);
end;
$$;

/* `••1234` — what a cashier may see of an account number. */
create or replace function app.mask_account_number(p_input text)
returns text
language sql
immutable
as $$
  select case
    when p_input is null then null
    when char_length(p_input) <= 4 then p_input
    else '••' || right(p_input, 4) end;
$$;

create or replace function app.create_financial_account(
  p_name    text,
  p_type    text,
  p_provider text default null,
  p_account_number text default null,
  p_notes   text default null,
  p_opening bigint default 0
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_id     uuid;
  v_name   text;
  v_number text;
  v_code   text;
begin
  perform app.require_permission('finance.accounts.manage');

  v_name := app.require_text(p_name, 'Account name', 60);
  if p_type not in ('bank', 'mobile_money') then
    -- "RamosMAX has one cash account, Cash at Hand."
    raise exception '%', case when p_type = 'cash'
      then 'RamosMAX has one cash account, Cash at Hand.'
      else 'Choose mobile money or bank.' end
      using errcode = 'invalid_parameter_value', detail = 'account_type';
  end if;
  v_number := app.account_number_input(p_account_number);
  if p_opening is not null and p_opening <> 0 then
    perform app.require_amount(p_opening, 'opening balance', 0);
  end if;

  if exists (select 1 from public.financial_accounts where lower(btrim(name)) = lower(btrim(v_name))) then
    raise exception 'An account called "%" already exists.', v_name
      using errcode = 'unique_violation', detail = 'duplicate_account';
  end if;
  if v_number is not null and exists (
    select 1 from public.financial_accounts where type = p_type and upper(account_number) = v_number) then
    raise exception 'An account with this number already exists.'
      using errcode = 'unique_violation', detail = 'duplicate_account_number';
  end if;

  v_code := left(regexp_replace(lower(v_name), '[^a-z0-9]+', '_', 'g'), 40) || '_' || substr(gen_random_uuid()::text, 1, 6);

  insert into public.financial_accounts
    (code, name, type, provider, account_number, payment_method, notes,
     opening_balance_ugx, opening_balance_recorded, created_by, updated_by)
  values
    (v_code, v_name, p_type, app.optional_text(p_provider, 'Provider / bank name', 60), v_number,
     case when p_type = 'bank' then null end, app.optional_text(p_notes, 'Notes', 300),
     0, false, auth.uid(), auth.uid())
  returning id into v_id;

  if coalesce(p_opening, 0) > 0 then
    perform app.post_transaction(
      p_type => 'opening_balance', p_amount => p_opening, p_to => v_id,
      p_description => 'Opening balance of ' || v_name);
    update public.financial_accounts
       set opening_balance_ugx = p_opening, opening_balance_recorded = true
     where id = v_id;
  end if;

  perform app.audit('financial_account.created', 'finance', v_id::text, null,
    v_name, null, null,
    jsonb_build_object('name', v_name, 'type', p_type, 'provider', p_provider,
                       'openingBalanceUgx', coalesce(p_opening, 0)));
  return v_id;
end;
$$;

create or replace function app.update_financial_account(
  p_account uuid,
  p_name    text default null,
  p_provider text default null,
  p_account_number text default null,
  p_notes   text default null,
  p_active  boolean default null,
  p_reason  text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.financial_accounts%rowtype;
  v_name   text;
  v_number text;
  v_reason text;
  v_changed boolean := false;
begin
  perform app.require_permission('finance.accounts.manage');

  select * into v_before from public.financial_accounts where id = p_account;
  if v_before.id is null then
    raise exception 'That financial account could not be found.'
      using errcode = 'no_data_found', detail = 'account_not_found';
  end if;

  v_name   := case when p_name is null then null else app.require_text(p_name, 'Account name', 60) end;
  v_number := case when p_account_number is null then null else app.account_number_input(p_account_number) end;
  v_reason := case when p_active is false then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;

  if v_name is not null and exists (
    select 1 from public.financial_accounts
     where id <> p_account and lower(btrim(name)) = lower(btrim(v_name))) then
    raise exception 'An account called "%" already exists.', v_name
      using errcode = 'unique_violation', detail = 'duplicate_account';
  end if;
  if v_number is not null and exists (
    select 1 from public.financial_accounts
     where id <> p_account and type = v_before.type and upper(account_number) = v_number) then
    raise exception 'An account with this number already exists.'
      using errcode = 'unique_violation', detail = 'duplicate_account_number';
  end if;

  if p_active is false and v_before.is_active then
    -- Cash at Hand, MTN and Airtel receive customer payments.
    if v_before.is_default then
      raise exception '% receives customer payments and cannot be deactivated.', v_before.name
        using errcode = 'raise_exception', detail = 'permanent_account';
    end if;
    if v_before.balance_ugx <> 0 then
      raise exception 'Move the balance to another account before deactivating this one.'
        using errcode = 'raise_exception', detail = 'balance_not_zero';
    end if;
  end if;

  update public.financial_accounts
     set name           = coalesce(v_name, name),
         provider       = case when p_provider is null then provider
                               else app.optional_text(p_provider, 'Provider / bank name', 60) end,
         account_number = case when p_account_number is null then account_number else v_number end,
         notes          = case when p_notes is null then notes
                               else app.optional_text(p_notes, 'Notes', 300) end,
         is_active      = coalesce(p_active, is_active),
         updated_by     = auth.uid(),
         updated_at     = now()
   where id = p_account;

  v_changed := v_name is not null or p_provider is not null or p_account_number is not null or p_notes is not null;
  if v_changed then
    perform app.audit('financial_account.updated', 'finance', p_account::text, null, v_before.name, v_reason,
      jsonb_build_object('name', v_before.name, 'provider', v_before.provider,
                         'accountNumber', v_before.account_number, 'notes', v_before.notes),
      jsonb_build_object('name', coalesce(v_name, v_before.name), 'provider', p_provider,
                         'accountNumber', v_number, 'notes', p_notes));
  end if;
  if p_active is not null and p_active <> v_before.is_active then
    perform app.audit(
      case when p_active then 'financial_account.activated' else 'financial_account.deactivated' end,
      'finance', p_account::text, null, v_before.name, v_reason,
      jsonb_build_object('active', v_before.is_active), jsonb_build_object('active', p_active));
  end if;
  if not v_changed and (p_active is null or p_active = v_before.is_active) then
    raise exception 'Nothing has changed.' using errcode = 'raise_exception', detail = 'no_changes';
  end if;
end;
$$;

/* Once per account: the money it held when RamosMAX started tracking it. */
create or replace function app.record_opening_balance(
  p_account uuid,
  p_amount  bigint,
  p_reason  text default null
)
returns table (transaction_id uuid, transaction_number text, balance_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_account public.financial_accounts%rowtype;
  v_txn     uuid;
begin
  perform app.require_permission('finance.accounts.manage');
  perform app.require_amount(p_amount, 'opening balance');

  select * into v_account from public.financial_accounts where id = p_account for update;
  if v_account.id is null then
    raise exception 'That financial account could not be found.'
      using errcode = 'no_data_found', detail = 'account_not_found';
  end if;
  if not v_account.is_active then
    raise exception '% is inactive.', v_account.name
      using errcode = 'raise_exception', detail = 'account_inactive';
  end if;
  if v_account.opening_balance_recorded then
    raise exception 'This account already has an opening balance. Use an adjustment to correct it.'
      using errcode = 'raise_exception', detail = 'opening_balance_exists';
  end if;

  v_txn := app.post_transaction(
    p_type => 'opening_balance', p_amount => p_amount, p_to => p_account,
    p_reason => app.optional_text(p_reason, 'Reason', 300),
    p_description => 'Opening balance of ' || v_account.name);

  update public.financial_accounts
     set opening_balance_recorded = true, opening_balance_ugx = p_amount
   where id = p_account;

  perform app.audit('financial_account.opening_balance', 'finance', p_account::text, null,
    v_account.name, p_reason, null,
    jsonb_build_object('amountUgx', p_amount,
      'transactionNumber', (select t.transaction_number from public.financial_transactions t where t.id = v_txn)));

  return query
    select v_txn, t.transaction_number, a.balance_ugx
      from public.financial_transactions t, public.financial_accounts a
     where t.id = v_txn and a.id = p_account;
end;
$$;

-- ---------------------------------------------------------------------------
-- Transfers
-- ---------------------------------------------------------------------------

create or replace function app.transfer_funds(
  p_from       uuid,
  p_to         uuid,
  p_amount     bigint,
  p_reason     text,
  p_request_id text,
  p_date       date default null,
  p_reference  text default null,
  p_description text default null
)
returns table (transaction_id uuid, transaction_number text,
               source_balance_ugx bigint, destination_balance_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_reason  text;
  v_date    date;
  v_txn     uuid;
  v_result  jsonb;
begin
  perform app.require_permission('finance.transfer');

  if p_from = p_to then
    raise exception 'The source and destination must be different accounts.'
      using errcode = 'invalid_parameter_value', detail = 'same_account';
  end if;
  perform app.require_amount(p_amount);
  perform app.require_request_id(p_request_id);
  v_reason := app.require_reason(p_reason);
  v_date   := app.require_business_date(p_date, 'transfer date');

  v_earlier := app.claim_request(p_request_id, 'transfer',
    jsonb_build_object('from', p_from, 'to', p_to, 'amount', p_amount));
  if v_earlier is not null then
    return query select (v_earlier ->> 'transaction_id')::uuid, v_earlier ->> 'transaction_number',
                        (v_earlier ->> 'source_balance_ugx')::bigint,
                        (v_earlier ->> 'destination_balance_ugx')::bigint;
    return;
  end if;

  perform app.require_active_account(p_from);
  perform app.require_active_account(p_to);

  v_txn := app.post_transaction(
    p_type => 'account_transfer', p_amount => p_amount, p_from => p_from, p_to => p_to,
    p_reason => v_reason, p_reference => app.optional_text(p_reference, 'Reference', 60),
    p_description => app.optional_text(p_description, 'Description', 200),
    p_request_id => p_request_id, p_date => v_date, p_approved_by => auth.uid());

  select jsonb_build_object(
      'transaction_id', v_txn,
      'transaction_number', t.transaction_number,
      'source_balance_ugx', (select a.balance_ugx from public.financial_accounts a where a.id = p_from),
      'destination_balance_ugx', (select a.balance_ugx from public.financial_accounts a where a.id = p_to))
    into v_result
    from public.financial_transactions t where t.id = v_txn;

  perform app.audit('finance.transfer', 'finance', v_txn::text, null,
    v_result ->> 'transaction_number', v_reason, null,
    jsonb_build_object('fromAccountId', p_from, 'toAccountId', p_to, 'amountUgx', p_amount,
                       'transactionNumber', v_result ->> 'transaction_number'));

  perform app.complete_request(p_request_id, v_result);

  return query select v_txn, v_result ->> 'transaction_number',
                      (v_result ->> 'source_balance_ugx')::bigint,
                      (v_result ->> 'destination_balance_ugx')::bigint;
end;
$$;

create or replace function app.require_active_account(p_account uuid)
returns public.financial_accounts
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v public.financial_accounts%rowtype;
begin
  select * into v from public.financial_accounts where id = p_account;
  if v.id is null then
    raise exception 'That financial account could not be found.'
      using errcode = 'no_data_found', detail = 'account_not_found';
  end if;
  if not v.is_active then
    raise exception '% is inactive.', v.name
      using errcode = 'raise_exception', detail = 'account_inactive';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Bank deposits
-- ---------------------------------------------------------------------------

create or replace function app.record_bank_deposit(
  p_source     uuid,
  p_bank       uuid,
  p_amount     bigint,
  p_bank_reference text,
  p_request_id text,
  p_date       date default null,
  p_description text default null
)
returns table (deposit_id uuid, deposit_number text, transaction_id uuid,
               transaction_number text, awaiting_banking_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_source  public.financial_accounts%rowtype;
  v_bank    public.financial_accounts%rowtype;
  v_number  text;
  v_id      uuid;
  v_txn     uuid;
  v_date    date;
  v_ref     text;
  v_result  jsonb;
begin
  perform app.require_permission('finance.deposit');

  if p_source = p_bank then
    raise exception 'The source and destination must be different accounts.'
      using errcode = 'invalid_parameter_value', detail = 'same_account';
  end if;
  perform app.require_amount(p_amount);
  perform app.require_request_id(p_request_id);
  v_ref  := app.require_text(p_bank_reference, 'Bank reference / slip number', 60);
  v_date := app.require_business_date(p_date, 'deposit date');

  v_earlier := app.claim_request(p_request_id, 'deposit',
    jsonb_build_object('source', p_source, 'bank', p_bank, 'amount', p_amount));
  if v_earlier is not null then
    return query select (v_earlier ->> 'deposit_id')::uuid, v_earlier ->> 'deposit_number',
                        (v_earlier ->> 'transaction_id')::uuid, v_earlier ->> 'transaction_number',
                        (v_earlier ->> 'awaiting_banking_ugx')::bigint;
    return;
  end if;

  v_source := app.require_active_account(p_source);
  v_bank   := app.require_active_account(p_bank);
  if v_bank.type <> 'bank' then
    raise exception 'Choose a bank account to deposit into.'
      using errcode = 'invalid_parameter_value', detail = 'not_bank';
  end if;
  if v_source.type = 'bank' then
    raise exception 'Use a transfer to move money between bank accounts.'
      using errcode = 'invalid_parameter_value', detail = 'source_is_bank';
  end if;

  v_number := app.next_reference('deposit_number_seq', 'RMX-BNK-');

  insert into public.bank_deposits
    (deposit_number, source_account_id, bank_account_id, amount_ugx, deposit_date,
     bank_reference, description, request_id, created_by, created_by_name, approved_by)
  values
    (v_number, p_source, p_bank, p_amount, v_date, v_ref,
     app.optional_text(p_description, 'Description', 200), p_request_id, auth.uid(),
     (select full_name from public.users where id = auth.uid()), auth.uid())
  returning id into v_id;

  v_txn := app.post_transaction(
    p_type => 'bank_deposit', p_amount => p_amount, p_from => p_source, p_to => p_bank,
    p_reference_type => 'bank_deposit', p_reference_id => v_id,
    p_reference => v_ref, p_description => coalesce(app.optional_text(p_description, 'Description', 200), 'Deposit ' || v_number),
    p_request_id => p_request_id, p_date => v_date, p_approved_by => auth.uid());

  update public.bank_deposits set transaction_id = v_txn where id = v_id;

  select jsonb_build_object(
      'deposit_id', v_id, 'deposit_number', v_number,
      'transaction_id', v_txn, 'transaction_number', t.transaction_number,
      'awaiting_banking_ugx', (select a.awaiting_banking_ugx from public.financial_accounts a where a.id = p_source))
    into v_result
    from public.financial_transactions t where t.id = v_txn;

  perform app.audit('finance.bank_deposit', 'finance', v_id::text, null, v_number, null, null,
    jsonb_build_object('depositNumber', v_number, 'fromAccountId', p_source,
                       'bankAccountId', p_bank, 'amountUgx', p_amount,
                       'transactionNumber', v_result ->> 'transaction_number'));

  perform app.complete_request(p_request_id, v_result);

  return query select v_id, v_number, v_txn, v_result ->> 'transaction_number',
                      (v_result ->> 'awaiting_banking_ugx')::bigint;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reconciliation and adjustments
-- ---------------------------------------------------------------------------

/*
 * Records what the system holds, what was counted and the difference. It
 * NEVER changes a balance: closing a difference is a separate, authorised
 * adjustment. The system figure is read here, inside the transaction — the
 * browser does not get to say what the account should hold.
 */
create or replace function app.reconcile_account(
  p_account    uuid,
  p_actual     bigint,
  p_request_id text,
  p_date       date default null,
  p_notes      text default null
)
returns table (reconciliation_id uuid, reconciliation_number text,
               system_balance_ugx bigint, difference_ugx bigint, status text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_account public.financial_accounts%rowtype;
  v_number  text;
  v_id      uuid;
  v_system  bigint;
  v_diff    bigint;
  v_status  text;
  v_date    date;
  v_result  jsonb;
begin
  perform app.require_permission('finance.reconcile');
  perform app.require_amount(p_actual, 'counted / statement balance', 0);
  perform app.require_request_id(p_request_id);
  v_date := app.require_business_date(p_date, 'reconciliation date');

  v_earlier := app.claim_request(p_request_id, 'reconciliation',
    jsonb_build_object('account', p_account, 'actual', p_actual));
  if v_earlier is not null then
    return query select (v_earlier ->> 'reconciliation_id')::uuid, v_earlier ->> 'reconciliation_number',
                        (v_earlier ->> 'system_balance_ugx')::bigint,
                        (v_earlier ->> 'difference_ugx')::bigint, v_earlier ->> 'status';
    return;
  end if;

  -- Locked so the system figure cannot move while it is being recorded.
  select * into v_account from public.financial_accounts where id = p_account for update;
  if v_account.id is null then
    raise exception 'That financial account could not be found.'
      using errcode = 'no_data_found', detail = 'account_not_found';
  end if;

  v_system := v_account.balance_ugx;
  v_diff   := p_actual - v_system;
  v_status := case when v_diff = 0 then 'balanced' else 'discrepancy' end;
  v_number := app.next_reference('reconciliation_number_seq', 'RMX-REC-');

  insert into public.reconciliations
    (reconciliation_number, account_id, account_name, account_type, reconciliation_date,
     system_balance_ugx, actual_balance_ugx, status, notes, request_id,
     reconciled_by, reconciled_by_name)
  values
    (v_number, p_account, v_account.name, v_account.type, v_date,
     v_system, p_actual, v_status, app.optional_text(p_notes, 'Notes', 500), p_request_id,
     auth.uid(), (select full_name from public.users where id = auth.uid()))
  returning id into v_id;

  if v_diff <> 0 then
    -- Someone who can decide on an adjustment needs to know.
    insert into public.finance_events (type, reference_type, reference_id, audience, payload)
    values ('reconciliation_difference', 'reconciliation', v_id, 'finance.adjust',
            jsonb_build_object('accountId', p_account, 'differenceUgx', v_diff,
                               'reconciliationNumber', v_number));
  end if;

  v_result := jsonb_build_object(
    'reconciliation_id', v_id, 'reconciliation_number', v_number,
    'system_balance_ugx', v_system, 'difference_ugx', v_diff, 'status', v_status);

  perform app.audit('finance.reconciled', 'finance', v_id::text, null, v_number, null, null,
    jsonb_build_object('accountId', p_account, 'reconciliationNumber', v_number,
                       'systemBalanceUgx', v_system, 'actualBalanceUgx', p_actual,
                       'differenceUgx', v_diff));

  perform app.complete_request(p_request_id, v_result);

  return query select v_id, v_number, v_system, v_diff, v_status;
end;
$$;

create or replace function app.record_account_adjustment(
  p_account    uuid,
  p_direction  text,
  p_amount     bigint,
  p_reason     text,
  p_request_id text,
  p_reconciliation uuid default null
)
returns table (transaction_id uuid, transaction_number text, balance_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_reason  text;
  v_rec     public.reconciliations%rowtype;
  v_txn     uuid;
  v_result  jsonb;
begin
  perform app.require_permission('finance.adjust');

  if p_direction not in ('in', 'out') then
    raise exception 'Choose whether money is added or removed.'
      using errcode = 'invalid_parameter_value', detail = 'direction';
  end if;
  perform app.require_amount(p_amount);
  perform app.require_request_id(p_request_id);
  v_reason := app.require_reason(p_reason);

  v_earlier := app.claim_request(p_request_id, 'adjustment',
    jsonb_build_object('account', p_account, 'direction', p_direction, 'amount', p_amount));
  if v_earlier is not null then
    return query select (v_earlier ->> 'transaction_id')::uuid, v_earlier ->> 'transaction_number',
                        (v_earlier ->> 'balance_ugx')::bigint;
    return;
  end if;

  if p_reconciliation is not null then
    select * into v_rec from public.reconciliations where id = p_reconciliation for update;
    if v_rec.id is null then
      raise exception 'That reconciliation could not be found.'
        using errcode = 'no_data_found', detail = 'reconciliation';
    end if;
    if v_rec.account_id <> p_account then
      raise exception 'That reconciliation is for another account.'
        using errcode = 'invalid_parameter_value', detail = 'reconciliation';
    end if;
    if v_rec.status <> 'discrepancy' then
      raise exception 'That reconciliation has no open difference.'
        using errcode = 'raise_exception', detail = 'reconciliation_closed';
    end if;
    -- The adjustment must close exactly the difference, in the right direction.
    if (p_direction = 'in') <> (v_rec.difference_ugx > 0) or p_amount <> abs(v_rec.difference_ugx) then
      raise exception 'The reconciliation difference is %UGX %.',
        case when v_rec.difference_ugx > 0 then '+' else '−' end,
        to_char(abs(v_rec.difference_ugx), 'FM999,999,999,999')
        using errcode = 'invalid_parameter_value', detail = 'adjustment_mismatch';
    end if;
  end if;

  perform app.require_active_account(p_account);

  v_txn := app.post_transaction(
    p_type => 'adjustment', p_amount => p_amount,
    p_from => case when p_direction = 'out' then p_account end,
    p_to   => case when p_direction = 'in'  then p_account end,
    p_reference_type => case when p_reconciliation is not null then 'reconciliation' end,
    p_reference_id   => p_reconciliation,
    p_reason => v_reason, p_request_id => p_request_id,
    p_description => 'Adjustment ' || case when p_direction = 'in' then '+' else '−' end,
    p_approved_by => auth.uid());

  if p_reconciliation is not null then
    update public.reconciliations
       set status = 'adjusted', adjustment_transaction_id = v_txn, adjusted_by = auth.uid()
     where id = p_reconciliation;
  end if;

  select jsonb_build_object('transaction_id', v_txn, 'transaction_number', t.transaction_number,
                            'balance_ugx', (select a.balance_ugx from public.financial_accounts a where a.id = p_account))
    into v_result from public.financial_transactions t where t.id = v_txn;

  perform app.audit('finance.adjustment', 'finance', v_txn::text, null,
    v_result ->> 'transaction_number', v_reason, null,
    jsonb_build_object('accountId', p_account, 'direction', p_direction, 'amountUgx', p_amount,
                       'transactionNumber', v_result ->> 'transaction_number',
                       'reconciliationId', p_reconciliation));

  perform app.complete_request(p_request_id, v_result);

  return query select v_txn, v_result ->> 'transaction_number', (v_result ->> 'balance_ugx')::bigint;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reversals
-- ---------------------------------------------------------------------------

/*
 * Reverses a transfer, deposit, adjustment or opening balance (finance.adjust),
 * or an expense / stock-purchase payment (expenses.adjust), which also puts the
 * expense back to "approved" and the purchase back to "unpaid".
 *
 * Customer payments are NOT reversed here: they go through reverse_payment,
 * which also restores the invoice and its loyalty points.
 */
create or replace function app.reverse_financial_transaction(
  p_transaction uuid,
  p_reason      text
)
returns table (transaction_id uuid, transaction_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_original public.financial_transactions%rowtype;
  v_reason   text;
  v_spending boolean;
  v_txn      uuid;
  v_number   text;
begin
  perform app.require_permission('finance.adjust', 'expenses.adjust');
  v_reason := app.require_reason(p_reason);

  select * into v_original from public.financial_transactions where id = p_transaction for update;
  if v_original.id is null then
    raise exception 'That transaction could not be found.'
      using errcode = 'no_data_found', detail = 'transaction';
  end if;

  if v_original.entry_type = 'customer_payment' then
    raise exception 'Reverse the customer payment from its invoice instead.'
      using errcode = 'raise_exception', detail = 'use_payment_reversal';
  end if;
  if v_original.entry_type = 'reversal' then
    raise exception 'A reversal cannot itself be reversed.'
      using errcode = 'raise_exception', detail = 'is_reversal';
  end if;
  if v_original.status = 'reversed' then
    raise exception 'This transaction has already been reversed.'
      using errcode = 'raise_exception', detail = 'already_reversed';
  end if;

  -- Spending is corrected by whoever may adjust spending; the rest of the
  -- ledger by whoever may adjust the accounts.
  v_spending := v_original.entry_type in ('expense_payment', 'inventory_purchase_payment');
  perform app.require_permission(case when v_spending then 'expenses.adjust' else 'finance.adjust' end);

  -- The mirror image: what left comes back, what arrived goes out.
  v_txn := app.post_transaction(
    p_type => 'reversal', p_amount => v_original.amount_ugx,
    p_from => v_original.destination_account_id,
    p_to   => v_original.source_account_id,
    p_reference_type => v_original.reference_type, p_reference_id => v_original.reference_id,
    p_description => 'Reversal of ' || v_original.transaction_number,
    p_reason => v_reason, p_category => v_original.category_id,
    p_reverses => p_transaction, p_reversal_of => v_original.entry_type,
    p_approved_by => auth.uid());

  select t.transaction_number into v_number from public.financial_transactions t where t.id = v_txn;

  -- The record the money belonged to goes back to where it was.
  if v_original.entry_type = 'bank_deposit' then
    update public.bank_deposits d
       set status = 'reversed', reversal_reason = v_reason,
           reversal_transaction_id = v_txn, reversed_at = now()
     where d.transaction_id = p_transaction;
  elsif v_original.entry_type = 'opening_balance' then
    -- Recording it again is then allowed, which is how a wrong one is fixed.
    update public.financial_accounts
       set opening_balance_recorded = false, opening_balance_ugx = 0
     where id = v_original.destination_account_id;
  end if;

  perform app.reverse_spending_record(v_original, v_txn, v_reason);

  perform app.audit('finance.transaction_reversed', 'finance', p_transaction::text, null,
    v_original.transaction_number, v_reason,
    jsonb_build_object('status', 'posted', 'transactionNumber', v_original.transaction_number,
                       'type', v_original.entry_type),
    jsonb_build_object('status', 'reversed', 'reversalTransactionNumber', v_number,
                       'amountUgx', v_original.amount_ugx));

  return query select v_txn, v_number;
end;
$$;

/*
 * Puts an expense or a purchase back where it was when its payment is
 * reversed. Defined separately so the expense and inventory migrations can
 * replace it once those tables exist.
 */
create or replace function app.reverse_spending_record(
  p_original public.financial_transactions,
  p_reversal uuid,
  p_reason   text
)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
begin
  -- Expenses and purchases arrive in 0017 and 0018; until then there is
  -- nothing of that kind in the ledger to put back.
  return;
end;
$$;
