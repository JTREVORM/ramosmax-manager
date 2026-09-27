-- ===========================================================================
-- DEVELOPMENT SEED — a service catalogue and a few fictitious customers
-- ===========================================================================
-- NEVER apply this to production. Names are obviously invented, plates are in
-- a test range, and no real customer or vehicle appears.
--
-- The catalogue exists so the intake screen has something to select. Prices
-- are placeholders for development, not RamosMAX's real prices — the real ones
-- are set in the application, never in code.
-- ===========================================================================

insert into public.services (name, category, price_ugx, description, estimated_duration_minutes, qualifies_for_loyalty)
values
  ('Body Wash',          'washing',   15000, 'Exterior body wash',            30, true),
  ('Interior Vacuum',    'interior',  10000, 'Seats, carpets and boot',       25, true),
  ('Engine Wash',        'washing',   25000, 'Engine bay cleaning',           45, false),
  ('Full Valet',         'detailing', 90000, 'Interior and exterior detail', 180, true),
  ('Tyre Polish',        'polishing',  8000, 'Tyre dressing',                 15, false),
  ('Wax and Seal',       'waxing',    45000, 'Hand wax and paint sealant',    90, true),
  ('Underbody Wash',     'exterior',  20000, 'Underbody and wheel arches',    30, false),
  ('Headlight Restore',  'other',     35000, 'Headlight polish and restore',  60, false)
on conflict do nothing;

do $$
declare
  v_customer uuid;
  v_vehicle  uuid;
begin
  -- Customer with two vehicles.
  insert into public.customers (customer_number, full_name, phone_number, address)
  values ('RMX-CUS-000001', 'Test Customer One', '+256772100001', 'Kisasi, Kampala')
  on conflict (customer_number) do nothing
  returning id into v_customer;

  if v_customer is not null then
    insert into public.vehicles
      (number_plate, normalized_plate, model, colour, make, year, vehicle_type,
       customer_id, customer_name, customer_number)
    values
      ('UBA 100A', 'UBA100A', 'Corolla', 'Silver', 'Toyota', 2016, 'car',
       v_customer, 'Test Customer One', 'RMX-CUS-000001'),
      ('UBB 200B', 'UBB200B', 'Hilux', 'White', 'Toyota', 2019, 'pickup',
       v_customer, 'Test Customer One', 'RMX-CUS-000001')
    on conflict (normalized_plate) do nothing;
    update public.customers set vehicle_count = 2 where id = v_customer;
  end if;

  -- Second customer, one vehicle.
  insert into public.customers (customer_number, full_name, phone_number)
  values ('RMX-CUS-000002', 'Test Customer Two', '+256772100002')
  on conflict (customer_number) do nothing
  returning id into v_customer;

  if v_customer is not null then
    insert into public.vehicles
      (number_plate, normalized_plate, model, colour, make, vehicle_type,
       customer_id, customer_name, customer_number)
    values
      ('UCD 300C', 'UCD300C', 'Premio', 'Black', 'Toyota', 'car',
       v_customer, 'Test Customer Two', 'RMX-CUS-000002')
    on conflict (normalized_plate) do nothing;
    update public.customers set vehicle_count = 1 where id = v_customer;
  end if;

  -- A walk-in vehicle with no customer at all.
  insert into public.vehicles (number_plate, normalized_plate, model, colour, vehicle_type)
  values ('UG 1234', 'UG1234', 'Land Cruiser', 'Green', 'suv')
  on conflict (normalized_plate) do nothing;
end;
$$;

-- Keep the sequences ahead of the seeded reference numbers.
select setval('app.customer_number_seq',
  greatest(2, (select coalesce(max(substring(customer_number from '[0-9]+$')::bigint), 0)
                 from public.customers)));
