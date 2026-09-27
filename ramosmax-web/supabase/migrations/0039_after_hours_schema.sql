-- ===========================================================================
-- RamosMAX Web — Final phase — 0039: after-hours work and cash handovers
-- ===========================================================================
-- Ports the Phase 8 model.
--
-- An AUTHORISATION (RMX-AH-000001) lets a holder of `after_hours.approve`
-- put an eligible worker on duty for a window. It hands out nothing of its
-- own: it writes ordinary `temporary_grants`, which `app.effective_permissions`
-- already honours by comparing the window to the server clock. THE
-- AUTHORISATION THEREFORE STOPS WORKING AT ITS EXPIRY WITH NO JOB RUNNING.
-- The sweep in 0043 only tidies the status and sends reminders; nothing
-- anywhere is allowed to depend on it having run.
--
-- A SESSION (RMX-AHS-000001) is the worker's shift. It is not a second
-- billing system: the existing intake, invoice, job and payment functions
-- simply TAG what they create with the open session and count it. A payment
-- is still one payment, one receipt and ONE ledger entry.
--
-- CUSTODY (RMX-AHC-000001) is an operational sub-ledger of the cash in the
-- worker's hands — never a financial account and never revenue:
--
--   expected cash = opening float
--                 + cash taken in the session
--                 − cash reversed WHILE THE SESSION WAS STILL OPEN
--
-- A HANDOVER (RMX-HO-000001) freezes that figure, recomputed from the
-- payments themselves at close. Nothing in the application ever sends an
-- expected amount and no function accepts one. Receiving it moves custody,
-- not money: the customer payments were posted to Cash at Hand when they were
-- collected, so a handover posts NOTHING to the ledger.
--
-- A DISCREPANCY (RMX-AHD-000001) is opened for any difference. Resolving it
-- may, only when asked explicitly, report a loss incident about the worker
-- (which still goes through the Phase F review and approval — NOTHING is ever
-- deducted from anyone's salary automatically) and/or post the one adjustment
-- that makes Cash at Hand agree with the cash that was counted.
--
-- Nothing here is ever deleted.
-- ===========================================================================

create sequence if not exists app.after_hours_number_seq    as bigint start 1;
create sequence if not exists app.session_number_seq        as bigint start 1;
create sequence if not exists app.custody_number_seq        as bigint start 1;
create sequence if not exists app.handover_number_seq       as bigint start 1;
create sequence if not exists app.discrepancy_number_seq    as bigint start 1;

-- ---------------------------------------------------------------------------
-- Authorisations
-- ---------------------------------------------------------------------------

create table if not exists public.after_hours_access (
  id                    uuid primary key default gen_random_uuid(),
  authorization_number  text not null unique,
  staff_uid             uuid not null references public.users(id),
  staff_name            text not null,
  staff_role            text not null,
  starts_at             timestamptz not null,
  expires_at            timestamptz not null,
  reason                text not null,
  -- What the authorisation hands out. Every entry must be on the grantable
  -- list; the list itself lives in app.after_hours_grantable().
  permissions           text[] not null default '{}',
  -- The temporary grants actually written (the target may already hold some
  -- of the permissions permanently).
  granted               text[] not null default '{}',
  opening_float_ugx     bigint not null default 0,
  -- The float belongs to the FIRST session opened under this authorisation.
  float_session_id      uuid,
  status                text not null default 'active',
  granted_by            uuid references public.users(id),
  granted_by_name       text,
  revoked_at            timestamptz,
  revoked_by            uuid references public.users(id),
  revoked_by_name       text,
  revoke_reason         text,
  expired_at            timestamptz,
  expiry_notified       boolean not null default false,
  request_id            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint after_hours_status check (status in ('active', 'revoked', 'expired')),
  constraint after_hours_window check (expires_at > starts_at),
  constraint after_hours_float  check (opening_float_ugx between 0 and 10000000)
);

create index if not exists after_hours_access_staff_idx
  on public.after_hours_access (staff_uid, expires_at desc);
create index if not exists after_hours_access_active_idx
  on public.after_hours_access (expires_at) where status = 'active';

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

create table if not exists public.after_hours_sessions (
  id                     uuid primary key default gen_random_uuid(),
  session_number         text not null unique,
  staff_uid              uuid not null references public.users(id),
  staff_name             text not null,
  authorization_id       uuid not null references public.after_hours_access(id),
  authorization_number   text not null,
  authorization_expires_at timestamptz not null,
  supervisor_uid         uuid references public.users(id),
  supervisor_name        text,
  status                 text not null default 'open',
  opened_at              timestamptz not null default now(),
  closed_at              timestamptz,
  closed_by              uuid references public.users(id),
  closed_by_name         text,
  close_notes            text,
  cancelled_at           timestamptz,
  cancelled_by           uuid references public.users(id),
  cancel_reason          text,
  opening_float_ugx      bigint not null default 0,
  cash_collected_ugx     bigint not null default 0,
  non_cash_collected_ugx bigint not null default 0,
  cash_reversed_ugx      bigint not null default 0,
  non_cash_reversed_ugx  bigint not null default 0,
  post_close_reversals_ugx bigint not null default 0,
  payment_count          integer not null default 0,
  reversal_count         integer not null default 0,
  -- Maintained with every payment, then RECALCULATED from the payments at
  -- close and frozen on the handover.
  expected_cash_ugx      bigint not null default 0,
  intakes_created        integer not null default 0,
  invoices_created       integer not null default 0,
  jobs_completed         integer not null default 0,
  handover_id            uuid,
  handover_number        text,
  handover_status        text,
  actual_received_ugx    bigint,
  difference_ugx         bigint,
  notes                  text,
  last_activity_at       timestamptz,
  request_id             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint session_status check (status in
    ('open', 'closed', 'handover_pending', 'reconciled', 'cancelled'))
);

/*
 * ONE open session per person. A partial unique index is the whole rule: two
 * concurrent opens cannot both win, whatever the application believes.
 */
create unique index if not exists after_hours_one_open_session
  on public.after_hours_sessions (staff_uid) where status = 'open';

create index if not exists after_hours_sessions_staff_idx
  on public.after_hours_sessions (staff_uid, opened_at desc);
create index if not exists after_hours_sessions_status_idx
  on public.after_hours_sessions (status, opened_at desc);

-- ---------------------------------------------------------------------------
-- Custody sub-ledger
-- ---------------------------------------------------------------------------
-- NOT a financial account. One row per opening float, after-hours payment and
-- reversal, so the expected cash can always be explained line by line.

create table if not exists public.after_hours_cash (
  id                  uuid primary key default gen_random_uuid(),
  entry_number        text not null unique,
  kind                text not null,
  session_id          uuid not null references public.after_hours_sessions(id),
  session_number      text not null,
  staff_uid           uuid not null references public.users(id),
  staff_name          text not null,
  payment_id          uuid references public.payments(id),
  receipt_number      text,
  invoice_number      text,
  number_plate        text,
  method              text,
  amount_ugx          bigint not null,
  -- How this entry changes the cash the worker is holding. Mobile money never
  -- enters their custody, so its delta is zero.
  cash_delta_ugx      bigint not null default 0,
  affects_expected    boolean not null default false,
  after_session_closed boolean not null default false,
  reason              text,
  created_by          uuid references public.users(id),
  created_at          timestamptz not null default now(),

  constraint custody_kind check (kind in ('opening_float', 'payment', 'payment_reversal'))
);

create index if not exists after_hours_cash_session_idx
  on public.after_hours_cash (session_id, created_at);

-- ---------------------------------------------------------------------------
-- Handovers
-- ---------------------------------------------------------------------------

create table if not exists public.cash_handovers (
  id                    uuid primary key default gen_random_uuid(),
  handover_number       text not null unique,
  session_id            uuid not null unique references public.after_hours_sessions(id),
  session_number        text not null,
  authorization_id      uuid references public.after_hours_access(id),
  staff_uid             uuid not null references public.users(id),
  staff_name            text not null,
  opening_float_ugx     bigint not null default 0,
  cash_collected_ugx    bigint not null default 0,
  cash_reversed_ugx     bigint not null default 0,
  non_cash_collected_ugx bigint not null default 0,
  payment_count         integer not null default 0,
  -- Worked out by the server from the payments themselves and FROZEN. No
  -- function accepts an expected amount.
  expected_cash_ugx     bigint not null,
  -- What the worker says they are handing over. Informational.
  declared_amount_ugx   bigint,
  -- What the receiver counted. This is the figure that decides.
  actual_amount_ugx     bigint,
  difference_ugx        bigint,
  status                text not null default 'pending',
  -- Where the cash physically goes. Recorded for reference only: the money is
  -- already in this account, so a handover posts nothing.
  destination_account   text not null default 'cash_at_hand',
  submitted_by          uuid references public.users(id),
  submitted_by_name     text,
  submitted_at          timestamptz,
  submit_notes          text,
  received_by           uuid references public.users(id),
  received_by_name      text,
  received_at           timestamptz,
  receive_notes         text,
  explanation           text,
  discrepancy_id        uuid,
  discrepancy_number    text,
  reconciled_at         timestamptz,
  reconciled_by         uuid references public.users(id),
  reminder_sent_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint handover_status check (status in
    ('pending', 'submitted', 'received', 'discrepancy', 'reconciled')),
  constraint handover_expected check (expected_cash_ugx >= 0),
  constraint handover_declared check (declared_amount_ugx is null
    or declared_amount_ugx between 0 and 2000000000),
  constraint handover_actual check (actual_amount_ugx is null
    or actual_amount_ugx between 0 and 2000000000)
);

create index if not exists cash_handovers_status_idx
  on public.cash_handovers (status, created_at desc);
create index if not exists cash_handovers_staff_idx
  on public.cash_handovers (staff_uid, created_at desc);

-- ---------------------------------------------------------------------------
-- Discrepancies
-- ---------------------------------------------------------------------------

create table if not exists public.cash_discrepancies (
  id                    uuid primary key default gen_random_uuid(),
  discrepancy_number    text not null unique,
  handover_id           uuid not null unique references public.cash_handovers(id),
  handover_number       text not null,
  session_id            uuid not null references public.after_hours_sessions(id),
  session_number        text not null,
  staff_uid             uuid not null references public.users(id),
  staff_name            text not null,
  expected_cash_ugx     bigint not null,
  declared_amount_ugx   bigint,
  actual_amount_ugx     bigint not null,
  difference_ugx        bigint not null,
  kind                  text not null,
  reason                text not null,
  reported_by           uuid references public.users(id),
  reported_by_name      text,
  reported_at           timestamptz not null default now(),
  status                text not null default 'open',
  reviewed_by           uuid references public.users(id),
  reviewed_by_name      text,
  reviewed_at           timestamptz,
  review_notes          text,
  outcome               text,
  resolution            text,
  resolved_by           uuid references public.users(id),
  resolved_by_name      text,
  resolved_at           timestamptz,
  loss_incident_id      uuid references public.loss_incidents(id),
  loss_number           text,
  adjustment_transaction_id uuid references public.financial_transactions(id),
  adjustment_transaction_number text,
  request_id            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint discrepancy_kind check (kind in ('shortage', 'excess')),
  constraint discrepancy_status check (status in
    ('open', 'under_review', 'resolved', 'waived')),
  constraint discrepancy_outcome check (outcome is null or outcome in ('resolved', 'waived')),
  -- The difference is always actual − expected, and never zero: a balanced
  -- handover has no discrepancy at all.
  constraint discrepancy_difference check (difference_ugx = actual_amount_ugx - expected_cash_ugx
                                           and difference_ugx <> 0)
);

create index if not exists cash_discrepancies_status_idx
  on public.cash_discrepancies (status, reported_at desc);

-- ---------------------------------------------------------------------------
-- Events (what the notification system in the next workstream will deliver)
-- ---------------------------------------------------------------------------

create table if not exists public.after_hours_events (
  id             uuid primary key default gen_random_uuid(),
  type           text not null,
  reference_type text not null,
  reference_id   uuid not null,
  audience       text not null,
  recipient_uid  uuid references public.users(id),
  payload        jsonb not null default '{}'::jsonb,
  delivered      boolean not null default false,
  created_at     timestamptz not null default now(),

  constraint after_hours_event_type check (type in (
    'after_hours_authorized', 'after_hours_revoked', 'after_hours_expiring',
    'cash_handover_pending', 'cash_handover_submitted', 'cash_handover_reminder',
    'cash_discrepancy_detected', 'cash_discrepancy_resolved'))
);

create index if not exists after_hours_events_audience_idx
  on public.after_hours_events (audience, created_at desc);

-- ---------------------------------------------------------------------------
-- Guards: what may never be rewritten
-- ---------------------------------------------------------------------------

/*
 * A handover's expected amount is the server's answer, frozen when the
 * session closed. The declared and counted amounts are frozen once recorded.
 * Nothing may change them afterwards — not a correction, not a second count.
 */
create or replace function app.guard_handover()
returns trigger
language plpgsql
as $$
begin
  if new.expected_cash_ugx is distinct from old.expected_cash_ugx then
    raise exception 'The expected cash on a handover cannot be changed.'
      using errcode = 'restrict_violation', detail = 'expected_frozen';
  end if;
  if old.declared_amount_ugx is not null
     and new.declared_amount_ugx is distinct from old.declared_amount_ugx then
    raise exception 'What was declared on a handover cannot be changed.'
      using errcode = 'restrict_violation', detail = 'declared_frozen';
  end if;
  if old.actual_amount_ugx is not null
     and new.actual_amount_ugx is distinct from old.actual_amount_ugx then
    raise exception 'A counted handover cannot be counted again.'
      using errcode = 'restrict_violation', detail = 'actual_frozen';
  end if;
  if old.session_id is distinct from new.session_id
     or old.staff_uid is distinct from new.staff_uid then
    raise exception 'A handover belongs to the session it was created for.'
      using errcode = 'restrict_violation', detail = 'handover_identity';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guard_handover on public.cash_handovers;
create trigger guard_handover before update on public.cash_handovers
  for each row execute function app.guard_handover();

/* The figures a discrepancy was opened about are the record of what happened. */
create or replace function app.guard_discrepancy()
returns trigger
language plpgsql
as $$
begin
  if new.expected_cash_ugx is distinct from old.expected_cash_ugx
     or new.actual_amount_ugx is distinct from old.actual_amount_ugx
     or new.difference_ugx is distinct from old.difference_ugx
     or new.kind is distinct from old.kind
     or new.handover_id is distinct from old.handover_id
     or new.staff_uid is distinct from old.staff_uid then
    raise exception 'The amounts a discrepancy was opened about cannot be changed.'
      using errcode = 'restrict_violation', detail = 'discrepancy_frozen';
  end if;
  if old.status in ('resolved', 'waived') and new.status <> old.status then
    raise exception 'This discrepancy has already been closed.'
      using errcode = 'restrict_violation', detail = 'already_resolved';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guard_discrepancy on public.cash_discrepancies;
create trigger guard_discrepancy before update on public.cash_discrepancies
  for each row execute function app.guard_discrepancy();

/* A custody entry is a record of a moment. It is never edited. */
create or replace function app.guard_custody()
returns trigger
language plpgsql
as $$
begin
  raise exception 'A custody entry cannot be changed.'
    using errcode = 'restrict_violation', detail = 'custody_immutable';
end;
$$;

drop trigger if exists guard_custody on public.after_hours_cash;
create trigger guard_custody before update on public.after_hours_cash
  for each row execute function app.guard_custody();

/* A session's opening float and its identity are fixed when it opens. */
create or replace function app.guard_session()
returns trigger
language plpgsql
as $$
begin
  if new.opening_float_ugx is distinct from old.opening_float_ugx
     or new.staff_uid is distinct from old.staff_uid
     or new.authorization_id is distinct from old.authorization_id
     or new.session_number is distinct from old.session_number then
    raise exception 'A session belongs to the person and authorisation it was opened under.'
      using errcode = 'restrict_violation', detail = 'session_identity';
  end if;
  if old.status in ('reconciled', 'cancelled') and new.status is distinct from old.status then
    raise exception 'This session has already been closed off.'
      using errcode = 'restrict_violation', detail = 'session_final';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guard_session on public.after_hours_sessions;
create trigger guard_session before update on public.after_hours_sessions
  for each row execute function app.guard_session();

-- Nothing in this module is ever deleted.
create or replace function app.refuse_delete_after_hours()
returns trigger
language plpgsql
as $$
begin
  raise exception 'After-hours and cash handover records are never deleted.'
    using errcode = 'restrict_violation', detail = 'no_delete';
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['after_hours_access', 'after_hours_sessions', 'after_hours_cash',
                           'cash_handovers', 'cash_discrepancies'] loop
    execute format('drop trigger if exists refuse_delete on public.%I', t);
    execute format('create trigger refuse_delete before delete on public.%I
                    for each row execute function app.refuse_delete_after_hours()', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Default deny
-- ---------------------------------------------------------------------------
-- Every table is closed until 0043 opens exactly what each role may read.
-- No client ever writes here: every mutation goes through a SECURITY DEFINER
-- function.

do $$
declare t text;
begin
  foreach t in array array['after_hours_access', 'after_hours_sessions', 'after_hours_cash',
                           'cash_handovers', 'cash_discrepancies', 'after_hours_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end;
$$;
