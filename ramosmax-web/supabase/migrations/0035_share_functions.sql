-- ===========================================================================
-- RamosMAX Web — Final phase — 0035: issues, transfers, adjustments,
-- contributions, reversals and point-in-time ownership
-- ===========================================================================
-- Ports `functions/src/shares.js`.
--
--   pending_approval ──approve (another person)──► posted ──reverse──► reversed
--          └────────────reject (reason)──────────► rejected
--
-- NOTHING IS EDITED. A correction is a new entry; a mistake is reversed by its
-- mirror image, effective the day it is made. Ownership on any date is the sum
-- of the applied lines effective on or before it, so a later entry can never
-- change an earlier answer.
--
-- The commitment is ALWAYS computed here as shares × the class's value per
-- share. Any total, percentage or contribution the browser sends is ignored.
-- ===========================================================================

create or replace function app.contribution_for(p_shares bigint, p_value_per_share bigint)
returns bigint
language plpgsql
immutable
as $$
declare v bigint;
begin
  v := p_shares * p_value_per_share;
  if v > 1000000000000::bigint then
    raise exception 'That share commitment is too large.'
      using errcode = 'invalid_parameter_value', detail = 'amount';
  end if;
  return v;
end;
$$;

create or replace function app.require_shares(p_input bigint, p_field text default 'number of shares')
returns bigint
language plpgsql
immutable
as $$
begin
  if p_input is null or p_input < 1 or p_input > 1000000000 then
    raise exception 'Enter the % as a whole number greater than zero.', p_field
      using errcode = 'invalid_parameter_value', detail = 'shares';
  end if;
  return p_input;
end;
$$;

/* Whether a payment of [p_amount] leaves an outstanding the policy allows. */
create or replace function app.check_share_payment(
  p_policy jsonb, p_outstanding bigint, p_amount bigint)
returns void
language plpgsql
immutable
as $$
begin
  if p_amount > p_outstanding then
    raise exception 'The payment cannot be more than the UGX % outstanding.',
      to_char(p_outstanding, 'FM999,999,999,999')
      using errcode = 'invalid_parameter_value', detail = 'overpayment';
  end if;
  if p_outstanding - p_amount > 0 then
    if p_amount = 0 and not (p_policy ->> 'allowUnpaidShares')::boolean then
      raise exception 'The share policy requires shares to be paid when they are issued.'
        using errcode = 'raise_exception', detail = 'full_payment_required';
    end if;
    if p_amount > 0 and not (p_policy ->> 'allowPartialPayment')::boolean then
      raise exception 'The share policy does not allow shares to be part-paid.'
        using errcode = 'raise_exception', detail = 'partial_payment_not_allowed';
    end if;
  end if;
end;
$$;

create or replace function app.payment_status_of(p_committed bigint, p_paid bigint)
returns text
language sql
immutable
as $$
  select case when p_paid >= p_committed then 'paid'
              when p_paid > 0 then 'partially_paid' else 'unpaid' end;
$$;

create or replace function app.require_can_receive_shares(p_sh public.shareholders)
returns void
language plpgsql
immutable
as $$
begin
  if p_sh.status <> 'active' then
    raise exception '% is % and cannot receive new shares.', p_sh.full_name, p_sh.status
      using errcode = 'raise_exception', detail = 'shareholder_not_active';
  end if;
end;
$$;

create or replace function app.require_can_transfer_out(p_sh public.shareholders)
returns void
language plpgsql
immutable
as $$
begin
  if p_sh.status in ('suspended', 'exited') then
    raise exception '% is %; their shares cannot be transferred.', p_sh.full_name, p_sh.status
      using errcode = 'raise_exception', detail = 'shareholder_not_active';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Contributions
-- ---------------------------------------------------------------------------

/*
 * Writes ONE contribution and, for money through an account, ONE
 * `share_capital_contribution` ledger entry — in the same transaction as the
 * ownership change that needed it.
 */
create or replace function app.write_share_contribution(
  p_share_txn  uuid,
  p_amount     bigint,
  p_source     text,
  p_account    uuid,
  p_date       date,
  p_reference  text,
  p_request_id text
)
returns table (contribution_id uuid, contribution_number text,
               financial_transaction_id uuid, financial_transaction_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_t      public.share_transactions%rowtype;
  v_sh     public.shareholders%rowtype;
  v_acct   public.financial_accounts%rowtype;
  v_number text;
  v_id     uuid;
  v_txn    uuid;
  v_txn_no text;
begin
  select * into v_t from public.share_transactions where id = p_share_txn;
  v_sh := app.read_shareholder(v_t.to_shareholder_id);
  v_number := app.next_reference('contribution_number_seq', 'RMX-SHR-CON-');

  if p_source = 'account' then
    v_acct := app.require_active_account(p_account);
    v_txn := app.post_transaction(
      p_type => 'share_capital_contribution', p_amount => p_amount, p_to => p_account,
      p_reference_type => 'share_transaction', p_reference_id => p_share_txn,
      p_description => format('Share capital %s from %s (%s)', v_number, v_sh.shareholder_number,
                              v_t.transaction_number),
      p_reference => p_reference, p_request_id => p_request_id, p_date => p_date,
      p_approved_by => auth.uid());
    select t.transaction_number into v_txn_no
      from public.financial_transactions t where t.id = v_txn;
  end if;

  insert into public.share_contributions
    (contribution_number, shareholder_id, shareholder_number, shareholder_name, class_id, class_code,
     share_transaction_id, share_transaction_number, amount_ugx, source, account_id, account_name,
     financial_transaction_id, financial_transaction_number, payment_date, reference, request_id,
     created_by, created_by_name)
  values
    (v_number, v_sh.id, v_sh.shareholder_number, v_sh.full_name, v_t.class_id, v_t.class_code,
     p_share_txn, v_t.transaction_number, p_amount, p_source,
     case when p_source = 'account' then p_account end, v_acct.name,
     v_txn, v_txn_no, p_date, p_reference, p_request_id,
     auth.uid(), (select full_name from public.users where id = auth.uid()))
  returning id into v_id;

  perform app.audit('share_contribution.recorded', 'shareholders', v_id::text, null, v_number, null, null,
    jsonb_build_object('contributionNumber', v_number, 'shareholderNumber', v_sh.shareholder_number,
                       'shareTransactionNumber', v_t.transaction_number, 'amountUgx', p_amount,
                       'source', p_source, 'financialTransactionNumber', v_txn_no));

  return query select v_id, v_number, v_txn, v_txn_no;
end;
$$;

-- ---------------------------------------------------------------------------
-- Posting
-- ---------------------------------------------------------------------------

/*
 * Posts a pending entry. EVERYTHING is re-validated here, so an approval never
 * posts something that stopped being valid while it waited: two pending
 * transfers cannot together take more shares than are owned.
 */
create or replace function app.post_share_transaction(p_txn uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_t      public.share_transactions%rowtype;
  v_cls    public.share_classes%rowtype;
  v_from   public.shareholders%rowtype;
  v_to     public.shareholders%rowtype;
  v_line   jsonb;
  v_policy jsonb := app.share_policy();
  v_paid   bigint := 0;
  v_held   bigint;
  v_contribution uuid;
begin
  select * into v_t from public.share_transactions where id = p_txn for update;

  -- SERIALISE every posting that touches these shareholders.
  --
  -- Without this, two transfers of 60 out of 100 would each read the same
  -- history and both succeed, leaving the holdings disagreeing with the
  -- ledger. The lock is taken in id order so two postings can never deadlock
  -- against each other, and it is held until the transaction commits — so the
  -- re-validation below sees whatever the other one did.
  perform 1 from public.shareholders
   where id = any (v_t.shareholder_ids) order by id for update;

  perform app.require_record_date_open(v_t.effective_date);
  v_cls := app.read_share_class(v_t.class_id);

  if v_t.type = 'shares_issued' then
    v_to := app.read_shareholder(v_t.to_shareholder_id);
    perform app.require_can_receive_shares(v_to);
    if not v_cls.active then
      raise exception 'The % share class is inactive.', v_cls.code
        using errcode = 'raise_exception', detail = 'share_class_inactive';
    end if;
    perform app.check_share_payment(v_policy, v_t.committed_ugx,
      coalesce((v_t.payment ->> 'amountUgx')::bigint, 0));

  elsif v_t.type = 'shares_transferred' then
    v_from := app.read_shareholder(v_t.from_shareholder_id);
    v_to   := app.read_shareholder(v_t.to_shareholder_id);
    perform app.require_can_transfer_out(v_from);
    perform app.require_can_receive_shares(v_to);
    select coalesce(outstanding_ugx, 0) into v_held from public.shareholdings
     where shareholder_id = v_from.id and class_id = v_t.class_id;
    if coalesce(v_held, 0) > 0 then
      raise exception '% has an unpaid % share commitment. Record the payment before transferring.',
        v_from.full_name, v_t.class_code
        using errcode = 'raise_exception', detail = 'outstanding_commitment';
    end if;

  elsif v_t.type = 'shares_adjusted' then
    v_to := app.read_shareholder((v_t.lines -> 0 ->> 'shareholderId')::uuid);
    if v_to.status = 'exited' then
      raise exception 'This shareholder has exited.'
        using errcode = 'raise_exception', detail = 'shareholder_not_active';
    end if;
  end if;

  -- No line may make anyone's holding negative on ANY day, now or in the past.
  for v_line in select * from jsonb_array_elements(v_t.lines) loop
    if (v_line ->> 'deltaShares')::bigint < 0 then
      if not app.never_negative((v_line ->> 'shareholderId')::uuid, v_t.class_id,
             jsonb_build_array(jsonb_build_object(
               'effectiveDate', v_t.effective_date, 'delta', (v_line ->> 'deltaShares')::bigint))) then
        raise exception '% would not have held enough shares on that date. Choose a later effective date.',
          v_line ->> 'shareholderName'
          using errcode = 'raise_exception', detail = 'insufficient_shares';
      end if;
    end if;
  end loop;

  -- Apply. The entry becomes part of the ledger, and every derived figure is
  -- rebuilt from it.
  update public.share_transactions
     set status = 'posted', applied = true
   where id = p_txn;

  if v_t.type = 'shares_issued' and coalesce((v_t.payment ->> 'amountUgx')::bigint, 0) > 0 then
    select c.contribution_id into v_contribution from app.write_share_contribution(
      p_txn, (v_t.payment ->> 'amountUgx')::bigint, v_t.payment ->> 'source',
      nullif(v_t.payment ->> 'accountId', '')::uuid, coalesce(v_t.acquisition_date, v_t.effective_date),
      v_t.reference, v_t.request_id) c;
    v_paid := (v_t.payment ->> 'amountUgx')::bigint;
    update public.share_transactions
       set paid_ugx = v_paid, outstanding_ugx = v_t.committed_ugx - v_paid,
           payment_status = app.payment_status_of(v_t.committed_ugx, v_paid),
           contribution_ids = array[v_contribution]
     where id = p_txn;
  elsif v_t.type = 'shares_issued' then
    update public.share_transactions
       set payment_status = app.payment_status_of(v_t.committed_ugx, 0),
           outstanding_ugx = v_t.committed_ugx
     where id = p_txn;
  end if;

  perform app.rebuild_ownership();

  return jsonb_build_object('paidUgx', v_paid, 'contributionId', v_contribution);
end;
$$;

/*
 * Records a request, or posts it at once when the share policy does not
 * require approval. A request that posts immediately is still validated,
 * audited and idempotent.
 */
create or replace function app.submit_share_transaction(p_txn uuid, p_audit_action text)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_t      public.share_transactions%rowtype;
  v_policy jsonb := app.share_policy();
  v_status text;
begin
  select * into v_t from public.share_transactions where id = p_txn;
  perform app.require_record_date_open(v_t.effective_date);

  if (v_policy ->> 'requireApproval')::boolean then
    v_status := 'pending_approval';
    insert into public.ownership_events (type, reference_type, reference_id, audience, payload)
    values ('share_transaction_pending', 'share_transaction', p_txn, 'shares.approve',
            jsonb_build_object('transactionNumber', v_t.transaction_number));
  else
    perform app.post_share_transaction(p_txn);
    update public.share_transactions
       set approved_by = auth.uid(),
           approved_by_name = (select full_name from public.users where id = auth.uid()),
           approved_at = now(), auto_approved = true
     where id = p_txn;
    v_status := 'posted';
  end if;

  select * into v_t from public.share_transactions where id = p_txn;
  perform app.audit(case when v_status = 'posted' then p_audit_action else 'shares.requested' end,
    'shareholders', p_txn::text, null, v_t.transaction_number, v_t.reason, null,
    jsonb_build_object('transactionNumber', v_t.transaction_number, 'type', v_t.type,
                       'classCode', v_t.class_code, 'shares', v_t.shares,
                       'committedUgx', v_t.committed_ugx, 'effectiveDate', v_t.effective_date,
                       'status', v_status));
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------

create or replace function app.issue_shares(
  p_shareholder     uuid,
  p_class           text,
  p_shares          bigint,
  p_request_id      text,
  p_effective_date  date default null,
  p_payment_source  text default 'account',
  p_payment_amount  bigint default null,
  p_account         uuid default null,
  p_acquisition_date date default null,
  p_reference       text default null,
  p_notes           text default null,
  p_reason          text default null
)
returns table (transaction_id uuid, transaction_number text, status text,
               committed_ugx bigint, paid_ugx bigint, outstanding_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier   jsonb;
  v_sh        public.shareholders%rowtype;
  v_cls       public.share_classes%rowtype;
  v_policy    jsonb := app.share_policy();
  v_committed bigint;
  v_amount    bigint;
  v_effective date;
  v_number    text;
  v_id        uuid;
  v_status    text;
  v_t         public.share_transactions%rowtype;
begin
  perform app.require_permission('shares.issue');
  perform app.require_request_id(p_request_id);
  perform app.require_shares(p_shares);
  if p_payment_source not in ('none', 'account', 'prior_record') then
    raise exception 'Choose how the shares were paid for.'
      using errcode = 'invalid_parameter_value', detail = 'payment_source';
  end if;
  v_amount := case when p_payment_source = 'none' then 0
                   else app.require_amount(p_payment_amount, 'amount paid', 1, app.max_capital_ugx()) end;
  if p_payment_source = 'account' and p_account is null then
    raise exception 'Choose the account the money was received into.'
      using errcode = 'invalid_parameter_value', detail = 'account';
  end if;
  v_effective := app.require_business_date(p_effective_date, 'effective date');
  if p_payment_source = 'prior_record' then perform app.require_reason(p_reason); end if;

  v_earlier := app.claim_request(p_request_id, 'share_issue',
    jsonb_build_object('shareholder', p_shareholder, 'class', lower(p_class), 'shares', p_shares));
  if v_earlier is not null then
    return query select (v_earlier ->> 'transaction_id')::uuid, v_earlier ->> 'transaction_number',
                        v_earlier ->> 'status', (v_earlier ->> 'committed_ugx')::bigint,
                        (v_earlier ->> 'paid_ugx')::bigint, (v_earlier ->> 'outstanding_ugx')::bigint;
    return;
  end if;

  v_sh  := app.read_shareholder(p_shareholder);
  v_cls := app.read_share_class(p_class);
  perform app.require_can_receive_shares(v_sh);
  if not v_cls.active then
    raise exception 'The % share class is inactive.', v_cls.code
      using errcode = 'raise_exception', detail = 'share_class_inactive';
  end if;

  -- The commitment is the server's arithmetic, from the class's own price.
  v_committed := app.contribution_for(p_shares, v_cls.value_per_share_ugx);
  perform app.check_share_payment(v_policy, v_committed, v_amount);

  v_number := app.next_reference('share_txn_number_seq', 'RMX-SHR-TXN-');
  insert into public.share_transactions
    (transaction_number, type, class_id, class_code, class_name, shares, value_per_share_ugx,
     committed_ugx, outstanding_ugx, payment_status, lines, shareholder_ids, to_shareholder_id,
     payment, acquisition_date, effective_date, reference, notes, reason, requested_by,
     requested_by_name, request_id)
  values
    (v_number, 'shares_issued', v_cls.id, v_cls.code, v_cls.name, p_shares, v_cls.value_per_share_ugx,
     v_committed, v_committed, 'unpaid',
     jsonb_build_array(jsonb_build_object(
       'shareholderId', v_sh.id, 'shareholderNumber', v_sh.shareholder_number,
       'shareholderName', v_sh.full_name, 'deltaShares', p_shares,
       'committedDeltaUgx', v_committed, 'sharesAfter', null)),
     array[v_sh.id], v_sh.id,
     jsonb_build_object('source', p_payment_source, 'amountUgx', v_amount,
                        'accountId', p_account),
     app.require_business_date(coalesce(p_acquisition_date, v_effective), 'acquisition date'),
     v_effective, app.optional_text(p_reference, 'Reference', 60),
     app.optional_text(p_notes, 'Notes', 500), app.optional_text(p_reason, 'Reason', 300),
     auth.uid(), (select full_name from public.users where id = auth.uid()), p_request_id)
  returning id into v_id;

  v_status := app.submit_share_transaction(v_id, 'shares.issued');
  select * into v_t from public.share_transactions where id = v_id;

  perform app.complete_request(p_request_id, jsonb_build_object(
    'transaction_id', v_id, 'transaction_number', v_number, 'status', v_status,
    'committed_ugx', v_t.committed_ugx, 'paid_ugx', v_t.paid_ugx,
    'outstanding_ugx', v_t.outstanding_ugx));

  return query select v_id, v_number, v_status, v_t.committed_ugx, v_t.paid_ugx, v_t.outstanding_ugx;
end;
$$;

/* Moves shares between two shareholders. Creates none: the total is unchanged. */
create or replace function app.transfer_shares(
  p_from uuid, p_to uuid, p_class text, p_shares bigint, p_reason text, p_request_id text,
  p_effective_date date default null, p_reference text default null, p_notes text default null)
returns table (transaction_id uuid, transaction_number text, status text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_from    public.shareholders%rowtype;
  v_to      public.shareholders%rowtype;
  v_cls     public.share_classes%rowtype;
  v_held    bigint;
  v_number  text;
  v_id      uuid;
  v_status  text;
  v_effective date;
begin
  perform app.require_permission('shares.transfer');
  perform app.require_request_id(p_request_id);
  perform app.require_shares(p_shares);
  perform app.require_reason(p_reason);
  if p_from = p_to then
    raise exception 'Choose two different shareholders.'
      using errcode = 'invalid_parameter_value', detail = 'same_shareholder';
  end if;
  v_effective := app.require_business_date(p_effective_date, 'effective date');

  v_earlier := app.claim_request(p_request_id, 'share_transfer',
    jsonb_build_object('from', p_from, 'to', p_to, 'class', lower(p_class), 'shares', p_shares));
  if v_earlier is not null then
    return query select (v_earlier ->> 'transaction_id')::uuid, v_earlier ->> 'transaction_number',
                        v_earlier ->> 'status';
    return;
  end if;

  v_from := app.read_shareholder(p_from);
  v_to   := app.read_shareholder(p_to);
  v_cls  := app.read_share_class(p_class);
  perform app.require_can_transfer_out(v_from);
  perform app.require_can_receive_shares(v_to);

  select coalesce(shares, 0) into v_held from public.shareholdings
   where shareholder_id = p_from and class_id = v_cls.id;
  if coalesce(v_held, 0) < p_shares then
    raise exception '% holds only % % shares.', v_from.full_name,
      to_char(coalesce(v_held, 0), 'FM999,999,999'), v_cls.code
      using errcode = 'raise_exception', detail = 'insufficient_shares';
  end if;

  v_number := app.next_reference('share_txn_number_seq', 'RMX-SHR-TXN-');
  insert into public.share_transactions
    (transaction_number, type, class_id, class_code, class_name, shares, lines, shareholder_ids,
     from_shareholder_id, to_shareholder_id, effective_date, reference, notes, reason,
     requested_by, requested_by_name, request_id)
  values
    (v_number, 'shares_transferred', v_cls.id, v_cls.code, v_cls.name, p_shares,
     jsonb_build_array(
       jsonb_build_object('shareholderId', v_from.id, 'shareholderNumber', v_from.shareholder_number,
                          'shareholderName', v_from.full_name, 'deltaShares', -p_shares,
                          'committedDeltaUgx', 0, 'sharesAfter', null),
       jsonb_build_object('shareholderId', v_to.id, 'shareholderNumber', v_to.shareholder_number,
                          'shareholderName', v_to.full_name, 'deltaShares', p_shares,
                          'committedDeltaUgx', 0, 'sharesAfter', null)),
     array[v_from.id, v_to.id], v_from.id, v_to.id, v_effective,
     app.optional_text(p_reference, 'Reference', 60), app.optional_text(p_notes, 'Notes', 500),
     p_reason, auth.uid(), (select full_name from public.users where id = auth.uid()), p_request_id)
  returning id into v_id;

  v_status := app.submit_share_transaction(v_id, 'shares.transferred');
  perform app.complete_request(p_request_id, jsonb_build_object(
    'transaction_id', v_id, 'transaction_number', v_number, 'status', v_status));
  return query select v_id, v_number, v_status;
end;
$$;

/* A correction: ±n shares with a reason. Earlier entries stay as they were. */
create or replace function app.adjust_shares(
  p_shareholder uuid, p_class text, p_delta_shares bigint, p_reason text, p_request_id text,
  p_adjust_commitment boolean default false, p_effective_date date default null,
  p_reference text default null, p_notes text default null)
returns table (transaction_id uuid, transaction_number text, status text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier   jsonb;
  v_sh        public.shareholders%rowtype;
  v_cls       public.share_classes%rowtype;
  v_committed bigint := 0;
  v_number    text;
  v_id        uuid;
  v_status    text;
  v_effective date;
begin
  perform app.require_permission('shares.adjust');
  perform app.require_request_id(p_request_id);
  if p_delta_shares is null or p_delta_shares = 0 or abs(p_delta_shares) > app.max_shares() then
    raise exception 'Enter the correction as a whole number of shares, e.g. -5 or 10.'
      using errcode = 'invalid_parameter_value', detail = 'shares';
  end if;
  perform app.require_reason(p_reason);
  v_effective := app.require_business_date(p_effective_date, 'effective date');

  v_earlier := app.claim_request(p_request_id, 'share_adjustment',
    jsonb_build_object('shareholder', p_shareholder, 'class', lower(p_class), 'delta', p_delta_shares));
  if v_earlier is not null then
    return query select (v_earlier ->> 'transaction_id')::uuid, v_earlier ->> 'transaction_number',
                        v_earlier ->> 'status';
    return;
  end if;

  v_sh  := app.read_shareholder(p_shareholder);
  v_cls := app.read_share_class(p_class);
  if v_sh.status = 'exited' then
    raise exception 'This shareholder has exited.'
      using errcode = 'raise_exception', detail = 'shareholder_not_active';
  end if;
  if p_adjust_commitment then
    v_committed := sign(p_delta_shares) * app.contribution_for(abs(p_delta_shares), v_cls.value_per_share_ugx);
  end if;

  v_number := app.next_reference('share_txn_number_seq', 'RMX-SHR-TXN-');
  insert into public.share_transactions
    (transaction_number, type, class_id, class_code, class_name, shares, adjustment_shares,
     adjust_commitment, value_per_share_ugx, committed_ugx, lines, shareholder_ids,
     effective_date, reference, notes, reason, requested_by, requested_by_name, request_id)
  values
    (v_number, 'shares_adjusted', v_cls.id, v_cls.code, v_cls.name, abs(p_delta_shares), p_delta_shares,
     p_adjust_commitment, case when p_adjust_commitment then v_cls.value_per_share_ugx end,
     case when p_adjust_commitment then v_committed end,
     jsonb_build_array(jsonb_build_object(
       'shareholderId', v_sh.id, 'shareholderNumber', v_sh.shareholder_number,
       'shareholderName', v_sh.full_name, 'deltaShares', p_delta_shares,
       'committedDeltaUgx', v_committed, 'sharesAfter', null)),
     array[v_sh.id], v_effective, app.optional_text(p_reference, 'Reference', 60),
     app.optional_text(p_notes, 'Notes', 500), p_reason,
     auth.uid(), (select full_name from public.users where id = auth.uid()), p_request_id)
  returning id into v_id;

  v_status := app.submit_share_transaction(v_id, 'shares.adjusted');
  perform app.complete_request(p_request_id, jsonb_build_object(
    'transaction_id', v_id, 'transaction_number', v_number, 'status', v_status));
  return query select v_id, v_number, v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Approval
-- ---------------------------------------------------------------------------

/*
 * approve posts a pending entry (everything re-validated); reject closes it
 * with a reason. THE REQUESTER CANNOT DECIDE THEIR OWN REQUEST, and nobody
 * decides a transaction on their own shareholding.
 */
create or replace function app.decide_share_transaction(
  p_transaction uuid, p_decision text, p_reason text default null)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_t      public.share_transactions%rowtype;
  v_reason text;
  v_status text;
begin
  perform app.require_permission('shares.approve');
  if p_decision not in ('approve', 'reject') then
    raise exception 'Choose approve or reject.'
      using errcode = 'invalid_parameter_value', detail = 'decision';
  end if;
  v_reason := case when p_decision = 'reject' then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;

  select * into v_t from public.share_transactions where id = p_transaction for update;
  if v_t.id is null then
    raise exception 'That share transaction could not be found.'
      using errcode = 'no_data_found', detail = 'share_transaction_not_found';
  end if;
  if v_t.status <> 'pending_approval' then
    raise exception 'This share transaction has already been decided.'
      using errcode = 'raise_exception', detail = 'already_decided';
  end if;
  if v_t.requested_by = auth.uid() and app.current_role_id() <> 'admin' then
    raise exception 'Another person must approve a share transaction you requested.'
      using errcode = 'insufficient_privilege', detail = 'self_approval';
  end if;
  perform app.require_not_own_shareholding(v_t.shareholder_ids, 'decide a transaction on');

  if p_decision = 'approve' then
    perform app.post_share_transaction(p_transaction);
    update public.share_transactions
       set approved_by = auth.uid(),
           approved_by_name = (select full_name from public.users where id = auth.uid()),
           approved_at = now(), decision_reason = v_reason
     where id = p_transaction;
    v_status := 'posted';
  else
    update public.share_transactions
       set status = 'rejected', rejected_by = auth.uid(),
           rejected_by_name = (select full_name from public.users where id = auth.uid()),
           rejected_at = now(), decision_reason = v_reason
     where id = p_transaction;
    v_status := 'rejected';
  end if;

  insert into public.ownership_events (type, reference_type, reference_id, audience, recipient_uid, payload)
  values ('share_transaction_completed', 'share_transaction', p_transaction, 'staff', v_t.requested_by,
          jsonb_build_object('transactionNumber', v_t.transaction_number));

  perform app.audit(case when v_status = 'posted'
                         then replace(v_t.type, 'shares_', 'shares.') else 'shares.rejected' end,
    'shareholders', p_transaction::text, null, v_t.transaction_number, v_reason,
    jsonb_build_object('status', 'pending_approval'),
    jsonb_build_object('status', v_status, 'transactionNumber', v_t.transaction_number,
                       'type', v_t.type, 'shares', v_t.shares, 'requestedBy', v_t.requested_by));
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Later money against an issue
-- ---------------------------------------------------------------------------

create or replace function app.record_share_contribution(
  p_share_transaction uuid, p_amount bigint, p_request_id text,
  p_source text default 'account', p_account uuid default null,
  p_payment_date date default null, p_reference text default null, p_reason text default null)
returns table (contribution_id uuid, contribution_number text, outstanding_ugx bigint,
               financial_transaction_id uuid, financial_transaction_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_t       public.share_transactions%rowtype;
  v_sh      public.shareholders%rowtype;
  v_c       record;
  v_paid    bigint;
  v_date    date;
begin
  perform app.require_permission('shares.issue');
  perform app.require_request_id(p_request_id);
  if p_source not in ('account', 'prior_record') then
    raise exception 'Choose how the money was received.'
      using errcode = 'invalid_parameter_value', detail = 'payment_source';
  end if;
  perform app.require_amount(p_amount, 'amount paid', 1, app.max_capital_ugx());
  if p_source = 'prior_record' then perform app.require_reason(p_reason); end if;
  if p_source = 'account' and p_account is null then
    raise exception 'Choose the account the money was received into.'
      using errcode = 'invalid_parameter_value', detail = 'account';
  end if;
  v_date := app.require_business_date(p_payment_date, 'payment date');

  v_earlier := app.claim_request(p_request_id, 'share_contribution',
    jsonb_build_object('txn', p_share_transaction, 'amount', p_amount));
  if v_earlier is not null then
    return query select (v_earlier ->> 'contribution_id')::uuid, v_earlier ->> 'contribution_number',
                        (v_earlier ->> 'outstanding_ugx')::bigint,
                        nullif(v_earlier ->> 'financial_transaction_id', '')::uuid,
                        v_earlier ->> 'financial_transaction_number';
    return;
  end if;

  select * into v_t from public.share_transactions where id = p_share_transaction for update;
  if v_t.id is null then
    raise exception 'That share transaction could not be found.'
      using errcode = 'no_data_found', detail = 'share_transaction_not_found';
  end if;
  if v_t.type <> 'shares_issued' or v_t.status <> 'posted' then
    raise exception 'Payments are recorded against posted share issues only.'
      using errcode = 'raise_exception', detail = 'not_payable';
  end if;
  perform app.check_share_payment(app.share_policy(), v_t.outstanding_ugx, p_amount);

  v_sh := app.read_shareholder(v_t.to_shareholder_id);
  if v_sh.status = 'exited' then
    raise exception 'This shareholder has exited.'
      using errcode = 'raise_exception', detail = 'shareholder_not_active';
  end if;

  select * into v_c from app.write_share_contribution(
    p_share_transaction, p_amount, p_source, p_account, v_date, p_reference, p_request_id);

  v_paid := v_t.paid_ugx + p_amount;
  update public.share_transactions
     set paid_ugx = v_paid, outstanding_ugx = v_t.committed_ugx - v_paid,
         payment_status = app.payment_status_of(v_t.committed_ugx, v_paid),
         contribution_ids = contribution_ids || v_c.contribution_id
   where id = p_share_transaction;

  perform app.rebuild_ownership();

  if p_reason is not null then
    perform app.audit('share_contribution.prior_record', 'shareholders', v_c.contribution_id::text,
      null, v_c.contribution_number, p_reason, null, jsonb_build_object('amountUgx', p_amount));
  end if;

  perform app.complete_request(p_request_id, jsonb_build_object(
    'contribution_id', v_c.contribution_id, 'contribution_number', v_c.contribution_number,
    'outstanding_ugx', v_t.committed_ugx - v_paid,
    'financial_transaction_id', v_c.financial_transaction_id,
    'financial_transaction_number', v_c.financial_transaction_number));

  return query select v_c.contribution_id, v_c.contribution_number, v_t.committed_ugx - v_paid,
                      v_c.financial_transaction_id, v_c.financial_transaction_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reversals
-- ---------------------------------------------------------------------------

create or replace function app.reverse_share_contribution(p_contribution uuid, p_reason text)
returns table (contribution_id uuid, transaction_id uuid, transaction_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_c      public.share_contributions%rowtype;
  v_t      public.share_transactions%rowtype;
  v_reason text;
  v_rev    record;
  v_paid   bigint;
begin
  perform app.require_permission('shares.adjust');
  v_reason := app.require_reason(p_reason);

  select * into v_c from public.share_contributions where id = p_contribution for update;
  if v_c.id is null then
    raise exception 'That contribution could not be found.'
      using errcode = 'no_data_found', detail = 'contribution';
  end if;
  if v_c.status <> 'posted' then
    raise exception 'This contribution has already been reversed.'
      using errcode = 'raise_exception', detail = 'already_reversed';
  end if;
  select * into v_t from public.share_transactions where id = v_c.share_transaction_id for update;

  if v_c.financial_transaction_id is not null then
    -- The money leaves the account again; refused if it no longer holds it.
    select * into v_rev from app.post_ownership_reversal(
      v_c.financial_transaction_id, v_reason, 'share_contribution', v_c.id);
  end if;

  update public.share_contributions
     set status = 'reversed', reversed_at = now(), reversed_by = auth.uid(),
         reversal_reason = v_reason, reversal_transaction_id = v_rev.transaction_id,
         reversal_transaction_number = v_rev.transaction_number
   where id = p_contribution;

  v_paid := v_t.paid_ugx - v_c.amount_ugx;
  update public.share_transactions
     set paid_ugx = v_paid, outstanding_ugx = v_t.committed_ugx - v_paid,
         payment_status = app.payment_status_of(v_t.committed_ugx, v_paid)
   where id = v_t.id;

  perform app.rebuild_ownership();

  perform app.audit('share_contribution.reversed', 'shareholders', p_contribution::text, null,
    v_c.contribution_number, v_reason,
    jsonb_build_object('status', 'posted', 'amountUgx', v_c.amount_ugx,
                       'financialTransactionNumber', v_c.financial_transaction_number),
    jsonb_build_object('status', 'reversed', 'reversalTransactionNumber', v_rev.transaction_number,
                       'outstandingUgx', v_t.committed_ugx - v_paid));

  return query select p_contribution, v_rev.transaction_id, v_rev.transaction_number;
end;
$$;

/*
 * Posts the mirror image of a posted entry, effective TODAY; the original
 * stays in the history marked reversed. Reversing an issue also reverses its
 * live contributions and their ledger entries in the same transaction.
 */
create or replace function app.reverse_share_transaction(
  p_transaction uuid, p_reason text, p_request_id text)
returns table (transaction_id uuid, transaction_number text, contributions_reversed integer)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier jsonb;
  v_t       public.share_transactions%rowtype;
  v_reason  text;
  v_today   date := app.eat_day();
  v_c       public.share_contributions%rowtype;
  v_rev     record;
  v_count   integer := 0;
  v_line    jsonb;
  v_lines   jsonb := '[]'::jsonb;
  v_number  text;
  v_id      uuid;
  v_sh      public.shareholders%rowtype;
begin
  perform app.require_permission('shares.adjust');
  perform app.require_request_id(p_request_id);
  v_reason := app.require_reason(p_reason);

  v_earlier := app.claim_request(p_request_id, 'share_reversal',
    jsonb_build_object('txn', p_transaction));
  if v_earlier is not null then
    return query select (v_earlier ->> 'transaction_id')::uuid, v_earlier ->> 'transaction_number',
                        (v_earlier ->> 'contributions_reversed')::integer;
    return;
  end if;

  select * into v_t from public.share_transactions where id = p_transaction for update;
  if v_t.id is null then
    raise exception 'That share transaction could not be found.'
      using errcode = 'no_data_found', detail = 'share_transaction_not_found';
  end if;
  if v_t.type = 'reversal' then
    raise exception 'A reversal cannot itself be reversed.'
      using errcode = 'raise_exception', detail = 'is_reversal';
  end if;
  if v_t.status = 'reversed' then
    raise exception 'This share transaction has already been reversed.'
      using errcode = 'raise_exception', detail = 'already_reversed';
  end if;
  if v_t.status <> 'posted' then
    raise exception 'Only a posted share transaction can be reversed.'
      using errcode = 'raise_exception', detail = 'not_posted';
  end if;
  perform app.require_record_date_open(v_today);

  -- The mirror image. Shares must still be held, and cannot be returned to
  -- someone who has exited.
  for v_line in select * from jsonb_array_elements(v_t.lines) loop
    if (v_line ->> 'deltaShares')::bigint > 0 then
      if not app.never_negative((v_line ->> 'shareholderId')::uuid, v_t.class_id,
             jsonb_build_array(jsonb_build_object(
               'effectiveDate', v_today, 'delta', -(v_line ->> 'deltaShares')::bigint))) then
        raise exception 'Those shares are no longer held by %. They cannot be reversed.',
          v_line ->> 'shareholderName'
          using errcode = 'raise_exception', detail = 'insufficient_shares';
      end if;
    else
      v_sh := app.read_shareholder((v_line ->> 'shareholderId')::uuid);
      if v_sh.status = 'exited' then
        raise exception '% has exited; reactivate them before shares are returned to them.',
          v_sh.full_name
          using errcode = 'raise_exception', detail = 'shareholder_not_active';
      end if;
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'shareholderId', v_line ->> 'shareholderId',
      'shareholderNumber', v_line ->> 'shareholderNumber',
      'shareholderName', v_line ->> 'shareholderName',
      'deltaShares', -(v_line ->> 'deltaShares')::bigint,
      'committedDeltaUgx', -coalesce((v_line ->> 'committedDeltaUgx')::bigint, 0),
      'sharesAfter', null));
  end loop;

  -- Its live contributions go back too, atomically.
  for v_c in select * from public.share_contributions
              where share_transaction_id = p_transaction and status = 'posted' for update loop
    v_rev := null;
    if v_c.financial_transaction_id is not null then
      select * into v_rev from app.post_ownership_reversal(
        v_c.financial_transaction_id, v_reason, 'share_contribution', v_c.id);
    end if;
    update public.share_contributions
       set status = 'reversed', reversed_at = now(), reversed_by = auth.uid(),
           reversal_reason = v_reason, reversal_transaction_id = v_rev.transaction_id,
           reversal_transaction_number = v_rev.transaction_number
     where id = v_c.id;
    v_count := v_count + 1;
  end loop;

  v_number := app.next_reference('share_txn_number_seq', 'RMX-SHR-TXN-');
  insert into public.share_transactions
    (transaction_number, type, status, applied, reversal_of_type, reversal_of_id, reversal_of_number,
     class_id, class_code, class_name, shares, lines, shareholder_ids, from_shareholder_id,
     to_shareholder_id, effective_date, reason, requested_by, requested_by_name,
     approved_by, approved_by_name, approved_at, request_id)
  values
    (v_number, 'reversal', 'posted', true, v_t.type, v_t.id, v_t.transaction_number,
     v_t.class_id, v_t.class_code, v_t.class_name, v_t.shares, v_lines, v_t.shareholder_ids,
     v_t.to_shareholder_id, v_t.from_shareholder_id, v_today, v_reason,
     auth.uid(), (select full_name from public.users where id = auth.uid()),
     auth.uid(), (select full_name from public.users where id = auth.uid()), now(), p_request_id)
  returning id into v_id;

  update public.share_transactions
     set status = 'reversed', reversed_by_id = v_id, reversed_by_number = v_number,
         reversed_at = now(), reversed_by = auth.uid(), reversal_reason = v_reason,
         paid_ugx = case when v_t.type = 'shares_issued' then 0 else paid_ugx end,
         outstanding_ugx = case when v_t.type = 'shares_issued' then 0 else outstanding_ugx end,
         payment_status = case when v_t.type = 'shares_issued' then 'reversed' else payment_status end
   where id = p_transaction;

  perform app.rebuild_ownership();

  perform app.audit('shares.reversed', 'shareholders', p_transaction::text, null,
    v_t.transaction_number, v_reason,
    jsonb_build_object('status', 'posted', 'transactionNumber', v_t.transaction_number, 'type', v_t.type),
    jsonb_build_object('status', 'reversed', 'reversalTransactionNumber', v_number,
                       'contributionsReversed', v_count));

  perform app.complete_request(p_request_id, jsonb_build_object(
    'transaction_id', v_id, 'transaction_number', v_number, 'contributions_reversed', v_count));
  return query select v_id, v_number, v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Historical ownership
-- ---------------------------------------------------------------------------

/* The ownership distribution as it stood at the end of an EAT day. */
create or replace function app.ownership_as_of(p_date date default null, p_class text default null)
returns table (shareholder_id uuid, shareholder_number text, shareholder_name text,
               shares bigint, ownership_percent numeric, total_shares bigint, as_of date)
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_day   date;
  v_total bigint;
begin
  perform app.require_permission('shares.view', 'shareholders.reports.view');
  v_day := app.require_business_date(p_date, 'date');
  select coalesce(sum(h.shares), 0) into v_total
    from app.holdings_as_of(v_day, p_class) h where h.shares > 0;

  return query
    select h.shareholder_id, s.shareholder_number, s.full_name, h.shares,
           app.ownership_percent(h.shares, v_total), v_total, v_day
      from app.holdings_as_of(v_day, p_class) h
      join public.shareholders s on s.id = h.shareholder_id
     where h.shares > 0
     order by h.shares desc, s.shareholder_number;
end;
$$;

/*
 * The lines of an entry with `sharesAfter` computed from the ledger.
 *
 * The reference stores that figure on the line. Here it is DERIVED, because a
 * stored running total is a second copy of ownership that could disagree with
 * the entries — and the ownership lines themselves are frozen by a trigger.
 */
create or replace function app.share_transaction_lines(p_transaction uuid)
returns table (shareholder_id uuid, shareholder_number text, shareholder_name text,
               delta_shares bigint, committed_delta_ugx bigint, shares_after bigint)
language sql
stable
-- Runs as the CALLER, so the row policy on `share_transactions` decides
-- whether they may see the entry at all.
security invoker
as $$
  select (l ->> 'shareholderId')::uuid,
         l ->> 'shareholderNumber',
         l ->> 'shareholderName',
         (l ->> 'deltaShares')::bigint,
         coalesce((l ->> 'committedDeltaUgx')::bigint, 0),
         case when t.applied then coalesce((
           select sum((l2 ->> 'deltaShares')::bigint)::bigint
             from public.share_transactions t2, jsonb_array_elements(t2.lines) l2
            where t2.applied and t2.class_id = t.class_id
              and (t2.effective_date < t.effective_date
                   or (t2.effective_date = t.effective_date and t2.created_at <= t.created_at))
              and (l2 ->> 'shareholderId') = (l ->> 'shareholderId')), 0) end
    from public.share_transactions t, jsonb_array_elements(t.lines) l
   where t.id = p_transaction;
$$;
