-- ===========================================================================
-- DEVELOPMENT SEED — the default financial accounts
-- ===========================================================================
-- Ports DEFAULT_ACCOUNTS from finance.js. Opening balances are ZERO: no money
-- is invented, and every shilling in the development database arrives through
-- a recorded payment.
-- ===========================================================================

insert into public.financial_accounts (code, name, type, provider, payment_method) values
  ('cash_at_hand',    'Cash at Hand',    'cash',         null,            'cash'),
  ('mtn_merchant',    'MTN Merchant',    'mobile_money', 'MTN Uganda',    'mtn_merchant'),
  ('airtel_merchant', 'Airtel Merchant', 'mobile_money', 'Airtel Uganda', 'airtel_merchant'),
  ('stanbic_main',    'Stanbic — Main',  'bank',         'Stanbic Bank',  'bank')
on conflict (code) do nothing;
