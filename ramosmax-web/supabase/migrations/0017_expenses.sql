-- ===========================================================================
-- RamosMAX Web — Phase E — 0017: expenses
-- ===========================================================================
-- Ports `functions/src/expenses.js`.
--
--   draft ──submit──► pending_review ──review──► ──approve──► approved ──pay──► paid
--                         │                                        │
--                         └──reject (reason)──► rejected           │
--   draft / pending_review / approved ──cancel (reason)──► cancelled
--   paid ──reverse payment (expenses.adjust)──► approved ◄─────────┘
--
-- CREATING, REVIEWING OR APPROVING AN EXPENSE MOVES NO MONEY. Only
-- `app.pay_expense` takes anything out of an account, and it does so in one
-- transaction with the `expense_payment` ledger entry and the status change.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------

create table if not exists public.expense_categories (
  id         text primary key,
  name       text not null,
  active     boolean not null default true,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.users (id),
  updated_by uuid references public.users (id)
);

create unique index if not exists expense_categories_name_key
  on public.expense_categories (lower(btrim(name)));

-- The built-in categories, from `expenseCategories` in access_catalog.json.
insert into public.expense_categories (id, name, is_default) values
  ('utilities',         'Utilities',         true),
  ('operations',        'Operations',        true),
  ('premises',          'Premises',          true),
  ('repairs',           'Repairs',           true),
  ('financial_charges', 'Financial Charges', true),
  ('marketing',         'Marketing',         true),
  ('transport',         'Transport',         true),
  ('office',            'Office',            true),
  ('licences',          'Licences',          true),
  ('miscellaneous',     'Miscellaneous',     true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------

create table if not exists public.expenses (
  id             uuid primary key default gen_random_uuid(),
  expense_number text not null unique,

  category_id    text not null references public.expense_categories (id),
  category_name  text not null,
  description    text not null,
  amount_ugx     bigint not null,
  expense_date   date not null,
  payee          text,
  -- Only a PLAN until the expense is paid. The account that actually paid is
  -- `paid_from_account_id`.
  payment_account_id uuid references public.financial_accounts (id),
  reference      text,
  notes          text,

  status         text not null default 'draft',

  created_by      uuid references public.users (id),
  created_by_name text,
  submitted_at    timestamptz,
  reviewed_by     uuid references public.users (id),
  reviewed_by_name text,
  reviewed_at     timestamptz,
  review_notes    text,
  approved_by     uuid references public.users (id),
  approved_by_name text,
  approved_at     timestamptz,
  rejected_by     uuid references public.users (id),
  rejected_at     timestamptz,
  rejection_reason text,
  paid_by         uuid references public.users (id),
  paid_by_name    text,
  paid_at         timestamptz,
  paid_from_account_id uuid references public.financial_accounts (id),
  paid_from_account_name text,
  payment_reference text,
  financial_transaction_id uuid references public.financial_transactions (id),
  financial_transaction_number text,
  cancelled_by    uuid references public.users (id),
  cancelled_at    timestamptz,
  cancel_reason   text,
  payment_reversal_reason text,
  payment_reversal_transaction_id uuid references public.financial_transactions (id),
  payment_reversed_at timestamptz,

  recurring_expense_id uuid,
  due_date       date,
  request_id     text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.users (id),

  constraint expense_amount check (amount_ugx >= 1 and amount_ugx <= 2000000000),
  constraint expense_status check (status in
    ('draft', 'pending_review', 'approved', 'rejected', 'paid', 'cancelled')),
  -- Money and status can never disagree: paid means there is a ledger entry.
  constraint expense_paid_has_entry check (
    (status = 'paid') = (financial_transaction_id is not null))
);

create index if not exists expenses_status_idx   on public.expenses (status, expense_date desc);
create index if not exists expenses_category_idx on public.expenses (category_id);
create index if not exists expenses_paid_idx     on public.expenses (paid_at desc) where status = 'paid';

-- ---------------------------------------------------------------------------
-- Recurring expenses
-- ---------------------------------------------------------------------------

create table if not exists public.recurring_expenses (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  category_id   text not null references public.expense_categories (id),
  category_name text not null,
  expected_amount_ugx bigint not null,
  frequency     text not null,
  next_due_date date not null,
  anchor_day    integer not null,
  reminder_days_before integer not null default 3,
  reminder_at   date not null,
  payee         text,
  payment_account_id uuid references public.financial_accounts (id),
  notes         text,
  active        boolean not null default true,
  last_generated_expense_id uuid references public.expenses (id),
  last_generated_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.users (id),
  updated_by    uuid references public.users (id),

  constraint recurring_amount    check (expected_amount_ugx >= 1 and expected_amount_ugx <= 2000000000),
  constraint recurring_frequency check (frequency in ('weekly', 'monthly', 'quarterly', 'yearly')),
  constraint recurring_reminder  check (reminder_days_before between 0 and 30),
  constraint recurring_anchor    check (anchor_day between 1 and 31)
);

alter table public.expenses
  drop constraint if exists expenses_recurring_fk;
alter table public.expenses
  add constraint expenses_recurring_fk
  foreign key (recurring_expense_id) references public.recurring_expenses (id);

-- Each due date produces one draft, ever.
create unique index if not exists recurring_due_once
  on public.expenses (recurring_expense_id, due_date)
  where recurring_expense_id is not null;

create sequence if not exists app.expense_number_seq as bigint start 1;

-- ---------------------------------------------------------------------------
-- Immutability and history
-- ---------------------------------------------------------------------------
-- An expense is a living record until it is paid; what can never happen is
-- rewriting the money after it has moved, or deleting any of it.

create or replace function app.guard_expense_history()
returns trigger
language plpgsql
as $$
begin
  if new.expense_number is distinct from old.expense_number
  or new.created_at     is distinct from old.created_at then
    raise exception 'An expense keeps its number and its creation time'
      using errcode = 'restrict_violation';
  end if;
  -- While an expense is paid, its money is settled: only a payment reversal
  -- may move it, and that returns it to `approved` in the same statement.
  if old.status = 'paid' and new.status = 'paid'
     and (new.amount_ugx is distinct from old.amount_ugx
          or new.category_id is distinct from old.category_id
          or new.financial_transaction_id is distinct from old.financial_transaction_id) then
    raise exception 'A paid expense cannot be rewritten: reverse the payment first'
      using errcode = 'restrict_violation';
  end if;
  if old.status in ('rejected', 'cancelled') and new.status <> old.status then
    raise exception 'A % expense is final', old.status using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists expense_history on public.expenses;
create trigger expense_history before update on public.expenses
  for each row execute function app.guard_expense_history();

do $$
declare t text;
begin
  foreach t in array array['expenses', 'recurring_expenses', 'expense_categories'] loop
    execute format('drop trigger if exists %I_no_delete on public.%I', t, t);
    execute format('create trigger %I_no_delete before delete on public.%I
                    for each row execute function app.forbid_delete()', t, t);
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function app.touch_updated_at()', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end;
$$;

-- ===========================================================================
-- Functions
-- ===========================================================================

create or replace function app.read_expense_category(p_id text)
returns public.expense_categories
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v public.expense_categories%rowtype;
begin
  select * into v from public.expense_categories where id = p_id;
  if v.id is null then
    raise exception 'Choose a valid category.'
      using errcode = 'invalid_parameter_value', detail = 'category';
  end if;
  if not v.active then
    raise exception '"%" is no longer in use.', v.name
      using errcode = 'invalid_parameter_value', detail = 'inactive_category';
  end if;
  return v;
end;
$$;

create or replace function app.create_expense_category(p_name text)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_name text;
  v_id   text;
begin
  perform app.require_permission('expenses.categories.manage');
  v_name := app.require_text(p_name, 'Category name', 40);
  -- The id is a slug of the name, as categoryKey() makes it.
  v_id := left(regexp_replace(regexp_replace(lower(v_name), '[^a-z0-9]+', '_', 'g'), '^_|_$', '', 'g'), 40);
  if v_id = '' then
    raise exception 'Use letters or digits in the category name.'
      using errcode = 'invalid_parameter_value', detail = 'name';
  end if;
  if exists (select 1 from public.expense_categories
              where id = v_id or lower(btrim(name)) = lower(btrim(v_name))) then
    raise exception 'A category called "%" already exists.', v_name
      using errcode = 'unique_violation', detail = 'duplicate_category';
  end if;

  insert into public.expense_categories (id, name, created_by, updated_by)
  values (v_id, v_name, auth.uid(), auth.uid());

  perform app.audit('expense_category.created', 'expenses', v_id, null, v_name, null, null,
    jsonb_build_object('name', v_name));
  return v_id;
end;
$$;

create or replace function app.update_expense_category(
  p_category text,
  p_name     text default null,
  p_active   boolean default null,
  p_reason   text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.expense_categories%rowtype;
  v_name   text;
  v_reason text;
begin
  perform app.require_permission('expenses.categories.manage');
  select * into v_before from public.expense_categories where id = p_category;
  if v_before.id is null then
    raise exception 'That category could not be found.'
      using errcode = 'no_data_found', detail = 'category';
  end if;

  v_name   := case when p_name is null then null else app.require_text(p_name, 'Category name', 40) end;
  v_reason := case when p_active is false then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;

  if v_name is not null and exists (
    select 1 from public.expense_categories
     where id <> p_category and lower(btrim(name)) = lower(btrim(v_name))) then
    raise exception 'A category called "%" already exists.', v_name
      using errcode = 'unique_violation', detail = 'duplicate_category';
  end if;
  if (v_name is null or v_name = v_before.name)
     and (p_active is null or p_active = v_before.active) then
    raise exception 'Nothing has changed.' using errcode = 'raise_exception', detail = 'no_changes';
  end if;

  update public.expense_categories
     set name = coalesce(v_name, name), active = coalesce(p_active, active), updated_by = auth.uid()
   where id = p_category;

  perform app.audit('expense_category.updated', 'expenses', p_category, null, v_before.name, v_reason,
    jsonb_build_object('name', v_before.name, 'active', v_before.active),
    jsonb_build_object('name', coalesce(v_name, v_before.name), 'active', coalesce(p_active, v_before.active)));
end;
$$;

-- ---------------------------------------------------------------------------
-- Recording an expense
-- ---------------------------------------------------------------------------

create or replace function app.create_expense(
  p_category   text,
  p_description text,
  p_amount     bigint,
  p_date       date,
  p_request_id text,
  p_payee      text default null,
  p_account    uuid default null,
  p_reference  text default null,
  p_notes      text default null,
  p_submit     boolean default false
)
returns table (expense_id uuid, expense_number text, status text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier  jsonb;
  v_category public.expense_categories%rowtype;
  v_number   text;
  v_id       uuid;
  v_status   text;
  v_date     date;
begin
  perform app.require_permission('expenses.create');
  perform app.require_amount(p_amount);
  perform app.require_request_id(p_request_id);
  -- A bill may be dated up to a year ahead.
  v_date := app.require_business_date(p_date, 'expense date', 366);

  v_earlier := app.claim_request(p_request_id, 'expense',
    jsonb_build_object('category', p_category, 'amount', p_amount, 'description', p_description));
  if v_earlier is not null then
    return query select (v_earlier ->> 'expense_id')::uuid, v_earlier ->> 'expense_number',
                        v_earlier ->> 'status';
    return;
  end if;

  v_category := app.read_expense_category(p_category);
  v_status   := case when p_submit then 'pending_review' else 'draft' end;
  v_number   := app.next_reference('expense_number_seq', 'RMX-EXP-');

  insert into public.expenses
    (expense_number, category_id, category_name, description, amount_ugx, expense_date,
     payee, payment_account_id, reference, notes, status, submitted_at,
     created_by, created_by_name, updated_by, request_id)
  values
    (v_number, v_category.id, v_category.name,
     app.require_text(p_description, 'Description', 200), p_amount, v_date,
     app.optional_text(p_payee, 'Vendor / payee', 80), p_account,
     app.optional_text(p_reference, 'Reference', 60), app.optional_text(p_notes, 'Notes', 500),
     v_status, case when p_submit then now() end,
     auth.uid(), (select full_name from public.users where id = auth.uid()), auth.uid(), p_request_id)
  returning id into v_id;

  if p_submit then
    insert into public.finance_events (type, reference_type, reference_id, audience, payload)
    values ('expense_awaiting_approval', 'expense', v_id, 'expenses.review',
            jsonb_build_object('expenseNumber', v_number, 'amountUgx', p_amount));
  end if;

  perform app.audit('expense.created', 'expenses', v_id::text, null, v_number, null, null,
    jsonb_build_object('expenseNumber', v_number, 'categoryId', v_category.id,
                       'amountUgx', p_amount, 'status', v_status));

  perform app.complete_request(p_request_id,
    jsonb_build_object('expense_id', v_id, 'expense_number', v_number, 'status', v_status));

  return query select v_id, v_number, v_status;
end;
$$;

/* Changes an expense that nobody has reviewed yet. Money never moves here. */
create or replace function app.update_expense(
  p_expense  uuid,
  p_category text default null,
  p_description text default null,
  p_amount   bigint default null,
  p_date     date default null,
  p_payee    text default null,
  p_account  uuid default null,
  p_reference text default null,
  p_notes    text default null,
  p_reason   text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before   public.expenses%rowtype;
  v_category public.expense_categories%rowtype;
begin
  perform app.require_permission('expenses.create');

  select * into v_before from public.expenses where id = p_expense for update;
  if v_before.id is null then
    raise exception 'That expense could not be found.'
      using errcode = 'no_data_found', detail = 'expense';
  end if;
  if v_before.status not in ('draft', 'pending_review') or v_before.reviewed_at is not null then
    raise exception 'Only a draft or an unreviewed expense can be edited.'
      using errcode = 'raise_exception', detail = 'not_editable';
  end if;
  -- Someone else's expense needs the reviewer's permission.
  if v_before.created_by is distinct from auth.uid() then
    perform app.require_permission('expenses.review');
  end if;

  if p_category is not null then
    v_category := app.read_expense_category(p_category);
  end if;
  if p_amount is not null then perform app.require_amount(p_amount); end if;

  update public.expenses
     set category_id   = coalesce(v_category.id, category_id),
         category_name = coalesce(v_category.name, category_name),
         description   = case when p_description is null then description
                              else app.require_text(p_description, 'Description', 200) end,
         amount_ugx    = coalesce(p_amount, amount_ugx),
         expense_date  = case when p_date is null then expense_date
                              else app.require_business_date(p_date, 'expense date', 366) end,
         payee         = case when p_payee is null then payee
                              else app.optional_text(p_payee, 'Vendor / payee', 80) end,
         payment_account_id = coalesce(p_account, payment_account_id),
         reference     = case when p_reference is null then reference
                              else app.optional_text(p_reference, 'Reference', 60) end,
         notes         = case when p_notes is null then notes
                              else app.optional_text(p_notes, 'Notes', 500) end,
         updated_by    = auth.uid()
   where id = p_expense;

  perform app.audit('expense.updated', 'expenses', p_expense::text, null,
    v_before.expense_number, app.optional_text(p_reason, 'Reason', 300),
    jsonb_build_object('amountUgx', v_before.amount_ugx, 'categoryId', v_before.category_id,
                       'description', v_before.description),
    jsonb_build_object('amountUgx', coalesce(p_amount, v_before.amount_ugx),
                       'categoryId', coalesce(v_category.id, v_before.category_id),
                       'description', coalesce(p_description, v_before.description)));
end;
$$;

/* submit · review · approve · reject · cancel. None of these moves money. */
create or replace function app.update_expense_status(
  p_expense uuid,
  p_action  text,
  p_reason  text default null,
  p_notes   text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.expenses%rowtype;
  v_reason text;
  v_status text;
  v_actor  text := (select full_name from public.users where id = auth.uid());
begin
  if p_action not in ('submit', 'review', 'approve', 'reject', 'cancel') then
    raise exception 'Choose a valid action.'
      using errcode = 'invalid_parameter_value', detail = 'action';
  end if;

  -- EXPENSE_ACTIONS: who may do it, and a reason where one is required.
  case p_action
    when 'submit'  then perform app.require_permission('expenses.create');
    when 'review'  then perform app.require_permission('expenses.review');
    when 'approve' then perform app.require_permission('expenses.approve');
    when 'reject'  then perform app.require_permission('expenses.review', 'expenses.approve');
    when 'cancel'  then perform app.require_permission('expenses.cancel');
  end case;
  v_reason := case when p_action in ('reject', 'cancel') then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;

  select * into v_before from public.expenses where id = p_expense for update;
  if v_before.id is null then
    raise exception 'That expense could not be found.'
      using errcode = 'no_data_found', detail = 'expense';
  end if;

  if (p_action = 'submit'  and v_before.status <> 'draft')
  or (p_action in ('review', 'approve', 'reject') and v_before.status <> 'pending_review')
  or (p_action = 'cancel'  and v_before.status not in ('draft', 'pending_review', 'approved')) then
    raise exception '%', case when v_before.status = 'paid'
      then 'This expense has already been paid.'
      else format('This expense is %s.', replace(v_before.status, '_', ' ')) end
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;

  if p_action = 'submit' and v_before.created_by is distinct from auth.uid() then
    perform app.require_permission('expenses.review');
  end if;
  if p_action = 'review' and v_before.reviewed_at is not null then
    raise exception 'This expense has already been reviewed.'
      using errcode = 'raise_exception', detail = 'already_reviewed';
  end if;
  -- Review and approval are separate steps, in that order.
  if p_action = 'approve' and v_before.reviewed_at is null then
    raise exception 'Review the expense before approving it.'
      using errcode = 'raise_exception', detail = 'not_reviewed';
  end if;

  v_status := case p_action
                when 'submit'  then 'pending_review'
                when 'review'  then v_before.status
                when 'approve' then 'approved'
                when 'reject'  then 'rejected'
                when 'cancel'  then 'cancelled' end;

  update public.expenses
     set status = v_status,
         submitted_at     = case when p_action = 'submit' then now() else submitted_at end,
         reviewed_by      = case when p_action = 'review' then auth.uid() else reviewed_by end,
         reviewed_by_name = case when p_action = 'review' then v_actor else reviewed_by_name end,
         reviewed_at      = case when p_action = 'review' then now() else reviewed_at end,
         review_notes     = case when p_action = 'review'
                                 then app.optional_text(p_notes, 'Notes', 500) else review_notes end,
         approved_by      = case when p_action = 'approve' then auth.uid() else approved_by end,
         approved_by_name = case when p_action = 'approve' then v_actor else approved_by_name end,
         approved_at      = case when p_action = 'approve' then now() else approved_at end,
         rejected_by      = case when p_action = 'reject' then auth.uid() else rejected_by end,
         rejected_at      = case when p_action = 'reject' then now() else rejected_at end,
         rejection_reason = case when p_action = 'reject' then v_reason else rejection_reason end,
         cancelled_by     = case when p_action = 'cancel' then auth.uid() else cancelled_by end,
         cancelled_at     = case when p_action = 'cancel' then now() else cancelled_at end,
         cancel_reason    = case when p_action = 'cancel' then v_reason else cancel_reason end,
         updated_by       = auth.uid()
   where id = p_expense;

  if p_action = 'submit' then
    insert into public.finance_events (type, reference_type, reference_id, audience, payload)
    values ('expense_awaiting_approval', 'expense', p_expense, 'expenses.review',
            jsonb_build_object('expenseNumber', v_before.expense_number, 'amountUgx', v_before.amount_ugx));
  elsif p_action in ('approve', 'reject') and v_before.created_by is distinct from auth.uid() then
    insert into public.finance_events (type, reference_type, reference_id, audience, payload)
    values ('expense_decided', 'expense', p_expense, 'author',
            jsonb_build_object('expenseNumber', v_before.expense_number, 'status', v_status));
  end if;

  perform app.audit(
    'expense.' || case p_action when 'submit' then 'submitted' when 'review' then 'reviewed'
                                when 'approve' then 'approved' when 'reject' then 'rejected'
                                else 'cancelled' end,
    'expenses', p_expense::text, null, v_before.expense_number, coalesce(v_reason, p_notes),
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', v_status, 'amountUgx', v_before.amount_ugx));

  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payment: the only step that moves money
-- ---------------------------------------------------------------------------

create or replace function app.pay_expense(
  p_expense    uuid,
  p_account    uuid,
  p_request_id text,
  p_reference  text default null,
  p_date       date default null
)
returns table (transaction_id uuid, transaction_number text, balance_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_expense public.expenses%rowtype;
  v_account public.financial_accounts%rowtype;
  v_txn     uuid;
  v_number  text;
  v_date    date;
  v_account_id uuid;
begin
  perform app.require_permission('expenses.pay');
  perform app.require_request_id(p_request_id);
  v_date := app.require_business_date(p_date, 'payment date');

  v_earlier := app.claim_request(p_request_id, 'expense_payment',
    jsonb_build_object('expense', p_expense, 'account', p_account));
  if v_earlier is not null then
    return query select (v_earlier ->> 'transaction_id')::uuid, v_earlier ->> 'transaction_number',
                        (v_earlier ->> 'balance_ugx')::bigint;
    return;
  end if;

  select * into v_expense from public.expenses where id = p_expense for update;
  if v_expense.id is null then
    raise exception 'That expense could not be found.'
      using errcode = 'no_data_found', detail = 'expense';
  end if;
  if v_expense.status = 'paid' then
    raise exception 'This expense has already been paid.'
      using errcode = 'raise_exception', detail = 'already_paid';
  end if;
  if v_expense.status <> 'approved' then
    raise exception 'Only an approved expense can be paid.'
      using errcode = 'raise_exception', detail = 'not_approved';
  end if;

  v_account_id := coalesce(p_account, v_expense.payment_account_id);
  if v_account_id is null then
    raise exception 'Choose the account this expense is paid from.'
      using errcode = 'invalid_parameter_value', detail = 'payment_account';
  end if;
  v_account := app.require_active_account(v_account_id);

  -- The ledger entry and the status change are one act.
  v_txn := app.post_transaction(
    p_type => 'expense_payment', p_amount => v_expense.amount_ugx, p_from => v_account_id,
    p_reference_type => 'expense', p_reference_id => p_expense,
    p_description => v_expense.expense_number || ': ' || v_expense.description,
    p_reference => coalesce(app.optional_text(p_reference, 'Payment reference', 60), v_expense.reference),
    p_request_id => p_request_id, p_date => v_date, p_category => v_expense.category_id,
    p_approved_by => v_expense.approved_by);

  select t.transaction_number into v_number from public.financial_transactions t where t.id = v_txn;

  update public.expenses
     set status = 'paid', paid_by = auth.uid(),
         paid_by_name = (select full_name from public.users where id = auth.uid()),
         paid_at = now(), paid_from_account_id = v_account_id, paid_from_account_name = v_account.name,
         payment_reference = app.optional_text(p_reference, 'Payment reference', 60),
         financial_transaction_id = v_txn, financial_transaction_number = v_number,
         updated_by = auth.uid()
   where id = p_expense;

  if v_expense.created_by is distinct from auth.uid() and v_expense.created_by is not null then
    insert into public.finance_events (type, reference_type, reference_id, audience, payload)
    values ('expense_decided', 'expense', p_expense, 'author',
            jsonb_build_object('expenseNumber', v_expense.expense_number, 'status', 'paid'));
  end if;

  perform app.audit('expense.paid', 'expenses', p_expense::text, null, v_expense.expense_number, null,
    jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', 'paid', 'amountUgx', v_expense.amount_ugx,
                       'accountId', v_account_id, 'transactionNumber', v_number));

  perform app.complete_request(p_request_id,
    jsonb_build_object('transaction_id', v_txn, 'transaction_number', v_number,
                       'balance_ugx', (select a.balance_ugx from public.financial_accounts a where a.id = v_account_id)));

  return query select v_txn, v_number,
    (select a.balance_ugx from public.financial_accounts a where a.id = v_account_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Recurring expenses
-- ---------------------------------------------------------------------------

/*
 * The next due date. Months keep the anchor day where the month has it and
 * clamp where it does not: 31 Jan → 28/29 Feb → 31 Mar.
 */
create or replace function app.advance_due_date(p_due date, p_frequency text, p_anchor integer)
returns date
language plpgsql
immutable
as $$
declare
  v_months integer;
  v_first  date;
  v_last   integer;
begin
  if p_frequency = 'weekly' then return p_due + 7; end if;
  v_months := case p_frequency when 'monthly' then 1 when 'quarterly' then 3 when 'yearly' then 12 end;
  if v_months is null then
    raise exception 'Choose weekly, monthly, quarterly or yearly.'
      using errcode = 'invalid_parameter_value', detail = 'frequency';
  end if;
  v_first := date_trunc('month', p_due + make_interval(months => v_months))::date;
  v_last  := extract(day from (v_first + interval '1 month' - interval '1 day'))::integer;
  return v_first + (least(coalesce(p_anchor, extract(day from p_due)::integer), v_last) - 1);
end;
$$;

create or replace function app.create_recurring_expense(
  p_name       text,
  p_category   text,
  p_amount     bigint,
  p_frequency  text,
  p_next_due   date,
  p_payee      text default null,
  p_account    uuid default null,
  p_reminder_days integer default 3,
  p_notes      text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_category public.expense_categories%rowtype;
  v_due  date;
  v_id   uuid;
begin
  perform app.require_permission('expenses.recurring.manage');
  perform app.require_amount(p_amount, 'expected amount');
  if p_frequency not in ('weekly', 'monthly', 'quarterly', 'yearly') then
    raise exception 'Choose weekly, monthly, quarterly or yearly.'
      using errcode = 'invalid_parameter_value', detail = 'frequency';
  end if;
  if p_reminder_days is null or p_reminder_days < 0 or p_reminder_days > 30 then
    raise exception 'Remind between 0 and 30 days before.'
      using errcode = 'invalid_parameter_value', detail = 'reminder';
  end if;
  v_due := app.require_business_date(p_next_due, 'next due date', 400);
  v_category := app.read_expense_category(p_category);

  insert into public.recurring_expenses
    (name, category_id, category_name, expected_amount_ugx, frequency, next_due_date,
     anchor_day, reminder_days_before, reminder_at, payee, payment_account_id, notes,
     created_by, updated_by)
  values
    (app.require_text(p_name, 'Name', 80), v_category.id, v_category.name, p_amount, p_frequency,
     v_due, extract(day from v_due)::integer, p_reminder_days, v_due - p_reminder_days,
     app.optional_text(p_payee, 'Vendor / payee', 80), p_account,
     app.optional_text(p_notes, 'Notes', 500), auth.uid(), auth.uid())
  returning id into v_id;

  perform app.audit('recurring_expense.created', 'expenses', v_id::text, null, p_name, null, null,
    jsonb_build_object('name', p_name, 'expectedAmountUgx', p_amount, 'frequency', p_frequency));
  return v_id;
end;
$$;

create or replace function app.update_recurring_expense(
  p_recurring uuid,
  p_name      text default null,
  p_amount    bigint default null,
  p_next_due  date default null,
  p_reminder_days integer default null,
  p_payee     text default null,
  p_account   uuid default null,
  p_notes     text default null,
  p_active    boolean default null,
  p_reason    text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.recurring_expenses%rowtype;
  v_reason text;
  v_due    date;
  v_days   integer;
begin
  perform app.require_permission('expenses.recurring.manage');
  select * into v_before from public.recurring_expenses where id = p_recurring for update;
  if v_before.id is null then
    raise exception 'That recurring expense could not be found.'
      using errcode = 'no_data_found', detail = 'recurring_expense';
  end if;

  v_reason := case when p_active is false then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;
  if p_amount is not null then perform app.require_amount(p_amount, 'expected amount'); end if;
  v_due  := case when p_next_due is null then v_before.next_due_date
                 else app.require_business_date(p_next_due, 'next due date', 400) end;
  v_days := coalesce(p_reminder_days, v_before.reminder_days_before);
  if v_days < 0 or v_days > 30 then
    raise exception 'Remind between 0 and 30 days before.'
      using errcode = 'invalid_parameter_value', detail = 'reminder';
  end if;

  update public.recurring_expenses
     set name = case when p_name is null then name else app.require_text(p_name, 'Name', 80) end,
         expected_amount_ugx = coalesce(p_amount, expected_amount_ugx),
         next_due_date = v_due,
         anchor_day = case when p_next_due is null then anchor_day else extract(day from v_due)::integer end,
         reminder_days_before = v_days,
         reminder_at = v_due - v_days,
         payee = case when p_payee is null then payee else app.optional_text(p_payee, 'Vendor / payee', 80) end,
         payment_account_id = coalesce(p_account, payment_account_id),
         notes = case when p_notes is null then notes else app.optional_text(p_notes, 'Notes', 500) end,
         active = coalesce(p_active, active),
         updated_by = auth.uid()
   where id = p_recurring;

  perform app.audit(
    case when p_active is false then 'recurring_expense.deactivated' else 'recurring_expense.updated' end,
    'expenses', p_recurring::text, null, v_before.name, v_reason,
    jsonb_build_object('name', v_before.name, 'expectedAmountUgx', v_before.expected_amount_ugx,
                       'active', v_before.active),
    jsonb_build_object('name', coalesce(p_name, v_before.name),
                       'expectedAmountUgx', coalesce(p_amount, v_before.expected_amount_ugx),
                       'active', coalesce(p_active, v_before.active)));
end;
$$;

/*
 * The scheduled sweep. For every active recurring expense whose reminder date
 * has come, it creates ONE DRAFT expense for that due date and advances the
 * schedule. IT NEVER PAYS ANYTHING, and it is safe to run again: the unique
 * index on (recurring_expense_id, due_date) makes each due date once.
 */
create or replace function app.sweep_recurring_expenses()
returns integer
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  r        public.recurring_expenses%rowtype;
  v_number text;
  v_id     uuid;
  v_next   date;
  v_made   integer := 0;
begin
  -- Server-side only: this runs as a scheduled job, never from a browser.
  if app.is_client_session() then
    raise exception 'The recurring sweep is not callable from a client session.'
      using errcode = 'insufficient_privilege', detail = 'forbidden';
  end if;

  for r in
    select * from public.recurring_expenses
     where active and reminder_at <= app.eat_day()
     order by next_due_date
     limit 200
     for update
  loop
    begin
      v_number := app.next_reference('expense_number_seq', 'RMX-EXP-');
      insert into public.expenses
        (expense_number, category_id, category_name, description, amount_ugx, expense_date,
         payee, payment_account_id, notes, status, recurring_expense_id, due_date, created_by_name)
      values
        (v_number, r.category_id, r.category_name, r.name, r.expected_amount_ugx, r.next_due_date,
         r.payee, r.payment_account_id,
         'Created from a recurring expense. Confirm the amount, then submit it for review.',
         'draft', r.id, r.next_due_date, 'RamosMAX')
      returning id into v_id;
    exception when unique_violation then
      -- This due date already produced its draft.
      continue;
    end;

    v_next := app.advance_due_date(r.next_due_date, r.frequency, r.anchor_day);
    update public.recurring_expenses
       set next_due_date = v_next,
           reminder_at = v_next - r.reminder_days_before,
           last_generated_expense_id = v_id,
           last_generated_at = now()
     where id = r.id;

    insert into public.finance_events (type, reference_type, reference_id, audience, payload)
    values ('recurring_expense_due', 'expense', v_id, 'expenses.approve',
            jsonb_build_object('expenseNumber', v_number, 'recurringExpenseId', r.id,
                               'dueDate', r.next_due_date));

    perform app.audit('recurring_expense.due', 'expenses', r.id::text, null, r.name, null, null,
      jsonb_build_object('expenseId', v_id, 'expenseNumber', v_number,
                         'dueDate', r.next_due_date, 'nextDueDate', v_next));
    v_made := v_made + 1;
  end loop;

  return v_made;
end;
$$;

-- ---------------------------------------------------------------------------
-- Putting a reversed expense payment back
-- ---------------------------------------------------------------------------
-- Replaces the placeholder in 0016 now that `expenses` exists.

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
  if p_original.entry_type = 'expense_payment' then
    -- Back to approved and unpaid, so it can be paid correctly or cancelled.
    update public.expenses
       set status = 'approved', paid_at = null, paid_by = null, paid_by_name = null,
           paid_from_account_id = null, paid_from_account_name = null,
           financial_transaction_id = null, financial_transaction_number = null,
           payment_reversed_at = now(), payment_reversal_reason = p_reason,
           payment_reversal_transaction_id = p_reversal, updated_by = auth.uid()
     where id = p_original.reference_id;
  end if;
end;
$$;
