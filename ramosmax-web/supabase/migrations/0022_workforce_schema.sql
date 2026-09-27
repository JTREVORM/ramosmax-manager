-- ===========================================================================
-- RamosMAX Web — Phase F — 0022: workforce schema
-- ===========================================================================
-- Attendance, daily allowances, salaries, payroll, deductions and loss
-- incidents. Ports the data model of `functions/src/attendance.js`,
-- `allowances.js`, `payroll.js` and `losses.js`.
--
-- The rules that shape this schema:
--
--   * ONE attendance record per person per EAT business day — a UNIQUE
--     constraint, not a check the application performs.
--   * The policy in force is COPIED onto each attendance record, so changing
--     the reporting time later never rewrites history.
--   * Salary is effective-dated history, never one mutable field. A payroll
--     copies the version it used onto every item.
--   * An incident never deducts anything by itself: a recovery exists only
--     after a decision and a schedule, and moves only when a payroll is paid.
--   * Nothing is deleted; corrections are recorded, not applied silently.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- attendance
-- ---------------------------------------------------------------------------

create table if not exists public.attendance (
  id                uuid primary key default gen_random_uuid(),
  attendance_number text not null unique,

  staff_uid    uuid not null references public.users (id),
  staff_id     text,
  staff_name   text not null,
  staff_role   text,

  -- The EAT business day this record belongs to.
  business_day date not null,
  working_day  boolean not null,

  clock_in_at  timestamptz,
  clock_out_at timestamptz,

  -- The POLICY SNAPSHOT: what was in force when the record was made.
  reporting_time        time not null,
  grace_period_minutes  integer not null,
  late_threshold_minutes integer not null,
  expected_reporting_at timestamptz not null,

  minutes_late  integer not null default 0,
  late          boolean not null default false,
  severely_late boolean not null default false,

  arrival_status      text not null,
  status              text not null default 'pending_verification',
  verification_status text not null default 'pending',

  source       text not null default 'manual',
  recorded_via text not null,
  device_id    text,
  external_ref text,

  notes        text,

  verified_by   uuid references public.users (id),
  verified_by_name text,
  verified_at   timestamptz,
  verification_notes text,
  rejection_reason   text,

  allowance_id    uuid,
  correction_count integer not null default 0,

  recorded_by      uuid references public.users (id),
  recorded_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id),

  -- One record per person per day. A duplicate is impossible, not merely
  -- refused by the function that would have created it.
  constraint attendance_one_per_day unique (staff_uid, business_day),

  constraint attendance_arrival check (arrival_status in ('on_time', 'late', 'absent', 'excused')),
  constraint attendance_status  check (status in
    ('pending_verification', 'present', 'late', 'absent', 'excused', 'rejected')),
  constraint attendance_verification check (verification_status in ('pending', 'approved', 'rejected')),
  constraint attendance_source  check (source in ('manual', 'biometric', 'imported')),
  constraint attendance_via     check (recorded_via in ('self', 'manager', 'device')),
  constraint attendance_minutes check (minutes_late >= 0),
  constraint attendance_times   check (clock_out_at is null or clock_in_at is null or clock_out_at > clock_in_at),
  -- An absence has no times.
  constraint attendance_absence_has_no_times check (
    arrival_status in ('on_time', 'late') or (clock_in_at is null and clock_out_at is null))
);

create index if not exists attendance_day_idx   on public.attendance (business_day desc);
create index if not exists attendance_staff_idx on public.attendance (staff_uid, business_day desc);
create index if not exists attendance_queue_idx on public.attendance (verification_status, business_day desc);

comment on constraint attendance_one_per_day on public.attendance is
  'Ports the Firestore document id `{staffUid}_{yyyy-mm-dd}`: two phones cannot both create today''s record.';

-- ---------------------------------------------------------------------------
-- attendance_corrections — the record of what was changed and why
-- ---------------------------------------------------------------------------

create table if not exists public.attendance_corrections (
  id             uuid primary key default gen_random_uuid(),
  attendance_id  uuid not null references public.attendance (id),
  attendance_number text not null,
  staff_uid      uuid not null references public.users (id),
  staff_name     text,
  business_day   date not null,

  previous_value jsonb not null,
  new_value      jsonb not null,
  changed_fields text[] not null,
  reason         text not null,
  cancelled_allowance_id uuid,

  corrected_by      uuid references public.users (id),
  corrected_by_name text,
  created_at timestamptz not null default now(),

  constraint correction_changed check (array_length(changed_fields, 1) >= 1)
);

create index if not exists corrections_attendance_idx
  on public.attendance_corrections (attendance_id, created_at desc);

-- ---------------------------------------------------------------------------
-- salary profiles and their history
-- ---------------------------------------------------------------------------
-- `salary_history` is append-only: a change is a NEW version, never an edit.
-- `salary_profiles` is the latest version, for display only.

create table if not exists public.salary_history (
  id            uuid primary key default gen_random_uuid(),
  staff_uid     uuid not null references public.users (id),
  staff_id      text,
  staff_name    text not null,
  staff_role    text,
  version       integer not null,

  basic_salary_ugx      bigint not null,
  payment_frequency     text not null default 'monthly',
  allowance_eligible    boolean not null,
  allowance_amount_ugx  bigint,
  active                boolean not null default true,
  effective_from        date not null,

  notes          text,
  reason         text,
  previous_value jsonb,
  previous_id    uuid references public.salary_history (id),

  created_by      uuid references public.users (id),
  created_by_name text,
  created_at timestamptz not null default now(),

  constraint salary_version_once unique (staff_uid, version),
  constraint salary_basic check (basic_salary_ugx >= 0 and basic_salary_ugx <= 100000000),
  constraint salary_allowance check (allowance_amount_ugx is null
    or (allowance_amount_ugx >= 0 and allowance_amount_ugx <= 1000000)),
  constraint salary_frequency check (payment_frequency in ('monthly', 'weekly'))
);

create index if not exists salary_history_staff_idx
  on public.salary_history (staff_uid, effective_from desc, version desc);

create table if not exists public.salary_profiles (
  staff_uid    uuid primary key references public.users (id),
  staff_id     text,
  staff_name   text not null,
  staff_role   text,
  basic_salary_ugx     bigint not null,
  payment_frequency    text not null,
  allowance_eligible   boolean not null,
  allowance_amount_ugx bigint,
  active               boolean not null,
  effective_from       date not null,
  current_history_id   uuid references public.salary_history (id),
  version              integer not null,
  notes        text,
  updated_by      uuid references public.users (id),
  updated_by_name text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- worker_allowances
-- ---------------------------------------------------------------------------

create table if not exists public.worker_allowances (
  id               uuid primary key default gen_random_uuid(),
  allowance_number text not null unique,

  staff_uid   uuid not null references public.users (id),
  staff_id    text,
  staff_name  text not null,
  staff_role  text,

  attendance_id     uuid not null references public.attendance (id),
  attendance_number text not null,
  business_day      date not null,

  late          boolean not null default false,
  severely_late boolean not null default false,
  minutes_late  integer not null default 0,
  salary_history_id uuid references public.salary_history (id),

  calculated_amount_ugx  bigint not null,
  suggested_decision     text not null,
  suggested_deduction_ugx bigint not null default 0,

  decision        text,
  deduction_ugx   bigint not null default 0,
  deduction_reason text,
  approved_amount_ugx bigint,

  proposed_decision      text,
  proposed_deduction_ugx bigint,
  proposed_by      uuid references public.users (id),
  proposed_by_name text,
  proposed_at      timestamptz,
  proposal_reason  text,

  status        text not null default 'calculated',
  auto_approved boolean not null default false,

  approved_by      uuid references public.users (id),
  approved_by_name text,
  approved_at      timestamptz,
  rejected_by      uuid references public.users (id),
  rejected_at      timestamptz,
  rejection_reason text,

  paid_via   text,
  paid_by    uuid references public.users (id),
  paid_by_name text,
  paid_at    timestamptz,
  paid_from_account_id   uuid references public.financial_accounts (id),
  paid_from_account_name text,
  payment_reference      text,
  financial_transaction_id     uuid references public.financial_transactions (id),
  financial_transaction_number text,
  payment_reversed_at    timestamptz,
  payment_reversal_reason text,

  payroll_id     uuid,
  payroll_number text,

  cancelled_by uuid references public.users (id),
  cancelled_at timestamptz,
  cancel_reason text,

  created_by      uuid references public.users (id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id),

  -- At most one LIVE allowance per attendance record.
  constraint allowance_amounts check (
    calculated_amount_ugx >= 0 and deduction_ugx >= 0
    and deduction_ugx <= calculated_amount_ugx
    and (approved_amount_ugx is null
         or (approved_amount_ugx >= 0 and approved_amount_ugx <= calculated_amount_ugx))),
  constraint allowance_status check (status in
    ('calculated', 'pending_approval', 'approved', 'rejected', 'paid', 'cancelled')),
  constraint allowance_decision check (decision is null or decision in ('full', 'deduct', 'reject')),
  constraint allowance_paid_via check (paid_via is null or paid_via in ('direct', 'payroll')),
  -- Paid means there is a payment behind it: a ledger entry, or a payroll.
  constraint allowance_paid_has_source check (
    (status = 'paid') = (financial_transaction_id is not null or payroll_id is not null))
);

create unique index if not exists allowance_one_live_per_attendance
  on public.worker_allowances (attendance_id) where status <> 'cancelled';

create index if not exists allowances_status_idx on public.worker_allowances (status, business_day desc);
create index if not exists allowances_staff_idx  on public.worker_allowances (staff_uid, business_day desc);

alter table public.attendance
  drop constraint if exists attendance_allowance_fk;
alter table public.attendance
  add constraint attendance_allowance_fk
  foreign key (allowance_id) references public.worker_allowances (id);

-- ---------------------------------------------------------------------------
-- payroll
-- ---------------------------------------------------------------------------

create table if not exists public.payroll (
  id             uuid primary key default gen_random_uuid(),
  payroll_number text not null unique,

  frequency     text not null,
  period_key    text not null,
  period_label  text not null,
  period_start  date not null,
  period_end    date not null,     -- exclusive
  period_last_day date not null,

  status  text not null default 'draft',
  version integer not null default 0,
  employee_count integer not null default 0,

  total_basic_ugx             bigint not null default 0,
  total_allowances_ugx        bigint not null default 0,
  total_other_earnings_ugx    bigint not null default 0,
  total_gross_ugx             bigint not null default 0,
  total_salary_deductions_ugx bigint not null default 0,
  total_loss_recoveries_ugx   bigint not null default 0,
  total_other_deductions_ugx  bigint not null default 0,
  total_deductions_ugx        bigint not null default 0,
  total_net_ugx               bigint not null default 0,

  notes text,

  created_by      uuid references public.users (id),
  created_by_name text,
  prepared_by     uuid references public.users (id),
  prepared_by_name text,
  prepared_at     timestamptz,
  submitted_by    uuid references public.users (id),
  submitted_at    timestamptz,
  reviewed_by     uuid references public.users (id),
  reviewed_by_name text,
  reviewed_at     timestamptz,
  review_notes    text,
  returned_reason text,
  approved_by     uuid references public.users (id),
  approved_by_name text,
  approved_at     timestamptz,
  paid_by         uuid references public.users (id),
  paid_by_name    text,
  paid_at         timestamptz,
  payment_date    date,
  payment_reference text,
  paid_from_account_id   uuid references public.financial_accounts (id),
  paid_from_account_name text,
  financial_transaction_id     uuid references public.financial_transactions (id),
  financial_transaction_number text,
  payment_reversed_at    timestamptz,
  payment_reversal_reason text,
  payment_reversal_transaction_id uuid references public.financial_transactions (id),
  locked_by  uuid references public.users (id),
  locked_at  timestamptz,
  cancelled_by uuid references public.users (id),
  cancelled_at timestamptz,
  cancel_reason text,
  correction_count integer not null default 0,
  last_correction_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id),

  constraint payroll_frequency check (frequency in ('monthly', 'weekly')),
  constraint payroll_status check (status in
    ('draft', 'prepared', 'pending_review', 'approved', 'paid', 'locked', 'cancelled')),
  constraint payroll_totals check (
    total_gross_ugx >= 0 and total_deductions_ugx >= 0 and total_net_ugx >= 0
    and total_net_ugx = total_gross_ugx - total_deductions_ugx)
);

-- ONE payroll per frequency and period, unless it was cancelled.
create unique index if not exists payroll_one_per_period
  on public.payroll (frequency, period_key) where status <> 'cancelled';

create table if not exists public.payroll_items (
  id          uuid primary key default gen_random_uuid(),
  item_number text not null,

  payroll_id      uuid not null references public.payroll (id),
  payroll_number  text not null,
  payroll_version integer not null,
  frequency   text not null,
  period_key  text not null,
  period_label text not null,
  period_start date not null,
  period_end   date not null,

  staff_uid  uuid not null references public.users (id),
  staff_id   text,
  staff_name text not null,
  staff_role text,

  -- The salary version this pay was computed from, copied so a later change
  -- can never rewrite it.
  salary_history_id uuid references public.salary_history (id),
  salary_version    integer,
  salary_active     boolean,

  basic_salary_ugx      bigint not null default 0,
  allowances_ugx        bigint not null default 0,
  allowance_days        integer not null default 0,
  other_earnings_ugx    bigint not null default 0,
  gross_ugx             bigint not null default 0,
  salary_deductions_ugx bigint not null default 0,
  loss_recoveries_ugx   bigint not null default 0,
  other_deductions_ugx  bigint not null default 0,
  total_deductions_ugx  bigint not null default 0,
  deduction_capped      boolean not null default false,
  net_ugx               bigint not null default 0,

  deduction_lines jsonb not null default '[]'::jsonb,
  allowance_ids   uuid[] not null default '{}',
  other_earnings  jsonb not null default '[]'::jsonb,

  status  text not null default 'prepared',
  current boolean not null default true,
  -- An employee sees their payslip only once the payroll has been paid.
  visible_to_staff boolean not null default false,
  payment_status text not null default 'unpaid',
  paid_at    timestamptz,
  payment_reversed_at timestamptz,
  financial_transaction_id uuid references public.financial_transactions (id),
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.users (id),

  constraint item_one_per_version unique (payroll_id, payroll_version, staff_uid),
  -- Net pay is never negative, and always what the parts say it is.
  constraint item_net check (net_ugx >= 0 and net_ugx = gross_ugx - total_deductions_ugx),
  constraint item_gross check (gross_ugx = basic_salary_ugx + allowances_ugx + other_earnings_ugx),
  constraint item_deductions check (
    total_deductions_ugx = salary_deductions_ugx + loss_recoveries_ugx + other_deductions_ugx
    and total_deductions_ugx >= 0),
  constraint item_payment_status check (payment_status in ('unpaid', 'paid'))
);

create index if not exists payroll_items_payroll_idx
  on public.payroll_items (payroll_id) where current;
create index if not exists payroll_items_staff_idx
  on public.payroll_items (staff_uid, created_at desc);

alter table public.worker_allowances
  drop constraint if exists allowance_payroll_fk;
alter table public.worker_allowances
  add constraint allowance_payroll_fk foreign key (payroll_id) references public.payroll (id);

-- Other authorised earnings, kept on the payroll itself so a recalculation
-- picks them up again.
create table if not exists public.payroll_earnings (
  id          uuid primary key default gen_random_uuid(),
  payroll_id  uuid not null references public.payroll (id),
  staff_uid   uuid not null references public.users (id),
  description text not null,
  amount_ugx  bigint not null,
  reason      text not null,
  added_by    uuid references public.users (id),
  added_at    timestamptz not null default now(),
  removed_at  timestamptz,
  removed_by  uuid references public.users (id),
  remove_reason text,

  constraint earning_amount check (amount_ugx > 0 and amount_ugx <= 100000000)
);

create index if not exists payroll_earnings_idx
  on public.payroll_earnings (payroll_id) where removed_at is null;

-- ---------------------------------------------------------------------------
-- loss incidents and salary deductions
-- ---------------------------------------------------------------------------

create table if not exists public.loss_incidents (
  id          uuid primary key default gen_random_uuid(),
  loss_number text not null unique,

  staff_uid   uuid references public.users (id),
  staff_id    text,
  staff_name  text,
  staff_role  text,

  incident_type text not null,
  incident_date date not null,
  amount_ugx    bigint not null,
  description   text not null,
  notes         text,

  status text not null default 'reported',
  -- The staff member sees an incident about them once it has been DECIDED,
  -- never while it is being investigated.
  visible_to_staff boolean not null default false,

  reported_by      uuid references public.users (id),
  reported_by_name text,
  reviewed_by      uuid references public.users (id),
  reviewed_by_name text,
  reviewed_at      timestamptz,
  review_notes     text,
  approved_by      uuid references public.users (id),
  approved_by_name text,
  approved_at      timestamptz,
  approved_recovery_ugx bigint not null default 0,
  recovery_reason  text,
  rejection_reason text,

  recovered_ugx   bigint not null default 0,
  outstanding_ugx bigint not null default 0,
  deduction_id    uuid,
  deduction_number text,

  cancelled_by uuid references public.users (id),
  cancelled_at timestamptz,
  cancel_reason text,
  cancelled_outstanding_ugx bigint not null default 0,

  source_type   text,
  source_id     uuid,
  source_number text,
  request_id    text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id),

  constraint loss_type check (incident_type in
    ('damaged_equipment', 'damaged_customer_property', 'stock_loss', 'worker_related_loss', 'other')),
  constraint loss_status check (status in
    ('reported', 'under_review', 'approved', 'rejected', 'recovery_scheduled',
     'partially_recovered', 'recovered', 'cancelled')),
  constraint loss_amount check (amount_ugx > 0 and amount_ugx <= 100000000),
  -- Never recover more than was approved, and never approve more than the loss.
  constraint loss_recovery_within_loss check (approved_recovery_ugx between 0 and amount_ugx),
  constraint loss_recovered_within_approved check (
    recovered_ugx >= 0 and recovered_ugx <= approved_recovery_ugx),
  constraint loss_outstanding check (
    outstanding_ugx >= 0 and outstanding_ugx <= approved_recovery_ugx)
);

create index if not exists losses_status_idx on public.loss_incidents (status, incident_date desc);
create index if not exists losses_staff_idx  on public.loss_incidents (staff_uid, incident_date desc);

create table if not exists public.salary_deductions (
  id               uuid primary key default gen_random_uuid(),
  deduction_number text not null unique,

  staff_uid  uuid not null references public.users (id),
  staff_id   text,
  staff_name text not null,

  type   text not null,
  reason text not null,
  reference text,
  source_kind   text not null default 'manual',
  source_id     uuid,
  source_number text,

  loss_incident_id uuid references public.loss_incidents (id),
  loss_number      text,

  total_amount_ugx bigint not null,
  instalment_ugx   bigint not null,
  recovered_ugx    bigint not null default 0,
  remaining_ugx    bigint not null,
  starts_from      date not null,

  status text not null default 'pending_approval',

  approved_by      uuid references public.users (id),
  approved_by_name text,
  approved_at      timestamptz,
  rejection_reason text,
  schedule_reason  text,
  cancelled_by uuid references public.users (id),
  cancelled_at timestamptz,
  cancel_reason text,
  request_id  text,

  created_by      uuid references public.users (id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id),

  constraint deduction_type check (type in ('loss_recovery', 'authorized_deduction', 'other')),
  constraint deduction_status check (status in
    ('pending_approval', 'active', 'completed', 'rejected', 'cancelled')),
  constraint deduction_amounts check (
    total_amount_ugx > 0 and instalment_ugx > 0 and instalment_ugx <= total_amount_ugx
    and recovered_ugx >= 0 and remaining_ugx >= 0
    and recovered_ugx + remaining_ugx = total_amount_ugx)
);

create index if not exists deductions_staff_idx on public.salary_deductions (staff_uid, status);

alter table public.loss_incidents
  drop constraint if exists loss_deduction_fk;
alter table public.loss_incidents
  add constraint loss_deduction_fk foreign key (deduction_id) references public.salary_deductions (id);

-- Every time a deduction is taken, with the payroll that took it. Append-only:
-- a reversal marks the row, it does not remove it.
create table if not exists public.deduction_applications (
  id           uuid primary key default gen_random_uuid(),
  deduction_id uuid not null references public.salary_deductions (id),
  payroll_id   uuid not null references public.payroll (id),
  payroll_number text not null,
  period_key   text not null,
  amount_ugx   bigint not null,
  applied_at   timestamptz not null default now(),
  reversed     boolean not null default false,
  reversed_at  timestamptz,
  reversal_reason text,

  constraint application_amount check (amount_ugx > 0)
);

-- A deduction is taken at most once per payroll, unless that taking was reversed.
create unique index if not exists deduction_once_per_payroll
  on public.deduction_applications (deduction_id, payroll_id) where not reversed;

-- ---------------------------------------------------------------------------
-- workforce_events — the hand-off point for notifications
-- ---------------------------------------------------------------------------
-- Payloads carry IDENTIFIERS AND TYPES ONLY: never a salary, a deduction or a
-- loss amount, because a notification can be read on a lock screen.

create table if not exists public.workforce_events (
  id             uuid primary key default gen_random_uuid(),
  type           text not null,
  reference_type text not null,
  reference_id   uuid not null,
  audience       text not null,
  recipient_uid  uuid references public.users (id),
  payload        jsonb not null default '{}'::jsonb,
  delivered      boolean not null default false,
  created_at     timestamptz not null default now(),

  constraint workforce_event_type check (type in (
    'attendance_review', 'attendance_rejected', 'attendance_corrected',
    'allowance_awaiting_approval', 'allowance_approved',
    'payroll_review', 'payroll_approved', 'payroll_paid', 'deduction_applied',
    'deduction_awaiting_approval', 'loss_incident_created', 'loss_recovery_scheduled'))
);

create index if not exists workforce_events_undelivered_idx
  on public.workforce_events (created_at) where not delivered;

-- ---------------------------------------------------------------------------
-- Reference number sequences
-- ---------------------------------------------------------------------------

create sequence if not exists app.attendance_number_seq as bigint start 1;
create sequence if not exists app.allowance_number_seq  as bigint start 1;
create sequence if not exists app.payroll_number_seq    as bigint start 1;
create sequence if not exists app.deduction_number_seq  as bigint start 1;
create sequence if not exists app.loss_number_seq       as bigint start 1;

-- ---------------------------------------------------------------------------
-- Immutability and history
-- ---------------------------------------------------------------------------

-- A salary version is a fact about a date: it is never edited.
drop trigger if exists salary_history_append_only on public.salary_history;
create trigger salary_history_append_only
  before update or delete on public.salary_history
  for each row execute function app.forbid_update_delete();

-- A correction is the record of what changed; it cannot itself be changed.
drop trigger if exists corrections_append_only on public.attendance_corrections;
create trigger corrections_append_only
  before update or delete on public.attendance_corrections
  for each row execute function app.forbid_update_delete();

drop trigger if exists workforce_events_delivery_only on public.workforce_events;
create trigger workforce_events_delivery_only
  before update on public.workforce_events
  for each row execute function app.guard_event_delivery();

-- An attendance record keeps its number, its day, its person and the policy
-- that was in force. Everything else moves through the documented workflow.
create or replace function app.guard_attendance_history()
returns trigger
language plpgsql
as $$
begin
  if new.attendance_number is distinct from old.attendance_number
  or new.staff_uid    is distinct from old.staff_uid
  or new.business_day is distinct from old.business_day
  or new.reporting_time is distinct from old.reporting_time
  or new.grace_period_minutes is distinct from old.grace_period_minutes
  or new.late_threshold_minutes is distinct from old.late_threshold_minutes
  or new.created_at is distinct from old.created_at then
    raise exception 'An attendance record keeps its identity and the policy it was judged by'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_history on public.attendance;
create trigger attendance_history before update on public.attendance
  for each row execute function app.guard_attendance_history();

-- A paid payroll is settled. Locking freezes it completely.
create or replace function app.guard_payroll_history()
returns trigger
language plpgsql
as $$
begin
  if new.payroll_number is distinct from old.payroll_number
  or new.frequency  is distinct from old.frequency
  or new.period_key is distinct from old.period_key
  or new.created_at is distinct from old.created_at then
    raise exception 'A payroll keeps its number and its period'
      using errcode = 'restrict_violation';
  end if;
  -- Once locked, the money is history: nothing about it may be rewritten.
  if old.status = 'locked' and (
       new.status is distinct from old.status
    or new.total_gross_ugx is distinct from old.total_gross_ugx
    or new.total_deductions_ugx is distinct from old.total_deductions_ugx
    or new.total_net_ugx is distinct from old.total_net_ugx
    or new.financial_transaction_id is distinct from old.financial_transaction_id
    or new.version is distinct from old.version) then
    raise exception 'A locked payroll cannot be changed: adjust the next payroll instead'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists payroll_history on public.payroll;
create trigger payroll_history before update on public.payroll
  for each row execute function app.guard_payroll_history();

-- A payslip's figures are fixed when it is written. A recalculation writes a
-- NEW version and supersedes this one; it never edits it.
create or replace function app.guard_payroll_item_history()
returns trigger
language plpgsql
as $$
begin
  if new.payroll_id is distinct from old.payroll_id
  or new.staff_uid  is distinct from old.staff_uid
  or new.payroll_version is distinct from old.payroll_version
  or new.basic_salary_ugx is distinct from old.basic_salary_ugx
  or new.gross_ugx is distinct from old.gross_ugx
  or new.total_deductions_ugx is distinct from old.total_deductions_ugx
  or new.net_ugx is distinct from old.net_ugx
  or new.deduction_lines is distinct from old.deduction_lines
  or new.salary_history_id is distinct from old.salary_history_id
  or new.created_at is distinct from old.created_at then
    raise exception 'A payslip is recalculated as a new version, never edited'
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'locked' and new.status is distinct from old.status then
    raise exception 'A locked payslip cannot be changed' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists payroll_item_history on public.payroll_items;
create trigger payroll_item_history before update on public.payroll_items
  for each row execute function app.guard_payroll_item_history();

-- An application of a deduction is a fact: only its reversal may be marked.
create or replace function app.guard_deduction_application()
returns trigger
language plpgsql
as $$
begin
  if new.deduction_id is distinct from old.deduction_id
  or new.payroll_id   is distinct from old.payroll_id
  or new.amount_ugx   is distinct from old.amount_ugx
  or new.applied_at   is distinct from old.applied_at then
    raise exception 'A deduction application is a record of what happened'
      using errcode = 'restrict_violation';
  end if;
  if old.reversed and not new.reversed then
    raise exception 'A reversed deduction application cannot be reinstated'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists deduction_application_history on public.deduction_applications;
create trigger deduction_application_history before update on public.deduction_applications
  for each row execute function app.guard_deduction_application();

-- Nothing in the workforce record is ever deleted, and updated_at is kept.
do $$
declare t text;
begin
  foreach t in array array['attendance', 'attendance_corrections', 'salary_history',
                           'salary_profiles', 'worker_allowances', 'payroll', 'payroll_items',
                           'payroll_earnings', 'loss_incidents', 'salary_deductions',
                           'deduction_applications', 'workforce_events'] loop
    execute format('drop trigger if exists %I_no_delete on public.%I', t, t);
    execute format('create trigger %I_no_delete before delete on public.%I
                    for each row execute function app.forbid_delete()', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;

  foreach t in array array['attendance', 'salary_profiles', 'worker_allowances', 'payroll',
                           'payroll_items', 'loss_incidents', 'salary_deductions'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function app.touch_updated_at()', t, t);
  end loop;
end;
$$;
