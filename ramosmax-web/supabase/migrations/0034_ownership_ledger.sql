-- ===========================================================================
-- RamosMAX Web — Final phase — 0034: owners' money in the existing ledger
-- ===========================================================================
-- Share capital coming IN and dividends going OUT are ordinary entries in the
-- SAME ledger as everything else. Three things change:
--
--   * the two entry types are accepted;
--   * they get their own daily totals. Share capital is NOT revenue and a
--     dividend is NOT an operating expense: both are owners' money, and the
--     reports keep them apart from the trading figures;
--   * the generic finance reversal REFUSES them, because reversing either has
--     to put the ownership record back — the commitment outstanding again, the
--     allocation unpaid again — which only the ownership functions can do.
-- ===========================================================================

do $$
begin
  alter table public.financial_transactions drop constraint if exists ledger_entry_type;
  alter table public.financial_transactions
    add constraint ledger_entry_type check (entry_type in (
      'customer_payment', 'expense_payment', 'inventory_purchase_payment',
      'account_transfer', 'bank_deposit', 'adjustment', 'opening_balance', 'reversal',
      'allowance_payment', 'payroll_payment',
      'share_capital_contribution', 'dividend_payment'));
end;
$$;

alter table public.finance_daily_summaries
  add column if not exists share_capital_ugx  bigint not null default 0,
  add column if not exists dividends_paid_ugx bigint not null default 0;

comment on column public.finance_daily_summaries.share_capital_ugx is
  'Owners'' money received for shares. Never revenue.';
comment on column public.finance_daily_summaries.dividends_paid_ugx is
  'Distributions to owners. Never an operating expense.';

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
         allowances_paid_ugx  = s.allowances_paid_ugx  + case when p_kind = 'allowance_payment' then p_amount else 0 end,
         payroll_paid_ugx     = s.payroll_paid_ugx     + case when p_kind = 'payroll_payment' then p_amount else 0 end,
         -- Owners' money, kept apart from the trading figures.
         share_capital_ugx    = s.share_capital_ugx    + case when p_kind = 'share_capital_contribution' then p_amount else 0 end,
         dividends_paid_ugx   = s.dividends_paid_ugx   + case when p_kind = 'dividend_payment' then p_amount else 0 end,
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

/* The generic finance reversal, now refusing owners' money too. */
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
  if v_original.entry_type in ('allowance_payment', 'payroll_payment') then
    raise exception '%', case when v_original.entry_type = 'payroll_payment'
      then 'Reverse the payroll payment from its payroll instead.'
      else 'Reverse the allowance payment from the allowances screen instead.' end
      using errcode = 'raise_exception', detail = 'use_pay_reversal';
  end if;
  -- Owners' money: the ownership record has to move with it.
  if v_original.entry_type in ('share_capital_contribution', 'dividend_payment') then
    raise exception '%', case when v_original.entry_type = 'dividend_payment'
      then 'Reverse the dividend payment from its allocation instead.'
      else 'Reverse the share contribution from its share transaction instead.' end
      using errcode = 'raise_exception', detail = 'use_ownership_reversal';
  end if;
  if v_original.entry_type = 'reversal' then
    raise exception 'A reversal cannot itself be reversed.'
      using errcode = 'raise_exception', detail = 'is_reversal';
  end if;
  if v_original.status = 'reversed' then
    raise exception 'This transaction has already been reversed.'
      using errcode = 'raise_exception', detail = 'already_reversed';
  end if;

  v_spending := v_original.entry_type in ('expense_payment', 'inventory_purchase_payment');
  perform app.require_permission(case when v_spending then 'expenses.adjust' else 'finance.adjust' end);

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

  if v_original.entry_type = 'bank_deposit' then
    update public.bank_deposits d
       set status = 'reversed', reversal_reason = v_reason,
           reversal_transaction_id = v_txn, reversed_at = now()
     where d.transaction_id = p_transaction;
  elsif v_original.entry_type = 'opening_balance' then
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

/* One place posts a reversal of an ownership entry, so both look the same. */
create or replace function app.post_ownership_reversal(
  p_original uuid, p_reason text, p_reference_type text, p_reference_id uuid)
returns table (transaction_id uuid, transaction_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_original public.financial_transactions%rowtype;
  v_txn      uuid;
  v_number   text;
begin
  select * into v_original from public.financial_transactions where id = p_original for update;
  if v_original.id is null then
    raise exception 'That transaction could not be found.'
      using errcode = 'no_data_found', detail = 'transaction';
  end if;
  if v_original.status = 'reversed' then
    raise exception 'This transaction has already been reversed.'
      using errcode = 'raise_exception', detail = 'already_reversed';
  end if;

  v_txn := app.post_transaction(
    p_type => 'reversal', p_amount => v_original.amount_ugx,
    p_from => v_original.destination_account_id,
    p_to   => v_original.source_account_id,
    p_reference_type => p_reference_type, p_reference_id => p_reference_id,
    p_description => 'Reversal of ' || v_original.transaction_number,
    p_reason => p_reason, p_reverses => p_original, p_reversal_of => v_original.entry_type,
    p_approved_by => auth.uid());
  select t.transaction_number into v_number from public.financial_transactions t where t.id = v_txn;
  return query select v_txn, v_number;
end;
$$;
