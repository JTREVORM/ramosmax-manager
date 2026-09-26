-- ===========================================================================
-- RamosMAX Web — Final phase — 0043: who may read after-hours records
-- ===========================================================================
-- `authenticated` holds SELECT only; every change goes through a SECURITY
-- DEFINER function, so these policies decide reading and nothing else.
--
-- The rules that matter, stated once:
--   * A worker reads their OWN authorisation, session, custody entries,
--     handover and discrepancy — and nobody else's, ever. That is what
--     `after_hours.request` means here.
--   * The expected cash is READ-ONLY to the person holding it. They can see
--     what the server says should be there; they cannot change it, and the
--     count that decides is somebody else's.
--   * A manager with `after_hours.view` sees the operational picture. A
--     manager with only `cash_handover.approve` sees the handovers they have
--     to receive.
-- ===========================================================================

drop policy if exists after_hours_access_read on public.after_hours_access;
create policy after_hours_access_read on public.after_hours_access
  for select to authenticated
  using (
    app.has_either_permission('after_hours.view', 'after_hours.approve')
    or (staff_uid = auth.uid() and app.has_permission('after_hours.request'))
  );

drop policy if exists after_hours_sessions_read on public.after_hours_sessions;
create policy after_hours_sessions_read on public.after_hours_sessions
  for select to authenticated
  using (
    app.has_either_permission('after_hours.view', 'after_hours.approve')
    or app.has_either_permission('cash_handover.approve', 'after_hours.discrepancy.review')
    or (staff_uid = auth.uid() and app.has_permission('after_hours.request'))
  );

drop policy if exists after_hours_cash_read on public.after_hours_cash;
create policy after_hours_cash_read on public.after_hours_cash
  for select to authenticated
  using (
    app.has_either_permission('after_hours.view', 'after_hours.approve')
    or app.has_either_permission('cash_handover.approve', 'after_hours.discrepancy.review')
    or (staff_uid = auth.uid() and app.has_permission('after_hours.request'))
  );

drop policy if exists cash_handovers_read on public.cash_handovers;
create policy cash_handovers_read on public.cash_handovers
  for select to authenticated
  using (
    app.has_either_permission('after_hours.view', 'cash_handover.approve')
    or app.has_either_permission('cash_handover.submit', 'after_hours.discrepancy.review')
    or (staff_uid = auth.uid() and app.has_permission('after_hours.request'))
  );

drop policy if exists cash_discrepancies_read on public.cash_discrepancies;
create policy cash_discrepancies_read on public.cash_discrepancies
  for select to authenticated
  using (
    app.has_either_permission('after_hours.view', 'after_hours.discrepancy.review')
    or app.has_permission('cash_handover.approve')
    or (staff_uid = auth.uid() and app.has_permission('after_hours.request'))
  );

drop policy if exists after_hours_events_read on public.after_hours_events;
create policy after_hours_events_read on public.after_hours_events
  for select to authenticated
  using (
    recipient_uid = auth.uid()
    or (recipient_uid is null and audience <> 'recipient' and app.has_permission(audience))
  );

grant select on public.after_hours_access, public.after_hours_sessions, public.after_hours_cash,
                 public.cash_handovers, public.cash_discrepancies, public.after_hours_events
  to authenticated;

-- ---------------------------------------------------------------------------
-- Self-service
-- ---------------------------------------------------------------------------

/*
 * Everything the signed-in worker needs for their own after-hours work: the
 * authorisation in force, the open session, what the server expects them to
 * hand over, the custody entries that explain it, and their history.
 *
 * Served from their own sign-in, so a modified client cannot ask for anybody
 * else's — and the expected amount arrives as a number to read, never a field
 * to fill in.
 */
create or replace function app.my_after_hours()
returns jsonb
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_auth    public.after_hours_access%rowtype;
  v_session public.after_hours_sessions%rowtype;
begin
  perform app.require_permission('after_hours.request', 'after_hours.view');

  select * into v_auth from public.after_hours_access
   where staff_uid = auth.uid() and status = 'active'
     and starts_at <= now() and expires_at > now()
   order by expires_at desc limit 1;

  select * into v_session from public.after_hours_sessions
   where staff_uid = auth.uid() and status = 'open' limit 1;

  return jsonb_build_object(
    'authorization', case when v_auth.id is null then null else jsonb_build_object(
      'authorizationId', v_auth.id, 'authorizationNumber', v_auth.authorization_number,
      'startsAt', v_auth.starts_at, 'expiresAt', v_auth.expires_at,
      'permissions', to_jsonb(v_auth.permissions),
      'openingFloatUgx', v_auth.opening_float_ugx,
      'floatTaken', v_auth.float_session_id is not null,
      'supervisorName', v_auth.granted_by_name) end,
    'session', case when v_session.id is null then null else jsonb_build_object(
      'sessionId', v_session.id, 'sessionNumber', v_session.session_number,
      'openedAt', v_session.opened_at, 'openingFloatUgx', v_session.opening_float_ugx,
      'cashCollectedUgx', v_session.cash_collected_ugx,
      'nonCashCollectedUgx', v_session.non_cash_collected_ugx,
      'cashReversedUgx', v_session.cash_reversed_ugx,
      -- Read-only. Nothing the worker sends can change it.
      'expectedCashUgx', v_session.expected_cash_ugx,
      'paymentCount', v_session.payment_count, 'intakesCreated', v_session.intakes_created,
      'invoicesCreated', v_session.invoices_created, 'jobsCompleted', v_session.jobs_completed,
      'authorizationExpiresAt', v_session.authorization_expires_at) end,
    'custody', coalesce((
      select jsonb_agg(jsonb_build_object(
               'entryNumber', c.entry_number, 'kind', c.kind, 'method', c.method,
               'amountUgx', c.amount_ugx, 'cashDeltaUgx', c.cash_delta_ugx,
               'receiptNumber', c.receipt_number, 'numberPlate', c.number_plate,
               'createdAt', c.created_at) order by c.created_at)
        from public.after_hours_cash c where c.session_id = v_session.id), '[]'::jsonb),
    'handovers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'handoverId', h.id, 'handoverNumber', h.handover_number,
               'sessionNumber', h.session_number, 'expectedCashUgx', h.expected_cash_ugx,
               'declaredAmountUgx', h.declared_amount_ugx,
               'actualAmountUgx', h.actual_amount_ugx, 'differenceUgx', h.difference_ugx,
               'status', h.status, 'createdAt', h.created_at) order by h.created_at desc)
        from public.cash_handovers h where h.staff_uid = auth.uid()), '[]'::jsonb),
    'discrepancies', coalesce((
      select jsonb_agg(jsonb_build_object(
               'discrepancyId', d.id, 'discrepancyNumber', d.discrepancy_number,
               'kind', d.kind, 'differenceUgx', d.difference_ugx, 'status', d.status,
               'outcome', d.outcome, 'reason', d.reason, 'resolution', d.resolution,
               'reportedAt', d.reported_at) order by d.reported_at desc)
        from public.cash_discrepancies d where d.staff_uid = auth.uid()), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sessionId', s.id, 'sessionNumber', s.session_number, 'status', s.status,
               'openedAt', s.opened_at, 'closedAt', s.closed_at,
               'expectedCashUgx', s.expected_cash_ugx,
               'actualReceivedUgx', s.actual_received_ugx,
               'differenceUgx', s.difference_ugx) order by s.opened_at desc)
        from (select * from public.after_hours_sessions
               where staff_uid = auth.uid() order by opened_at desc limit 50) s), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------

/*
 * Tidies statuses and raises reminders. NOTHING DEPENDS ON THIS HAVING RUN.
 *
 * An authorisation stops working at its expiry because
 * `app.effective_permissions` compares the grant's window to the server clock
 * on every single query. This function only writes the `expired` label that
 * the screens read, warns 30 minutes before the end, and reminds about a
 * handover still outstanding two hours after its session closed.
 *
 * Each reminder is claimed with an UPDATE that sets its flag, so two
 * overlapping runs cannot remind twice.
 */
create or replace function app.sweep_after_hours()
returns table (expired integer, warned integer, reminded integer)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_expired  integer := 0;
  v_warned   integer := 0;
  v_reminded integer := 0;
begin
  perform app.require_permission('after_hours.approve', 'settings.manage');

  with done as (
    update public.after_hours_access
       set status = 'expired', expired_at = now(), updated_at = now()
     where status = 'active' and expires_at <= now()
     returning 1)
  select count(*)::integer into v_expired from done;

  with warn as (
    update public.after_hours_access
       set expiry_notified = true, updated_at = now()
     where status = 'active' and not expiry_notified
       and starts_at <= now()
       and expires_at > now() and expires_at <= now() + interval '30 minutes'
     returning id, staff_uid, authorization_number, expires_at),
  sent as (
    insert into public.after_hours_events (type, reference_type, reference_id, audience,
                                           recipient_uid, payload)
    select 'after_hours_expiring', 'authorization', w.id, 'recipient', w.staff_uid,
           jsonb_build_object('authorizationNumber', w.authorization_number,
                              'expiresAt', w.expires_at)
      from warn w returning 1)
  select count(*)::integer into v_warned from sent;

  with due as (
    update public.cash_handovers
       set reminder_sent_at = now()
     where status in ('pending', 'submitted') and reminder_sent_at is null
       and created_at <= now() - interval '2 hours'
     returning id, staff_uid, handover_number, status),
  sent as (
    insert into public.after_hours_events (type, reference_type, reference_id, audience,
                                           recipient_uid, payload)
    select 'cash_handover_reminder', 'handover', d.id, 'recipient', d.staff_uid,
           jsonb_build_object('handoverNumber', d.handover_number)
      from due d where d.status = 'pending'
    union all
    select 'cash_handover_reminder', 'handover', d.id, 'cash_handover.approve', null,
           jsonb_build_object('handoverNumber', d.handover_number)
      from due d
    returning 1),
  counted as (select id from due)
  select count(*)::integer into v_reminded from counted;

  return query select v_expired, v_warned, v_reminded;
end;
$$;

comment on function app.sweep_after_hours() is
  'Labels and reminders only. Expiry is enforced by app.effective_permissions comparing the grant window to the server clock — never by this sweep.';
