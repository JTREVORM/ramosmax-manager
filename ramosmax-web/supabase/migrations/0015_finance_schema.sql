-- ===========================================================================
-- RamosMAX Web — Phase E — 0015: finance schema
-- ===========================================================================
-- EXTENDS the Phase D finance slice. It does not replace it: the same
-- `financial_accounts`, `financial_transactions` and `finance_daily_summaries`
-- carry customer payments, expense payments, stock purchases, transfers,
-- deposits, adjustments and opening balances. There is one ledger.
--
-- Ports `functions/src/finance.js`:
--
--   balanceUgx = Σ entries[].deltaUgx for the account          (tested)
--   no overdraft: an outflow larger than the balance is refused
--   nothing is edited or deleted: a mistake is reversed or adjusted
--
-- The Firestore document held its per-account movements in an `entries` array.
-- The relational equivalent is `financial_transaction_entries`: one row per
-- account a transaction touched, with the signed change and the balance after
-- it. The transaction row keeps its Phase D `account_id` / `direction` /
-- `balance_after_ugx` describing the PRIMARY account (the source of an
-- outflow, the destination of an inflow), so every Phase D query and test
-- continues to read exactly what it read before.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- financial_accounts
-- ---------------------------------------------------------------------------

alter table public.financial_accounts
  add column if not exists account_number           text,
  add column if not exists is_default               boolean not null default false,
  add column if not exists opening_balance_ugx      bigint  not null default 0,
  add column if not exists opening_balance_recorded boolean not null default false,
  -- Cash collected from customers and not yet taken to a bank. It is PART of
  -- the cash balance, never extra money.
  add column if not exists awaiting_banking_ugx     bigint  not null default 0,
  add column if not exists notes                    text,
  add column if not exists transaction_count        integer not null default 0,
  add column if not exists last_transaction_at      timestamptz,
  add column if not exists created_by               uuid references public.users (id),
  add column if not exists updated_by               uuid references public.users (id);

-- Names are unique case-insensitively, as `nameKey` made them.
create unique index if not exists accounts_name_key
  on public.financial_accounts (lower(btrim(name)));

-- Account / merchant numbers are unique per type.
create unique index if not exists accounts_number_key
  on public.financial_accounts (type, upper(account_number))
  where account_number is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_awaiting_within_balance') then
    -- `greatest(balance, 0)` so that an attempt to write a negative balance is
    -- reported by accounts_balance_non_negative, which is the real rule there.
    alter table public.financial_accounts
      add constraint accounts_awaiting_within_balance
      check (awaiting_banking_ugx >= 0 and awaiting_banking_ugx <= greatest(balance_ugx, 0));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounts_opening_non_negative') then
    alter table public.financial_accounts
      add constraint accounts_opening_non_negative check (opening_balance_ugx >= 0);
  end if;
end;
$$;

-- The waiting amount is bookkeeping ON TOP of the balance, so it follows the
-- balance wherever the balance goes. `Ledger._move` clamps it to 0..balance on
-- every movement; this trigger makes that true of every write, including one
-- that lowers a balance by another route.
create or replace function app.clamp_awaiting_banking()
returns trigger
language plpgsql
as $$
begin
  if new.type = 'cash' then
    new.awaiting_banking_ugx := greatest(0, least(new.awaiting_banking_ugx, greatest(new.balance_ugx, 0)));
  else
    new.awaiting_banking_ugx := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists accounts_clamp_awaiting on public.financial_accounts;
create trigger accounts_clamp_awaiting
  before insert or update on public.financial_accounts
  for each row execute function app.clamp_awaiting_banking();

comment on column public.financial_accounts.awaiting_banking_ugx is
  'Cash at hand collected from customers and not yet banked. Part of balance_ugx, never additional money. Clamped to 0..balance_ugx.';

-- ---------------------------------------------------------------------------
-- The permanent accounts
-- ---------------------------------------------------------------------------
-- DEFAULT_ACCOUNTS in finance.js are created on first use, because Firestore
-- has no schema step. A relational database does, so they are created here.
-- These three receive customer payments and can never be deactivated; bank
-- accounts are added by an administrator.
insert into public.financial_accounts (code, name, type, provider, payment_method, is_default) values
  ('cash_at_hand',    'Cash at Hand',    'cash',         null,            'cash',            true),
  ('mtn_merchant',    'MTN Merchant',    'mobile_money', 'MTN Uganda',    'mtn_merchant',    true),
  ('airtel_merchant', 'Airtel Merchant', 'mobile_money', 'Airtel Uganda', 'airtel_merchant', true)
on conflict (code) do nothing;

update public.financial_accounts
   set is_default = true
 where code in ('cash_at_hand', 'mtn_merchant', 'airtel_merchant');

-- ---------------------------------------------------------------------------
-- financial_transactions
-- ---------------------------------------------------------------------------

alter table public.financial_transactions
  add column if not exists reversal_of_type       text,
  add column if not exists source_account_id      uuid references public.financial_accounts (id),
  add column if not exists destination_account_id uuid references public.financial_accounts (id),
  add column if not exists status                 text not null default 'posted',
  add column if not exists request_id             text,
  -- The BUSINESS date the person chose. `business_day` stays the EAT day the
  -- entry was posted, which is what the daily summaries count.
  add column if not exists transaction_date       date,
  add column if not exists reference              text,
  add column if not exists reason                 text,
  add column if not exists category_id            text,
  add column if not exists approved_by            uuid references public.users (id),
  add column if not exists reversed_at            timestamptz,
  add column if not exists reversed_by            uuid references public.users (id),
  add column if not exists reversal_reason        text;

-- Revenue is customer payments and nothing else. Derived, never asserted.
alter table public.financial_transactions
  add column if not exists is_revenue boolean
  generated always as (entry_type = 'customer_payment') stored;

do $$
begin
  alter table public.financial_transactions drop constraint if exists ledger_entry_type;
  alter table public.financial_transactions
    add constraint ledger_entry_type check (entry_type in (
      'customer_payment', 'expense_payment', 'inventory_purchase_payment',
      'account_transfer', 'bank_deposit', 'adjustment', 'opening_balance', 'reversal'));
  if not exists (select 1 from pg_constraint where conname = 'ledger_status') then
    alter table public.financial_transactions
      add constraint ledger_status check (status in ('posted', 'reversed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ledger_reversal_names_its_original') then
    alter table public.financial_transactions
      add constraint ledger_reversal_names_its_original
      check ((entry_type = 'reversal') = (reverses_id is not null));
  end if;
end;
$$;

update public.financial_transactions
   set transaction_date = coalesce(transaction_date, business_day)
 where transaction_date is null;

create index if not exists ledger_type_idx    on public.financial_transactions (entry_type, created_at desc);
create index if not exists ledger_day_idx     on public.financial_transactions (business_day);
create unique index if not exists ledger_request_key
  on public.financial_transactions (request_id) where request_id is not null;

-- ---------------------------------------------------------------------------
-- financial_transaction_entries — the per-account movements
-- ---------------------------------------------------------------------------
-- One row per account a transaction touched. This is the authoritative record
-- of what happened to each balance:
--
--   financial_accounts.balance_ugx = Σ delta_ugx over this table
--
-- which holds for every account and every transaction type, including the two
-- sides of a transfer or a bank deposit.

create table if not exists public.financial_transaction_entries (
  id                uuid primary key default gen_random_uuid(),
  transaction_id    uuid not null references public.financial_transactions (id),
  account_id        uuid not null references public.financial_accounts (id),
  delta_ugx         bigint not null,
  balance_after_ugx bigint not null,
  created_at        timestamptz not null default now(),

  constraint entry_delta_not_zero check (delta_ugx <> 0),
  constraint entry_balance_non_negative check (balance_after_ugx >= 0),
  constraint entries_one_per_account unique (transaction_id, account_id)
);

create index if not exists entries_account_idx
  on public.financial_transaction_entries (account_id, created_at desc);

comment on table public.financial_transaction_entries is
  'Ports the `entries` array of a Firestore ledger document: for every account a transaction touched, the signed change and the balance after it.';

-- ---------------------------------------------------------------------------
-- finance_daily_summaries
-- ---------------------------------------------------------------------------
-- Written in the SAME transaction as every ledger entry, so a report can never
-- disagree with the ledger. A reversal counts on the day it is made.

alter table public.finance_daily_summaries
  add column if not exists expenses_paid_ugx    bigint not null default 0,
  add column if not exists purchases_paid_ugx   bigint not null default 0,
  add column if not exists transfers_ugx        bigint not null default 0,
  add column if not exists deposits_ugx         bigint not null default 0,
  add column if not exists adjustments_in_ugx   bigint not null default 0,
  add column if not exists adjustments_out_ugx  bigint not null default 0,
  add column if not exists opening_balances_ugx bigint not null default 0,
  add column if not exists transaction_count    integer not null default 0,
  -- reversals.{originalType}Ugx, expensesByCategory.{categoryId} and
  -- byAccount.{accountId}.{in,out}Ugx, kept as the reference shaped them.
  add column if not exists reversals            jsonb not null default '{}'::jsonb,
  add column if not exists expenses_by_category jsonb not null default '{}'::jsonb,
  add column if not exists by_account           jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- bank_deposits
-- ---------------------------------------------------------------------------

create table if not exists public.bank_deposits (
  id                 uuid primary key default gen_random_uuid(),
  deposit_number     text not null unique,

  source_account_id  uuid not null references public.financial_accounts (id),
  bank_account_id    uuid not null references public.financial_accounts (id),
  amount_ugx         bigint not null,
  deposit_date       date not null,
  bank_reference     text not null,
  description        text,

  status             text not null default 'completed',
  transaction_id     uuid references public.financial_transactions (id),
  request_id         text,

  reversal_reason    text,
  reversal_transaction_id uuid references public.financial_transactions (id),
  reversed_at        timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references public.users (id),
  created_by_name    text,
  approved_by        uuid references public.users (id),

  constraint deposit_amount     check (amount_ugx > 0),
  constraint deposit_status     check (status in ('completed', 'reversed')),
  constraint deposit_accounts   check (source_account_id <> bank_account_id),
  constraint deposit_reference  check (btrim(bank_reference) <> '')
);

create index if not exists deposits_day_idx on public.bank_deposits (deposit_date desc);

-- ---------------------------------------------------------------------------
-- reconciliations
-- ---------------------------------------------------------------------------
-- A reconciliation NEVER changes a balance. It records what the system says,
-- what was counted, and the difference. Closing a difference needs an explicit
-- adjustment, which is a separate authorised act.

create table if not exists public.reconciliations (
  id                    uuid primary key default gen_random_uuid(),
  reconciliation_number text not null unique,

  account_id            uuid not null references public.financial_accounts (id),
  account_name          text not null,
  account_type          text not null,
  reconciliation_date   date not null,

  -- Read inside the transaction, from the account itself.
  system_balance_ugx    bigint not null,
  actual_balance_ugx    bigint not null,
  -- Actual − System: positive means more money than recorded.
  difference_ugx        bigint generated always as (actual_balance_ugx - system_balance_ugx) stored,
  status                text not null,

  notes                 text,
  adjustment_transaction_id uuid references public.financial_transactions (id),
  adjusted_by           uuid references public.users (id),
  request_id            text,

  reconciled_by         uuid references public.users (id),
  reconciled_by_name    text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint reconciliation_actual  check (actual_balance_ugx >= 0),
  constraint reconciliation_system  check (system_balance_ugx >= 0),
  constraint reconciliation_status  check (status in ('balanced', 'discrepancy', 'adjusted'))
);

create index if not exists reconciliations_account_idx
  on public.reconciliations (account_id, created_at desc);

-- ---------------------------------------------------------------------------
-- finance_events — the hand-off point for notifications
-- ---------------------------------------------------------------------------
-- Phase 9 notifies holders of a permission (a reconciliation difference, an
-- expense waiting for review, a recurring expense due). The web port records
-- the EVENT here, in the same transaction as the change that caused it;
-- delivery is a later phase, exactly as loyalty_events already works.

create table if not exists public.finance_events (
  id             uuid primary key default gen_random_uuid(),
  type           text not null,
  reference_type text not null,
  reference_id   uuid not null,
  audience       text not null,
  payload        jsonb not null default '{}'::jsonb,
  delivered      boolean not null default false,
  created_at     timestamptz not null default now(),

  constraint finance_event_type check (type in (
    'reconciliation_difference', 'expense_awaiting_approval', 'expense_decided',
    'recurring_expense_due'))
);

create index if not exists finance_events_undelivered_idx
  on public.finance_events (created_at) where not delivered;

-- ---------------------------------------------------------------------------
-- Reference number sequences
-- ---------------------------------------------------------------------------

create sequence if not exists app.deposit_number_seq        as bigint start 1;
create sequence if not exists app.reconciliation_number_seq as bigint start 1;

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------

-- The ledger guard, widened for the columns Phase E adds. Everything that
-- describes the money is frozen; only the reversal marking may ever be set,
-- and only once.
create or replace function app.guard_ledger_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.transaction_number     is distinct from old.transaction_number
  or new.account_id             is distinct from old.account_id
  or new.entry_type             is distinct from old.entry_type
  or new.direction              is distinct from old.direction
  or new.amount_ugx             is distinct from old.amount_ugx
  or new.balance_after_ugx      is distinct from old.balance_after_ugx
  or new.reference_type         is distinct from old.reference_type
  or new.reference_id           is distinct from old.reference_id
  or new.business_day           is distinct from old.business_day
  or new.created_at             is distinct from old.created_at
  or new.reverses_id            is distinct from old.reverses_id
  or new.source_account_id      is distinct from old.source_account_id
  or new.destination_account_id is distinct from old.destination_account_id
  or new.transaction_date       is distinct from old.transaction_date
  or new.request_id             is distinct from old.request_id
  or new.reversal_of_type       is distinct from old.reversal_of_type
  or new.category_id            is distinct from old.category_id then
    raise exception 'financial_transactions is immutable: post a reversal instead'
      using errcode = 'restrict_violation';
  end if;
  if old.reversed_by_id is not null and new.reversed_by_id is distinct from old.reversed_by_id then
    raise exception 'This ledger entry has already been reversed'
      using errcode = 'restrict_violation';
  end if;
  -- posted → reversed is the only status change there is.
  if new.status is distinct from old.status and not (old.status = 'posted' and new.status = 'reversed') then
    raise exception 'A ledger entry can only go from posted to reversed'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

-- The per-account movements never change at all.
drop trigger if exists ledger_entries_immutable on public.financial_transaction_entries;
create trigger ledger_entries_immutable
  before update or delete on public.financial_transaction_entries
  for each row execute function app.forbid_update_delete();

-- A deposit and a reconciliation are records of an event: their money figures
-- are frozen, and only the outcome fields may move.
create or replace function app.guard_deposit_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.deposit_number    is distinct from old.deposit_number
  or new.source_account_id is distinct from old.source_account_id
  or new.bank_account_id   is distinct from old.bank_account_id
  or new.amount_ugx        is distinct from old.amount_ugx
  or new.deposit_date      is distinct from old.deposit_date
  or new.created_at        is distinct from old.created_at then
    raise exception 'bank_deposits is immutable: reverse the deposit instead'
      using errcode = 'restrict_violation';
  end if;
  -- The ledger entry is attached once, when the deposit posts, and never
  -- changed after that.
  if old.transaction_id is not null and new.transaction_id is distinct from old.transaction_id then
    raise exception 'A deposit keeps the ledger entry it posted'
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'reversed' and new.status <> 'reversed' then
    raise exception 'A reversed deposit cannot be reinstated' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists deposit_immutable on public.bank_deposits;
create trigger deposit_immutable before update on public.bank_deposits
  for each row execute function app.guard_deposit_immutable();

create or replace function app.guard_reconciliation_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.reconciliation_number is distinct from old.reconciliation_number
  or new.account_id            is distinct from old.account_id
  or new.system_balance_ugx    is distinct from old.system_balance_ugx
  or new.actual_balance_ugx    is distinct from old.actual_balance_ugx
  or new.reconciliation_date   is distinct from old.reconciliation_date
  or new.created_at            is distinct from old.created_at then
    raise exception 'reconciliations is immutable: the counted figures cannot be rewritten'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists reconciliation_immutable on public.reconciliations;
create trigger reconciliation_immutable before update on public.reconciliations
  for each row execute function app.guard_reconciliation_immutable();

-- An event is a record of something that happened. Only the delivery flag may
-- ever move; the event itself cannot be rewritten.
create or replace function app.guard_event_delivery()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
  or new.type is distinct from old.type
  or new.created_at is distinct from old.created_at
  or to_jsonb(new) - 'delivered' is distinct from to_jsonb(old) - 'delivered' then
    raise exception '% records what happened: only delivery may be marked', tg_table_name
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists finance_events_delivery_only on public.finance_events;
create trigger finance_events_delivery_only
  before update on public.finance_events
  for each row execute function app.guard_event_delivery();

drop trigger if exists loyalty_events_delivery_only on public.loyalty_events;
create trigger loyalty_events_delivery_only
  before update on public.loyalty_events
  for each row execute function app.guard_event_delivery();

-- Financial history is never deleted.
do $$
declare t text;
begin
  foreach t in array array['financial_transaction_entries', 'bank_deposits',
                           'reconciliations', 'finance_events', 'finance_daily_summaries']
  loop
    execute format('drop trigger if exists %I_no_delete on public.%I', t, t);
    execute format('create trigger %I_no_delete before delete on public.%I
                    for each row execute function app.forbid_delete()', t, t);
  end loop;
end;
$$;

-- updated_at maintenance for the tables that carry it.
do $$
declare t text;
begin
  foreach t in array array['bank_deposits', 'reconciliations']
  loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function app.touch_updated_at()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security: closed until 0019 opens exactly what each role may read
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['financial_transaction_entries', 'bank_deposits',
                           'reconciliations', 'finance_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end;
$$;
