-- ===========================================================================
-- RamosMAX Web — Phase C — 0007: number plates, customers, vehicles, services
-- ===========================================================================
-- Ports functions/src/plates.js and functions/src/operations.js.
-- The browser is never authoritative for a plate, a price or a uniqueness
-- decision; every one of them is made here.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Number plates — ports plates.js exactly
-- ---------------------------------------------------------------------------
-- Two forms: a DISPLAY form ("UGB 123A", canonical spacing, upper case) and a
-- KEY ("UGB123A", letters and digits only) used for search and uniqueness.

create or replace function app.plate_key(p_input text)
returns text
language sql
immutable
as $$
  select regexp_replace(upper(coalesce(p_input, '')), '[^A-Z0-9]', '', 'g');
$$;

create or replace function app.display_plate(p_input text)
returns text
language plpgsql
immutable
as $$
declare
  v_upper   text;
  v_spaced  text;
  v_compact text;
  v_match   text[];
begin
  v_upper  := regexp_replace(upper(coalesce(p_input, '')), '[^A-Z0-9 ]', ' ', 'g');
  v_spaced := btrim(regexp_replace(v_upper, '\s+', ' ', 'g'));

  if app.is_plate_shape(v_spaced) then return v_spaced; end if;

  v_compact := regexp_replace(v_upper, '\s+', '', 'g');
  v_match := regexp_match(v_compact, '^([A-Z]+)([0-9]+)([A-Z]?)$');
  if v_match is not null then
    return v_match[1] || ' ' || v_match[2] || v_match[3];
  end if;
  return v_spaced;
end;
$$;

-- The accepted Ugandan formats: private/commercial and motorcycles, then
-- government, police and army, then diplomatic.
create or replace function app.is_plate_shape(p_display text)
returns boolean
language sql
immutable
as $$
  select p_display ~ '^U[A-Z]{2} [0-9]{3}[A-Z]?$'
      or p_display ~ '^(UG|UP|UPDF|UPF|UA) [0-9]{3,4}[A-Z]?$'
      or p_display ~ '^(CD|UN|DC) [0-9]{2,3} [0-9]{2,3}$';
$$;

/** The canonical display plate, or NULL when the input is not a valid plate. */
create or replace function app.parse_plate(p_input text)
returns text
language sql
immutable
as $$
  select case when app.is_plate_shape(app.display_plate(p_input))
              then app.display_plate(p_input) end;
$$;

create or replace function app.require_plate(p_input text)
returns text
language plpgsql
immutable
as $$
declare
  v_plate text := app.parse_plate(p_input);
begin
  if v_plate is null then
    raise exception 'Enter a valid number plate, e.g. UGB 123A.'
      using errcode = 'invalid_parameter_value', detail = 'plate';
  end if;
  return v_plate;
end;
$$;

-- ---------------------------------------------------------------------------
-- Shared input helpers
-- ---------------------------------------------------------------------------

create or replace function app.require_name(p_input text)
returns text
language plpgsql
immutable
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_input, '')), '\s+', ' ', 'g');
begin
  if char_length(v_name) < 2 then
    raise exception 'Enter the full name.' using errcode = 'invalid_parameter_value', detail = 'name';
  end if;
  if char_length(v_name) > 80 then
    raise exception 'The name is too long (80 characters maximum).'
      using errcode = 'invalid_parameter_value', detail = 'name';
  end if;
  return v_name;
end;
$$;

create or replace function app.optional_text(p_input text, p_field text, p_max integer default 500)
returns text
language plpgsql
immutable
as $$
declare
  v text := regexp_replace(btrim(coalesce(p_input, '')), '\s+', ' ', 'g');
begin
  if v = '' then return null; end if;
  if char_length(v) > p_max then
    raise exception '% is too long (% characters maximum).', p_field, p_max
      using errcode = 'invalid_parameter_value', detail = 'text';
  end if;
  return v;
end;
$$;

create or replace function app.require_reason(p_input text)
returns text
language plpgsql
immutable
as $$
declare
  v text := btrim(coalesce(p_input, ''));
begin
  if v = '' then
    raise exception 'Enter a reason for this change.'
      using errcode = 'invalid_parameter_value', detail = 'reason';
  end if;
  if char_length(v) < 3 then
    raise exception 'The reason is too short.' using errcode = 'invalid_parameter_value', detail = 'reason';
  end if;
  if char_length(v) > 500 then
    raise exception 'The reason is too long (500 characters maximum).'
      using errcode = 'invalid_parameter_value', detail = 'reason';
  end if;
  return v;
end;
$$;

-- ===========================================================================
-- Customers
-- ===========================================================================

create or replace function app.create_customer(
  p_full_name         text,
  p_phone             text default null,
  p_alternative_phone text default null,
  p_email             text default null,
  p_address           text default null,
  p_notes             text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_id     uuid;
  v_phone  text;
  v_alt    text;
  v_number text;
  v_existing uuid;
begin
  perform app.require_permission('customers.manage');

  v_phone := case when btrim(coalesce(p_phone, '')) = '' then null
                  else app.normalize_phone(p_phone) end;
  if btrim(coalesce(p_phone, '')) <> '' and v_phone is null then
    raise exception 'Enter a valid phone number, e.g. 0772 123 456.'
      using errcode = 'invalid_parameter_value', detail = 'phone';
  end if;

  v_alt := case when btrim(coalesce(p_alternative_phone, '')) = '' then null
                else app.normalize_phone(p_alternative_phone) end;
  if btrim(coalesce(p_alternative_phone, '')) <> '' and v_alt is null then
    raise exception 'Enter a valid alternative phone number.'
      using errcode = 'invalid_parameter_value', detail = 'alternative_phone';
  end if;

  -- A clear message and a pointer to the existing record, as the reference
  -- implementation gives. The unique index below is the real guarantee.
  if v_phone is not null then
    select id into v_existing from public.customers where phone_number = v_phone;
    if v_existing is not null then
      raise exception 'A customer with this phone number already exists.'
        using errcode = 'unique_violation', detail = 'duplicate_phone', hint = v_existing::text;
    end if;
  end if;

  v_number := app.next_reference('customer_number_seq', 'RMX-CUS-');

  insert into public.customers
    (customer_number, full_name, phone_number, alternative_phone, email, address, notes,
     created_by, updated_by)
  values
    (v_number, app.require_name(p_full_name), v_phone, v_alt,
     app.optional_text(p_email, 'Email', 120),
     app.optional_text(p_address, 'Address', 200),
     app.optional_text(p_notes, 'Notes', 500),
     auth.uid(), auth.uid())
  returning id into v_id;

  perform app.audit('customer.created', 'customers', v_number, null, null, null, null,
    jsonb_build_object('fullName', app.require_name(p_full_name),
                       'phoneNumber', app.mask_phone(v_phone)));
  return v_id;
end;
$$;

create or replace function app.update_customer(
  p_customer          uuid,
  p_full_name         text,
  p_phone             text default null,
  p_alternative_phone text default null,
  p_email             text default null,
  p_address           text default null,
  p_notes             text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.customers%rowtype;
  v_phone  text;
  v_alt    text;
  v_existing uuid;
begin
  perform app.require_permission('customers.manage');

  select * into v_before from public.customers where id = p_customer;
  if v_before.id is null then
    raise exception 'That customer could not be found.' using errcode = 'no_data_found', detail = 'customer';
  end if;

  v_phone := case when btrim(coalesce(p_phone, '')) = '' then null
                  else app.normalize_phone(p_phone) end;
  if btrim(coalesce(p_phone, '')) <> '' and v_phone is null then
    raise exception 'Enter a valid phone number, e.g. 0772 123 456.'
      using errcode = 'invalid_parameter_value', detail = 'phone';
  end if;
  v_alt := case when btrim(coalesce(p_alternative_phone, '')) = '' then null
                else app.normalize_phone(p_alternative_phone) end;

  if v_phone is not null and v_phone is distinct from v_before.phone_number then
    select id into v_existing from public.customers where phone_number = v_phone and id <> p_customer;
    if v_existing is not null then
      raise exception 'A customer with this phone number already exists.'
        using errcode = 'unique_violation', detail = 'duplicate_phone', hint = v_existing::text;
    end if;
  end if;

  update public.customers
     set full_name         = app.require_name(p_full_name),
         phone_number      = v_phone,
         alternative_phone = v_alt,
         email             = app.optional_text(p_email, 'Email', 120),
         address           = app.optional_text(p_address, 'Address', 200),
         notes             = app.optional_text(p_notes, 'Notes', 500),
         updated_by        = auth.uid()
   where id = p_customer;

  -- Display copies on the customer's vehicles stay in step.
  update public.vehicles
     set customer_name = app.require_name(p_full_name), updated_by = auth.uid()
   where customer_id = p_customer;

  perform app.audit('customer.updated', 'customers', v_before.customer_number, null, null, null,
    jsonb_build_object('fullName', v_before.full_name,
                       'phoneNumber', app.mask_phone(v_before.phone_number)),
    jsonb_build_object('fullName', app.require_name(p_full_name),
                       'phoneNumber', app.mask_phone(v_phone)));
end;
$$;

create or replace function app.set_customer_status(p_customer uuid, p_active boolean, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.customers%rowtype;
  v_status text := case when p_active then 'active' else 'inactive' end;
  v_reason text := app.require_reason(p_reason);
begin
  perform app.require_permission('customers.manage');

  select * into v_before from public.customers where id = p_customer;
  if v_before.id is null then
    raise exception 'That customer could not be found.' using errcode = 'no_data_found', detail = 'customer';
  end if;
  if v_before.status = v_status then
    raise exception '%', case when p_active then 'This customer is already active.'
                             else 'This customer is already inactive.' end
      using errcode = 'invalid_parameter_value', detail = 'no_changes';
  end if;

  update public.customers
     set status = v_status, status_reason = v_reason,
         status_changed_at = now(), status_changed_by = auth.uid(), updated_by = auth.uid()
   where id = p_customer;

  perform app.audit(
    case when p_active then 'customer.activated' else 'customer.deactivated' end,
    'customers', v_before.customer_number, null, null, v_reason,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_status));
end;
$$;

-- ===========================================================================
-- Vehicles
-- ===========================================================================

create or replace function app.create_vehicle(
  p_plate        text,
  p_model        text,
  p_colour       text,
  p_make         text default null,
  p_year         integer default null,
  p_vehicle_type text default null,
  p_customer     uuid default null,
  p_notes        text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_id       uuid;
  v_plate    text := app.require_plate(p_plate);
  v_key      text := app.plate_key(v_plate);
  v_existing uuid;
  v_customer public.customers%rowtype;
begin
  perform app.require_permission('vehicles.manage');

  select id into v_existing from public.vehicles where normalized_plate = v_key;
  if v_existing is not null then
    raise exception '% is already registered.', v_plate
      using errcode = 'unique_violation', detail = 'duplicate_plate', hint = v_existing::text;
  end if;

  if p_customer is not null then
    select * into v_customer from public.customers where id = p_customer;
    if v_customer.id is null then
      raise exception 'That customer could not be found.'
        using errcode = 'no_data_found', detail = 'customer';
    end if;
    -- Linking requires an ACTIVE customer.
    if v_customer.status <> 'active' then
      raise exception 'That customer is inactive. Reactivate them before linking a vehicle.'
        using errcode = 'invalid_parameter_value', detail = 'customer_inactive';
    end if;
  end if;

  insert into public.vehicles
    (number_plate, normalized_plate, model, colour, make, year, vehicle_type, notes,
     customer_id, customer_name, customer_number, created_by, updated_by)
  values
    (v_plate, v_key,
     app.require_name(p_model), app.require_name(p_colour),
     app.optional_text(p_make, 'Make', 60), p_year,
     p_vehicle_type, app.optional_text(p_notes, 'Notes', 500),
     p_customer, v_customer.full_name, v_customer.customer_number,
     auth.uid(), auth.uid())
  returning id into v_id;

  if p_customer is not null then
    update public.customers set vehicle_count = vehicle_count + 1 where id = p_customer;
  end if;

  perform app.audit('vehicle.created', 'vehicles', v_plate, null, null, null, null,
    jsonb_build_object('numberPlate', v_plate, 'customerId', p_customer));
  return v_id;
end;
$$;

create or replace function app.update_vehicle(
  p_vehicle      uuid,
  p_model        text,
  p_colour       text,
  p_make         text default null,
  p_year         integer default null,
  p_vehicle_type text default null,
  p_notes        text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.vehicles%rowtype;
begin
  perform app.require_permission('vehicles.manage');
  select * into v_before from public.vehicles where id = p_vehicle;
  if v_before.id is null then
    raise exception 'That vehicle could not be found.' using errcode = 'no_data_found', detail = 'vehicle';
  end if;

  update public.vehicles
     set model        = app.require_name(p_model),
         colour       = app.require_name(p_colour),
         make         = app.optional_text(p_make, 'Make', 60),
         year         = p_year,
         vehicle_type = p_vehicle_type,
         notes        = app.optional_text(p_notes, 'Notes', 500),
         updated_by   = auth.uid()
   where id = p_vehicle;

  perform app.audit('vehicle.updated', 'vehicles', v_before.number_plate, null, null, null,
    jsonb_build_object('model', v_before.model, 'colour', v_before.colour),
    jsonb_build_object('model', app.require_name(p_model), 'colour', app.require_name(p_colour)));
end;
$$;

-- A plate change needs a REASON. The old plate is kept in previous_plates and
-- past intakes keep the plate they were recorded with, so history stays intact.
create or replace function app.change_vehicle_plate(p_vehicle uuid, p_plate text, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before   public.vehicles%rowtype;
  v_plate    text := app.require_plate(p_plate);
  v_key      text := app.plate_key(v_plate);
  v_reason   text := app.require_reason(p_reason);
  v_existing uuid;
begin
  perform app.require_permission('vehicles.manage');
  select * into v_before from public.vehicles where id = p_vehicle;
  if v_before.id is null then
    raise exception 'That vehicle could not be found.' using errcode = 'no_data_found', detail = 'vehicle';
  end if;
  if v_before.normalized_plate = v_key then
    raise exception 'This vehicle already has that number plate.'
      using errcode = 'invalid_parameter_value', detail = 'no_changes';
  end if;

  select id into v_existing from public.vehicles where normalized_plate = v_key;
  if v_existing is not null then
    raise exception '% is already registered.', v_plate
      using errcode = 'unique_violation', detail = 'duplicate_plate', hint = v_existing::text;
  end if;

  update public.vehicles
     set number_plate     = v_plate,
         normalized_plate = v_key,
         previous_plates  = previous_plates || v_before.number_plate,
         updated_by       = auth.uid()
   where id = p_vehicle;

  perform app.audit('vehicle.plate_changed', 'vehicles', v_plate, null, null, v_reason,
    jsonb_build_object('numberPlate', v_before.number_plate),
    jsonb_build_object('numberPlate', v_plate));
end;
$$;

create or replace function app.set_vehicle_customer(p_vehicle uuid, p_customer uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before   public.vehicles%rowtype;
  v_customer public.customers%rowtype;
  v_reason   text := app.require_reason(p_reason);
begin
  perform app.require_permission('vehicles.manage');
  select * into v_before from public.vehicles where id = p_vehicle;
  if v_before.id is null then
    raise exception 'That vehicle could not be found.' using errcode = 'no_data_found', detail = 'vehicle';
  end if;

  if p_customer is not null then
    select * into v_customer from public.customers where id = p_customer;
    if v_customer.id is null then
      raise exception 'That customer could not be found.'
        using errcode = 'no_data_found', detail = 'customer';
    end if;
    if v_customer.status <> 'active' then
      raise exception 'That customer is inactive. Reactivate them before linking a vehicle.'
        using errcode = 'invalid_parameter_value', detail = 'customer_inactive';
    end if;
  end if;

  update public.vehicles
     set customer_id     = p_customer,
         customer_name   = v_customer.full_name,
         customer_number = v_customer.customer_number,
         updated_by      = auth.uid()
   where id = p_vehicle;

  if v_before.customer_id is not null then
    update public.customers set vehicle_count = greatest(0, vehicle_count - 1)
     where id = v_before.customer_id;
  end if;
  if p_customer is not null then
    update public.customers set vehicle_count = vehicle_count + 1 where id = p_customer;
  end if;

  perform app.audit('vehicle.customer_changed', 'vehicles', v_before.number_plate, null, null, v_reason,
    jsonb_build_object('customerId', v_before.customer_id),
    jsonb_build_object('customerId', p_customer));
end;
$$;

create or replace function app.set_vehicle_status(p_vehicle uuid, p_active boolean, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.vehicles%rowtype;
  v_status text := case when p_active then 'active' else 'inactive' end;
  v_reason text := app.require_reason(p_reason);
begin
  perform app.require_permission('vehicles.manage');
  select * into v_before from public.vehicles where id = p_vehicle;
  if v_before.id is null then
    raise exception 'That vehicle could not be found.' using errcode = 'no_data_found', detail = 'vehicle';
  end if;
  if v_before.status = v_status then
    raise exception '%', case when p_active then 'This vehicle is already active.'
                             else 'This vehicle is already inactive.' end
      using errcode = 'invalid_parameter_value', detail = 'no_changes';
  end if;

  update public.vehicles
     set status = v_status, status_reason = v_reason,
         status_changed_at = now(), status_changed_by = auth.uid(), updated_by = auth.uid()
   where id = p_vehicle;

  perform app.audit(
    case when p_active then 'vehicle.activated' else 'vehicle.deactivated' end,
    'vehicles', v_before.number_plate, null, null, v_reason,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_status));
end;
$$;

-- ===========================================================================
-- Services
-- ===========================================================================

create or replace function app.create_service(
  p_name        text,
  p_category    text,
  p_price_ugx   bigint,
  p_description text default null,
  p_duration    integer default null,
  p_loyalty     boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_id   uuid;
  v_name text := app.require_name(p_name);
begin
  perform app.require_permission('services.manage');

  if exists (select 1 from public.services where lower(name) = lower(v_name)) then
    raise exception 'A service with this name already exists.'
      using errcode = 'unique_violation', detail = 'duplicate_name';
  end if;
  if p_price_ugx is null or p_price_ugx < 0 or p_price_ugx > 100000000 then
    raise exception 'Enter a whole price between UGX 0 and UGX 100,000,000.'
      using errcode = 'invalid_parameter_value', detail = 'price';
  end if;

  insert into public.services
    (name, category, price_ugx, description, estimated_duration_minutes,
     qualifies_for_loyalty, created_by, updated_by)
  values
    (v_name, p_category, p_price_ugx, app.optional_text(p_description, 'Description', 300),
     p_duration, coalesce(p_loyalty, false), auth.uid(), auth.uid())
  returning id into v_id;

  perform app.audit('service.created', 'services', v_name, null, null, null, null,
    jsonb_build_object('name', v_name, 'priceUgx', p_price_ugx));
  return v_id;
end;
$$;

create or replace function app.update_service(
  p_service     uuid,
  p_name        text,
  p_category    text,
  p_price_ugx   bigint,
  p_description text default null,
  p_duration    integer default null,
  p_loyalty     boolean default false,
  p_reason      text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.services%rowtype;
  v_name   text := app.require_name(p_name);
begin
  perform app.require_permission('services.manage');
  select * into v_before from public.services where id = p_service;
  if v_before.id is null then
    raise exception 'That service could not be found.' using errcode = 'no_data_found', detail = 'service';
  end if;

  if exists (select 1 from public.services where lower(name) = lower(v_name) and id <> p_service) then
    raise exception 'A service with this name already exists.'
      using errcode = 'unique_violation', detail = 'duplicate_name';
  end if;
  if p_price_ugx is null or p_price_ugx < 0 or p_price_ugx > 100000000 then
    raise exception 'Enter a whole price between UGX 0 and UGX 100,000,000.'
      using errcode = 'invalid_parameter_value', detail = 'price';
  end if;

  update public.services
     set name = v_name, category = p_category, price_ugx = p_price_ugx,
         description = app.optional_text(p_description, 'Description', 300),
         estimated_duration_minutes = p_duration,
         qualifies_for_loyalty = coalesce(p_loyalty, false),
         updated_by = auth.uid()
   where id = p_service;

  -- A price change is audited separately, with the old and new price, because
  -- it is the change most likely to be questioned later.
  if v_before.price_ugx is distinct from p_price_ugx then
    perform app.audit('service.price_changed', 'services', v_name, null, null, p_reason,
      jsonb_build_object('priceUgx', v_before.price_ugx),
      jsonb_build_object('priceUgx', p_price_ugx));
  end if;

  perform app.audit('service.updated', 'services', v_name, null, null, p_reason,
    jsonb_build_object('name', v_before.name, 'category', v_before.category),
    jsonb_build_object('name', v_name, 'category', p_category));
end;
$$;

create or replace function app.set_service_active(p_service uuid, p_active boolean)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.services%rowtype;
begin
  perform app.require_permission('services.manage');
  select * into v_before from public.services where id = p_service;
  if v_before.id is null then
    raise exception 'That service could not be found.' using errcode = 'no_data_found', detail = 'service';
  end if;
  if v_before.is_active = p_active then
    raise exception '%', case when p_active then 'This service is already active.'
                             else 'This service is already inactive.' end
      using errcode = 'invalid_parameter_value', detail = 'no_changes';
  end if;

  update public.services set is_active = p_active, updated_by = auth.uid() where id = p_service;

  perform app.audit(
    case when p_active then 'service.activated' else 'service.deactivated' end,
    'services', v_before.name, null, null, null,
    jsonb_build_object('isActive', v_before.is_active),
    jsonb_build_object('isActive', p_active));
end;
$$;

grant execute on function
  app.create_customer(text, text, text, text, text, text),
  app.update_customer(uuid, text, text, text, text, text, text),
  app.set_customer_status(uuid, boolean, text),
  app.create_vehicle(text, text, text, text, integer, text, uuid, text),
  app.update_vehicle(uuid, text, text, text, integer, text, text),
  app.change_vehicle_plate(uuid, text, text),
  app.set_vehicle_customer(uuid, uuid, text),
  app.set_vehicle_status(uuid, boolean, text),
  app.create_service(text, text, bigint, text, integer, boolean),
  app.update_service(uuid, text, text, bigint, text, integer, boolean, text),
  app.set_service_active(uuid, boolean),
  app.plate_key(text), app.display_plate(text), app.parse_plate(text)
to authenticated;
