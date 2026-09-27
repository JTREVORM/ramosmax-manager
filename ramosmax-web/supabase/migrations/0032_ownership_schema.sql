-- ===========================================================================
-- RamosMAX Web — Final phase — 0032: shareholders, shares and dividends
-- ===========================================================================
-- Ports the Phase 7 ownership model.
--
-- `share_transactions` is an IMMUTABLE OWNERSHIP LEDGER. Ownership is not a
-- number somebody edits: it is the sum of the signed lines of every applied
-- entry effective on or before a day. That is what makes historical ownership
-- reconstructable and what stops a later entry from rewriting an earlier
-- answer. The holdings, shareholder totals, class totals and the register are
-- all DERIVED from it and recomputed by the server after every posting.
--
-- Money: an issue records a COMMITMENT. Money actually received is a
-- `share_contributions` row and, when it came through a business account, ONE
-- `share_capital_contribution` entry in the existing ledger — owners' capital,
-- never revenue.
--
-- Nothing here is deleted. A shareholder who leaves becomes `exited` and
-- keeps their entire history.
-- ===========================================================================

create sequence if not exists app.shareholder_number_seq as bigint start 1;
create sequence if not exists app.share_txn_number_seq   as bigint start 1;
create sequence if not exists app.contribution_number_seq as bigint start 1;
create sequence if not exists app.dividend_number_seq    as bigint start 1;
create sequence if not exists app.allocation_number_seq  as bigint start 1;

-- ---------------------------------------------------------------------------
-- Shareholders
-- ---------------------------------------------------------------------------

create table if not exists public.shareholders (
  id                 uuid primary key default gen_random_uuid(),
  shareholder_number text not null unique,
  full_name          text not null,
  phone_number       text,
  email              text,
  address            text,
  id_type            text,
  id_number          text,
  join_date          date not null,
  notes              text,
  status             text not null default 'active',
  status_reason      text,
  status_changed_at  timestamptz,
  -- The RamosMAX sign-in of the person who IS this shareholder.
  linked_uid         uuid references public.users(id),
  linked_user_name   text,
  -- Server-maintained totals, recomputed from the ledger after every posting.
  total_shares       bigint not null default 0,
  ownership_percent  numeric(9, 4) not null default 0,
  committed_ugx      bigint not null default 0,
  paid_ugx           bigint not null default 0,
  outstanding_ugx    bigint not null default 0,
  dividends_paid_ugx bigint not null default 0,
  search_text        text,
  request_id         text,
  created_by         uuid references public.users(id),
  created_by_name    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.users(id),
  constraint shareholder_status check (status in ('active', 'inactive', 'suspended', 'exited')),
  constraint shareholder_id_type check (id_type is null
    or id_type in ('national_id', 'passport', 'company_registration', 'other')),
  -- Both or neither, exactly as the reference validates.
  constraint shareholder_identification check ((id_type is null) = (id_number is null)),
  constraint shareholder_totals check (total_shares >= 0 and committed_ugx >= 0 and paid_ugx >= 0
    and outstanding_ugx = committed_ugx - paid_ugx and dividends_paid_ugx >= 0)
);

-- A phone number, an identification and a sign-in each belong to at most one
-- shareholder. These are the reference's `unique_keys` reservations, which a
-- relational database expresses as unique indexes.
create unique index if not exists shareholders_phone_key
  on public.shareholders (phone_number) where phone_number is not null;
create unique index if not exists shareholders_identification_key
  on public.shareholders (id_type, id_number) where id_number is not null;
create unique index if not exists shareholders_linked_uid_key
  on public.shareholders (linked_uid) where linked_uid is not null;
create index if not exists shareholders_status_idx on public.shareholders (status, shareholder_number);
create index if not exists shareholders_search_idx on public.shareholders using gin (to_tsvector('simple', coalesce(search_text, '')));

-- ---------------------------------------------------------------------------
-- Share classes
-- ---------------------------------------------------------------------------
-- No class and no share price exists until the business creates one. Nothing
-- here is hard-coded, and no legal characteristic of a class is modelled.

create table if not exists public.share_classes (
  id                   text primary key,
  code                 text not null unique,
  name                 text not null,
  description          text,
  value_per_share_ugx  bigint not null,
  active               boolean not null default true,
  issued_shares        bigint not null default 0,
  committed_ugx        bigint not null default 0,
  paid_ugx             bigint not null default 0,
  outstanding_ugx      bigint not null default 0,
  created_by           uuid references public.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  updated_by           uuid references public.users(id),
  constraint share_class_code check (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  constraint share_class_value check (value_per_share_ugx >= 0 and value_per_share_ugx <= 100000000),
  constraint share_class_totals check (issued_shares >= 0 and committed_ugx >= 0 and paid_ugx >= 0)
);

-- ---------------------------------------------------------------------------
-- Holdings — one shareholder in one class, written only by the server
-- ---------------------------------------------------------------------------

create table if not exists public.shareholdings (
  shareholder_id     uuid not null references public.shareholders(id),
  class_id           text not null references public.share_classes(id),
  shareholder_number text,
  shareholder_name   text,
  class_code         text,
  shares             bigint not null default 0,
  committed_ugx      bigint not null default 0,
  paid_ugx           bigint not null default 0,
  outstanding_ugx    bigint not null default 0,
  updated_at         timestamptz not null default now(),
  primary key (shareholder_id, class_id),
  constraint holding_non_negative check (shares >= 0 and committed_ugx >= 0 and paid_ugx >= 0
    and outstanding_ugx = committed_ugx - paid_ugx and outstanding_ugx >= 0)
);

-- ---------------------------------------------------------------------------
-- The ownership ledger
-- ---------------------------------------------------------------------------

create table if not exists public.share_transactions (
  id                  uuid primary key default gen_random_uuid(),
  transaction_number  text not null unique,
  type                text not null,
  status              text not null default 'pending_approval',
  -- `applied` marks the entries ownership is computed from: posted and
  -- reversed ones. A rejected or pending entry counts for nothing.
  applied             boolean not null default false,
  class_id            text not null references public.share_classes(id),
  class_code          text not null,
  class_name          text,
  shares              bigint not null,
  adjustment_shares   bigint,
  adjust_commitment   boolean not null default false,
  value_per_share_ugx bigint,
  committed_ugx       bigint,
  paid_ugx            bigint not null default 0,
  outstanding_ugx     bigint not null default 0,
  payment_status      text,
  contribution_ids    uuid[] not null default '{}',
  -- The signed per-shareholder lines. This is the ownership record itself.
  lines               jsonb not null,
  shareholder_ids     uuid[] not null,
  from_shareholder_id uuid references public.shareholders(id),
  to_shareholder_id   uuid references public.shareholders(id),
  payment             jsonb,
  acquisition_date    date,
  effective_date      date not null,
  reference           text,
  notes               text,
  reason              text,
  reversal_of_type    text,
  reversal_of_id      uuid references public.share_transactions(id),
  reversal_of_number  text,
  reversed_by_id      uuid references public.share_transactions(id),
  reversed_by_number  text,
  reversal_reason     text,
  reversed_at         timestamptz,
  reversed_by         uuid references public.users(id),
  requested_by        uuid references public.users(id),
  requested_by_name   text,
  approved_by         uuid references public.users(id),
  approved_by_name    text,
  approved_at         timestamptz,
  auto_approved       boolean not null default false,
  rejected_by         uuid references public.users(id),
  rejected_by_name    text,
  rejected_at         timestamptz,
  decision_reason     text,
  request_id          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint share_txn_type check (type in ('shares_issued', 'shares_transferred', 'shares_adjusted', 'reversal')),
  constraint share_txn_status check (status in ('pending_approval', 'posted', 'rejected', 'reversed')),
  constraint share_txn_shares check (shares > 0 and shares <= 1000000000),
  constraint share_txn_applied check (applied = (status in ('posted', 'reversed'))),
  constraint share_txn_money check (paid_ugx >= 0 and outstanding_ugx >= 0)
);

create index if not exists share_txn_applied_idx on public.share_transactions (applied, effective_date);
create index if not exists share_txn_status_idx on public.share_transactions (status, transaction_number);
create index if not exists share_txn_holders_idx on public.share_transactions using gin (shareholder_ids);

-- ---------------------------------------------------------------------------
-- Contributions — money actually received for shares
-- ---------------------------------------------------------------------------

create table if not exists public.share_contributions (
  id                           uuid primary key default gen_random_uuid(),
  contribution_number          text not null unique,
  shareholder_id               uuid not null references public.shareholders(id),
  shareholder_number           text,
  shareholder_name             text,
  class_id                     text not null references public.share_classes(id),
  class_code                   text,
  share_transaction_id         uuid not null references public.share_transactions(id),
  share_transaction_number     text,
  amount_ugx                   bigint not null,
  source                       text not null,
  account_id                   uuid references public.financial_accounts(id),
  account_name                 text,
  financial_transaction_id     uuid references public.financial_transactions(id),
  financial_transaction_number text,
  payment_date                 date not null,
  reference                    text,
  status                       text not null default 'posted',
  request_id                   text,
  reversed_at                  timestamptz,
  reversed_by                  uuid references public.users(id),
  reversal_reason              text,
  reversal_transaction_id      uuid references public.financial_transactions(id),
  reversal_transaction_number  text,
  created_by                   uuid references public.users(id),
  created_by_name              text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint contribution_source check (source in ('account', 'prior_record')),
  constraint contribution_status check (status in ('posted', 'reversed')),
  constraint contribution_amount check (amount_ugx > 0),
  -- Money through an account always has a ledger entry; a prior record never
  -- touches a balance.
  constraint contribution_account check ((source = 'account') = (account_id is not null))
);

create index if not exists contributions_txn_idx on public.share_contributions (share_transaction_id, status);

-- ---------------------------------------------------------------------------
-- Dividends
-- ---------------------------------------------------------------------------

create table if not exists public.dividends (
  id                        uuid primary key default gen_random_uuid(),
  dividend_number           text not null unique,
  financial_period          text not null,
  declaration_date          date not null,
  record_date               date not null,
  payment_date              date,
  calculation_method        text not null,
  class_id                  text references public.share_classes(id),
  class_code                text,
  notes                     text,
  status                    text not null default 'draft',
  total_distributable_ugx   bigint,
  -- The DECLARED amount per share, in whole shillings (the per_share method).
  dividend_per_share_ugx    bigint,
  -- The pool method's derived rate, to four decimal places. It is a display
  -- figure, never an amount anyone is paid, which is why it is not `_ugx`:
  -- every allocation below is exact integer arithmetic.
  per_share_rate            numeric(20, 4),
  eligible_shares           bigint not null default 0,
  eligible_shareholder_count integer not null default 0,
  allocated_ugx             bigint not null default 0,
  unallocated_ugx           bigint not null default 0,
  allocation_count          integer not null default 0,
  payable_count             integer not null default 0,
  paid_ugx                  bigint not null default 0,
  paid_count                integer not null default 0,
  outstanding_ugx           bigint not null default 0,
  -- Once the allocations are calculated the record date is LOCKED: no share
  -- transaction may take effect on or before it, so the snapshot cannot drift.
  record_locked             boolean not null default false,
  snapshot                  jsonb,
  version                   integer not null default 0,
  calculated_at             timestamptz,
  calculated_by             uuid references public.users(id),
  calculated_by_name        text,
  declared_by               uuid references public.users(id),
  declared_by_name          text,
  declared_at               timestamptz,
  approved_by               uuid references public.users(id),
  approved_by_name          text,
  approved_at               timestamptz,
  cancelled_by              uuid references public.users(id),
  cancelled_by_name         text,
  cancelled_at              timestamptz,
  cancel_reason             text,
  returned_reason           text,
  request_id                text,
  created_by                uuid references public.users(id),
  created_by_name           text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  updated_by                uuid references public.users(id),
  constraint dividend_status check (status in ('draft', 'declared', 'approved', 'partially_paid', 'paid', 'cancelled')),
  constraint dividend_method check (calculation_method in ('pool', 'per_share')),
  constraint dividend_totals check (allocated_ugx >= 0 and unallocated_ugx >= 0 and paid_ugx >= 0
    and paid_count >= 0 and outstanding_ugx = allocated_ugx - paid_ugx),
  constraint dividend_dates check (payment_date is null or payment_date >= record_date)
);

create index if not exists dividends_locked_idx on public.dividends (record_locked, record_date);

create table if not exists public.dividend_allocations (
  id                            uuid primary key default gen_random_uuid(),
  allocation_number             text not null unique,
  dividend_id                   uuid not null references public.dividends(id),
  dividend_number               text not null,
  financial_period              text,
  record_date                   date not null,
  class_id                      text references public.share_classes(id),
  class_code                    text,
  shareholder_id                uuid not null references public.shareholders(id),
  shareholder_number            text,
  shareholder_name              text,
  linked_uid                    uuid,
  -- The FROZEN record-date snapshot. Later ownership changes never touch it.
  shares_at_record_date         bigint not null,
  total_shares_at_record_date   bigint not null,
  ownership_percent_at_record_date numeric(9, 4) not null,
  dividend_per_share_ugx        bigint,
  per_share_rate                numeric(20, 4),
  gross_ugx                     bigint not null,
  deductions_ugx                bigint not null default 0,
  net_ugx                       bigint not null,
  payment_status                text not null default 'unpaid',
  dividend_status               text not null default 'draft',
  current                       boolean not null default true,
  version                       integer not null default 1,
  paid_at                       timestamptz,
  payment_date                  date,
  payment_reference             text,
  account_id                    uuid references public.financial_accounts(id),
  account_name                  text,
  financial_transaction_id      uuid references public.financial_transactions(id),
  financial_transaction_number  text,
  paid_by                       uuid references public.users(id),
  paid_by_name                  text,
  reversals                     jsonb not null default '[]'::jsonb,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint allocation_payment_status check (payment_status in ('unpaid', 'paid', 'not_payable')),
  constraint allocation_amounts check (gross_ugx >= 0 and deductions_ugx >= 0
    and net_ugx = gross_ugx - deductions_ugx and net_ugx >= 0),
  constraint allocation_shares check (shares_at_record_date > 0 and total_shares_at_record_date > 0)
);

create index if not exists allocations_dividend_idx on public.dividend_allocations (dividend_id, current);
create index if not exists allocations_shareholder_idx on public.dividend_allocations (shareholder_id, current);

-- ---------------------------------------------------------------------------
-- Ownership events, for notifications that carry identifiers only
-- ---------------------------------------------------------------------------

create table if not exists public.ownership_events (
  id             uuid primary key default gen_random_uuid(),
  type           text not null,
  reference_type text not null,
  reference_id   uuid not null,
  audience       text not null,
  recipient_uid  uuid references public.users(id),
  payload        jsonb not null default '{}'::jsonb,
  delivered      boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists ownership_events_audience_idx on public.ownership_events (audience, created_at desc);

-- ---------------------------------------------------------------------------
-- Guards: what may never be rewritten
-- ---------------------------------------------------------------------------

/* A posted ownership entry is history: its lines, dates and money are frozen. */
create or replace function app.guard_share_transaction()
returns trigger
language plpgsql
as $$
begin
  if new.transaction_number is distinct from old.transaction_number
  or new.type is distinct from old.type
  or new.class_id is distinct from old.class_id
  or new.shares is distinct from old.shares
  or new.effective_date is distinct from old.effective_date
  or new.created_at is distinct from old.created_at then
    raise exception 'A share transaction keeps its number, type, class, size and effective date'
      using errcode = 'restrict_violation';
  end if;
  -- Once applied, the OWNERSHIP LINES themselves can never change.
  if old.applied and new.lines is distinct from old.lines then
    raise exception 'The ownership lines of an applied share transaction cannot be changed'
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'rejected' and new.status is distinct from old.status then
    raise exception 'A rejected share transaction cannot be reopened'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

/* A frozen allocation. Its record-date snapshot is the whole point. */
create or replace function app.guard_dividend_allocation()
returns trigger
language plpgsql
as $$
begin
  if new.allocation_number is distinct from old.allocation_number
  or new.dividend_id is distinct from old.dividend_id
  or new.shareholder_id is distinct from old.shareholder_id
  or new.record_date is distinct from old.record_date
  or new.shares_at_record_date is distinct from old.shares_at_record_date
  or new.total_shares_at_record_date is distinct from old.total_shares_at_record_date
  or new.ownership_percent_at_record_date is distinct from old.ownership_percent_at_record_date
  or new.gross_ugx is distinct from old.gross_ugx
  or new.net_ugx is distinct from old.net_ugx then
    raise exception 'A dividend allocation keeps its record-date snapshot and its amount'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

/* A contribution's money and source are what happened. */
create or replace function app.guard_contribution()
returns trigger
language plpgsql
as $$
begin
  if new.contribution_number is distinct from old.contribution_number
  or new.amount_ugx is distinct from old.amount_ugx
  or new.source is distinct from old.source
  or new.share_transaction_id is distinct from old.share_transaction_id
  or new.financial_transaction_id is distinct from old.financial_transaction_id then
    raise exception 'A share contribution keeps its number, amount, source and postings'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists share_transaction_history on public.share_transactions;
create trigger share_transaction_history before update on public.share_transactions
  for each row execute function app.guard_share_transaction();

drop trigger if exists dividend_allocation_history on public.dividend_allocations;
create trigger dividend_allocation_history before update on public.dividend_allocations
  for each row execute function app.guard_dividend_allocation();

drop trigger if exists contribution_history on public.share_contributions;
create trigger contribution_history before update on public.share_contributions
  for each row execute function app.guard_contribution();

-- Nothing is deleted, RLS is on and forced, and clients hold no write at all.
do $$
declare t text;
begin
  foreach t in array array['shareholders', 'share_classes', 'shareholdings', 'share_transactions',
                           'share_contributions', 'dividends', 'dividend_allocations',
                           'ownership_events'] loop
    execute format('drop trigger if exists %I_no_delete on public.%I', t, t);
    execute format('create trigger %I_no_delete before delete on public.%I
                    for each row execute function app.forbid_delete()', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;

  foreach t in array array['shareholders', 'share_classes', 'shareholdings', 'share_transactions',
                           'share_contributions', 'dividends', 'dividend_allocations'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function app.touch_updated_at()', t, t);
  end loop;
end;
$$;
