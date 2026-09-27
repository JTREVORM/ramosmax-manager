-- ===========================================================================
-- RamosMAX Web — 0058: ending somebody's sessions, for real
-- ===========================================================================
-- `users.sessions_valid_from` was added in 0049 with the comment "Sessions
-- issued before this are rejected". `app.change_user_phone` sets it. NOTHING
-- READS IT. A phone-number change therefore audited that it had ended every
-- session, told the person so on screen, and left every cookie working.
--
-- `app.prepare_password_reset` had the opposite gap: it sets
-- `must_change_password` but stamps nothing, so after an administrator reset
-- somebody's existing cookie still authenticated them. They were pushed to the
-- change-password screen and could get no further without the password they no
-- longer had — a soft stop, not the revocation the design calls for.
--
-- Only `app.complete_password_change` did it properly, by stamping
-- `password_changed_at`, which `currentUser()` has always compared against.
--
-- This migration gives all three the same mechanism. The application now reads
-- BOTH stamps, and this function is what sets the second one.
--
-- WHY A FUNCTION AND NOT AN UPDATE FROM THE APPLICATION
--
-- Every mutation in RamosMAX goes through a SECURITY DEFINER function, and
-- that rule is worth more than the two lines it saves here. `authenticated`
-- holds no UPDATE on `users` beyond two session columns, and this is not one
-- of them.
--
-- It writes no audit entry of its own. Every caller has already audited the
-- thing that caused it — `password.changed`, `user.password_reset`,
-- `user.phone_changed` — and a second row saying the sessions then ended would
-- be noise, not evidence.
-- ===========================================================================

create or replace function app.end_sessions(p_user uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_at timestamptz := now();
begin
  update public.users
     set sessions_valid_from = v_at
   where id = p_user;

  if not found then
    raise exception 'That account could not be found.'
      using errcode = 'no_data_found', detail = 'user_not_found';
  end if;

  return v_at;
end;
$$;

comment on function app.end_sessions(uuid) is
  'Ends every session issued before now. Server-only: the caller has already decided it may.';

-- ---------------------------------------------------------------------------
-- An administrator's reset ends the sessions too
-- ---------------------------------------------------------------------------
-- Same body as 0005, with the stamp added. Without it, resetting somebody's
-- password left them signed in on whatever device they had open.
create or replace function app.prepare_password_reset(p_target uuid, p_reason text default null)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_password text;
begin
  perform app.require_permission('users.passwords.reset');
  perform app.require_not_self(p_target,
    'Change your own password from your profile instead.');
  perform app.require_can_reset_password(p_target);

  v_password := app.generate_password(12);

  update public.users
     set must_change_password = true,
         password_set         = true,
         password_reset_at    = now(),
         password_reset_by    = auth.uid(),
         -- Whatever they had open is over. The temporary password is the only
         -- way back in, and it only permits replacing itself.
         sessions_valid_from  = now(),
         updated_by           = auth.uid()
   where id = p_target;

  -- The password itself is NEVER written to the audit trail.
  perform app.audit('user.password_reset', 'users', p_target::text, p_target,
    'Temporary password issued; existing sessions ended', p_reason, null,
    jsonb_build_object('mustChangePassword', true));

  return v_password;
end;
$$;

-- Server-only, exactly as `app.prepare_password_reset` and `app.create_user`
-- are: it pairs with a credential-store side effect the browser cannot make.
revoke all on function app.end_sessions(uuid) from anon, authenticated;
revoke all on function app.prepare_password_reset(uuid, text) from anon, authenticated;

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app from anon;
alter default privileges in schema app revoke execute on functions from public;
