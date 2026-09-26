-- ===========================================================================
-- RamosMAX Web — Final phase — 0047: notifications
-- ===========================================================================
-- Ports Phase 9 `notify.js`.
--
-- WHAT A NOTIFICATION MAY SAY. A notice carries a type and a record id, and
-- a title and body that are GENERIC — never a name, a role, a permission or
-- an amount. They appear on locked screens and in browser notification
-- shades, where anybody standing nearby can read them.
--
-- ONE NOTICE PER EVENT. The in-app record's dedupe key is deterministic:
-- recipient, type, record and the ten-minute window. A retried trigger, a
-- repeated sweep or a double-delivered event therefore writes one row, not
-- two.
--
-- WHAT MAY BE MUTED. People may turn PUSH off for ordinary categories. The
-- in-app record is always written, and the critical ones — their own access,
-- their own pay, an after-hours authorisation, cash they are accountable for
-- — always push, whatever the preferences say.
--
-- Business functions never call this directly. They write an event row in
-- their own transaction, and delivery happens afterwards, so a failure to
-- notify can never roll back a payment.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The catalogue: the only text a notification may carry
-- ---------------------------------------------------------------------------

create table if not exists app.notification_types (
  type     text primary key,
  category text not null,
  critical boolean not null default false,
  title    text not null,
  body     text not null
);

insert into app.notification_types (type, category, critical, title, body) values
  -- access: never mutable, it is about the person's own account
  ('account_activated', 'access', true, 'Account activated',
   'Your RamosMAX account is active. You can sign in.'),
  ('account_deactivated', 'access', true, 'RamosMAX access changed',
   'Your RamosMAX access has been turned off. Contact an administrator.'),
  ('role_changed', 'access', true, 'Your role has changed',
   'Open RamosMAX to see your updated access.'),
  ('temporary_permission_granted', 'access', true, 'Temporary access granted',
   'You have been given temporary access in RamosMAX.'),
  ('temporary_permission_expiring', 'access', true, 'Temporary access ending soon',
   'Your temporary access in RamosMAX ends within 30 minutes.'),
  ('password_reset', 'access', true, 'Password reset',
   'Your RamosMAX password was reset by an administrator. If you did not expect this, tell a manager.'),
  -- jobs
  ('work_order_assigned', 'jobs', false, 'New job assigned',
   'A job has been assigned to you. Open RamosMAX to accept it.'),
  ('work_order_reassigned', 'jobs', false, 'Job moved',
   'A job assigned to you has been moved to someone else.'),
  ('work_order_cancelled', 'jobs', false, 'Job cancelled',
   'A job assigned to you has been cancelled. Open RamosMAX for details.'),
  ('job_ready_to_invoice', 'jobs', false, 'Job ready to invoice',
   'All work on a job you started is complete. Open RamosMAX to invoice it.'),
  -- sales
  ('loyalty_reward_unlocked', 'sales', false, 'Loyalty reward unlocked',
   'A vehicle has unlocked a loyalty reward. Open RamosMAX for details.'),
  -- finance
  ('recurring_expense_due', 'finance', false, 'Bill due soon',
   'A recurring expense is due. Open RamosMAX to review it.'),
  ('low_stock', 'finance', false, 'Stock running low',
   'An inventory item is low or out of stock. Open RamosMAX for details.'),
  ('expense_awaiting_approval', 'finance', false, 'Expense to review',
   'An expense is waiting for review or approval. Open RamosMAX for details.'),
  ('expense_decided', 'finance', false, 'Expense updated',
   'An expense you recorded has been approved, rejected or paid. Open RamosMAX for details.'),
  ('reconciliation_difference', 'finance', false, 'Reconciliation difference',
   'An account reconciliation found a difference. Open RamosMAX to review it.'),
  -- workforce: generic on purpose — never a name, a salary or an amount
  ('attendance_review', 'workforce', false, 'Attendance to review',
   'A late arrival is waiting for verification. Open RamosMAX to review it.'),
  ('attendance_rejected', 'workforce', false, 'Attendance not approved',
   'One of your attendance records was not approved. Open RamosMAX for details.'),
  ('attendance_corrected', 'workforce', false, 'Attendance corrected',
   'One of your attendance records was corrected. Open RamosMAX for details.'),
  ('allowance_awaiting_approval', 'workforce', false, 'Allowances to approve',
   'Daily allowances are waiting for approval. Open RamosMAX to review them.'),
  ('allowance_approved', 'workforce', false, 'Allowance approved',
   'Your daily allowance has been approved. Open RamosMAX for details.'),
  ('payroll_review', 'workforce', false, 'Payroll needs attention',
   'A payroll is waiting for review or approval. Open RamosMAX for details.'),
  ('payroll_approved', 'workforce', false, 'Payroll approved',
   'A payroll has been approved and is ready to pay. Open RamosMAX for details.'),
  ('loss_incident_created', 'workforce', false, 'Loss incident reported',
   'A loss incident has been reported. Open RamosMAX to review it.'),
  ('deduction_awaiting_approval', 'workforce', false, 'Deduction to approve',
   'A salary deduction is waiting for approval. Open RamosMAX for details.'),
  -- pay: a person's own money, never mutable
  ('payroll_paid', 'pay', true, 'Pay processed',
   'Your pay for the period has been processed. Open RamosMAX to see your payslip.'),
  ('deduction_applied', 'pay', true, 'Deduction applied',
   'A deduction was applied to your pay. Open RamosMAX to see your payslip.'),
  ('loss_recovery_scheduled', 'pay', true, 'Recovery scheduled',
   'A recovery from your pay has been scheduled. Open RamosMAX for details.'),
  -- shareholding: never a shareholder name, a share count or an amount
  ('share_transaction_pending', 'shareholding', false, 'Share transaction to approve',
   'A share transaction is waiting for approval. Open RamosMAX to review it.'),
  ('share_transaction_completed', 'shareholding', false, 'Share transaction completed',
   'A share transaction you requested has been decided. Open RamosMAX for details.'),
  ('dividend_declared', 'shareholding', false, 'Dividend to approve',
   'A dividend has been declared and is waiting for approval. Open RamosMAX to review it.'),
  ('dividend_approved', 'shareholding', false, 'Dividend approved',
   'A dividend has been approved and is ready to pay. Open RamosMAX for details.'),
  ('dividend_paid', 'shareholding', false, 'Dividend paid',
   'A dividend payment to you has been recorded. Open RamosMAX to see your shareholding.'),
  -- after-hours: the four that are about cash somebody is accountable for
  -- always push
  ('after_hours_authorized', 'after_hours', true, 'After-hours work authorised',
   'You have been authorised for after-hours work. Open RamosMAX for the times.'),
  ('after_hours_revoked', 'after_hours', false, 'After-hours access ended',
   'Your after-hours authorisation has ended. Close your session and hand over cash.'),
  ('after_hours_expiring', 'after_hours', true, 'After-hours ending soon',
   'Your after-hours authorisation ends within 30 minutes. Close your session and hand over cash.'),
  ('cash_handover_pending', 'after_hours', false, 'Cash handover pending',
   'An after-hours session has closed and its cash is waiting to be handed over.'),
  ('cash_handover_submitted', 'after_hours', false, 'Cash handover submitted',
   'A cash handover is waiting to be counted and received. Open RamosMAX to receive it.'),
  ('cash_handover_reminder', 'after_hours', true, 'Cash handover overdue',
   'An after-hours cash handover is still waiting to be completed. Open RamosMAX for details.'),
  ('cash_discrepancy_detected', 'after_hours', true, 'Cash discrepancy',
   'A cash handover did not match the expected amount. Open RamosMAX to review it.'),
  ('cash_discrepancy_resolved', 'after_hours', false, 'Cash discrepancy resolved',
   'A cash handover discrepancy has been resolved. Open RamosMAX for details.')
on conflict (type) do update set
  category = excluded.category, critical = excluded.critical,
  title = excluded.title, body = excluded.body;

-- Reference data, but it lives in `app`, so it follows the same posture as
-- every other private table: RLS on and forced, no policy, no client grant.
-- The catalogue reaches a browser only through the functions below.
alter table app.notification_types enable row level security;
alter table app.notification_types force  row level security;
revoke all on app.notification_types from anon, authenticated;

comment on table app.notification_types is
  'Every notice a person can receive, with the ONLY text it may carry. Generic by design: these appear on locked screens.';

/* The categories a person may mute. Access and pay are never mutable. */
create or replace function app.mutable_categories()
returns text[]
language sql
immutable
as $$
  select array['jobs', 'sales', 'finance', 'workforce', 'shareholding', 'after_hours']::text[];
$$;

/* A repeat of the same notice to the same person inside this window is one notice. */
create or replace function app.dedupe_window()
returns interval
language sql
immutable
as $$ select interval '10 minutes' $$;

-- ---------------------------------------------------------------------------
-- The inbox
-- ---------------------------------------------------------------------------

create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references public.users(id) on delete cascade,
  type          text not null references app.notification_types(type),
  category      text not null,
  critical      boolean not null default false,
  record_type   text,
  record_id     uuid,
  title         text not null,
  body          text not null,
  read          boolean not null default false,
  read_at       timestamptz,
  push          jsonb not null default jsonb_build_object('status', 'pending'),
  -- recipient + type + record + the ten-minute window. A repeat inside the
  -- window collides here and is dropped rather than delivered twice.
  dedupe_key    text not null unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists notifications_inbox_idx
  on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (recipient_id) where not read;
create index if not exists notifications_push_idx
  on public.notifications (created_at) where push ->> 'status' = 'pending';

-- ---------------------------------------------------------------------------
-- Web Push subscriptions
-- ---------------------------------------------------------------------------
-- The browser's endpoint and its two keys. These are credentials for pushing
-- to somebody's device, so they are readable only by the service role — no
-- policy below grants a client SELECT on this table, not even its owner's.

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz,
  failures    integer not null default 0
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- Preferences live on the user, beside the rest of their access settings.
alter table public.users
  add column if not exists notification_preferences jsonb not null default '{}'::jsonb;

do $$
declare t text;
begin
  foreach t in array array['notifications', 'push_subscriptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end;
$$;

-- A person reads their OWN inbox. Nobody reads anybody else's, at any level.
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications
  for select to authenticated using (recipient_id = auth.uid());

grant select on public.notifications to authenticated;

-- ---------------------------------------------------------------------------
-- Writing a notice
-- ---------------------------------------------------------------------------

/*
 * One in-app notice. NOT client-callable: only the delivery job reaches it.
 *
 * Returns 'recorded', 'duplicate' (the same notice moments ago) or 'skipped'
 * (no such person, or their account is off — except the notice that tells
 * them their account was turned off).
 */
create or replace function app.notify(
  p_recipient uuid,
  p_type      text,
  p_record_type text default null,
  p_record_id uuid default null
)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_t    app.notification_types%rowtype;
  v_user public.users%rowtype;
  v_key  text;
begin
  select * into v_t from app.notification_types where type = p_type;
  if v_t.type is null then return 'skipped'; end if;
  select * into v_user from public.users where id = p_recipient;
  if v_user.id is null then return 'skipped'; end if;
  if not v_user.active and p_type <> 'account_deactivated' then return 'skipped'; end if;

  v_key := p_recipient::text || ':' || p_type || ':' || coalesce(p_record_id::text, 'none')
           || ':' || floor(extract(epoch from now())
                           / extract(epoch from app.dedupe_window()))::bigint::text;

  insert into public.notifications
    (recipient_id, type, category, critical, record_type, record_id, title, body, dedupe_key)
  values
    (p_recipient, v_t.type, v_t.category, v_t.critical, p_record_type, p_record_id,
     v_t.title, v_t.body, v_key)
  on conflict (dedupe_key) do nothing;

  if not found then return 'duplicate'; end if;
  return 'recorded';
end;
$$;

-- ---------------------------------------------------------------------------
-- Delivery: events become notices
-- ---------------------------------------------------------------------------

/*
 * Business functions write an EVENT in their own transaction and never call
 * the notifier, so a failure to notify cannot roll back a payment. This turns
 * the events into notices afterwards.
 *
 * An event addressed to a permission is expanded to everybody who holds it
 * right now — which is why an authorisation that has just expired stops
 * receiving the manager's notices without anybody maintaining a list.
 */
create or replace function app.deliver_events(p_limit integer default 500)
returns table (events_delivered integer, notices_written integer)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_event record;
  v_uid   uuid;
  v_delivered integer := 0;
  v_notices   integer := 0;
begin
  for v_event in
    select 'workforce' as source, e.id, e.type, e.reference_type, e.reference_id,
           e.audience, e.recipient_uid
      from public.workforce_events e where not e.delivered
    union all
    select 'ownership', e.id, e.type, e.reference_type, e.reference_id, e.audience, e.recipient_uid
      from public.ownership_events e where not e.delivered
    union all
    select 'after_hours', e.id, e.type, e.reference_type, e.reference_id, e.audience,
           e.recipient_uid
      from public.after_hours_events e where not e.delivered
    order by 1, 2
    limit p_limit
  loop
    if v_event.recipient_uid is not null then
      if app.notify(v_event.recipient_uid, v_event.type, v_event.reference_type,
                    v_event.reference_id) = 'recorded' then
        v_notices := v_notices + 1;
      end if;
    elsif v_event.audience is not null and v_event.audience <> 'recipient' then
      for v_uid in
        select u.id from public.users u
         where u.active and v_event.audience = any (app.effective_permissions(u.id))
      loop
        if app.notify(v_uid, v_event.type, v_event.reference_type,
                      v_event.reference_id) = 'recorded' then
          v_notices := v_notices + 1;
        end if;
      end loop;
    end if;

    if v_event.source = 'workforce' then
      update public.workforce_events e set delivered = true where e.id = v_event.id;
    elsif v_event.source = 'ownership' then
      update public.ownership_events e set delivered = true where e.id = v_event.id;
    else
      update public.after_hours_events e set delivered = true where e.id = v_event.id;
    end if;
    v_delivered := v_delivered + 1;
  end loop;

  return query select v_delivered, v_notices;
end;
$$;

-- ---------------------------------------------------------------------------
-- Push
-- ---------------------------------------------------------------------------

/* Whether this notice may be pushed to this person. Critical always may. */
create or replace function app.push_allowed(p_recipient uuid, p_type text)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select case
    when (select critical from app.notification_types where type = p_type) then true
    else coalesce(
      (select (u.notification_preferences ->> t.category) is distinct from 'false'
         from public.users u, app.notification_types t
        where u.id = p_recipient and t.type = p_type), true)
    end;
$$;

/*
 * The notices waiting to be pushed, with the subscriptions to push them to.
 * NOT client-callable: the rows carry the keys that address somebody's
 * device.
 */
create or replace function app.pending_push(p_limit integer default 100)
returns table (notification_id uuid, recipient_id uuid, type text, title text, body text,
               record_type text, record_id uuid,
               subscriptions jsonb)
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  with due as (
    select n.* from public.notifications n
     where n.push ->> 'status' = 'pending'
       and n.created_at > now() - interval '1 day'
     order by n.created_at
     limit p_limit
  )
  select d.id, d.recipient_id, d.type, d.title, d.body, d.record_type, d.record_id,
         coalesce((select jsonb_agg(jsonb_build_object('endpoint', s.endpoint,
                     'p256dh', s.p256dh, 'auth', s.auth))
                     from public.push_subscriptions s where s.user_id = d.recipient_id),
                  '[]'::jsonb)
    from due d
   where app.push_allowed(d.recipient_id, d.type);
$$;

/* Records what happened to a push. NOT client-callable. */
create or replace function app.record_push(p_notification uuid, p_result jsonb)
returns void
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  update public.notifications
     set push = coalesce(p_result, jsonb_build_object('status', 'failed')), updated_at = now()
   where id = p_notification;
$$;

/* Marks the muted ones so the job does not keep looking at them. */
create or replace function app.skip_muted_push(p_limit integer default 500)
returns integer
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  with muted as (
    select n.id from public.notifications n
     where n.push ->> 'status' = 'pending'
       and not app.push_allowed(n.recipient_id, n.type)
     limit p_limit
  ), done as (
    update public.notifications
       set push = jsonb_build_object('status', 'skipped', 'reason', 'muted'), updated_at = now()
     where id in (select id from muted) returning 1
  )
  select count(*)::integer from done;
$$;

/* A device that Web Push says is gone. NOT client-callable. */
create or replace function app.drop_push_subscription(p_endpoint text)
returns void
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  delete from public.push_subscriptions where endpoint = p_endpoint;
$$;

-- ---------------------------------------------------------------------------
-- What the signed-in person may do
-- ---------------------------------------------------------------------------

create or replace function app.my_notifications(p_limit integer default 50,
                                                p_unread_only boolean default false)
returns table (id uuid, type text, category text, critical boolean, record_type text,
               record_id uuid, title text, body text, read boolean, created_at timestamptz)
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select n.id, n.type, n.category, n.critical, n.record_type, n.record_id, n.title, n.body,
         n.read, n.created_at
    from public.notifications n
   where n.recipient_id = auth.uid()
     and (not p_unread_only or not n.read)
   order by n.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create or replace function app.unread_notification_count()
returns integer
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select count(*)::integer from public.notifications
   where recipient_id = auth.uid() and not read;
$$;

create or replace function app.mark_notification_read(p_notification uuid)
returns integer
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  with done as (
    update public.notifications
       set read = true, read_at = now(), updated_at = now()
     where recipient_id = auth.uid() and (p_notification is null or id = p_notification)
       and not read
     returning 1)
  select count(*)::integer from done;
$$;

create or replace function app.notification_preferences()
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select coalesce((select notification_preferences from public.users where id = auth.uid()),
                  '{}'::jsonb);
$$;

/*
 * Muting a category turns off PUSH for it. The in-app notice is still
 * written, and the categories that are about somebody's own access or their
 * own pay cannot be muted at all.
 */
create or replace function app.set_notification_preferences(p_changes jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_key  text;
  v_next jsonb := app.notification_preferences();
begin
  perform app.require_active();
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'Choose which notices to turn off.'
      using errcode = 'invalid_parameter_value', detail = 'preferences';
  end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if not (v_key = any (app.mutable_categories())) then
      raise exception 'Notices about your access and your pay cannot be turned off.'
        using errcode = 'invalid_parameter_value', detail = 'not_mutable';
    end if;
    if jsonb_typeof(p_changes -> v_key) <> 'boolean' then
      raise exception 'Choose on or off for each kind of notice.'
        using errcode = 'invalid_parameter_value', detail = 'preferences';
    end if;
    v_next := jsonb_set(v_next, array[v_key], p_changes -> v_key, true);
  end loop;

  update public.users set notification_preferences = v_next, updated_at = now()
   where id = auth.uid();
  return v_next;
end;
$$;

/* Registers this browser for push. The caller may only register their own. */
create or replace function app.register_push_subscription(
  p_endpoint text,
  p_p256dh   text,
  p_auth     text,
  p_user_agent text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare v_id uuid;
begin
  perform app.require_active();
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 2000
     or p_p256dh is null or p_auth is null then
    raise exception 'That push subscription is not valid.'
      using errcode = 'invalid_parameter_value', detail = 'subscription';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth,
          app.optional_text(p_user_agent, 'User agent', 200))
  on conflict (endpoint) do update
     set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, failures = 0
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function app.remove_push_subscription(p_endpoint text)
returns integer
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  with done as (
    delete from public.push_subscriptions
     where endpoint = p_endpoint and user_id = auth.uid() returning 1)
  select count(*)::integer from done;
$$;

/* The categories, and which of them may be muted, for the settings screen. */
create or replace function app.notification_categories()
returns table (category text, mutable boolean, types integer)
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select t.category, t.category = any (app.mutable_categories()), count(*)::integer
    from app.notification_types t group by t.category order by t.category;
$$;
