-- ===========================================================================
-- RamosMAX Web — Phase E — 0019: row level security for finance, expenses
-- and inventory
-- ===========================================================================
-- Default-deny, as everywhere else: `authenticated` holds SELECT only, and a
-- row is visible only to someone holding the Phase 9 permission for it. Every
-- write goes through a SECURITY DEFINER function.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- CLOSES A REAL HOLE: account balances were readable by any cashier
-- ---------------------------------------------------------------------------
-- Phase D added `accounts_choosable` so a cashier could pick the bank account
-- a payment went into. A row policy cannot hide a column, and SELECT was
-- granted on the whole table, so the same cashier could read `balance_ugx` and
-- `awaiting_banking_ugx` for every account — which `finance.view` exists to
-- prevent, and which the reference implementation never exposes (its
-- `settings/payment_accounts` holds names and masked numbers only).
--
-- The picker now comes from a view that runs as its OWNER and selects only the
-- safe columns, so the base table can stay closed to anyone without
-- `finance.view`.

drop policy if exists accounts_choosable on public.financial_accounts;

drop view if exists public.payment_accounts;
create view public.payment_accounts as
  select a.id, a.code, a.name, a.type, a.provider, a.payment_method,
         app.mask_account_number(a.account_number) as account_number_masked
    from public.financial_accounts a
   where a.is_active
     -- The view runs as its owner, so this is the whole access check.
     and (app.has_either_permission('payments.record', 'invoices.view')
          or app.has_either_permission('expenses.pay', 'finance.view'));

comment on view public.payment_accounts is
  'The accounts a payment may be recorded against: names and masked numbers, never a balance. Ports settings/payment_accounts, which is why a Cashier may read it.';

grant select on public.payment_accounts to authenticated;

-- ---------------------------------------------------------------------------
-- Finance
-- ---------------------------------------------------------------------------

drop policy if exists ledger_entries_read on public.financial_transaction_entries;
create policy ledger_entries_read on public.financial_transaction_entries
  for select to authenticated using (app.has_permission('finance.transactions.view'));

drop policy if exists deposits_read on public.bank_deposits;
create policy deposits_read on public.bank_deposits
  for select to authenticated using (app.has_permission('finance.transactions.view'));

drop policy if exists reconciliations_read on public.reconciliations;
create policy reconciliations_read on public.reconciliations
  for select to authenticated using (app.has_permission('finance.transactions.view'));

drop policy if exists finance_events_read on public.finance_events;
create policy finance_events_read on public.finance_events
  for select to authenticated
  using (app.has_either_permission('finance.view', 'expenses.view'));

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------

drop policy if exists expenses_read on public.expenses;
create policy expenses_read on public.expenses
  for select to authenticated using (app.has_permission('expenses.view'));

drop policy if exists expense_categories_read on public.expense_categories;
create policy expense_categories_read on public.expense_categories
  for select to authenticated
  using (app.has_either_permission('expenses.view', 'expenses.create'));

drop policy if exists recurring_expenses_read on public.recurring_expenses;
create policy recurring_expenses_read on public.recurring_expenses
  for select to authenticated using (app.has_permission('expenses.view'));

-- ---------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------

drop policy if exists suppliers_read on public.suppliers;
create policy suppliers_read on public.suppliers
  for select to authenticated using (app.has_permission('inventory.view'));

drop policy if exists items_read on public.inventory_items;
create policy items_read on public.inventory_items
  for select to authenticated using (app.has_permission('inventory.view'));

drop policy if exists movements_read on public.stock_movements;
create policy movements_read on public.stock_movements
  for select to authenticated using (app.has_permission('inventory.view'));

drop policy if exists purchases_read on public.inventory_purchases;
create policy purchases_read on public.inventory_purchases
  for select to authenticated using (app.has_permission('inventory.view'));

drop policy if exists purchase_items_read on public.inventory_purchase_items;
create policy purchase_items_read on public.inventory_purchase_items
  for select to authenticated using (app.has_permission('inventory.view'));

drop policy if exists inventory_events_read on public.inventory_events;
create policy inventory_events_read on public.inventory_events
  for select to authenticated using (app.has_permission('inventory.view'));

-- ---------------------------------------------------------------------------
-- Read privileges
-- ---------------------------------------------------------------------------
-- SELECT only. Every INSERT, UPDATE and DELETE stays with the functions.

grant select on
  public.financial_transaction_entries, public.bank_deposits, public.reconciliations,
  public.finance_events, public.expenses, public.expense_categories,
  public.recurring_expenses, public.suppliers, public.inventory_items,
  public.stock_movements, public.inventory_purchases, public.inventory_purchase_items,
  public.inventory_events
to authenticated;
