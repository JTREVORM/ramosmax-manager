-- ===========================================================================
-- DEVELOPMENT SEED — fake test accounts, one per role
-- ===========================================================================
-- NEVER apply this to production. Every value is obviously fictitious:
-- names are "Test <Role>", phone numbers are in the +25677200000x test block,
-- and no real customer, employee, shareholder or financial data appears.
--
-- Passwords are bcrypt-hashed with pgcrypto, the same scheme GoTrue uses, so
-- local credential checks are genuine. The shared development password is
-- `DevP@ssw0rd!` and is worthless outside this machine.
--
-- The sign-in identity is a random address on the reserved .invalid domain,
-- exactly as passwords.js newSignInIdentity() produces — nobody types it.
-- ===========================================================================

do $$
declare
  v_roles text[] := array['admin','manager','cashier','worker','shareholder','auditor'];
  v_names text[] := array['Test Administrator','Test Manager','Test Cashier',
                          'Test Worker','Test Shareholder','Test Auditor'];
  v_role  text;
  v_id    uuid;
  i       integer;
begin
  for i in 1..array_length(v_roles, 1) loop
    v_role := v_roles[i];
    v_id   := ('00000000-0000-4000-8000-00000000000' || i)::uuid;

    insert into auth.users (id, email, encrypted_password, email_confirmed_at)
    values (v_id, app.new_sign_in_identity(), crypt('DevP@ssw0rd!', gen_salt('bf')), now())
    on conflict (id) do nothing;

    insert into public.users
      (id, phone_number, full_name, role, active, staff_id,
       password_set, must_change_password)
    values
      (v_id, '+25677200000' || i, v_names[i], v_role, true,
       'RMX-STF-000' || i, true, false)
    on conflict (id) do nothing;
  end loop;
end;
$$;

-- Reference settings, values only — no amounts tied to real operations.
insert into public.settings (key, value) values
  ('payroll_policy', jsonb_build_object(
      'reportingTime', '08:00', 'graceMinutes', 15,
      'dailyAllowanceUgx', 5000, 'latePolicy', 'DEDUCT')),
  ('loyalty', jsonb_build_object(
      'pointsPerWash', 20, 'rewardThreshold', 200, 'rewardPercent', 25)),
  ('after_hours_policy', jsonb_build_object(
      'maxWindowHours', 12, 'maxFloatUgx', 200000,
      'paymentMethods', jsonb_build_array('cash', 'mtn', 'airtel')))
on conflict (key) do nothing;
