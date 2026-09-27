-- ===========================================================================
-- RamosMAX Web — Phase E — 0018: inventory
-- ===========================================================================
-- Ports `functions/src/inventory.js`.
--
-- An item's quantity changes ONLY inside `app.move_stock`, in the same
-- statement that appends the `stock_movements` row explaining it
-- (quantity_before → quantity_after), so every quantity can be rebuilt from
-- its movements. STOCK CAN NEVER GO NEGATIVE: a CHECK constraint and a row
-- lock, not a browser calculation.
--
-- ACCOUNTING: buying stock is an ACQUISITION, not an operating expense. Paying
-- for a purchase posts an `inventory_purchase_payment` ledger entry and
-- creates no expense record, so expense reports never double-count stock.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------

create table if not exists public.suppliers (
  id              uuid primary key default gen_random_uuid(),
  supplier_number text not null unique,
  name            text not null,
  contact_person  text,
  phone           text,
  email           text,
  address         text,
  notes           text,
  active          boolean not null default true,

  purchase_count      integer not null default 0,
  total_purchased_ugx bigint  not null default 0,
  last_purchase_at    timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.users (id),
  updated_by uuid references public.users (id),

  constraint supplier_totals check (purchase_count >= 0 and total_purchased_ugx >= 0)
);

create unique index if not exists suppliers_name_key on public.suppliers (lower(btrim(name)));

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------

create table if not exists public.inventory_items (
  id            uuid primary key default gen_random_uuid(),
  sku           text not null unique,
  name          text not null,
  category      text not null,
  unit          text not null,
  description   text,
  is_consumable boolean not null default true,

  -- Server-maintained. Nothing else may write it.
  quantity      integer not null default 0,
  minimum_stock integer not null default 0,
  reorder_level integer not null default 0,

  -- OK / LOW / OUT_OF_STOCK, computed by the database from the quantity and
  -- the levels, exactly as stockStatusFor does.
  stock_status  text generated always as (
    case when quantity <= 0 then 'out_of_stock'
         when quantity <= greatest(minimum_stock, reorder_level) then 'low'
         else 'ok' end) stored,

  preferred_supplier_id   uuid references public.suppliers (id),
  preferred_supplier_name text,
  last_unit_cost_ugx      bigint,
  active        boolean not null default true,

  last_movement_at    timestamptz,
  last_counted_at     timestamptz,
  last_counted_quantity integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.users (id),
  updated_by uuid references public.users (id),

  -- Stock can never go negative.
  constraint item_quantity_non_negative check (quantity >= 0),
  constraint item_quantity_max          check (quantity <= 1000000),
  constraint item_levels     check (reorder_level >= minimum_stock and minimum_stock >= 0),
  constraint item_unit_cost  check (last_unit_cost_ugx is null
                                    or (last_unit_cost_ugx >= 0 and last_unit_cost_ugx <= 100000000)),
  constraint item_category   check (category in ('chemicals', 'soaps_shampoo', 'wax_polish',
    'towels_cloths', 'brushes_tools', 'cleaning_materials', 'spare_parts', 'other')),
  constraint item_unit       check (unit in ('piece', 'bottle', 'litre', 'kg', 'pack', 'box',
    'roll', 'pair', 'set', 'can', 'other'))
);

create unique index if not exists items_name_key on public.inventory_items (lower(btrim(name)));
create index if not exists items_status_idx on public.inventory_items (stock_status, name)
  where active;

-- ---------------------------------------------------------------------------
-- Purchases
-- ---------------------------------------------------------------------------

create table if not exists public.inventory_purchases (
  id              uuid primary key default gen_random_uuid(),
  purchase_number text not null unique,

  supplier_id     uuid not null references public.suppliers (id),
  supplier_name   text not null,
  purchase_date   date not null,
  supplier_reference text,

  total_ugx       bigint not null default 0,
  line_count      integer not null default 0,

  status          text not null default 'pending_approval',
  payment_status  text not null default 'unpaid',

  notes           text,
  request_id      text,

  approved_by     uuid references public.users (id),
  approved_at     timestamptz,
  received_by     uuid references public.users (id),
  received_by_name text,
  received_at     timestamptz,
  paid_by         uuid references public.users (id),
  paid_at         timestamptz,
  paid_from_account_id uuid references public.financial_accounts (id),
  financial_transaction_id uuid references public.financial_transactions (id),
  financial_transaction_number text,
  payment_reversal_reason text,
  payment_reversal_transaction_id uuid references public.financial_transactions (id),
  cancelled_by    uuid references public.users (id),
  cancelled_at    timestamptz,
  cancel_reason   text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.users (id),
  created_by_name text,
  updated_by      uuid references public.users (id),

  constraint purchase_total  check (total_ugx >= 0 and total_ugx <= 2000000000),
  constraint purchase_status check (status in ('pending_approval', 'approved', 'received', 'cancelled')),
  constraint purchase_payment_status check (payment_status in ('unpaid', 'paid')),
  -- Paid means there is a ledger entry, and nothing else can say otherwise.
  constraint purchase_paid_has_entry check (
    (payment_status = 'paid' and total_ugx > 0) = (financial_transaction_id is not null))
);

create table if not exists public.inventory_purchase_items (
  id            uuid primary key default gen_random_uuid(),
  purchase_id   uuid not null references public.inventory_purchases (id),
  item_id       uuid not null references public.inventory_items (id),
  name          text not null,
  sku           text not null,
  unit          text not null,
  quantity      integer not null,
  unit_cost_ugx bigint not null,
  -- The line total is arithmetic, so the database does it.
  line_total_ugx bigint generated always as (quantity * unit_cost_ugx) stored,

  constraint purchase_line_quantity check (quantity >= 1 and quantity <= 1000000),
  constraint purchase_line_cost     check (unit_cost_ugx >= 0 and unit_cost_ugx <= 100000000),
  constraint purchase_line_once     unique (purchase_id, item_id)
);

-- ---------------------------------------------------------------------------
-- Stock movements — immutable history
-- ---------------------------------------------------------------------------

create table if not exists public.stock_movements (
  id              uuid primary key default gen_random_uuid(),
  movement_number text not null unique,

  item_id         uuid not null references public.inventory_items (id),
  item_name       text not null,
  sku             text not null,
  unit            text not null,

  type            text not null,
  quantity        integer not null,
  quantity_change integer not null,
  quantity_before integer not null,
  quantity_after  integer not null,

  reason          text,
  reason_code     text,
  reference       text,
  purchase_id     uuid references public.inventory_purchases (id),
  intake_id       uuid references public.service_intakes (id),
  job_number      text,
  worker_id       uuid references public.users (id),
  worker_name     text,
  unit_cost_ugx   bigint,
  counted_quantity integer,
  system_quantity  integer,
  approved_by     uuid references public.users (id),
  request_id      text,

  status          text not null default 'posted',
  reversal_of_id  uuid references public.stock_movements (id),
  reversal_of_type text,
  reversed_by_id  uuid references public.stock_movements (id),
  reversed_at     timestamptz,
  reversed_by     uuid references public.users (id),
  reversal_reason text,

  created_at      timestamptz not null default now(),
  created_by      uuid references public.users (id),
  created_by_name text,

  constraint movement_type check (type in
    ('stock_in', 'usage', 'stock_out', 'return', 'adjustment_in', 'adjustment_out', 'reversal')),
  constraint movement_status check (status in ('posted', 'reversed')),
  constraint movement_quantity check (quantity > 0 and quantity_change <> 0),
  constraint movement_after check (quantity_after >= 0 and quantity_after = quantity_before + quantity_change),
  constraint movement_reason_code check (reason_code is null or reason_code in
    ('damaged', 'expired', 'wastage', 'internal_use', 'other'))
);

create index if not exists movements_item_idx on public.stock_movements (item_id, created_at desc);
create index if not exists movements_type_idx on public.stock_movements (type, created_at desc);

-- ---------------------------------------------------------------------------
-- Low-stock events
-- ---------------------------------------------------------------------------

create table if not exists public.inventory_events (
  id             uuid primary key default gen_random_uuid(),
  type           text not null,
  item_id        uuid not null references public.inventory_items (id),
  sku            text,
  item_name      text,
  quantity       integer,
  stock_status   text,
  delivered      boolean not null default false,
  created_at     timestamptz not null default now(),

  constraint inventory_event_type check (type in ('low_stock', 'out_of_stock'))
);

create index if not exists inventory_events_undelivered_idx
  on public.inventory_events (created_at) where not delivered;

-- ---------------------------------------------------------------------------
-- Reference numbers
-- ---------------------------------------------------------------------------

create sequence if not exists app.supplier_number_seq as bigint start 1;
create sequence if not exists app.purchase_number_seq as bigint start 1;
create sequence if not exists app.movement_number_seq as bigint start 1;

-- One SKU counter per category, as `sku_{PREFIX}` was.
do $$
declare p text;
begin
  foreach p in array array['CHEM', 'SOAP', 'WAX', 'TOWL', 'TOOL', 'CLEN', 'PART', 'MISC'] loop
    execute format('create sequence if not exists app.sku_%s_seq as bigint start 1', lower(p));
  end loop;
end;
$$;

create or replace function app.sku_prefix(p_category text)
returns text
language sql
immutable
as $$
  select case p_category
    when 'chemicals'          then 'CHEM'
    when 'soaps_shampoo'      then 'SOAP'
    when 'wax_polish'         then 'WAX'
    when 'towels_cloths'      then 'TOWL'
    when 'brushes_tools'      then 'TOOL'
    when 'cleaning_materials' then 'CLEN'
    when 'spare_parts'        then 'PART'
    else 'MISC' end;
$$;

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------

create or replace function app.guard_stock_movement_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.movement_number  is distinct from old.movement_number
  or new.item_id          is distinct from old.item_id
  or new.type             is distinct from old.type
  or new.quantity         is distinct from old.quantity
  or new.quantity_change  is distinct from old.quantity_change
  or new.quantity_before  is distinct from old.quantity_before
  or new.quantity_after   is distinct from old.quantity_after
  or new.created_at       is distinct from old.created_at
  or new.reversal_of_id   is distinct from old.reversal_of_id then
    raise exception 'stock_movements is immutable: record a reversal instead'
      using errcode = 'restrict_violation';
  end if;
  if old.reversed_by_id is not null and new.reversed_by_id is distinct from old.reversed_by_id then
    raise exception 'This movement has already been reversed'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists stock_movement_immutable on public.stock_movements;
create trigger stock_movement_immutable before update on public.stock_movements
  for each row execute function app.guard_stock_movement_immutable();

drop trigger if exists purchase_lines_immutable on public.inventory_purchase_items;
create trigger purchase_lines_immutable
  before update on public.inventory_purchase_items
  for each row execute function app.forbid_update_delete();

drop trigger if exists inventory_events_delivery_only on public.inventory_events;
create trigger inventory_events_delivery_only before update on public.inventory_events
  for each row execute function app.guard_event_delivery();

do $$
declare t text;
begin
  foreach t in array array['suppliers', 'inventory_items', 'inventory_purchases',
                           'inventory_purchase_items', 'stock_movements', 'inventory_events'] loop
    execute format('drop trigger if exists %I_no_delete on public.%I', t, t);
    execute format('create trigger %I_no_delete before delete on public.%I
                    for each row execute function app.forbid_delete()', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
  foreach t in array array['suppliers', 'inventory_items', 'inventory_purchases'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function app.touch_updated_at()', t, t);
  end loop;
end;
$$;

-- ===========================================================================
-- Functions
-- ===========================================================================

create or replace function app.require_quantity(
  p_input integer,
  p_field text default 'quantity',
  p_min   integer default 1
)
returns integer
language plpgsql
immutable
as $$
begin
  if p_input is null or p_input < p_min or p_input > 1000000 then
    raise exception 'Enter the % as a whole number%.', p_field,
      case when p_min > 0 then ' greater than zero' else '' end
      using errcode = 'invalid_parameter_value', detail = 'quantity';
  end if;
  return p_input;
end;
$$;

/* Stock-outs worth at least this need inventory.stock.adjust. */
create or replace function app.high_value_threshold_ugx()
returns bigint
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  -- settings/inventory.highValueThresholdUgx, defaulting to UGX 200,000 when
  -- it is missing or not a positive whole number, exactly as the reference
  -- falls back to DEFAULT_HIGH_VALUE_UGX.
  select coalesce(
    (select case when jsonb_typeof(value -> 'highValueThresholdUgx') = 'number'
                  and (value ->> 'highValueThresholdUgx') ~ '^\d+$'
                  and (value ->> 'highValueThresholdUgx')::bigint > 0
                 then (value ->> 'highValueThresholdUgx')::bigint end
       from public.settings where key = 'inventory'),
    200000);
$$;

/*
 * One movement. Locks the item, refuses to go below zero, writes the immutable
 * row and returns it. Everything that changes a quantity goes through here.
 */
create or replace function app.move_stock(
  p_item     uuid,
  p_type     text,
  p_change   integer,
  p_reason   text default null,
  p_reason_code text default null,
  p_reference text default null,
  p_purchase uuid default null,
  p_intake   uuid default null,
  p_worker   uuid default null,
  p_unit_cost bigint default null,
  p_approved_by uuid default null,
  p_request_id text default null,
  p_reversal_of uuid default null,
  p_reversal_of_type text default null,
  p_counted  integer default null,
  p_system   integer default null
)
returns public.stock_movements
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_item     public.inventory_items%rowtype;
  v_before   integer;
  v_after    integer;
  v_number   text;
  v_movement public.stock_movements%rowtype;
  v_status_before text;
begin
  -- FOR UPDATE serialises concurrent movements on this item: two people
  -- issuing stock at the same moment cannot both read the same quantity.
  select * into v_item from public.inventory_items where id = p_item for update;
  if v_item.id is null then
    raise exception 'That inventory item could not be found.'
      using errcode = 'no_data_found', detail = 'item';
  end if;

  v_status_before := v_item.stock_status;
  v_before := v_item.quantity;
  v_after  := v_before + p_change;
  if v_after < 0 then
    raise exception 'Only % %(s) of % in stock; % requested.',
      v_before, v_item.unit, v_item.name, -p_change
      using errcode = 'raise_exception', detail = 'insufficient_stock';
  end if;

  v_number := app.next_reference('movement_number_seq', 'RMX-STM-');

  insert into public.stock_movements
    (movement_number, item_id, item_name, sku, unit, type, quantity, quantity_change,
     quantity_before, quantity_after, reason, reason_code, reference, purchase_id,
     intake_id, job_number, worker_id, worker_name, unit_cost_ugx, approved_by,
     request_id, reversal_of_id, reversal_of_type, counted_quantity, system_quantity,
     created_by, created_by_name)
  values
    (v_number, p_item, v_item.name, v_item.sku, v_item.unit, p_type, abs(p_change), p_change,
     v_before, v_after, p_reason, p_reason_code, p_reference, p_purchase,
     p_intake, (select job_number from public.service_intakes where id = p_intake),
     p_worker, (select full_name from public.users where id = p_worker),
     p_unit_cost, p_approved_by, p_request_id, p_reversal_of, p_reversal_of_type,
     p_counted, p_system,
     auth.uid(), (select full_name from public.users where id = auth.uid()))
  returning * into v_movement;

  update public.inventory_items
     set quantity = v_after,
         last_movement_at = now(),
         last_unit_cost_ugx = coalesce(p_unit_cost, last_unit_cost_ugx),
         last_counted_at = case when p_counted is not null then now() else last_counted_at end,
         last_counted_quantity = coalesce(p_counted, last_counted_quantity),
         updated_by = auth.uid(),
         updated_at = now()
   where id = p_item;

  -- An item that has just become worse off is worth telling someone about.
  if (select stock_status from public.inventory_items where id = p_item)
     is distinct from v_status_before
     and (select stock_status from public.inventory_items where id = p_item) <> 'ok' then
    insert into public.inventory_events (type, item_id, sku, item_name, quantity, stock_status)
    select case when i.stock_status = 'out_of_stock' then 'out_of_stock' else 'low_stock' end,
           i.id, i.sku, i.name, i.quantity, i.stock_status
      from public.inventory_items i where i.id = p_item;
  end if;

  return v_movement;
end;
$$;

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------

create or replace function app.create_inventory_item(
  p_name     text,
  p_category text,
  p_unit     text,
  p_minimum  integer default 0,
  p_reorder  integer default 0,
  p_description text default null,
  p_consumable boolean default true,
  p_supplier uuid default null,
  p_unit_cost bigint default null,
  p_sku      text default null,
  p_opening  integer default 0
)
returns table (item_id uuid, sku text, stock_status text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_name text;
  v_sku  text;
  v_id   uuid;
begin
  perform app.require_permission('inventory.manage');
  if coalesce(p_opening, 0) > 0 then
    -- Opening stock is a stock-in, so it needs the stock-in permission too.
    perform app.require_permission('inventory.stock.in');
  end if;

  v_name := app.require_text(p_name, 'Item name', 60);
  perform app.require_quantity(coalesce(p_minimum, 0), 'minimum stock', 0);
  perform app.require_quantity(coalesce(p_reorder, 0), 'reorder level', 0);
  if coalesce(p_reorder, 0) < coalesce(p_minimum, 0) then
    raise exception 'The reorder level cannot be below the minimum stock level.'
      using errcode = 'invalid_parameter_value', detail = 'levels';
  end if;
  if exists (select 1 from public.inventory_items where lower(btrim(name)) = lower(btrim(v_name))) then
    raise exception 'An item called "%" already exists.', v_name
      using errcode = 'unique_violation', detail = 'duplicate_item';
  end if;

  if p_sku is null or btrim(p_sku) = '' then
    v_sku := app.next_reference(
      'sku_' || lower(app.sku_prefix(p_category)) || '_seq',
      'RMX-' || app.sku_prefix(p_category) || '-', 3);
  else
    v_sku := upper(btrim(p_sku));
    if v_sku !~ '^[A-Z0-9][A-Z0-9-]{2,23}$' then
      raise exception 'Use 3–24 letters, digits or dashes for the SKU.'
        using errcode = 'invalid_parameter_value', detail = 'sku';
    end if;
    if exists (select 1 from public.inventory_items i where i.sku = v_sku) then
      raise exception 'SKU % is already in use.', v_sku
        using errcode = 'unique_violation', detail = 'duplicate_sku';
    end if;
  end if;

  insert into public.inventory_items
    (sku, name, category, unit, description, is_consumable, minimum_stock, reorder_level,
     preferred_supplier_id, preferred_supplier_name, last_unit_cost_ugx, created_by, updated_by)
  values
    (v_sku, v_name, p_category, p_unit, app.optional_text(p_description, 'Description', 300),
     coalesce(p_consumable, true), coalesce(p_minimum, 0), coalesce(p_reorder, 0),
     p_supplier, (select name from public.suppliers where id = p_supplier),
     p_unit_cost, auth.uid(), auth.uid())
  returning id into v_id;

  if coalesce(p_opening, 0) > 0 then
    perform app.move_stock(v_id, 'stock_in', p_opening, 'Opening stock',
      p_unit_cost => p_unit_cost);
  end if;

  perform app.audit('inventory_item.created', 'inventory', v_id::text, null, v_name, null, null,
    jsonb_build_object('sku', v_sku, 'name', v_name, 'category', p_category,
                       'unit', p_unit, 'openingQuantity', coalesce(p_opening, 0)));

  return query select v_id, v_sku, i.stock_status from public.inventory_items i where i.id = v_id;
end;
$$;

/* Details only. Quantity and SKU are never editable. */
create or replace function app.update_inventory_item(
  p_item     uuid,
  p_name     text default null,
  p_category text default null,
  p_unit     text default null,
  p_minimum  integer default null,
  p_reorder  integer default null,
  p_description text default null,
  p_consumable boolean default null,
  p_supplier uuid default null,
  p_unit_cost bigint default null,
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
  v_before public.inventory_items%rowtype;
  v_name   text;
  v_reason text;
  v_min    integer;
  v_reorder integer;
begin
  perform app.require_permission('inventory.manage');
  select * into v_before from public.inventory_items where id = p_item for update;
  if v_before.id is null then
    raise exception 'That inventory item could not be found.'
      using errcode = 'no_data_found', detail = 'item';
  end if;

  v_reason := case when p_active is false then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;
  v_name   := case when p_name is null then null else app.require_text(p_name, 'Item name', 60) end;
  v_min    := coalesce(p_minimum, v_before.minimum_stock);
  v_reorder := coalesce(p_reorder, v_before.reorder_level);
  if v_reorder < v_min then
    raise exception 'The reorder level cannot be below the minimum stock level.'
      using errcode = 'invalid_parameter_value', detail = 'levels';
  end if;
  if v_name is not null and exists (
    select 1 from public.inventory_items
     where id <> p_item and lower(btrim(name)) = lower(btrim(v_name))) then
    raise exception 'An item called "%" already exists.', v_name
      using errcode = 'unique_violation', detail = 'duplicate_item';
  end if;

  update public.inventory_items
     set name = coalesce(v_name, name),
         category = coalesce(p_category, category),
         unit = coalesce(p_unit, unit),
         minimum_stock = v_min,
         reorder_level = v_reorder,
         description = case when p_description is null then description
                            else app.optional_text(p_description, 'Description', 300) end,
         is_consumable = coalesce(p_consumable, is_consumable),
         preferred_supplier_id = coalesce(p_supplier, preferred_supplier_id),
         preferred_supplier_name = case when p_supplier is null then preferred_supplier_name
                                        else (select name from public.suppliers where id = p_supplier) end,
         last_unit_cost_ugx = coalesce(p_unit_cost, last_unit_cost_ugx),
         active = coalesce(p_active, active),
         updated_by = auth.uid()
   where id = p_item;

  perform app.audit(
    case when p_active is false then 'inventory_item.deactivated'
         when p_active is true and not v_before.active then 'inventory_item.activated'
         else 'inventory_item.updated' end,
    'inventory', p_item::text, null, coalesce(v_name, v_before.name), v_reason,
    jsonb_build_object('name', v_before.name, 'minimumStock', v_before.minimum_stock,
                       'reorderLevel', v_before.reorder_level, 'active', v_before.active),
    jsonb_build_object('name', coalesce(v_name, v_before.name), 'minimumStock', v_min,
                       'reorderLevel', v_reorder, 'active', coalesce(p_active, v_before.active)));
end;
$$;

-- ---------------------------------------------------------------------------
-- Stock in / usage / stock out / return
-- ---------------------------------------------------------------------------

create or replace function app.record_stock_movement(
  p_item       uuid,
  p_type       text,
  p_quantity   integer,
  p_reason     text,
  p_request_id text,
  p_reason_code text default null,
  p_reference  text default null,
  p_unit_cost  bigint default null,
  p_intake     uuid default null,
  p_worker     uuid default null
)
returns table (movement_id uuid, movement_number text, quantity_after integer, stock_status text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier   jsonb;
  v_item      public.inventory_items%rowtype;
  v_reason    text;
  v_movement  public.stock_movements%rowtype;
  v_approved  uuid;
  v_threshold bigint;
  v_value     bigint;
begin
  if p_type not in ('stock_in', 'usage', 'stock_out', 'return') then
    raise exception 'Choose stock in, usage, stock out or return.'
      using errcode = 'invalid_parameter_value', detail = 'type';
  end if;
  -- Receiving needs inventory.stock.in; everything that takes stock away
  -- needs inventory.stock.out.
  perform app.require_permission(
    case when p_type = 'stock_in' then 'inventory.stock.in' else 'inventory.stock.out' end);

  perform app.require_quantity(p_quantity);
  perform app.require_request_id(p_request_id);
  v_reason := app.require_reason(p_reason);

  if p_type = 'stock_out' then
    if p_reason_code is null or p_reason_code not in
       ('damaged', 'expired', 'wastage', 'internal_use', 'other') then
      raise exception 'Choose why the stock is going out.'
        using errcode = 'invalid_parameter_value', detail = 'reason_code';
    end if;
  end if;

  v_earlier := app.claim_request(p_request_id, 'stock_movement',
    jsonb_build_object('item', p_item, 'type', p_type, 'quantity', p_quantity));
  if v_earlier is not null then
    return query select (v_earlier ->> 'movement_id')::uuid, v_earlier ->> 'movement_number',
                        (v_earlier ->> 'quantity_after')::integer, v_earlier ->> 'stock_status';
    return;
  end if;

  select * into v_item from public.inventory_items where id = p_item;
  if v_item.id is null then
    raise exception 'That inventory item could not be found.'
      using errcode = 'no_data_found', detail = 'item';
  end if;
  if p_type = 'stock_in' and not v_item.active then
    raise exception '% is inactive.', v_item.name
      using errcode = 'raise_exception', detail = 'item_inactive';
  end if;

  -- A high-value stock-out needs a manager. The threshold comes from the
  -- settings, never from the browser, and the value uses the last known cost.
  if p_type = 'stock_out' then
    v_threshold := app.high_value_threshold_ugx();
    v_value     := p_quantity::bigint * coalesce(v_item.last_unit_cost_ugx, 0);
    if v_value >= v_threshold then
      if not ('inventory.stock.adjust' = any (app.effective_permissions())) then
        raise exception 'Stock-outs worth UGX % or more need a manager''s approval.',
          to_char(v_threshold, 'FM999,999,999,999')
          using errcode = 'insufficient_privilege', detail = 'approval_required';
      end if;
      v_approved := auth.uid();
    end if;
  end if;

  v_movement := app.move_stock(
    p_item => p_item, p_type => p_type,
    p_change => case when p_type = 'stock_in' then p_quantity else -p_quantity end,
    p_reason => v_reason, p_reason_code => p_reason_code,
    p_reference => app.optional_text(p_reference, 'Reference', 60),
    p_intake => case when p_type = 'usage' then p_intake end,
    p_worker => case when p_type = 'usage' then p_worker end,
    p_unit_cost => case when p_type = 'stock_in' then p_unit_cost end,
    p_approved_by => v_approved, p_request_id => p_request_id);

  perform app.audit('stock.' || p_type, 'inventory', p_item::text, null,
    v_movement.movement_number, v_reason,
    jsonb_build_object('quantity', v_movement.quantity_before),
    jsonb_build_object('quantity', v_movement.quantity_after, 'type', p_type,
                       'movementNumber', v_movement.movement_number, 'reasonCode', p_reason_code));

  perform app.complete_request(p_request_id, jsonb_build_object(
    'movement_id', v_movement.id, 'movement_number', v_movement.movement_number,
    'quantity_after', v_movement.quantity_after,
    'stock_status', (select i.stock_status from public.inventory_items i where i.id = p_item)));

  return query select v_movement.id, v_movement.movement_number, v_movement.quantity_after,
                      i.stock_status from public.inventory_items i where i.id = p_item;
end;
$$;

/* A physical count. The DIFFERENCE is recorded, never a new quantity. */
create or replace function app.adjust_stock(
  p_item       uuid,
  p_counted    integer,
  p_reason     text,
  p_request_id text
)
returns table (movement_id uuid, movement_number text, difference integer, quantity_after integer)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier  jsonb;
  v_system   integer;
  v_diff     integer;
  v_reason   text;
  v_movement public.stock_movements%rowtype;
begin
  perform app.require_permission('inventory.stock.adjust');
  perform app.require_quantity(p_counted, 'counted quantity', 0);
  perform app.require_request_id(p_request_id);
  v_reason := app.require_reason(p_reason);

  v_earlier := app.claim_request(p_request_id, 'stock_adjustment',
    jsonb_build_object('item', p_item, 'counted', p_counted));
  if v_earlier is not null then
    return query select (v_earlier ->> 'movement_id')::uuid, v_earlier ->> 'movement_number',
                        (v_earlier ->> 'difference')::integer, (v_earlier ->> 'quantity_after')::integer;
    return;
  end if;

  select quantity into v_system from public.inventory_items where id = p_item;
  if v_system is null then
    raise exception 'That inventory item could not be found.'
      using errcode = 'no_data_found', detail = 'item';
  end if;
  v_diff := p_counted - v_system;
  if v_diff = 0 then
    raise exception 'The count matches the system quantity. No adjustment is needed.'
      using errcode = 'raise_exception', detail = 'no_difference';
  end if;

  v_movement := app.move_stock(
    p_item => p_item,
    p_type => case when v_diff > 0 then 'adjustment_in' else 'adjustment_out' end,
    p_change => v_diff, p_reason => v_reason, p_approved_by => auth.uid(),
    p_request_id => p_request_id, p_counted => p_counted, p_system => v_system);

  perform app.audit('stock.adjusted', 'inventory', p_item::text, null,
    v_movement.movement_number, v_reason,
    jsonb_build_object('quantity', v_system),
    jsonb_build_object('quantity', p_counted, 'differenceQuantity', v_diff,
                       'movementNumber', v_movement.movement_number));

  perform app.complete_request(p_request_id, jsonb_build_object(
    'movement_id', v_movement.id, 'movement_number', v_movement.movement_number,
    'difference', v_diff, 'quantity_after', p_counted));

  return query select v_movement.id, v_movement.movement_number, v_diff, p_counted;
end;
$$;

/* The mirror of a movement, once. Purchase receipts are corrected by a return. */
create or replace function app.reverse_stock_movement(
  p_movement uuid,
  p_reason   text
)
returns table (movement_id uuid, movement_number text, quantity_after integer)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_original public.stock_movements%rowtype;
  v_reason   text;
  v_movement public.stock_movements%rowtype;
begin
  perform app.require_permission('inventory.stock.adjust');
  v_reason := app.require_reason(p_reason);

  select * into v_original from public.stock_movements where id = p_movement for update;
  if v_original.id is null then
    raise exception 'That stock movement could not be found.'
      using errcode = 'no_data_found', detail = 'movement';
  end if;
  if v_original.type = 'reversal' then
    raise exception 'A reversal cannot itself be reversed.'
      using errcode = 'raise_exception', detail = 'is_reversal';
  end if;
  if v_original.status = 'reversed' then
    raise exception 'This movement has already been reversed.'
      using errcode = 'raise_exception', detail = 'already_reversed';
  end if;
  if v_original.purchase_id is not null then
    raise exception 'Stock received on a purchase is corrected with a return to the supplier.'
      using errcode = 'raise_exception', detail = 'use_return';
  end if;

  v_movement := app.move_stock(
    p_item => v_original.item_id, p_type => 'reversal',
    p_change => -v_original.quantity_change, p_reason => v_reason,
    p_reversal_of => p_movement, p_reversal_of_type => v_original.type);

  update public.stock_movements
     set status = 'reversed', reversed_by_id = v_movement.id, reversed_at = now(),
         reversed_by = auth.uid(), reversal_reason = v_reason
   where id = p_movement;

  perform app.audit('stock.reversed', 'inventory', p_movement::text, null,
    v_original.movement_number, v_reason,
    jsonb_build_object('status', 'posted', 'movementNumber', v_original.movement_number,
                       'quantityChange', v_original.quantity_change),
    jsonb_build_object('status', 'reversed', 'reversalMovementNumber', v_movement.movement_number,
                       'quantityAfter', v_movement.quantity_after));

  return query select v_movement.id, v_movement.movement_number, v_movement.quantity_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------

create or replace function app.create_supplier(
  p_name    text,
  p_contact text default null,
  p_phone   text default null,
  p_email   text default null,
  p_address text default null,
  p_notes   text default null
)
returns table (supplier_id uuid, supplier_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_name   text;
  v_phone  text;
  v_number text;
  v_id     uuid;
begin
  perform app.require_permission('inventory.suppliers.manage');
  v_name := app.require_text(p_name, 'Supplier name', 80);
  if exists (select 1 from public.suppliers where lower(btrim(name)) = lower(btrim(v_name))) then
    raise exception 'A supplier called "%" already exists.', v_name
      using errcode = 'unique_violation', detail = 'duplicate_supplier';
  end if;
  if p_phone is not null and btrim(p_phone) <> '' then
    v_phone := app.normalize_phone(p_phone);
    if v_phone is null then
      raise exception 'Enter a valid phone number, e.g. 0772 123 456.'
        using errcode = 'invalid_parameter_value', detail = 'phone';
    end if;
  end if;

  v_number := app.next_reference('supplier_number_seq', 'RMX-SUP-');
  insert into public.suppliers (supplier_number, name, contact_person, phone, email, address, notes,
                                created_by, updated_by)
  values (v_number, v_name, app.optional_text(p_contact, 'Contact person', 80), v_phone,
          app.optional_text(p_email, 'Email', 120), app.optional_text(p_address, 'Address', 200),
          app.optional_text(p_notes, 'Notes', 500), auth.uid(), auth.uid())
  returning id into v_id;

  perform app.audit('supplier.created', 'inventory', v_id::text, null, v_name, null, null,
    jsonb_build_object('supplierNumber', v_number, 'name', v_name));
  return query select v_id, v_number;
end;
$$;

create or replace function app.update_supplier(
  p_supplier uuid,
  p_name    text default null,
  p_contact text default null,
  p_phone   text default null,
  p_email   text default null,
  p_address text default null,
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
  v_before public.suppliers%rowtype;
  v_name   text;
  v_phone  text;
  v_reason text;
begin
  perform app.require_permission('inventory.suppliers.manage');
  select * into v_before from public.suppliers where id = p_supplier for update;
  if v_before.id is null then
    raise exception 'That supplier could not be found.'
      using errcode = 'no_data_found', detail = 'supplier';
  end if;

  v_reason := case when p_active is false then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;
  v_name := case when p_name is null then null else app.require_text(p_name, 'Supplier name', 80) end;
  if v_name is not null and exists (
    select 1 from public.suppliers where id <> p_supplier
       and lower(btrim(name)) = lower(btrim(v_name))) then
    raise exception 'A supplier called "%" already exists.', v_name
      using errcode = 'unique_violation', detail = 'duplicate_supplier';
  end if;
  if p_phone is not null and btrim(p_phone) <> '' then
    v_phone := app.normalize_phone(p_phone);
    if v_phone is null then
      raise exception 'Enter a valid phone number, e.g. 0772 123 456.'
        using errcode = 'invalid_parameter_value', detail = 'phone';
    end if;
  end if;

  update public.suppliers
     set name = coalesce(v_name, name),
         contact_person = case when p_contact is null then contact_person
                               else app.optional_text(p_contact, 'Contact person', 80) end,
         phone = coalesce(v_phone, phone),
         email = case when p_email is null then email else app.optional_text(p_email, 'Email', 120) end,
         address = case when p_address is null then address
                        else app.optional_text(p_address, 'Address', 200) end,
         notes = case when p_notes is null then notes else app.optional_text(p_notes, 'Notes', 500) end,
         active = coalesce(p_active, active),
         updated_by = auth.uid()
   where id = p_supplier;

  perform app.audit(
    case when p_active is false then 'supplier.deactivated' else 'supplier.updated' end,
    'inventory', p_supplier::text, null, coalesce(v_name, v_before.name), v_reason,
    jsonb_build_object('name', v_before.name, 'active', v_before.active),
    jsonb_build_object('name', coalesce(v_name, v_before.name), 'active', coalesce(p_active, v_before.active)));
end;
$$;

-- ---------------------------------------------------------------------------
-- Purchases
-- ---------------------------------------------------------------------------
-- A purchase is a STOCK ACQUISITION. Paying for one posts an
-- `inventory_purchase_payment` ledger entry and creates NO expense record.

create or replace function app.create_purchase(
  p_supplier   uuid,
  p_items      jsonb,
  p_request_id text,
  p_date       date default null,
  p_supplier_reference text default null,
  p_notes      text default null
)
returns table (purchase_id uuid, purchase_number text, total_ugx bigint, status text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier  jsonb;
  v_supplier public.suppliers%rowtype;
  v_number   text;
  v_id       uuid;
  v_status   text;
  v_total    bigint := 0;
  v_count    integer := 0;
  v_date     date;
  v_line     jsonb;
  v_item     public.inventory_items%rowtype;
  v_qty      integer;
  v_cost     bigint;
begin
  perform app.require_permission('inventory.purchase.create');
  perform app.require_request_id(p_request_id);
  v_date := app.require_business_date(p_date, 'purchase date');

  v_earlier := app.claim_request(p_request_id, 'purchase',
    jsonb_build_object('supplier', p_supplier, 'items', p_items));
  if v_earlier is not null then
    return query select (v_earlier ->> 'purchase_id')::uuid, v_earlier ->> 'purchase_number',
                        (v_earlier ->> 'total_ugx')::bigint, v_earlier ->> 'status';
    return;
  end if;

  select * into v_supplier from public.suppliers where id = p_supplier;
  if v_supplier.id is null or not v_supplier.active then
    raise exception 'Choose an active supplier.'
      using errcode = 'invalid_parameter_value', detail = 'supplier';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item.'
      using errcode = 'invalid_parameter_value', detail = 'items';
  end if;
  if jsonb_array_length(p_items) > 30 then
    raise exception 'A purchase can have at most 30 lines.'
      using errcode = 'invalid_parameter_value', detail = 'items';
  end if;

  -- Approved at once when the person may approve purchases; otherwise it waits.
  v_status := case when 'inventory.purchase.approve' = any (app.effective_permissions())
                   then 'approved' else 'pending_approval' end;
  v_number := app.next_reference('purchase_number_seq', 'RMX-PUR-');

  insert into public.inventory_purchases
    (purchase_number, supplier_id, supplier_name, purchase_date, supplier_reference,
     status, notes, request_id, approved_by, approved_at, created_by, created_by_name, updated_by)
  values
    (v_number, p_supplier, v_supplier.name, v_date,
     app.optional_text(p_supplier_reference, 'Supplier invoice / reference', 60),
     v_status, app.optional_text(p_notes, 'Notes', 500), p_request_id,
     case when v_status = 'approved' then auth.uid() end,
     case when v_status = 'approved' then now() end,
     auth.uid(), (select full_name from public.users where id = auth.uid()), auth.uid())
  returning id into v_id;

  for v_line in select * from jsonb_array_elements(p_items) loop
    select * into v_item from public.inventory_items
     where id = (v_line ->> 'itemId')::uuid;
    if v_item.id is null or not v_item.active then
      raise exception 'One of the items is missing or inactive.'
        using errcode = 'invalid_parameter_value', detail = 'items';
    end if;
    v_qty  := app.require_quantity((v_line ->> 'quantity')::integer);
    v_cost := app.require_amount((v_line ->> 'unitCostUgx')::bigint, 'unit cost', 0, 100000000);

    -- The SERVER prices every line. The browser sends quantities and costs,
    -- never a line total and never the purchase total.
    insert into public.inventory_purchase_items
      (purchase_id, item_id, name, sku, unit, quantity, unit_cost_ugx)
    values (v_id, v_item.id, v_item.name, v_item.sku, v_item.unit, v_qty, v_cost);

    v_total := v_total + (v_qty::bigint * v_cost);
    v_count := v_count + 1;
  end loop;

  perform app.require_amount(v_total, 'purchase total', 0);

  update public.inventory_purchases
     set total_ugx = v_total, line_count = v_count,
         payment_status = case when v_total = 0 then 'paid' else 'unpaid' end
   where id = v_id;

  perform app.audit('purchase.created', 'inventory', v_id::text, null, v_number, null, null,
    jsonb_build_object('purchaseNumber', v_number, 'supplierId', p_supplier,
                       'totalUgx', v_total, 'lineCount', v_count, 'status', v_status));

  perform app.complete_request(p_request_id, jsonb_build_object(
    'purchase_id', v_id, 'purchase_number', v_number, 'total_ugx', v_total, 'status', v_status));

  return query select v_id, v_number, v_total, v_status;
end;
$$;

create or replace function app.update_purchase_status(
  p_purchase uuid,
  p_action   text,
  p_reason   text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.inventory_purchases%rowtype;
  v_reason text;
  v_status text;
begin
  perform app.require_permission('inventory.purchase.approve');
  if p_action not in ('approve', 'cancel') then
    raise exception 'Choose approve or cancel.'
      using errcode = 'invalid_parameter_value', detail = 'action';
  end if;
  v_reason := case when p_action = 'cancel' then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;

  select * into v_before from public.inventory_purchases where id = p_purchase for update;
  if v_before.id is null then
    raise exception 'That purchase could not be found.'
      using errcode = 'no_data_found', detail = 'purchase';
  end if;

  if p_action = 'approve' and v_before.status <> 'pending_approval' then
    raise exception 'Only a purchase awaiting approval can be approved.'
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;
  if p_action = 'cancel' then
    if v_before.status not in ('pending_approval', 'approved') then
      raise exception 'Received or cancelled purchases cannot be cancelled.'
        using errcode = 'raise_exception', detail = 'invalid_status';
    end if;
    if v_before.payment_status = 'paid' and v_before.total_ugx > 0 then
      raise exception 'Reverse the payment before cancelling this purchase.'
        using errcode = 'raise_exception', detail = 'paid';
    end if;
  end if;

  v_status := case when p_action = 'approve' then 'approved' else 'cancelled' end;
  update public.inventory_purchases
     set status = v_status,
         approved_by = case when p_action = 'approve' then auth.uid() else approved_by end,
         approved_at = case when p_action = 'approve' then now() else approved_at end,
         cancelled_by = case when p_action = 'cancel' then auth.uid() else cancelled_by end,
         cancelled_at = case when p_action = 'cancel' then now() else cancelled_at end,
         cancel_reason = case when p_action = 'cancel' then v_reason else cancel_reason end,
         updated_by = auth.uid()
   where id = p_purchase;

  perform app.audit(case when p_action = 'approve' then 'purchase.approved' else 'purchase.cancelled' end,
    'inventory', p_purchase::text, null, v_before.purchase_number, v_reason,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_status));

  return v_status;
end;
$$;

/* The money side of a purchase, shared by receive-and-pay and pay-later. */
create or replace function app.post_purchase_payment(
  p_purchase   public.inventory_purchases,
  p_account    uuid,
  p_reference  text,
  p_request_id text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
begin
  perform app.require_active_account(p_account);
  return app.post_transaction(
    p_type => 'inventory_purchase_payment', p_amount => p_purchase.total_ugx, p_from => p_account,
    p_reference_type => 'purchase', p_reference_id => p_purchase.id,
    p_description => p_purchase.purchase_number || ': stock from ' || p_purchase.supplier_name,
    p_reference => coalesce(p_reference, p_purchase.supplier_reference),
    p_request_id => p_request_id, p_approved_by => p_purchase.approved_by);
end;
$$;

/*
 * Confirms delivery: one stock_in per line, once. With `p_pay_from` the
 * purchase is also paid in the SAME transaction, so if the payment fails
 * nothing is received either.
 */
create or replace function app.receive_purchase(
  p_purchase   uuid,
  p_request_id text,
  p_pay_from   uuid default null,
  p_reference  text default null
)
returns table (purchase_id uuid, status text, transaction_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier  jsonb;
  v_purchase public.inventory_purchases%rowtype;
  v_line     public.inventory_purchase_items%rowtype;
  v_txn      uuid;
  v_number   text;
begin
  perform app.require_permission('inventory.stock.in');
  if p_pay_from is not null then
    perform app.require_permission('expenses.pay');
  end if;
  perform app.require_request_id(p_request_id);

  v_earlier := app.claim_request(p_request_id, 'purchase_receipt',
    jsonb_build_object('purchase', p_purchase, 'payFrom', p_pay_from));
  if v_earlier is not null then
    return query select (v_earlier ->> 'purchase_id')::uuid, v_earlier ->> 'status',
                        v_earlier ->> 'transaction_number';
    return;
  end if;

  select * into v_purchase from public.inventory_purchases where id = p_purchase for update;
  if v_purchase.id is null then
    raise exception 'That purchase could not be found.'
      using errcode = 'no_data_found', detail = 'purchase';
  end if;
  if v_purchase.status = 'received' then
    raise exception 'This purchase has already been received.'
      using errcode = 'raise_exception', detail = 'already_received';
  end if;
  if v_purchase.status <> 'approved' then
    raise exception 'Only an approved purchase can be received.'
      using errcode = 'raise_exception', detail = 'not_approved';
  end if;
  if p_pay_from is not null and v_purchase.payment_status = 'paid' then
    raise exception 'This purchase has already been paid.'
      using errcode = 'raise_exception', detail = 'already_paid';
  end if;

  -- The payment happens FIRST: if the account cannot fund it, no stock moves.
  if p_pay_from is not null and v_purchase.total_ugx > 0 then
    v_txn := app.post_purchase_payment(v_purchase, p_pay_from,
      app.optional_text(p_reference, 'Payment reference', 60), p_request_id);
    select t.transaction_number into v_number from public.financial_transactions t where t.id = v_txn;
  end if;

  for v_line in select * from public.inventory_purchase_items pi where pi.purchase_id = p_purchase loop
    perform app.move_stock(
      p_item => v_line.item_id, p_type => 'stock_in', p_change => v_line.quantity,
      p_reason => 'Received on ' || v_purchase.purchase_number,
      p_reference => v_purchase.supplier_reference,
      p_purchase => p_purchase, p_unit_cost => v_line.unit_cost_ugx,
      p_request_id => p_request_id);

    update public.inventory_items
       set preferred_supplier_id = coalesce(preferred_supplier_id, v_purchase.supplier_id),
           preferred_supplier_name = coalesce(preferred_supplier_name, v_purchase.supplier_name)
     where id = v_line.item_id;
  end loop;

  update public.inventory_purchases
     set status = 'received', received_by = auth.uid(),
         received_by_name = (select full_name from public.users where id = auth.uid()),
         received_at = now(),
         payment_status = case when v_txn is not null then 'paid' else payment_status end,
         paid_at = case when v_txn is not null then now() else paid_at end,
         paid_by = case when v_txn is not null then auth.uid() else paid_by end,
         paid_from_account_id = case when v_txn is not null then p_pay_from else paid_from_account_id end,
         financial_transaction_id = coalesce(v_txn, financial_transaction_id),
         financial_transaction_number = coalesce(v_number, financial_transaction_number),
         updated_by = auth.uid()
   where id = p_purchase;

  update public.suppliers
     set purchase_count = purchase_count + 1,
         total_purchased_ugx = total_purchased_ugx + v_purchase.total_ugx,
         last_purchase_at = now()
   where id = v_purchase.supplier_id;

  perform app.audit('purchase.received', 'inventory', p_purchase::text, null,
    v_purchase.purchase_number, null,
    jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', 'received', 'lineCount', v_purchase.line_count,
                       'totalUgx', v_purchase.total_ugx, 'paidFromAccountId', p_pay_from));
  if v_txn is not null then
    perform app.audit('purchase.paid', 'finance', p_purchase::text, null,
      v_purchase.purchase_number, null, null,
      jsonb_build_object('purchaseNumber', v_purchase.purchase_number,
                         'amountUgx', v_purchase.total_ugx, 'accountId', p_pay_from,
                         'transactionNumber', v_number));
  end if;

  perform app.complete_request(p_request_id, jsonb_build_object(
    'purchase_id', p_purchase, 'status', 'received', 'transaction_number', v_number));

  return query select p_purchase, 'received'::text, v_number;
end;
$$;

create or replace function app.pay_purchase(
  p_purchase   uuid,
  p_account    uuid,
  p_request_id text,
  p_reference  text default null
)
returns table (transaction_id uuid, transaction_number text, balance_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier  jsonb;
  v_purchase public.inventory_purchases%rowtype;
  v_txn      uuid;
  v_number   text;
begin
  perform app.require_permission('expenses.pay');
  perform app.require_request_id(p_request_id);

  v_earlier := app.claim_request(p_request_id, 'purchase_payment',
    jsonb_build_object('purchase', p_purchase, 'account', p_account));
  if v_earlier is not null then
    return query select (v_earlier ->> 'transaction_id')::uuid, v_earlier ->> 'transaction_number',
                        (v_earlier ->> 'balance_ugx')::bigint;
    return;
  end if;

  select * into v_purchase from public.inventory_purchases where id = p_purchase for update;
  if v_purchase.id is null then
    raise exception 'That purchase could not be found.'
      using errcode = 'no_data_found', detail = 'purchase';
  end if;
  if v_purchase.payment_status = 'paid' then
    raise exception 'This purchase has already been paid.'
      using errcode = 'raise_exception', detail = 'already_paid';
  end if;
  if v_purchase.status not in ('approved', 'received') then
    raise exception 'Only an approved or received purchase can be paid.'
      using errcode = 'raise_exception', detail = 'not_approved';
  end if;

  v_txn := app.post_purchase_payment(v_purchase, p_account,
    app.optional_text(p_reference, 'Payment reference', 60), p_request_id);
  select t.transaction_number into v_number from public.financial_transactions t where t.id = v_txn;

  update public.inventory_purchases
     set payment_status = 'paid', paid_at = now(), paid_by = auth.uid(),
         paid_from_account_id = p_account, financial_transaction_id = v_txn,
         financial_transaction_number = v_number, updated_by = auth.uid()
   where id = p_purchase;

  perform app.audit('purchase.paid', 'finance', p_purchase::text, null,
    v_purchase.purchase_number, null, null,
    jsonb_build_object('purchaseNumber', v_purchase.purchase_number,
                       'amountUgx', v_purchase.total_ugx, 'accountId', p_account,
                       'transactionNumber', v_number));

  perform app.complete_request(p_request_id, jsonb_build_object(
    'transaction_id', v_txn, 'transaction_number', v_number,
    'balance_ugx', (select a.balance_ugx from public.financial_accounts a where a.id = p_account)));

  return query select v_txn, v_number,
    (select a.balance_ugx from public.financial_accounts a where a.id = p_account);
end;
$$;

-- ---------------------------------------------------------------------------
-- Putting a reversed payment back — now including purchases
-- ---------------------------------------------------------------------------

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
    update public.expenses
       set status = 'approved', paid_at = null, paid_by = null, paid_by_name = null,
           paid_from_account_id = null, paid_from_account_name = null,
           financial_transaction_id = null, financial_transaction_number = null,
           payment_reversed_at = now(), payment_reversal_reason = p_reason,
           payment_reversal_transaction_id = p_reversal, updated_by = auth.uid()
     where id = p_original.reference_id;
  elsif p_original.entry_type = 'inventory_purchase_payment' then
    -- The stock stays received; only the money goes back.
    update public.inventory_purchases
       set payment_status = 'unpaid', paid_at = null, paid_by = null,
           paid_from_account_id = null, financial_transaction_id = null,
           financial_transaction_number = null,
           payment_reversal_reason = p_reason, payment_reversal_transaction_id = p_reversal,
           updated_by = auth.uid()
     where id = p_original.reference_id;
  end if;
end;
$$;
