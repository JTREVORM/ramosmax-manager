-- ===========================================================================
-- RamosMAX Web — Phase D — 0010: invoices, payments, receipts, credit, loyalty
-- ===========================================================================
-- Ports the Phase 4 money model (docs/BILLING_AND_PAYMENTS.md, LOYALTY.md).
--
-- MONEY IS BIGINT WHOLE SHILLINGS. There is no floating point anywhere.
--
-- DERIVED AMOUNTS ARE GENERATED COLUMNS. total, outstanding and payment_status
-- are computed by PostgreSQL from the base columns, so no caller — not the
-- browser, not a Server Action, not even a buggy RPC — can write a total that
-- disagrees with its parts:
--
--   total_ugx       = subtotal_ugx - discount_ugx
--   outstanding_ugx = subtotal_ugx - discount_ugx - paid_ugx
--   payment_status  = cancelled | paid | credit | partially_paid | unpaid
--
-- FINANCE SLICE. Phase 9 writes a customer_payment ledger entry in the SAME
-- transaction as the payment, and the payment stores the account and
-- transaction it posted to. Payments cannot be atomic without it, so the
-- minimum ledger is built here: accounts, an append-only transaction ledger
-- and daily summaries, serving ONLY customer payments and their reversals.
-- Transfers, deposits, reconciliation and expenses remain Phase E.
-- ===========================================================================

create sequence if not exists app.invoice_number_seq;
create sequence if not exists app.receipt_number_seq;
create sequence if not exists app.transaction_number_seq;

-- ---------------------------------------------------------------------------
-- financial_accounts
-- ---------------------------------------------------------------------------

create table if not exists public.financial_accounts (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name           text not null,
  type           text not null,
  provider       text,
  payment_method text unique,
  balance_ugx    bigint not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint accounts_type check (type in ('cash', 'mobile_money', 'bank')),
  -- An account balance may never go negative: money cannot be taken out of an
  -- account that does not hold it.
  constraint accounts_balance_non_negative check (balance_ugx >= 0)
);

-- ---------------------------------------------------------------------------
-- financial_transactions — the immutable ledger
-- ---------------------------------------------------------------------------

create table if not exists public.financial_transactions (
  id                 uuid primary key default gen_random_uuid(),
  transaction_number text not null unique,

  account_id         uuid not null references public.financial_accounts (id),
  entry_type         text not null,
  direction          text not null,
  amount_ugx         bigint not null,
  balance_after_ugx  bigint not null,

  reference_type     text,
  reference_id       uuid,
  description        text,

  -- A reversal names the entry it undoes; the original names its reversal.
  reverses_id        uuid references public.financial_transactions (id),
  reversed_by_id     uuid references public.financial_transactions (id),

  business_day       date not null,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.users (id),

  constraint ledger_entry_type check (entry_type in ('customer_payment', 'reversal')),
  constraint ledger_direction  check (direction in ('in', 'out')),
  constraint ledger_amount     check (amount_ugx > 0),
  constraint ledger_balance    check (balance_after_ugx >= 0)
);

create index if not exists ledger_account_idx on public.financial_transactions (account_id, created_at desc);
create index if not exists ledger_reference_idx on public.financial_transactions (reference_type, reference_id);

-- Server-maintained totals per East Africa Time business day, written in the
-- SAME transaction as every ledger entry so reports can never disagree.
create table if not exists public.finance_daily_summaries (
  business_day     date primary key,
  payments_in_ugx  bigint not null default 0,
  reversals_ugx    bigint not null default 0,
  updated_at       timestamptz not null default now(),

  constraint summary_non_negative check (payments_in_ugx >= 0 and reversals_ugx >= 0)
);

-- ---------------------------------------------------------------------------
-- invoices
-- ---------------------------------------------------------------------------

create table if not exists public.invoices (
  id                uuid primary key default gen_random_uuid(),
  invoice_number    text not null unique,

  service_intake_id uuid not null references public.service_intakes (id),
  job_number        text not null,
  vehicle_id        uuid not null references public.vehicles (id),
  number_plate      text not null,
  customer_id       uuid references public.customers (id),
  customer_name     text,

  subtotal_ugx      bigint not null,
  discount_ugx      bigint not null default 0,
  paid_ugx          bigint not null default 0,

  -- Derived by the DATABASE. Nothing can write these.
  total_ugx         bigint generated always as (subtotal_ugx - discount_ugx) stored,
  outstanding_ugx   bigint generated always as (subtotal_ugx - discount_ugx - paid_ugx) stored,

  status            text not null default 'active',
  on_credit         boolean not null default false,
  credit_reason     text,
  credit_marked_at  timestamptz,
  credit_marked_by  uuid references public.users (id),

  -- Ports paymentStatusFor(): cancelled wins, then fully paid, then credit,
  -- then partially paid. The order matters and is preserved exactly.
  payment_status    text generated always as (
    case
      when status = 'cancelled'                          then 'cancelled'
      when subtotal_ugx - discount_ugx - paid_ugx = 0    then 'paid'
      when on_credit                                     then 'credit'
      when paid_ugx > 0                                  then 'partially_paid'
      else 'unpaid'
    end
  ) stored,

  -- Loyalty is earned once per invoice, when it becomes fully paid.
  loyalty_earned        boolean not null default false,
  loyalty_points_earned integer not null default 0,

  cancelled_at      timestamptz,
  cancelled_by      uuid references public.users (id),
  cancel_reason     text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references public.users (id),
  created_by_name   text,
  updated_by        uuid references public.users (id),

  constraint invoices_status          check (status in ('active', 'cancelled')),
  constraint invoices_subtotal        check (subtotal_ugx >= 0),
  constraint invoices_discount_range  check (discount_ugx >= 0 and discount_ugx <= subtotal_ugx),
  constraint invoices_paid_range      check (paid_ugx >= 0 and paid_ugx <= subtotal_ugx - discount_ugx),
  constraint invoices_loyalty_points  check (loyalty_points_earned >= 0)
);

-- One invoice per job. Cancelling frees the job to be invoiced again, so the
-- index excludes cancelled invoices.
create unique index if not exists invoices_one_per_job
  on public.invoices (service_intake_id) where status <> 'cancelled';

create index if not exists invoices_status_idx   on public.invoices (payment_status, created_at desc);
create index if not exists invoices_customer_idx on public.invoices (customer_id);
create index if not exists invoices_vehicle_idx  on public.invoices (vehicle_id);

-- Line items: a snapshot of what was completed, at the price agreed at intake.
create table if not exists public.invoice_items (
  id                    uuid primary key default gen_random_uuid(),
  invoice_id            uuid not null references public.invoices (id),
  worker_order_id       uuid not null references public.worker_orders (id),
  service_id            uuid not null references public.services (id),
  service_name          text not null,
  category              text not null,
  price_ugx             bigint not null,
  qualifies_for_loyalty boolean not null default false,

  constraint invoice_items_price check (price_ugx >= 0)
);

create index if not exists invoice_items_invoice_idx on public.invoice_items (invoice_id);
create unique index if not exists invoice_items_one_per_order
  on public.invoice_items (invoice_id, worker_order_id);

-- ---------------------------------------------------------------------------
-- discounts
-- ---------------------------------------------------------------------------

create table if not exists public.discounts (
  id                 uuid primary key default gen_random_uuid(),
  invoice_id         uuid not null references public.invoices (id),
  source             text not null default 'manual',
  discount_type      text not null,
  discount_value     bigint not null,
  discount_amount_ugx bigint not null,
  reason_code        text not null,
  reason             text,
  description        text,
  approved_by        uuid references public.users (id),
  status             text not null default 'active',

  created_at         timestamptz not null default now(),
  created_by         uuid references public.users (id),

  constraint discounts_source check (source in ('manual', 'loyalty_reward')),
  constraint discounts_type   check (discount_type in ('percentage', 'fixed')),
  constraint discounts_status check (status in ('active', 'cancelled')),
  constraint discounts_amount check (discount_amount_ugx > 0),
  constraint discounts_reason_code check (reason_code in
    ('manager_approval', 'promotional', 'service_issue', 'other', 'loyalty_reward'))
);

-- One ACTIVE discount per invoice.
create unique index if not exists discounts_one_per_invoice
  on public.discounts (invoice_id) where status = 'active';

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
-- A payment is never deleted. It is marked `reversed`, and the reversal keeps
-- the original amount, method and reference intact.

create table if not exists public.payments (
  id                       uuid primary key default gen_random_uuid(),
  invoice_id               uuid not null references public.invoices (id),
  amount_ugx               bigint not null,
  method                   text not null,
  reference                text,
  notes                    text,
  status                   text not null default 'active',

  financial_account_id     uuid not null references public.financial_accounts (id),
  financial_transaction_id uuid not null references public.financial_transactions (id),

  -- The idempotency key. One logical payment attempt, however many times the
  -- client retries it.
  request_id               text not null unique,

  reversed_at              timestamptz,
  reversed_by              uuid references public.users (id),
  reversal_reason          text,
  reversal_transaction_id  uuid references public.financial_transactions (id),

  created_at               timestamptz not null default now(),
  created_by               uuid references public.users (id),
  created_by_name          text,

  constraint payments_status check (status in ('active', 'reversed')),
  constraint payments_amount check (amount_ugx > 0),
  constraint payments_method check (method in ('cash', 'mtn_merchant', 'airtel_merchant', 'bank')),
  -- Every method except cash needs a transaction reference.
  constraint payments_reference_required check (
    method = 'cash' or (reference is not null and btrim(reference) <> ''))
);

create index if not exists payments_invoice_idx on public.payments (invoice_id, created_at);
create index if not exists payments_created_idx on public.payments (created_at desc);

-- ---------------------------------------------------------------------------
-- receipts
-- ---------------------------------------------------------------------------

create table if not exists public.receipts (
  id             uuid primary key default gen_random_uuid(),
  receipt_number text not null unique,
  payment_id     uuid not null unique references public.payments (id),
  invoice_id     uuid not null references public.invoices (id),
  -- A full snapshot of what was shown at the counter, frozen at issue time.
  snapshot       jsonb not null,
  status         text not null default 'active',
  created_at     timestamptz not null default now(),
  created_by     uuid references public.users (id),

  constraint receipts_status check (status in ('active', 'reversed'))
);

-- ---------------------------------------------------------------------------
-- loyalty
-- ---------------------------------------------------------------------------
-- Loyalty belongs to the VEHICLE, not the customer. A customer with two cars
-- has two accounts.

create table if not exists public.loyalty_accounts (
  vehicle_id       uuid primary key references public.vehicles (id),
  points_balance   integer not null default 0,
  lifetime_points  integer not null default 0,
  rewards_unlocked integer not null default 0,
  rewards_redeemed integer not null default 0,
  last_earned_at   timestamptz,
  updated_at       timestamptz not null default now(),

  -- The balance never goes negative, even when a reversal takes back more
  -- than remains.
  constraint loyalty_balance_non_negative check (points_balance >= 0)
);

create table if not exists public.loyalty_transactions (
  id             uuid primary key default gen_random_uuid(),
  vehicle_id     uuid not null references public.vehicles (id),
  type           text not null,
  points         integer not null,
  balance_before integer not null,
  balance_after  integer not null,
  reference_type text,
  reference_id   uuid,
  reason         text,
  reversed_by_id uuid references public.loyalty_transactions (id),
  created_at     timestamptz not null default now(),
  created_by     uuid references public.users (id),

  constraint loyalty_type check (type in ('earned', 'redeemed', 'adjustment', 'reversal', 'expiry')),
  constraint loyalty_balances check (balance_before >= 0 and balance_after >= 0)
);

create index if not exists loyalty_tx_vehicle_idx on public.loyalty_transactions (vehicle_id, created_at desc);

create table if not exists public.loyalty_rewards (
  id               uuid primary key default gen_random_uuid(),
  vehicle_id       uuid not null references public.vehicles (id),
  status           text not null default 'available',
  discount_percent integer not null,
  points_cost      integer not null,
  invoice_id       uuid references public.invoices (id),
  unlocked_at      timestamptz not null default now(),
  redeemed_at      timestamptz,
  redeemed_by      uuid references public.users (id),

  constraint rewards_status check (status in ('available', 'redeemed', 'reversed', 'revoked'))
);

-- ONE available reward per vehicle. Points above the threshold do not unlock a
-- second reward until the first is used.
create unique index if not exists rewards_one_available_per_vehicle
  on public.loyalty_rewards (vehicle_id) where status = 'available';

-- Hand-off records for future customer messages (SMS or WhatsApp). Customers
-- are not app users.
create table if not exists public.loyalty_events (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references public.vehicles (id),
  type         text not null,
  number_plate text,
  balance      integer,
  delivered    boolean not null default false,
  created_at   timestamptz not null default now(),

  constraint loyalty_event_type check (type in ('reward_nearing', 'reward_unlocked', 'reward_redeemed'))
);

-- ===========================================================================
-- Immutability
-- ===========================================================================
-- Financial history is never rewritten to represent a later event. Corrections
-- are reversal records.

-- Fully append-only: not one column may change.
do $$
declare t text;
begin
  foreach t in array array['financial_transactions', 'invoice_items',
                           'loyalty_transactions', 'receipts'] loop
    execute format('drop trigger if exists %I_no_delete on public.%I', t, t);
    execute format('create trigger %I_no_delete before delete on public.%I
                    for each row execute function app.forbid_delete()', t, t);
  end loop;
end;
$$;

-- financial_transactions: only the reversal link may ever be set, and only
-- once. Amount, account, direction and balance are frozen.
create or replace function app.guard_ledger_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.transaction_number is distinct from old.transaction_number
  or new.account_id        is distinct from old.account_id
  or new.entry_type        is distinct from old.entry_type
  or new.direction         is distinct from old.direction
  or new.amount_ugx        is distinct from old.amount_ugx
  or new.balance_after_ugx is distinct from old.balance_after_ugx
  or new.reference_type    is distinct from old.reference_type
  or new.reference_id      is distinct from old.reference_id
  or new.business_day      is distinct from old.business_day
  or new.created_at        is distinct from old.created_at
  or new.reverses_id       is distinct from old.reverses_id then
    raise exception 'financial_transactions is immutable: post a reversal instead'
      using errcode = 'restrict_violation';
  end if;
  if old.reversed_by_id is not null and new.reversed_by_id is distinct from old.reversed_by_id then
    raise exception 'This ledger entry has already been reversed'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists ledger_immutable on public.financial_transactions;
create trigger ledger_immutable before update on public.financial_transactions
  for each row execute function app.guard_ledger_immutable();

-- invoice_items and loyalty_transactions never change at all.
drop trigger if exists invoice_items_immutable on public.invoice_items;
create trigger invoice_items_immutable before update on public.invoice_items
  for each row execute function app.forbid_update_delete();

create or replace function app.guard_loyalty_ledger_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.vehicle_id     is distinct from old.vehicle_id
  or new.type           is distinct from old.type
  or new.points         is distinct from old.points
  or new.balance_before is distinct from old.balance_before
  or new.balance_after  is distinct from old.balance_after
  or new.created_at     is distinct from old.created_at then
    raise exception 'loyalty_transactions is immutable: record a reversal instead'
      using errcode = 'restrict_violation';
  end if;
  if old.reversed_by_id is not null and new.reversed_by_id is distinct from old.reversed_by_id then
    raise exception 'This loyalty entry has already been reversed'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists loyalty_ledger_immutable on public.loyalty_transactions;
create trigger loyalty_ledger_immutable before update on public.loyalty_transactions
  for each row execute function app.guard_loyalty_ledger_immutable();

-- payments: the MONEY is frozen. Only the reversal fields may be written, and
-- only once.
create or replace function app.guard_payment_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.invoice_id               is distinct from old.invoice_id
  or new.amount_ugx               is distinct from old.amount_ugx
  or new.method                   is distinct from old.method
  or new.reference                is distinct from old.reference
  or new.request_id               is distinct from old.request_id
  or new.financial_account_id     is distinct from old.financial_account_id
  or new.financial_transaction_id is distinct from old.financial_transaction_id
  or new.created_at               is distinct from old.created_at
  or new.created_by               is distinct from old.created_by then
    raise exception 'A payment cannot be altered: reverse it instead'
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'reversed' and new.status = 'reversed'
     and new.reversed_at is distinct from old.reversed_at then
    raise exception 'This payment has already been reversed'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists payments_immutable on public.payments;
create trigger payments_immutable before update on public.payments
  for each row execute function app.guard_payment_immutable();

-- Invoices: once money has been taken, the agreed amounts are frozen. Only
-- paid_ugx, status, credit and loyalty bookkeeping may move after that.
create or replace function app.guard_invoice_history()
returns trigger
language plpgsql
as $$
begin
  if new.invoice_number    is distinct from old.invoice_number
  or new.service_intake_id is distinct from old.service_intake_id
  or new.subtotal_ugx      is distinct from old.subtotal_ugx
  or new.created_at        is distinct from old.created_at then
    raise exception 'An invoice''s identity and subtotal are immutable'
      using errcode = 'restrict_violation';
  end if;
  -- The discount may only be set before any money is taken.
  if new.discount_ugx is distinct from old.discount_ugx and old.paid_ugx > 0 then
    raise exception 'The discount cannot change once a payment has been recorded'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_history_guard on public.invoices;
create trigger invoices_history_guard before update on public.invoices
  for each row execute function app.guard_invoice_history();

drop trigger if exists invoices_no_delete on public.invoices;
create trigger invoices_no_delete before delete on public.invoices
  for each row execute function app.forbid_delete();

drop trigger if exists payments_no_delete on public.payments;
create trigger payments_no_delete before delete on public.payments
  for each row execute function app.forbid_delete();

drop trigger if exists discounts_no_delete on public.discounts;
create trigger discounts_no_delete before delete on public.discounts
  for each row execute function app.forbid_delete();

drop trigger if exists accounts_no_delete on public.financial_accounts;
create trigger accounts_no_delete before delete on public.financial_accounts
  for each row execute function app.forbid_delete();

-- `payments` and `receipts` are deliberately absent: they carry no updated_at
-- because they are not updated. A payment is reversed once, and the reversal
-- is recorded in its own columns. (An earlier version attached the trigger to
-- payments anyway, which made every reversal fail with "record new has no
-- field updated_at".)
do $$
declare t text;
begin
  foreach t in array array['invoices', 'financial_accounts', 'loyalty_accounts'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function app.touch_updated_at()', t, t);
  end loop;
  -- Remove it if a previous run of this migration installed it.
  execute 'drop trigger if exists payments_touch on public.payments';
end;
$$;

-- ===========================================================================
-- Default deny
-- ===========================================================================

do $$
declare t text;
begin
  foreach t in array array['financial_accounts', 'financial_transactions',
                           'finance_daily_summaries', 'invoices', 'invoice_items',
                           'discounts', 'payments', 'receipts', 'loyalty_accounts',
                           'loyalty_transactions', 'loyalty_rewards', 'loyalty_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end;
$$;
