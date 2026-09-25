-- ===========================================================================
-- RamosMAX Web — Phase D — 0012: loyalty
-- ===========================================================================
-- Ports functions/src/loyalty.js. Loyalty belongs to the VEHICLE.
--
-- The defaults are taken from DEFAULT_LOYALTY in loyalty.js, and settings/
-- loyalty overrides them FIELD BY FIELD when a stored value is a positive
-- integer up to 100,000 — an invalid value falls back rather than breaking.
--
-- The balance is never changed without a ledger entry in the same statement,
-- so the sum of the ledger always equals the balance.
-- ===========================================================================

create or replace function app.loyalty_config()
returns table (points_per_service integer, reward_threshold integer,
               reward_percent integer, points_on_redemption integer,
               near_threshold integer)
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v jsonb := coalesce((select value from public.settings where key = 'loyalty'), '{}'::jsonb);
  -- Ports DEFAULT_LOYALTY exactly.
  v_points integer := 20;
  v_threshold integer := 200;
  v_percent integer := 25;
  v_consumed integer := 200;
  v_near integer := 160;

begin
  -- A stored value is used only when it is a positive integer <= 100000.
  if (v->>'pointsPerQualifyingService') ~ '^[0-9]+$'
     and (v->>'pointsPerQualifyingService')::int between 1 and 100000 then
    v_points := (v->>'pointsPerQualifyingService')::int;
  end if;
  if (v->>'rewardThreshold') ~ '^[0-9]+$'
     and (v->>'rewardThreshold')::int between 1 and 100000 then
    v_threshold := (v->>'rewardThreshold')::int;
  end if;
  if (v->>'rewardDiscountPercent') ~ '^[0-9]+$'
     and (v->>'rewardDiscountPercent')::int between 1 and 100000 then
    v_percent := (v->>'rewardDiscountPercent')::int;
  end if;
  if (v->>'pointsConsumedOnRedemption') ~ '^[0-9]+$'
     and (v->>'pointsConsumedOnRedemption')::int between 1 and 100000 then
    v_consumed := (v->>'pointsConsumedOnRedemption')::int;
  end if;
  if (v->>'nearThresholdPoints') ~ '^[0-9]+$'
     and (v->>'nearThresholdPoints')::int between 1 and 100000 then
    v_near := (v->>'nearThresholdPoints')::int;
  end if;

  -- The reward percentage is capped at 100.
  v_percent := least(v_percent, 100);

  return query select v_points, v_threshold, v_percent, v_consumed, v_near;
end;
$$;

-- ---------------------------------------------------------------------------
-- The single place the balance moves
-- ---------------------------------------------------------------------------
-- Writes one ledger entry and the account in the same statement, locking the
-- account so concurrent awards and redemptions cannot interleave. The balance
-- never goes below zero: a reversal takes what is left.

create or replace function app.post_loyalty(
  p_vehicle   uuid,
  p_type      text,
  p_points    integer,
  p_reference_type text,
  p_reference_id   uuid,
  p_reason    text default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before integer;
  v_after  integer;
  v_applied integer;
begin
  insert into public.loyalty_accounts (vehicle_id) values (p_vehicle)
  on conflict (vehicle_id) do nothing;

  select points_balance into v_before
    from public.loyalty_accounts where vehicle_id = p_vehicle for update;

  -- Never below zero: the shortfall is simply not taken.
  v_after   := greatest(0, v_before + p_points);
  v_applied := v_after - v_before;

  update public.loyalty_accounts
     set points_balance   = v_after,
         lifetime_points  = lifetime_points + greatest(0, v_applied),
         last_earned_at   = case when v_applied > 0 then now() else last_earned_at end,
         updated_at       = now()
   where vehicle_id = p_vehicle;

  insert into public.loyalty_transactions
    (vehicle_id, type, points, balance_before, balance_after,
     reference_type, reference_id, reason, created_by)
  values
    (p_vehicle, p_type, v_applied, v_before, v_after,
     p_reference_type, p_reference_id, p_reason, auth.uid());

  perform app.refresh_loyalty_reward(p_vehicle);
  return v_applied;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reward lifecycle
-- ---------------------------------------------------------------------------
-- One available reward per vehicle. A balance at or above the threshold
-- unlocks one; a correction that drops the balance below its cost revokes it.

create or replace function app.refresh_loyalty_reward(p_vehicle uuid)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_config record;
  v_balance integer;
  v_reward  public.loyalty_rewards%rowtype;
  v_plate   text;
begin
  select * into v_config from app.loyalty_config();
  select points_balance into v_balance from public.loyalty_accounts where vehicle_id = p_vehicle;
  select * into v_reward from public.loyalty_rewards
   where vehicle_id = p_vehicle and status = 'available';

  if v_reward.id is not null then
    -- A correction dropped the balance below what the reward costs.
    if v_balance < v_reward.points_cost then
      update public.loyalty_rewards set status = 'revoked' where id = v_reward.id;
    end if;
    return;
  end if;

  if v_balance >= v_config.reward_threshold then
    insert into public.loyalty_rewards (vehicle_id, discount_percent, points_cost)
    values (p_vehicle, v_config.reward_percent, v_config.points_on_redemption)
    on conflict do nothing;

    update public.loyalty_accounts
       set rewards_unlocked = rewards_unlocked + 1 where vehicle_id = p_vehicle;

    select number_plate into v_plate from public.vehicles where id = p_vehicle;
    insert into public.loyalty_events (vehicle_id, type, number_plate, balance)
    values (p_vehicle, 'reward_unlocked', v_plate, v_balance);
  elsif v_balance >= v_config.near_threshold then
    -- One "nearing a reward" hand-off per crossing, not per payment.
    if not exists (
      select 1 from public.loyalty_events
       where vehicle_id = p_vehicle and type = 'reward_nearing'
         and created_at > now() - interval '1 day') then
      select number_plate into v_plate from public.vehicles where id = p_vehicle;
      insert into public.loyalty_events (vehicle_id, type, number_plate, balance)
      values (p_vehicle, 'reward_nearing', v_plate, v_balance);
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Earning — called from inside record_payment
-- ---------------------------------------------------------------------------
-- Qualifying lines x points per service, once per invoice, only when the
-- invoice becomes fully paid.

create or replace function app.award_invoice_loyalty(p_invoice uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_config  record;
  v_lines   integer;
  v_points  integer;
begin
  select * into v_invoice from public.invoices where id = p_invoice;
  if v_invoice.loyalty_earned then return 0; end if;

  select * into v_config from app.loyalty_config();
  select count(*) into v_lines from public.invoice_items
   where invoice_id = p_invoice and qualifies_for_loyalty;

  v_points := v_lines * v_config.points_per_service;

  -- The invoice is marked as having earned even when nothing qualified, so it
  -- is never considered again.
  update public.invoices
     set loyalty_earned = true, loyalty_points_earned = v_points where id = p_invoice;

  if v_points = 0 then return 0; end if;

  perform app.post_loyalty(v_invoice.vehicle_id, 'earned', v_points,
    'invoice', p_invoice, 'Invoice ' || v_invoice.invoice_number || ' paid in full');

  return v_points;
end;
$$;

-- Taking points back when a payment is reversed or an invoice cancelled. They
-- can only be taken while the vehicle still has them; the shortfall is
-- recorded by the balance simply not going negative.
create or replace function app.take_back_invoice_loyalty(p_invoice uuid, p_reason text)
returns integer
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_taken   integer;
begin
  select * into v_invoice from public.invoices where id = p_invoice;
  if not v_invoice.loyalty_earned or v_invoice.loyalty_points_earned = 0 then
    update public.invoices set loyalty_earned = false, loyalty_points_earned = 0
     where id = p_invoice;
    return 0;
  end if;

  v_taken := app.post_loyalty(v_invoice.vehicle_id, 'reversal',
    -v_invoice.loyalty_points_earned, 'invoice', p_invoice, p_reason);

  -- Paying the invoice again earns the points again.
  update public.invoices set loyalty_earned = false, loyalty_points_earned = 0
   where id = p_invoice;

  return -v_taken;
end;
$$;

-- ---------------------------------------------------------------------------
-- Redemption
-- ---------------------------------------------------------------------------
-- The app shows the exact amount off and sends the amount it showed. If the
-- server would apply anything else, it refuses with `preview_stale` rather
-- than silently charging a different figure.

create or replace function app.apply_loyalty_reward(
  p_invoice  uuid,
  p_expected bigint
)
returns bigint
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_reward  public.loyalty_rewards%rowtype;
  v_config  record;
  v_amount  bigint;
begin
  perform app.require_permission('loyalty.redeem');

  select * into v_invoice from public.invoices where id = p_invoice for update;
  if v_invoice.id is null then
    raise exception 'That invoice could not be found.'
      using errcode = 'no_data_found', detail = 'invoice';
  end if;
  if v_invoice.status = 'cancelled' then
    raise exception 'This invoice was cancelled.'
      using errcode = 'invalid_parameter_value', detail = 'cancelled';
  end if;
  if v_invoice.paid_ugx > 0 then
    raise exception 'A reward cannot be applied once a payment has been recorded.'
      using errcode = 'invalid_parameter_value', detail = 'payments_exist';
  end if;
  if exists (select 1 from public.discounts where invoice_id = p_invoice and status = 'active') then
    raise exception 'This invoice already has a discount.'
      using errcode = 'invalid_parameter_value', detail = 'discount_exists';
  end if;

  -- The reward is read and updated inside this transaction, so two invoices
  -- redeeming at the same moment cannot both succeed.
  select * into v_reward from public.loyalty_rewards
   where vehicle_id = v_invoice.vehicle_id and status = 'available'
   for update;
  if v_reward.id is null then
    raise exception 'This vehicle has no reward available.'
      using errcode = 'invalid_parameter_value', detail = 'no_reward';
  end if;

  select * into v_config from app.loyalty_config();
  v_amount := app.percent_of(v_invoice.subtotal_ugx, v_reward.discount_percent);

  if v_amount <= 0 then
    raise exception 'That reward rounds to nothing on this invoice.'
      using errcode = 'invalid_parameter_value', detail = 'discount_value';
  end if;
  if p_expected is not null and p_expected <> v_amount then
    raise exception 'The reward is worth % on this invoice, not %.', v_amount, p_expected
      using errcode = 'invalid_parameter_value', detail = 'preview_stale',
            hint = v_amount::text;
  end if;

  update public.loyalty_rewards
     set status = 'redeemed', invoice_id = p_invoice,
         redeemed_at = now(), redeemed_by = auth.uid()
   where id = v_reward.id;

  perform app.post_loyalty(v_invoice.vehicle_id, 'redeemed', -v_reward.points_cost,
    'invoice', p_invoice, 'Reward redeemed on ' || v_invoice.invoice_number);

  update public.loyalty_accounts
     set rewards_redeemed = rewards_redeemed + 1 where vehicle_id = v_invoice.vehicle_id;

  insert into public.discounts
    (invoice_id, source, discount_type, discount_value, discount_amount_ugx,
     reason_code, description, approved_by, created_by)
  values
    (p_invoice, 'loyalty_reward', 'percentage', v_reward.discount_percent, v_amount,
     'loyalty_reward', 'Loyalty reward', auth.uid(), auth.uid());

  update public.invoices set discount_ugx = v_amount, updated_by = auth.uid()
   where id = p_invoice;

  insert into public.loyalty_events (vehicle_id, type, number_plate, balance)
  select v_invoice.vehicle_id, 'reward_redeemed', v_invoice.number_plate, points_balance
    from public.loyalty_accounts where vehicle_id = v_invoice.vehicle_id;

  perform app.audit('discount.loyalty_reward_applied', 'billing', v_invoice.invoice_number,
    null, null, 'loyalty_reward', null,
    jsonb_build_object('discountUgx', v_amount, 'pointsUsed', v_reward.points_cost));

  return v_amount;
end;
$$;

-- Cancelling an invoice returns a redeemed reward and its points.
create or replace function app.return_loyalty_reward(p_invoice uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_reward  public.loyalty_rewards%rowtype;
  v_invoice public.invoices%rowtype;
begin
  select * into v_reward from public.loyalty_rewards
   where invoice_id = p_invoice and status = 'redeemed' for update;
  if v_reward.id is null then return; end if;

  select * into v_invoice from public.invoices where id = p_invoice;

  update public.loyalty_rewards set status = 'reversed' where id = v_reward.id;

  -- The points come back, and a fresh reward unlocks if the balance allows.
  perform app.post_loyalty(v_invoice.vehicle_id, 'reversal', v_reward.points_cost,
    'invoice', p_invoice, 'Reward returned: ' || p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Corrections
-- ---------------------------------------------------------------------------

create or replace function app.adjust_loyalty_points(
  p_vehicle uuid,
  p_points  integer,
  p_reason  text
)
returns integer
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_reason text := app.require_reason(p_reason);
begin
  perform app.require_permission('loyalty.adjust');

  if p_points = 0 or abs(p_points) > 10000 then
    raise exception 'Adjustments are up to 10,000 points, up or down.'
      using errcode = 'invalid_parameter_value', detail = 'points';
  end if;
  if not exists (select 1 from public.vehicles where id = p_vehicle) then
    raise exception 'That vehicle could not be found.'
      using errcode = 'no_data_found', detail = 'vehicle';
  end if;

  perform app.audit('loyalty.adjusted', 'loyalty', p_vehicle::text, null, null, v_reason,
    null, jsonb_build_object('points', p_points));

  return app.post_loyalty(p_vehicle, 'adjustment', p_points, 'manual', null, v_reason);
end;
$$;

-- Reversing one ledger entry, once. The unique index on reversed_by_id's
-- source entry is enforced by the guard trigger, so two concurrent reversals
-- of one entry cannot both succeed.
create or replace function app.reverse_loyalty_transaction(p_transaction uuid, p_reason text)
returns integer
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_entry  public.loyalty_transactions%rowtype;
  v_reason text := app.require_reason(p_reason);
  v_new    uuid;
  v_applied integer;
begin
  perform app.require_permission('loyalty.adjust');

  select * into v_entry from public.loyalty_transactions
   where id = p_transaction for update;
  if v_entry.id is null then
    raise exception 'That loyalty entry could not be found.'
      using errcode = 'no_data_found', detail = 'transaction';
  end if;
  if v_entry.type = 'reversal' then
    raise exception 'A reversal cannot itself be reversed.'
      using errcode = 'invalid_parameter_value', detail = 'not_reversible';
  end if;
  if v_entry.type = 'redeemed' then
    raise exception 'Cancel the reward''s invoice to undo a redemption.'
      using errcode = 'invalid_parameter_value', detail = 'not_reversible';
  end if;
  if v_entry.reversed_by_id is not null then
    raise exception 'This loyalty entry has already been reversed.'
      using errcode = 'invalid_parameter_value', detail = 'already_reversed';
  end if;

  v_applied := app.post_loyalty(v_entry.vehicle_id, 'reversal', -v_entry.points,
    'transaction', p_transaction, v_reason);

  select id into v_new from public.loyalty_transactions
   where vehicle_id = v_entry.vehicle_id and reference_id = p_transaction
     and type = 'reversal' order by created_at desc limit 1;

  update public.loyalty_transactions set reversed_by_id = v_new where id = p_transaction;

  perform app.audit('loyalty.reversed', 'loyalty', p_transaction::text, null, null, v_reason,
    jsonb_build_object('points', v_entry.points), jsonb_build_object('points', v_applied));

  return v_applied;
end;
$$;

grant execute on function
  app.apply_loyalty_reward(uuid, bigint),
  app.adjust_loyalty_points(uuid, integer, text),
  app.reverse_loyalty_transaction(uuid, text),
  app.loyalty_config()
to authenticated;

revoke all on function
  app.post_loyalty(uuid, text, integer, text, uuid, text),
  app.award_invoice_loyalty(uuid),
  app.take_back_invoice_loyalty(uuid, text),
  app.return_loyalty_reward(uuid, text),
  app.refresh_loyalty_reward(uuid)
from anon, authenticated;
