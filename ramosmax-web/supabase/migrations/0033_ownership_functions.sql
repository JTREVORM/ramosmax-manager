-- ===========================================================================
-- RamosMAX Web — Final phase — 0033: shareholders, classes, policies,
-- and the ownership derivation the whole module rests on
-- ===========================================================================
-- Ports `functions/src/shareholders.js`.
-- ===========================================================================

create or replace function app.max_shares()      returns bigint language sql immutable as $$ select 1000000000::bigint; $$;
create or replace function app.max_capital_ugx() returns bigint language sql immutable as $$ select 1000000000000::bigint; $$;
create or replace function app.max_share_value_ugx() returns bigint language sql immutable as $$ select 100000000::bigint; $$;

/* The share policy, defaults included. Shares are paid in full when issued
   and every ownership change needs a second person, unless the business says
   otherwise. */
create or replace function app.share_policy()
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select jsonb_build_object(
    'requireApproval',    app.policy_bool(v, 'requireApproval', true),
    'allowUnpaidShares',  app.policy_bool(v, 'allowUnpaidShares', false),
    'allowPartialPayment', app.policy_bool(v, 'allowPartialPayment', false))
  from (select value as v from public.settings where key = 'share_policy'
        union all select '{}'::jsonb where not exists
          (select 1 from public.settings where key = 'share_policy') limit 1) q;
$$;

create or replace function app.dividend_policy()
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select jsonb_build_object('requireAdminApproval', app.policy_bool(v, 'requireAdminApproval', true))
  from (select value as v from public.settings where key = 'dividend_policy'
        union all select '{}'::jsonb where not exists
          (select 1 from public.settings where key = 'dividend_policy') limit 1) q;
$$;

create or replace function app.update_shareholding_policy(
  p_policy text, p_changes jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_key     text;
  v_before  jsonb;
  v_next    jsonb;
  v_reason  text;
  v_changed text[];
  v_k       text;
begin
  perform app.require_permission('settings.manage');
  if p_policy not in ('share', 'dividend') then
    raise exception 'Choose the share or dividend policy.'
      using errcode = 'invalid_parameter_value', detail = 'policy';
  end if;
  v_reason := app.require_reason(p_reason);
  v_key := p_policy || '_policy';
  v_before := case when p_policy = 'share' then app.share_policy() else app.dividend_policy() end;

  for v_k in select jsonb_object_keys(coalesce(p_changes, '{}'::jsonb)) loop
    if not (v_before ? v_k) or jsonb_typeof(p_changes -> v_k) <> 'boolean' then
      raise exception 'One of the settings is not recognised.'
        using errcode = 'invalid_parameter_value', detail = 'policy';
    end if;
  end loop;

  v_next := v_before || coalesce(p_changes, '{}'::jsonb);
  select array_agg(k) into v_changed
    from jsonb_object_keys(v_before) k where v_before -> k is distinct from v_next -> k;
  if v_changed is null then
    raise exception 'Nothing has changed.' using errcode = 'raise_exception', detail = 'no_changes';
  end if;

  insert into public.settings (key, value, updated_by)
  values (v_key, v_next, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by,
                                  updated_at = now();

  perform app.audit(p_policy || '_policy.updated', 'shareholders', v_key, null, v_key, v_reason,
    v_before, v_next);
  return v_next;
end;
$$;

-- ---------------------------------------------------------------------------
-- The record-date lock
-- ---------------------------------------------------------------------------

/* The latest record date frozen by a calculated dividend, or null. */
create or replace function app.locked_record_date()
returns date
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select max(record_date) from public.dividends
   where record_locked and status <> 'cancelled';
$$;

create or replace function app.require_record_date_open(p_effective date)
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare v_lock date := app.locked_record_date();
begin
  if v_lock is not null and p_effective <= v_lock then
    raise exception 'Ownership up to % is fixed by a calculated dividend. Use a later effective date, or cancel that dividend first.',
      v_lock
      using errcode = 'raise_exception', detail = 'record_date_locked';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership, derived from the ledger
-- ---------------------------------------------------------------------------

/* Ownership % = shares ÷ total shares × 100, to four decimal places. */
create or replace function app.ownership_percent(p_shares bigint, p_total bigint)
returns numeric
language sql
immutable
as $$
  select case when coalesce(p_total, 0) = 0 then 0::numeric
              else round((p_shares::numeric * 1000000) / p_total) / 10000 end;
$$;

/*
 * Shares held at the END of an EAT day, summed from the immutable ledger.
 *
 * This is the only definition of ownership in the system. Today's holdings are
 * a special case of it, and a dividend's record-date snapshot is another.
 */
create or replace function app.holdings_as_of(p_day date, p_class text default null)
returns table (shareholder_id uuid, shares bigint)
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select (l ->> 'shareholderId')::uuid as shareholder_id,
         sum((l ->> 'deltaShares')::bigint)::bigint as shares
    from public.share_transactions t, jsonb_array_elements(t.lines) l
   where t.applied
     and t.effective_date <= p_day
     and (p_class is null or t.class_id = p_class)
   group by 1;
$$;

/* The same, split by class — what the holdings table is rebuilt from. */
create or replace function app.holdings_by_class(p_day date)
returns table (shareholder_id uuid, class_id text, shares bigint, committed_ugx bigint)
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select (l ->> 'shareholderId')::uuid, t.class_id,
         sum((l ->> 'deltaShares')::bigint)::bigint,
         sum(coalesce((l ->> 'committedDeltaUgx')::bigint, 0))::bigint
    from public.share_transactions t, jsonb_array_elements(t.lines) l
   where t.applied and t.effective_date <= p_day
   group by 1, 2;
$$;

/*
 * True when this shareholder's holding in this class never goes below zero at
 * the end of ANY day, with [p_extra] ({effectiveDate, delta}) added.
 *
 * This is what stops a backdated transfer from taking shares before they
 * existed — checking only today would let an impossible history through.
 */
create or replace function app.never_negative(
  p_shareholder uuid, p_class text, p_extra jsonb default '[]'::jsonb)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select not exists (
    select 1 from (
      select day, sum(delta) over (order by day) as running
        from (
          select t.effective_date as day, sum((l ->> 'deltaShares')::bigint) as delta
            from public.share_transactions t, jsonb_array_elements(t.lines) l
           where t.applied and t.class_id = p_class
             and (l ->> 'shareholderId')::uuid = p_shareholder
           group by t.effective_date
          union all
          select (e ->> 'effectiveDate')::date, (e ->> 'delta')::bigint
            from jsonb_array_elements(coalesce(p_extra, '[]'::jsonb)) e
        ) days
       group by day, delta
    ) q where running < 0);
$$;

/*
 * Rebuilds every derived ownership figure from the ledger and the posted
 * contributions: holdings, shareholder totals, ownership percentages and
 * class totals.
 *
 * Deriving rather than incrementing is deliberate. A running total can drift;
 * a figure recomputed from the entries cannot disagree with them.
 */
create or replace function app.rebuild_ownership()
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare v_total bigint;
begin
  -- Holdings: shares and commitment from the ledger, money from the
  -- contributions that are still posted.
  create temporary table if not exists rebuild_holdings (
    shareholder_id uuid, class_id text, shares bigint, committed_ugx bigint, paid_ugx bigint
  ) on commit drop;
  delete from rebuild_holdings;

  insert into rebuild_holdings (shareholder_id, class_id, shares, committed_ugx, paid_ugx)
  select coalesce(h.shareholder_id, c.shareholder_id), coalesce(h.class_id, c.class_id),
         coalesce(h.shares, 0), coalesce(h.committed_ugx, 0), coalesce(c.paid_ugx, 0)
    from (select * from app.holdings_by_class(date '9999-12-31')) h
    full join (
      select shareholder_id, class_id, sum(amount_ugx)::bigint as paid_ugx
        from public.share_contributions where status = 'posted'
       group by 1, 2) c
      on c.shareholder_id = h.shareholder_id and c.class_id = h.class_id;

  insert into public.shareholdings as sh
    (shareholder_id, class_id, shareholder_number, shareholder_name, class_code,
     shares, committed_ugx, paid_ugx, outstanding_ugx)
  select r.shareholder_id, r.class_id, s.shareholder_number, s.full_name, k.code,
         r.shares, r.committed_ugx, r.paid_ugx, r.committed_ugx - r.paid_ugx
    from rebuild_holdings r
    join public.shareholders s on s.id = r.shareholder_id
    join public.share_classes k on k.id = r.class_id
  on conflict (shareholder_id, class_id) do update set
    shareholder_number = excluded.shareholder_number,
    shareholder_name   = excluded.shareholder_name,
    class_code         = excluded.class_code,
    shares             = excluded.shares,
    committed_ugx      = excluded.committed_ugx,
    paid_ugx           = excluded.paid_ugx,
    outstanding_ugx    = excluded.outstanding_ugx,
    updated_at         = now();

  -- Any holding that no longer appears goes to zero; nothing is deleted.
  update public.shareholdings h
     set shares = 0, committed_ugx = 0, paid_ugx = 0, outstanding_ugx = 0, updated_at = now()
   where not exists (select 1 from rebuild_holdings r
                      where r.shareholder_id = h.shareholder_id and r.class_id = h.class_id)
     and (h.shares <> 0 or h.committed_ugx <> 0 or h.paid_ugx <> 0);

  select coalesce(sum(shares), 0) into v_total from public.shareholdings;

  update public.shareholders s
     set total_shares      = coalesce(t.shares, 0),
         committed_ugx     = coalesce(t.committed_ugx, 0),
         paid_ugx          = coalesce(t.paid_ugx, 0),
         outstanding_ugx   = coalesce(t.committed_ugx, 0) - coalesce(t.paid_ugx, 0),
         ownership_percent = app.ownership_percent(coalesce(t.shares, 0), v_total),
         updated_at        = now()
    from (select shareholder_id, sum(shares)::bigint as shares,
                 sum(committed_ugx)::bigint as committed_ugx, sum(paid_ugx)::bigint as paid_ugx
            from public.shareholdings group by 1) t
   where t.shareholder_id = s.id
     and (s.total_shares, s.committed_ugx, s.paid_ugx, s.ownership_percent)
         is distinct from (coalesce(t.shares, 0), coalesce(t.committed_ugx, 0),
                           coalesce(t.paid_ugx, 0),
                           app.ownership_percent(coalesce(t.shares, 0), v_total));

  update public.share_classes k
     set issued_shares   = coalesce(t.shares, 0),
         committed_ugx   = coalesce(t.committed_ugx, 0),
         paid_ugx        = coalesce(t.paid_ugx, 0),
         outstanding_ugx = coalesce(t.committed_ugx, 0) - coalesce(t.paid_ugx, 0),
         updated_at      = now()
    from (select class_id, sum(shares)::bigint as shares,
                 sum(committed_ugx)::bigint as committed_ugx, sum(paid_ugx)::bigint as paid_ugx
            from public.shareholdings group by 1) t
   where t.class_id = k.id
     and (k.issued_shares, k.committed_ugx, k.paid_ugx)
         is distinct from (coalesce(t.shares, 0), coalesce(t.committed_ugx, 0), coalesce(t.paid_ugx, 0));
end;
$$;

-- ---------------------------------------------------------------------------
-- Shareholder profiles
-- ---------------------------------------------------------------------------

create or replace function app.optional_email(p_input text)
returns text
language plpgsql
immutable
as $$
declare v text := nullif(btrim(coalesce(p_input, '')), '');
begin
  if v is null then return null; end if;
  if char_length(v) > 120 or v !~ '^[^@\s]+@[^@\s.]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address.'
      using errcode = 'invalid_parameter_value', detail = 'email';
  end if;
  return lower(v);
end;
$$;

create or replace function app.read_shareholder(p_id uuid)
returns public.shareholders
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare v public.shareholders%rowtype;
begin
  select * into v from public.shareholders where id = p_id;
  if v.id is null then
    raise exception 'That shareholder could not be found.'
      using errcode = 'no_data_found', detail = 'shareholder_not_found';
  end if;
  return v;
end;
$$;

create or replace function app.read_share_class(p_id text)
returns public.share_classes
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare v public.share_classes%rowtype;
begin
  select * into v from public.share_classes where id = lower(coalesce(p_id, ''));
  if v.id is null then
    raise exception 'That share class could not be found.'
      using errcode = 'no_data_found', detail = 'share_class_not_found';
  end if;
  return v;
end;
$$;

/* Identification: both or neither, and in the reference's shape. */
create or replace function app.identification(p_type text, p_number text)
returns text[]
language plpgsql
immutable
as $$
declare
  v_type text := nullif(btrim(coalesce(p_type, '')), '');
  v_num  text := nullif(btrim(coalesce(p_number, '')), '');
begin
  if (v_type is null) <> (v_num is null) then
    raise exception 'Enter both the identification type and number, or neither.'
      using errcode = 'invalid_parameter_value', detail = 'identification';
  end if;
  if v_type is null then return array[null, null]::text[]; end if;
  if v_type not in ('national_id', 'passport', 'company_registration', 'other') then
    raise exception 'Choose a valid identification type.'
      using errcode = 'invalid_parameter_value', detail = 'identification';
  end if;
  if v_num !~ '^[A-Za-z0-9][A-Za-z0-9 /-]{2,39}$' then
    raise exception 'Use letters, digits, spaces, dashes or slashes for the identification number.'
      using errcode = 'invalid_parameter_value', detail = 'identification';
  end if;
  return array[v_type, upper(regexp_replace(v_num, '\s+', '', 'g'))];
end;
$$;

create or replace function app.create_shareholder(
  p_full_name  text,
  p_request_id text,
  p_phone      text default null,
  p_email      text default null,
  p_address    text default null,
  p_id_type    text default null,
  p_id_number  text default null,
  p_join_date  date default null,
  p_notes      text default null
)
returns table (shareholder_id uuid, shareholder_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_name    text;
  v_phone   text;
  v_ident   text[];
  v_number  text;
  v_id      uuid;
  v_join    date;
begin
  perform app.require_permission('shareholders.create');
  perform app.require_request_id(p_request_id);
  v_name  := app.require_name(p_full_name);
  v_phone := case when nullif(btrim(coalesce(p_phone, '')), '') is null then null
                  else app.normalize_phone(p_phone) end;
  if p_phone is not null and nullif(btrim(p_phone), '') is not null and v_phone is null then
    raise exception 'Enter a valid phone number, e.g. 0772 123 456.'
      using errcode = 'invalid_parameter_value', detail = 'phone';
  end if;
  v_ident := app.identification(p_id_type, p_id_number);
  v_join  := app.require_business_date(p_join_date, 'join date');

  v_earlier := app.claim_request(p_request_id, 'shareholder_create',
    jsonb_build_object('name', v_name, 'phone', v_phone));
  if v_earlier is not null then
    return query select (v_earlier ->> 'shareholder_id')::uuid, v_earlier ->> 'shareholder_number';
    return;
  end if;

  if v_phone is not null and exists (select 1 from public.shareholders where phone_number = v_phone) then
    raise exception 'A shareholder with this phone number already exists.'
      using errcode = 'unique_violation', detail = 'duplicate_phone';
  end if;
  if v_ident[2] is not null and exists (
       select 1 from public.shareholders where id_type = v_ident[1] and id_number = v_ident[2]) then
    raise exception 'A shareholder with this identification number already exists.'
      using errcode = 'unique_violation', detail = 'duplicate_identification';
  end if;

  v_number := app.next_reference('shareholder_number_seq', 'RMX-SHR-');
  insert into public.shareholders
    (shareholder_number, full_name, phone_number, email, address, id_type, id_number,
     join_date, notes, search_text, request_id, created_by, created_by_name, updated_by)
  values
    (v_number, v_name, v_phone, app.optional_email(p_email),
     app.optional_text(p_address, 'Address', 200), v_ident[1], v_ident[2], v_join,
     app.optional_text(p_notes, 'Notes', 500), lower(v_name || ' ' || v_number), p_request_id,
     auth.uid(), (select full_name from public.users where id = auth.uid()), auth.uid())
  returning id into v_id;

  perform app.audit('shareholder.created', 'shareholders', v_id::text, null, v_number, null, null,
    jsonb_build_object('shareholderNumber', v_number, 'fullName', v_name,
                       'phoneNumber', app.mask_phone(v_phone),
                       'idNumber', case when v_ident[2] is null then null
                                        else '••' || right(v_ident[2], 3) end));

  perform app.complete_request(p_request_id,
    jsonb_build_object('shareholder_id', v_id, 'shareholder_number', v_number));
  return query select v_id, v_number;
end;
$$;

create or replace function app.update_shareholder(
  p_shareholder uuid,
  p_full_name   text default null,
  p_phone       text default null,
  p_email       text default null,
  p_address     text default null,
  p_id_type     text default null,
  p_id_number   text default null,
  p_notes       text default null,
  p_reason      text default null
)
returns text[]
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before  public.shareholders%rowtype;
  v_name    text;
  v_phone   text;
  v_ident   text[];
  v_changed text[] := '{}';
begin
  perform app.require_permission('shareholders.update');
  v_before := app.read_shareholder(p_shareholder);
  v_name  := coalesce(app.require_name(coalesce(p_full_name, v_before.full_name)), v_before.full_name);
  v_phone := case when p_phone is null then v_before.phone_number
                  when nullif(btrim(p_phone), '') is null then null
                  else app.normalize_phone(p_phone) end;
  if p_phone is not null and nullif(btrim(p_phone), '') is not null and v_phone is null then
    raise exception 'Enter a valid phone number, e.g. 0772 123 456.'
      using errcode = 'invalid_parameter_value', detail = 'phone';
  end if;
  v_ident := case when p_id_type is null and p_id_number is null
                  then array[v_before.id_type, v_before.id_number]
                  else app.identification(p_id_type, p_id_number) end;

  if v_name is distinct from v_before.full_name then v_changed := v_changed || 'fullName'::text; end if;
  if v_phone is distinct from v_before.phone_number then v_changed := v_changed || 'phoneNumber'::text; end if;
  if p_email is not null and app.optional_email(p_email) is distinct from v_before.email
    then v_changed := v_changed || 'email'::text; end if;
  if p_address is not null and app.optional_text(p_address, 'Address', 200) is distinct from v_before.address
    then v_changed := v_changed || 'address'::text; end if;
  if v_ident[1] is distinct from v_before.id_type or v_ident[2] is distinct from v_before.id_number
    then v_changed := v_changed || 'identification'::text; end if;
  if p_notes is not null and app.optional_text(p_notes, 'Notes', 500) is distinct from v_before.notes
    then v_changed := v_changed || 'notes'::text; end if;

  if array_length(v_changed, 1) is null then
    raise exception 'Nothing has changed.' using errcode = 'raise_exception', detail = 'no_changes';
  end if;

  if v_phone is not null and exists (
       select 1 from public.shareholders where phone_number = v_phone and id <> p_shareholder) then
    raise exception 'A shareholder with this phone number already exists.'
      using errcode = 'unique_violation', detail = 'duplicate_phone';
  end if;
  if v_ident[2] is not null and exists (
       select 1 from public.shareholders
        where id_type = v_ident[1] and id_number = v_ident[2] and id <> p_shareholder) then
    raise exception 'A shareholder with this identification number already exists.'
      using errcode = 'unique_violation', detail = 'duplicate_identification';
  end if;

  update public.shareholders
     set full_name    = v_name,
         phone_number = v_phone,
         email        = case when p_email is null then email else app.optional_email(p_email) end,
         address      = case when p_address is null then address
                             else app.optional_text(p_address, 'Address', 200) end,
         id_type      = v_ident[1],
         id_number    = v_ident[2],
         notes        = case when p_notes is null then notes
                             else app.optional_text(p_notes, 'Notes', 500) end,
         search_text  = lower(v_name || ' ' || v_before.shareholder_number),
         updated_by   = auth.uid()
   where id = p_shareholder;

  if 'fullName' = any (v_changed) then
    update public.shareholdings set shareholder_name = v_name where shareholder_id = p_shareholder;
  end if;

  -- The audit trail masks the phone number and the identification, exactly as
  -- the reference does: an audit entry is not a back door to contact details.
  perform app.audit('shareholder.updated', 'shareholders', p_shareholder::text, null,
    v_before.shareholder_number, app.optional_text(p_reason, 'Reason', 300),
    jsonb_build_object('fullName', v_before.full_name,
                       'phoneNumber', app.mask_phone(v_before.phone_number),
                       'idNumber', case when v_before.id_number is null then null
                                        else '••' || right(v_before.id_number, 3) end),
    jsonb_build_object('fullName', v_name, 'phoneNumber', app.mask_phone(v_phone),
                       'idNumber', case when v_ident[2] is null then null
                                        else '••' || right(v_ident[2], 3) end,
                       'changed', to_jsonb(v_changed)));
  return v_changed;
end;
$$;

/* ACTIVE / INACTIVE / SUSPENDED / EXITED, with a reason. */
create or replace function app.set_shareholder_status(
  p_shareholder uuid, p_status text, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_sh     public.shareholders%rowtype;
  v_reason text;
begin
  perform app.require_permission('shareholders.manage');
  if p_status not in ('active', 'inactive', 'suspended', 'exited') then
    raise exception 'Choose active, inactive, suspended or exited.'
      using errcode = 'invalid_parameter_value', detail = 'status';
  end if;
  v_reason := app.require_reason(p_reason);

  select * into v_sh from public.shareholders where id = p_shareholder for update;
  if v_sh.id is null then
    raise exception 'That shareholder could not be found.'
      using errcode = 'no_data_found', detail = 'shareholder_not_found';
  end if;
  if v_sh.status = p_status then
    raise exception 'This shareholder is already %.', p_status
      using errcode = 'raise_exception', detail = 'no_changes';
  end if;

  if p_status = 'exited' then
    if v_sh.total_shares > 0 then
      raise exception 'Transfer or adjust this shareholder''s shares to zero before marking them exited.'
        using errcode = 'raise_exception', detail = 'holds_shares';
    end if;
    if v_sh.outstanding_ugx > 0 then
      raise exception 'This shareholder still has an unpaid share commitment.'
        using errcode = 'raise_exception', detail = 'outstanding_commitment';
    end if;
    if exists (select 1 from public.share_transactions
                where status = 'pending_approval' and p_shareholder = any (shareholder_ids)) then
      raise exception 'Decide this shareholder''s pending share transactions first.'
        using errcode = 'raise_exception', detail = 'pending_transactions';
    end if;
  end if;

  update public.shareholders
     set status = p_status, status_reason = v_reason, status_changed_at = now(), updated_by = auth.uid()
   where id = p_shareholder;

  perform app.audit('shareholder.status_changed', 'shareholders', p_shareholder::text, null,
    v_sh.shareholder_number, v_reason,
    jsonb_build_object('status', v_sh.status), jsonb_build_object('status', p_status));
  return p_status;
end;
$$;

/* Links (or unlinks) the sign-in of the person who IS this shareholder. */
create or replace function app.link_shareholder_account(
  p_shareholder uuid, p_uid uuid default null, p_reason text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_sh   public.shareholders%rowtype;
  v_name text;
begin
  perform app.require_permission('shareholders.manage');
  select * into v_sh from public.shareholders where id = p_shareholder for update;
  if v_sh.id is null then
    raise exception 'That shareholder could not be found.'
      using errcode = 'no_data_found', detail = 'shareholder_not_found';
  end if;
  if v_sh.linked_uid is not distinct from p_uid then
    raise exception 'Nothing has changed.' using errcode = 'raise_exception', detail = 'no_changes';
  end if;
  if p_uid is not null then
    select full_name into v_name from public.users where id = p_uid;
    if v_name is null then
      raise exception 'That user could not be found.'
        using errcode = 'no_data_found', detail = 'user_not_found';
    end if;
    if exists (select 1 from public.shareholders where linked_uid = p_uid and id <> p_shareholder) then
      raise exception 'That user is already linked to another shareholder.'
        using errcode = 'unique_violation', detail = 'duplicate_link';
    end if;
  end if;

  update public.shareholders
     set linked_uid = p_uid, linked_user_name = v_name, updated_by = auth.uid()
   where id = p_shareholder;

  perform app.audit(case when p_uid is null then 'shareholder.account_unlinked'
                         else 'shareholder.account_linked' end,
    'shareholders', p_shareholder::text, p_uid, v_sh.shareholder_number,
    app.optional_text(p_reason, 'Reason', 300),
    jsonb_build_object('linkedUid', v_sh.linked_uid), jsonb_build_object('linkedUid', p_uid));
  return p_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Share classes
-- ---------------------------------------------------------------------------

create or replace function app.create_share_class(
  p_code text, p_name text, p_value_per_share_ugx bigint, p_description text default null)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_id   text;
begin
  perform app.require_permission('shareholders.manage');
  if v_code !~ '^[A-Z][A-Z0-9_]{1,19}$' then
    raise exception 'Use 2–20 capital letters, digits or underscores for the class code, e.g. ORDINARY.'
      using errcode = 'invalid_parameter_value', detail = 'class_code';
  end if;
  perform app.require_amount(p_value_per_share_ugx, 'value per share', 1, app.max_share_value_ugx());
  v_id := lower(v_code);
  if exists (select 1 from public.share_classes where id = v_id) then
    raise exception 'A share class with code % already exists.', v_code
      using errcode = 'unique_violation', detail = 'duplicate_class';
  end if;

  insert into public.share_classes (id, code, name, description, value_per_share_ugx, created_by, updated_by)
  values (v_id, v_code, app.require_text(p_name, 'Class name', 60),
          app.optional_text(p_description, 'Description', 300), p_value_per_share_ugx,
          auth.uid(), auth.uid());

  perform app.audit('share_class.created', 'shareholders', v_id, null, v_code, null, null,
    jsonb_build_object('code', v_code, 'name', p_name, 'valuePerShareUgx', p_value_per_share_ugx));
  return v_id;
end;
$$;

/* Name, description, value per share (FUTURE issues only) and active flag. */
create or replace function app.update_share_class(
  p_class       text,
  p_name        text default null,
  p_description text default null,
  p_value_per_share_ugx bigint default null,
  p_active      boolean default null,
  p_reason      text default null
)
returns text[]
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before  public.share_classes%rowtype;
  v_changed text[] := '{}';
  v_reason  text;
begin
  perform app.require_permission('shareholders.manage');
  v_before := app.read_share_class(p_class);
  if p_name is not null and app.require_text(p_name, 'Class name', 60) is distinct from v_before.name
    then v_changed := v_changed || 'name'::text; end if;
  if p_description is not null
     and app.optional_text(p_description, 'Description', 300) is distinct from v_before.description
    then v_changed := v_changed || 'description'::text; end if;
  if p_value_per_share_ugx is not null and p_value_per_share_ugx <> v_before.value_per_share_ugx then
    perform app.require_amount(p_value_per_share_ugx, 'value per share', 1, app.max_share_value_ugx());
    v_changed := v_changed || 'valuePerShareUgx'::text;
  end if;
  if p_active is not null and p_active <> v_before.active then v_changed := v_changed || 'active'::text; end if;
  if array_length(v_changed, 1) is null then
    raise exception 'Nothing has changed.' using errcode = 'raise_exception', detail = 'no_changes';
  end if;
  -- Changing the price or retiring a class needs a reason.
  v_reason := case when 'valuePerShareUgx' = any (v_changed) or 'active' = any (v_changed)
                   then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;

  update public.share_classes
     set name        = coalesce(p_name, name),
         description = case when p_description is null then description
                            else app.optional_text(p_description, 'Description', 300) end,
         value_per_share_ugx = coalesce(p_value_per_share_ugx, value_per_share_ugx),
         active      = coalesce(p_active, active),
         updated_by  = auth.uid()
   where id = v_before.id;

  -- A price change applies to FUTURE issues only. Every issue already carries
  -- the value it used, so no history moves.
  perform app.audit('share_class.updated', 'shareholders', v_before.id, null, v_before.code, v_reason,
    jsonb_build_object('name', v_before.name, 'valuePerShareUgx', v_before.value_per_share_ugx,
                       'active', v_before.active),
    jsonb_build_object('name', coalesce(p_name, v_before.name),
                       'valuePerShareUgx', coalesce(p_value_per_share_ugx, v_before.value_per_share_ugx),
                       'active', coalesce(p_active, v_before.active), 'changed', to_jsonb(v_changed)));
  return v_changed;
end;
$$;

/* Refuses an approver acting on a shareholding that is their own. */
create or replace function app.require_not_own_shareholding(p_shareholders uuid[], p_what text)
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
begin
  -- Administrators are exempt, as in payroll.
  if app.current_role_id() = 'admin' then return; end if;
  if exists (select 1 from public.shareholders
              where id = any (p_shareholders) and linked_uid = auth.uid()) then
    raise exception 'You cannot % your own shareholding.', p_what
      using errcode = 'insufficient_privilege', detail = 'own_shareholding';
  end if;
end;
$$;
