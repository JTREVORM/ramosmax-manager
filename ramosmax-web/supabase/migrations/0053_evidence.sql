-- ===========================================================================
-- RamosMAX Web — Final phase — 0053: evidence attachments
-- ===========================================================================
-- The reference stores evidence in Firebase Storage and keeps the PATH on the
-- record: a deposit slip, a reconciliation statement, an expense receipt, a
-- supplier invoice, a sick note, a photograph of a loss, a staff profile
-- photo. `firebase/storage.rules` decides who may put a file there and who
-- may read it, and forbids replacing or deleting one.
--
-- This migration ports the half that belongs to the database: the columns,
-- the same path shapes the reference validates, the same permission to
-- attach, and the same refusal to replace or remove. Moving the bytes needs a
-- Supabase Storage bucket, which needs the hosted project — see
-- docs/SUPABASE_SETUP.md §7 and docs/PARITY.md §11.
--
-- One difference, deliberate and reported: the reference passes the path to
-- the function that creates the record, because the app uploads first. Here
-- it is a separate call made after the upload finishes, so a failed upload
-- can never take the record down with it. The path shape, the permission and
-- the "never replaced, never deleted" rule are unchanged.
-- ===========================================================================

alter table public.attendance          add column if not exists attachment_path text;
alter table public.expenses            add column if not exists attachment_path text;
alter table public.bank_deposits       add column if not exists attachment_path text;
alter table public.reconciliations     add column if not exists attachment_path text;
alter table public.inventory_purchases add column if not exists attachment_path text;
alter table public.loss_incidents      add column if not exists attachment_path text;

-- ---------------------------------------------------------------- the paths

/**
 * `<bucket>/<kind>/<uploadId>/<file>`, exactly as access.js optionalAttachment
 * and workforce.js optionalUpload spell it.
 */
create or replace function app.require_upload_path(p_path text, p_bucket text, p_kind text)
returns text
language plpgsql
immutable
as $$
begin
  if p_path is null or p_path = '' then
    return null;
  end if;
  if p_path !~ ('^' || p_bucket || '/' || p_kind ||
                '/[A-Za-z0-9_-]{8,64}/[A-Za-z0-9._-]{1,100}$') then
    raise exception 'The attachment could not be saved.'
      using errcode = 'invalid_parameter_value', detail = 'attachment';
  end if;
  return p_path;
end;
$$;

/** `staff/<staffId>/profile/<file>`, as access.js requireProfilePhotoPath. */
create or replace function app.require_profile_photo_path(p_path text, p_staff_id text)
returns text
language plpgsql
immutable
as $$
declare
  v_prefix text;
begin
  if p_path is null or p_path = '' then
    return null;
  end if;
  if p_staff_id is null or p_staff_id = '' then
    raise exception 'Link a staff record before adding a profile photo.'
      using errcode = 'invalid_parameter_value', detail = 'photo';
  end if;
  v_prefix := 'staff/' || p_staff_id || '/profile/';
  if p_path not like v_prefix || '%'
     or position('/' in substr(p_path, length(v_prefix) + 1)) > 0
     or length(p_path) > length(v_prefix) + 100 then
    raise exception 'The profile photo could not be saved.'
      using errcode = 'invalid_parameter_value', detail = 'photo';
  end if;
  return p_path;
end;
$$;

-- ------------------------------------------------------------- attaching it

/**
 * Records the path of a file that has already been uploaded.
 *
 * Evidence is never replaced and never removed: a record that already carries
 * one is refused, which is `allow update, delete: if false` in the reference's
 * storage rules said in SQL.
 */
create or replace function app.attach_evidence(
  p_kind   text,
  p_record uuid,
  p_path   text
) returns text
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_bucket   text;
  v_existing text;
  v_module   text;
begin
  if p_path is null or p_path = '' then
    raise exception 'There is no file to attach.'
      using errcode = 'invalid_parameter_value', detail = 'attachment';
  end if;

  -- Which record, which permission, which bucket. The permission is the one
  -- that creates the record: evidence is part of recording it.
  case p_kind
    when 'expenses' then
      perform app.require_permission('expenses.create');
      v_bucket := 'finance_uploads'; v_module := 'expenses';
      select attachment_path into v_existing from public.expenses where id = p_record;
    when 'deposits' then
      perform app.require_permission('finance.deposit');
      v_bucket := 'finance_uploads'; v_module := 'finance';
      select attachment_path into v_existing from public.bank_deposits where id = p_record;
    when 'reconciliations' then
      perform app.require_permission('finance.reconcile');
      v_bucket := 'finance_uploads'; v_module := 'finance';
      select attachment_path into v_existing from public.reconciliations where id = p_record;
    when 'purchases' then
      perform app.require_permission('inventory.purchase.create');
      v_bucket := 'finance_uploads'; v_module := 'inventory';
      select attachment_path into v_existing from public.inventory_purchases where id = p_record;
    when 'attendance' then
      perform app.require_permission('attendance.record');
      v_bucket := 'payroll_uploads'; v_module := 'attendance';
      select attachment_path into v_existing from public.attendance where id = p_record;
    when 'losses' then
      perform app.require_permission('losses.create');
      v_bucket := 'payroll_uploads'; v_module := 'losses';
      select attachment_path into v_existing from public.loss_incidents where id = p_record;
    else
      raise exception 'That is not something evidence can be attached to.'
        using errcode = 'invalid_parameter_value', detail = 'kind';
  end case;

  if not found then
    raise exception 'That record could not be found.'
      using errcode = 'no_data_found', detail = 'record_not_found';
  end if;
  if v_existing is not null then
    raise exception 'This record already has evidence. Evidence is never replaced.'
      using errcode = 'invalid_parameter_value', detail = 'evidence_exists';
  end if;

  perform app.require_upload_path(p_path, v_bucket, p_kind);

  case p_kind
    when 'expenses' then
      update public.expenses set attachment_path = p_path where id = p_record;
    when 'deposits' then
      update public.bank_deposits set attachment_path = p_path where id = p_record;
    when 'reconciliations' then
      update public.reconciliations set attachment_path = p_path where id = p_record;
    when 'purchases' then
      update public.inventory_purchases set attachment_path = p_path where id = p_record;
    when 'attendance' then
      update public.attendance set attachment_path = p_path where id = p_record;
    when 'losses' then
      update public.loss_incidents set attachment_path = p_path where id = p_record;
  end case;

  -- The path, never the file, and never a second copy of it.
  perform app.audit('evidence.attached', v_module, p_record::text, null, p_path, null,
    null, jsonb_build_object('kind', p_kind));
  return p_path;
end;
$$;

/**
 * A staff profile photo.
 *
 * The photo belongs to the STAFF ID, not to the person: `app.link_staff`
 * clears it, because a photo must never follow somebody onto a staff record
 * that is not theirs.
 */
create or replace function app.set_profile_photo(p_user uuid, p_path text)
returns text
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_user public.users%rowtype;
  v_path text;
begin
  select * into v_user from public.users where id = p_user for update;
  if v_user.id is null then
    raise exception 'That account could not be found.'
      using errcode = 'no_data_found', detail = 'user_not_found';
  end if;
  if p_user <> auth.uid() then
    perform app.require_permission('users.edit');
    perform app.require_can_administer(p_user);
  end if;

  v_path := app.require_profile_photo_path(p_path, v_user.staff_id);
  update public.users set profile_photo_path = v_path, updated_at = now(), updated_by = auth.uid()
   where id = p_user;

  perform app.audit('user.photo_changed', 'users', p_user::text, p_user,
    v_user.full_name, null,
    jsonb_build_object('had', v_user.profile_photo_path is not null),
    jsonb_build_object('has', v_path is not null));
  return v_path;
end;
$$;

comment on function app.attach_evidence(text, uuid, text) is
  'Records the path of an already-uploaded file. Never replaces one.';
comment on function app.set_profile_photo(uuid, text) is
  'A staff profile photo path. Belongs to the staff ID, and is cleared when that changes.';

-- PUBLIC only, as in 0046, 0048, 0050, 0051 and 0052.
revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app from anon;
alter default privileges in schema app revoke execute on functions from public;

grant execute on function
  app.attach_evidence(text, uuid, text),
  app.set_profile_photo(uuid, text)
to authenticated;
