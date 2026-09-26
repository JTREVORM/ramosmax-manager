-- ===========================================================================
-- RamosMAX Web — Final phase — 0042: cash handovers and discrepancies
-- ===========================================================================
-- A handover moves CUSTODY, not money. Every after-hours payment was posted
-- to Cash at Hand when it was collected, so receiving the cash posts nothing
-- to the ledger, changes no balance and creates no revenue. What it does is
-- record that the notes physically reached the manager, and compare what was
-- counted with what the server says should be there.
--
-- The separation of duties is the point:
--   * the server works out what is expected, from the payments;
--   * the worker states what they are handing over — informational only;
--   * SOMEBODY ELSE counts it, and their count is what decides;
--   * any difference opens a discrepancy that a third role reviews.
--
-- Resolving a shortage may REPORT a loss incident about the worker. It never
-- deducts anything: the incident goes through the Phase F review and
-- decision, and a salary deduction needs its own authorisation after that.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Submit — what the worker says they are handing over
-- ---------------------------------------------------------------------------

create or replace function app.submit_cash_handover(
  p_handover   uuid,
  p_declared_amount_ugx bigint,
  p_request_id text,
  p_notes      text default null
)
returns table (handover_id uuid, status text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_cached   jsonb;
  v_h        public.cash_handovers%rowtype;
  v_declared bigint;
  v_notes    text := app.optional_text(p_notes, 'Notes', 500);
begin
  perform app.require_permission('after_hours.request', 'cash_handover.submit');
  perform app.require_request_id(p_request_id);
  v_declared := app.require_amount(p_declared_amount_ugx, 'amount handed over', 0, 2000000000);

  v_cached := app.claim_request(p_request_id, 'cash_handover_submit',
    jsonb_build_object('handover', p_handover, 'declared', v_declared));
  if v_cached is not null then
    return query select (v_cached ->> 'handoverId')::uuid, v_cached ->> 'status';
    return;
  end if;

  select * into v_h from public.cash_handovers where id = p_handover for update;
  if v_h.id is null then
    raise exception 'That cash handover could not be found.'
      using errcode = 'no_data_found', detail = 'handover_not_found';
  end if;
  if v_h.staff_uid <> auth.uid() and not app.has_permission('cash_handover.submit') then
    raise exception 'You can only submit your own cash handover.'
      using errcode = 'insufficient_privilege', detail = 'not_owner';
  end if;
  if v_h.status = 'submitted' then
    raise exception 'This handover has already been submitted.'
      using errcode = 'invalid_parameter_value', detail = 'already_submitted';
  end if;
  if v_h.status <> 'pending' then
    raise exception 'This handover has already been received.'
      using errcode = 'invalid_parameter_value', detail = 'invalid_status';
  end if;

  update public.cash_handovers
     set status = 'submitted', declared_amount_ugx = v_declared,
         submitted_by = auth.uid(),
         submitted_by_name = (select full_name from public.users where id = auth.uid()),
         submitted_at = now(), submit_notes = v_notes
   where id = p_handover;

  update public.after_hours_sessions
     set handover_status = 'submitted' where id = v_h.session_id;

  perform app.audit('cash_handover.submitted', 'cash_handover', p_handover::text, v_h.staff_uid,
    v_h.handover_number, v_notes, null,
    jsonb_build_object('handoverNumber', v_h.handover_number,
                       'expectedCashUgx', v_h.expected_cash_ugx,
                       'declaredAmountUgx', v_declared));

  insert into public.after_hours_events (type, reference_type, reference_id, audience, payload)
  values ('cash_handover_submitted', 'handover', p_handover, 'cash_handover.approve',
          jsonb_build_object('handoverNumber', v_h.handover_number));

  perform app.complete_request(p_request_id,
    jsonb_build_object('handoverId', p_handover, 'status', 'submitted'));
  return query select p_handover, 'submitted'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Receive — somebody else counts it
-- ---------------------------------------------------------------------------

create or replace function app.receive_cash_handover(
  p_handover   uuid,
  p_actual_amount_ugx bigint,
  p_request_id text,
  p_explanation text default null,
  p_notes      text default null
)
returns table (handover_id uuid, status text, difference_ugx bigint,
               discrepancy_id uuid, discrepancy_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_cached  jsonb;
  v_h       public.cash_handovers%rowtype;
  v_actual  bigint;
  v_diff    bigint;
  v_kind    text;
  v_status  text;
  v_expl    text;
  v_notes   text := app.optional_text(p_notes, 'Notes', 500);
  v_did     uuid;
  v_dnum    text;
begin
  perform app.require_permission('cash_handover.approve');
  perform app.require_request_id(p_request_id);
  v_actual := app.require_amount(p_actual_amount_ugx, 'amount received', 0, 2000000000);

  v_cached := app.claim_request(p_request_id, 'cash_handover_receive',
    jsonb_build_object('handover', p_handover, 'actual', v_actual));
  if v_cached is not null then
    return query select (v_cached ->> 'handoverId')::uuid, v_cached ->> 'status',
                        (v_cached ->> 'differenceUgx')::bigint,
                        nullif(v_cached ->> 'discrepancyId', '')::uuid,
                        nullif(v_cached ->> 'discrepancyNumber', '');
    return;
  end if;

  select * into v_h from public.cash_handovers where id = p_handover for update;
  if v_h.id is null then
    raise exception 'That cash handover could not be found.'
      using errcode = 'no_data_found', detail = 'handover_not_found';
  end if;
  -- Nobody counts their own cash. This is the separation of duties.
  if v_h.staff_uid = auth.uid() then
    raise exception 'Someone else must receive your cash handover.'
      using errcode = 'insufficient_privilege', detail = 'self_receipt';
  end if;
  if v_h.status not in ('pending', 'submitted') then
    raise exception 'This handover has already been received.'
      using errcode = 'invalid_parameter_value', detail = 'already_received';
  end if;

  v_diff := v_actual - v_h.expected_cash_ugx;
  if v_diff <> 0 then
    v_expl := app.require_reason(p_explanation);
    v_kind := case when v_diff < 0 then 'shortage' else 'excess' end;
    v_dnum := app.next_reference('discrepancy_number_seq', 'RMX-AHD-');
    insert into public.cash_discrepancies
      (discrepancy_number, handover_id, handover_number, session_id, session_number,
       staff_uid, staff_name, expected_cash_ugx, declared_amount_ugx, actual_amount_ugx,
       difference_ugx, kind, reason, reported_by, reported_by_name)
    values
      (v_dnum, p_handover, v_h.handover_number, v_h.session_id, v_h.session_number,
       v_h.staff_uid, v_h.staff_name, v_h.expected_cash_ugx, v_h.declared_amount_ugx, v_actual,
       v_diff, v_kind, v_expl, auth.uid(),
       (select full_name from public.users where id = auth.uid()))
    returning id into v_did;

    perform app.audit('cash_discrepancy.created', 'cash_handover', v_did::text, v_h.staff_uid,
      v_dnum, v_expl, null,
      jsonb_build_object('discrepancyNumber', v_dnum, 'handoverNumber', v_h.handover_number,
                         'expectedCashUgx', v_h.expected_cash_ugx,
                         'actualAmountUgx', v_actual, 'differenceUgx', v_diff));
  else
    v_expl := app.optional_text(p_explanation, 'Explanation', 500);
  end if;

  v_status := case when v_did is null then 'received' else 'discrepancy' end;

  update public.cash_handovers
     set status = v_status, actual_amount_ugx = v_actual, difference_ugx = v_diff,
         explanation = v_expl, received_by = auth.uid(),
         received_by_name = (select full_name from public.users where id = auth.uid()),
         received_at = now(), receive_notes = v_notes,
         discrepancy_id = v_did, discrepancy_number = v_dnum,
         reconciled_at = case when v_did is null then now() else null end,
         reconciled_by = case when v_did is null then auth.uid() else null end
   where id = p_handover;

  update public.after_hours_sessions
     set status = case when v_did is null then 'reconciled' else 'handover_pending' end,
         handover_status = v_status, actual_received_ugx = v_actual, difference_ugx = v_diff
   where id = v_h.session_id;

  -- No ledger entry, no balance change, no revenue: the money was posted when
  -- it was collected. This is custody accounting.
  perform app.audit('cash_handover.received', 'cash_handover', p_handover::text, v_h.staff_uid,
    v_h.handover_number, coalesce(v_expl, v_notes),
    jsonb_build_object('status', v_h.status),
    jsonb_build_object('status', v_status, 'handoverNumber', v_h.handover_number,
                       'expectedCashUgx', v_h.expected_cash_ugx, 'actualAmountUgx', v_actual,
                       'differenceUgx', v_diff, 'destinationAccount', 'cash_at_hand'));

  if v_did is not null then
    insert into public.after_hours_events (type, reference_type, reference_id, audience,
                                           recipient_uid, payload)
    values ('cash_discrepancy_detected', 'discrepancy', v_did, 'recipient', v_h.staff_uid,
            jsonb_build_object('discrepancyNumber', v_dnum)),
           ('cash_discrepancy_detected', 'discrepancy', v_did, 'after_hours.discrepancy.review',
            null, jsonb_build_object('discrepancyNumber', v_dnum));
  end if;

  perform app.complete_request(p_request_id, jsonb_build_object(
    'handoverId', p_handover, 'status', v_status, 'differenceUgx', v_diff,
    'discrepancyId', v_did, 'discrepancyNumber', v_dnum));

  return query select p_handover, v_status, v_diff, v_did, v_dnum;
end;
$$;

-- ---------------------------------------------------------------------------
-- Discrepancies
-- ---------------------------------------------------------------------------

create or replace function app.require_not_own_handover(p_staff uuid)
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
begin
  if p_staff = auth.uid() then
    raise exception 'You cannot review or resolve a discrepancy about your own handover.'
      using errcode = 'insufficient_privilege', detail = 'self_action';
  end if;
end;
$$;

create or replace function app.review_cash_discrepancy(p_discrepancy uuid, p_notes text)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_d     public.cash_discrepancies%rowtype;
  v_notes text := app.require_reason(p_notes);
begin
  perform app.require_permission('after_hours.discrepancy.review');
  select * into v_d from public.cash_discrepancies where id = p_discrepancy for update;
  if v_d.id is null then
    raise exception 'That discrepancy could not be found.'
      using errcode = 'no_data_found', detail = 'discrepancy_not_found';
  end if;
  perform app.require_not_own_handover(v_d.staff_uid);
  if v_d.status <> 'open' then
    raise exception 'Only an open discrepancy can be put under review.'
      using errcode = 'invalid_parameter_value', detail = 'invalid_status';
  end if;

  update public.cash_discrepancies
     set status = 'under_review', reviewed_by = auth.uid(),
         reviewed_by_name = (select full_name from public.users where id = auth.uid()),
         reviewed_at = now(), review_notes = v_notes
   where id = p_discrepancy;

  perform app.audit('cash_discrepancy.reviewed', 'cash_handover', p_discrepancy::text,
    v_d.staff_uid, v_d.discrepancy_number, v_notes,
    jsonb_build_object('status', 'open'), jsonb_build_object('status', 'under_review'));
  return 'under_review';
end;
$$;

/*
 * Closes a discrepancy. The figures it was opened about never change.
 *
 * Two follow-ups, both OPT-IN and both separately permissioned:
 *
 *   p_recover_from_worker — only for a shortage being resolved, and only with
 *     `losses.create`. It REPORTS a loss incident. Nothing is charged to
 *     anybody: the incident goes through the ordinary review and decision,
 *     and any deduction from salary needs its own authorisation afterwards.
 *
 *   p_post_adjustment — only with `finance.adjust`. It posts the ONE ledger
 *     adjustment that makes Cash at Hand agree with the cash that was counted:
 *     out for a shortage, in for an excess, always exactly the difference and
 *     never an amount anyone chooses.
 */
create or replace function app.resolve_cash_discrepancy(
  p_discrepancy uuid,
  p_outcome     text,
  p_resolution  text,
  p_request_id  text,
  p_recover_from_worker boolean default false,
  p_post_adjustment     boolean default false
)
returns table (discrepancy_id uuid, status text, loss_number text,
               adjustment_transaction_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_cached  jsonb;
  v_d       public.cash_discrepancies%rowtype;
  v_res     text := app.require_reason(p_resolution);
  v_recover boolean := coalesce(p_recover_from_worker, false);
  v_adjust  boolean := coalesce(p_post_adjustment, false);
  v_amount  bigint;
  v_loss    record;
  v_account uuid;
  v_txn     uuid;
  v_txnnum  text;
  v_lossnum text;
  v_lossid  uuid;
begin
  perform app.require_permission('after_hours.discrepancy.review');
  perform app.require_request_id(p_request_id);
  if p_outcome is null or p_outcome not in ('resolved', 'waived') then
    raise exception 'Choose resolved or waived.'
      using errcode = 'invalid_parameter_value', detail = 'outcome';
  end if;
  if v_recover and p_outcome = 'waived' then
    raise exception 'A waived discrepancy is not recovered from the worker.'
      using errcode = 'invalid_parameter_value', detail = 'outcome';
  end if;

  v_cached := app.claim_request(p_request_id, 'cash_discrepancy_resolve',
    jsonb_build_object('discrepancy', p_discrepancy, 'outcome', p_outcome));
  if v_cached is not null then
    return query select (v_cached ->> 'discrepancyId')::uuid, v_cached ->> 'status',
                        nullif(v_cached ->> 'lossNumber', ''),
                        nullif(v_cached ->> 'adjustmentTransactionNumber', '');
    return;
  end if;

  select * into v_d from public.cash_discrepancies where id = p_discrepancy for update;
  if v_d.id is null then
    raise exception 'That discrepancy could not be found.'
      using errcode = 'no_data_found', detail = 'discrepancy_not_found';
  end if;
  perform app.require_not_own_handover(v_d.staff_uid);
  if v_d.status not in ('open', 'under_review') then
    raise exception 'This discrepancy has already been closed.'
      using errcode = 'invalid_parameter_value', detail = 'already_resolved';
  end if;
  v_amount := abs(v_d.difference_ugx);

  if v_recover then
    if v_d.difference_ugx >= 0 then
      raise exception 'Only a shortage can be recovered from the worker.'
        using errcode = 'invalid_parameter_value', detail = 'not_a_shortage';
    end if;
    perform app.require_permission('losses.create');
    select * into v_loss from app.create_loss_incident(
      'worker_related_loss', v_amount,
      format('After-hours cash shortage %s (handover %s): expected UGX %s, received UGX %s.',
             v_d.discrepancy_number, v_d.handover_number,
             to_char(v_d.expected_cash_ugx, 'FM999,999,999,999'),
             to_char(v_d.actual_amount_ugx, 'FM999,999,999,999')),
      -- Its own idempotency key: the resolve has already claimed this one.
      p_request_id || '-loss', v_d.staff_uid, app.eat_day(), v_res);
    v_lossid  := v_loss.incident_id;
    v_lossnum := v_loss.loss_number;
    update public.loss_incidents
       set source_type = 'cash_discrepancy', source_id = p_discrepancy,
           source_number = v_d.discrepancy_number
     where id = v_lossid;
  end if;

  if v_adjust then
    perform app.require_permission('finance.adjust');
    select id into v_account from public.financial_accounts where code = 'cash_at_hand';
    if v_account is null then
      raise exception 'Cash at Hand has not been set up.'
        using errcode = 'no_data_found', detail = 'account_not_found';
    end if;
    v_txn := app.post_transaction(
      p_type => 'adjustment', p_amount => v_amount,
      p_from => case when v_d.difference_ugx < 0 then v_account end,
      p_to   => case when v_d.difference_ugx > 0 then v_account end,
      p_reference_type => 'cash_discrepancy', p_reference_id => p_discrepancy,
      p_description => format('Adjustment %s (after-hours handover %s)',
                              case when v_d.difference_ugx < 0 then '−' else '+' end,
                              v_d.handover_number),
      p_reason => format('Cash handover discrepancy %s: %s', v_d.discrepancy_number, v_res),
      p_approved_by => auth.uid());
    select t.transaction_number into v_txnnum
      from public.financial_transactions t where t.id = v_txn;
  end if;

  update public.cash_discrepancies
     set status = p_outcome, outcome = p_outcome, resolution = v_res,
         resolved_by = auth.uid(),
         resolved_by_name = (select full_name from public.users where id = auth.uid()),
         resolved_at = now(), loss_incident_id = v_lossid, loss_number = v_lossnum,
         adjustment_transaction_id = v_txn, adjustment_transaction_number = v_txnnum,
         request_id = p_request_id
   where id = p_discrepancy;

  update public.cash_handovers
     set status = 'reconciled', reconciled_at = now(), reconciled_by = auth.uid()
   where id = v_d.handover_id;

  update public.after_hours_sessions
     set status = 'reconciled', handover_status = 'reconciled'
   where id = v_d.session_id;

  perform app.audit('cash_discrepancy.' || p_outcome, 'cash_handover', p_discrepancy::text,
    v_d.staff_uid, v_d.discrepancy_number, v_res,
    jsonb_build_object('status', v_d.status),
    jsonb_build_object('status', p_outcome, 'differenceUgx', v_d.difference_ugx,
                       'lossNumber', v_lossnum, 'adjustmentTransactionNumber', v_txnnum));
  perform app.audit('cash_handover.reconciled', 'cash_handover', v_d.handover_id::text,
    v_d.staff_uid, v_d.handover_number, null,
    jsonb_build_object('status', 'discrepancy'),
    jsonb_build_object('status', 'reconciled', 'discrepancyNumber', v_d.discrepancy_number));

  insert into public.after_hours_events (type, reference_type, reference_id, audience,
                                         recipient_uid, payload)
  values ('cash_discrepancy_resolved', 'discrepancy', p_discrepancy, 'recipient', v_d.staff_uid,
          jsonb_build_object('discrepancyNumber', v_d.discrepancy_number, 'outcome', p_outcome));
  if v_d.reported_by is not null and v_d.reported_by <> v_d.staff_uid then
    insert into public.after_hours_events (type, reference_type, reference_id, audience,
                                           recipient_uid, payload)
    values ('cash_discrepancy_resolved', 'discrepancy', p_discrepancy, 'recipient',
            v_d.reported_by,
            jsonb_build_object('discrepancyNumber', v_d.discrepancy_number, 'outcome', p_outcome));
  end if;

  perform app.complete_request(p_request_id, jsonb_build_object(
    'discrepancyId', p_discrepancy, 'status', p_outcome, 'lossNumber', v_lossnum,
    'adjustmentTransactionNumber', v_txnnum));

  return query select p_discrepancy, p_outcome, v_lossnum, v_txnnum;
end;
$$;
