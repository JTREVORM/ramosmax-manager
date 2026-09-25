-- ===========================================================================
-- RamosMAX Web — Phase D — 0013: RLS for the money tables
-- ===========================================================================
-- Direct translation of the Phase 4 and Phase 5 blocks of
-- firebase/firestore.rules. SELECT only; no client holds INSERT, UPDATE or
-- DELETE on any financial table.
-- ===========================================================================

drop policy if exists invoices_read on public.invoices;
create policy invoices_read on public.invoices
  for select to authenticated using (app.has_permission('invoices.view'));

drop policy if exists invoice_items_read on public.invoice_items;
create policy invoice_items_read on public.invoice_items
  for select to authenticated using (app.has_permission('invoices.view'));

-- Discounts are part of the invoice picture.
drop policy if exists discounts_read on public.discounts;
create policy discounts_read on public.discounts
  for select to authenticated using (app.has_permission('invoices.view'));

drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments
  for select to authenticated using (app.has_permission('payments.view'));

-- A receipt is readable by whoever may see the payment OR the invoice.
drop policy if exists receipts_read on public.receipts;
create policy receipts_read on public.receipts
  for select to authenticated
  using (app.has_either_permission('payments.view', 'invoices.view'));

-- Finance: balances need finance.view, the ledger needs
-- finance.transactions.view. A Cashier holds neither, so they can record a
-- payment without ever seeing the business's balances.
drop policy if exists accounts_read on public.financial_accounts;
create policy accounts_read on public.financial_accounts
  for select to authenticated using (app.has_permission('finance.view'));

drop policy if exists ledger_read on public.financial_transactions;
create policy ledger_read on public.financial_transactions
  for select to authenticated using (app.has_permission('finance.transactions.view'));

drop policy if exists summaries_read on public.finance_daily_summaries;
create policy summaries_read on public.finance_daily_summaries
  for select to authenticated using (app.has_permission('finance.view'));

-- Loyalty.
drop policy if exists loyalty_accounts_read on public.loyalty_accounts;
create policy loyalty_accounts_read on public.loyalty_accounts
  for select to authenticated using (app.has_permission('loyalty.view'));

drop policy if exists loyalty_tx_read on public.loyalty_transactions;
create policy loyalty_tx_read on public.loyalty_transactions
  for select to authenticated using (app.has_permission('loyalty.view'));

drop policy if exists loyalty_rewards_read on public.loyalty_rewards;
create policy loyalty_rewards_read on public.loyalty_rewards
  for select to authenticated using (app.has_permission('loyalty.view'));

drop policy if exists loyalty_events_read on public.loyalty_events;
create policy loyalty_events_read on public.loyalty_events
  for select to authenticated using (app.has_permission('loyalty.view'));

grant select on
  public.invoices, public.invoice_items, public.discounts, public.payments,
  public.receipts, public.financial_accounts, public.financial_transactions,
  public.finance_daily_summaries, public.loyalty_accounts,
  public.loyalty_transactions, public.loyalty_rewards, public.loyalty_events
to authenticated;

-- ---------------------------------------------------------------------------
-- The payment accounts a cashier may choose
-- ---------------------------------------------------------------------------
-- The Phase 9 rules expose settings/payment_accounts — the active bank
-- accounts a cashier may pick — with NAMES AND MASKED NUMBERS ONLY, never
-- balances. A row-level policy cannot hide a column, so this is a view.

create or replace view public.payment_accounts
with (security_invoker = true) as
  select a.id, a.code, a.name, a.type, a.provider, a.payment_method
    from public.financial_accounts a
   where a.is_active;

comment on view public.payment_accounts is
  'The accounts a payment may be recorded against. Exposes no balance, so a Cashier can choose an account without seeing what the business holds.';

-- The view is security_invoker, so the base table's policy would still apply
-- and a Cashier (no finance.view) would see nothing. A dedicated policy lets
-- anyone who may record a payment read the CHOICES, and nothing more.
drop policy if exists accounts_choosable on public.financial_accounts;
create policy accounts_choosable on public.financial_accounts
  for select to authenticated
  using (app.has_either_permission('payments.record', 'invoices.view'));

grant select on public.payment_accounts to authenticated;

-- ---------------------------------------------------------------------------
-- Loyalty summary for a vehicle
-- ---------------------------------------------------------------------------

create or replace function app.vehicle_loyalty(p_vehicle uuid)
returns table (points_balance integer, lifetime_points integer,
               rewards_unlocked integer, rewards_redeemed integer,
               reward_available boolean, reward_percent integer,
               reward_threshold integer, points_to_next integer)
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  select coalesce(a.points_balance, 0),
         coalesce(a.lifetime_points, 0),
         coalesce(a.rewards_unlocked, 0),
         coalesce(a.rewards_redeemed, 0),
         exists (select 1 from public.loyalty_rewards r
                  where r.vehicle_id = p_vehicle and r.status = 'available'),
         c.reward_percent,
         c.reward_threshold,
         greatest(0, c.reward_threshold - coalesce(a.points_balance, 0))
    from app.loyalty_config() c
    left join public.loyalty_accounts a on a.vehicle_id = p_vehicle;
$$;

grant execute on function app.vehicle_loyalty(uuid) to authenticated;
