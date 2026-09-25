-- ===========================================================================
-- RamosMAX Web — Phase E — 0021: reference numbers longer than their width
-- ===========================================================================
-- FIXES A REAL COLLISION.
--
-- `app.next_reference` padded with `lpad(n::text, width, '0')`. PostgreSQL's
-- lpad TRUNCATES when the string is longer than the width, so once a counter
-- passed its width the numbers started repeating:
--
--   lpad('1470', 3, '0') = '147'      -- the 1,470th item, colliding with the 147th
--
-- The reference implementation uses `String(n).padStart(width, '0')`, which
-- pads and never truncates. SKUs (`RMX-CHEM-001`, width 3) hit this after 999
-- items in a category; the six-wide counters would hit it after 999,999.
-- ===========================================================================

create or replace function app.next_reference(p_sequence text, p_prefix text, p_width integer default 6)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_next bigint;
  v_text text;
begin
  execute format('select nextval(%L)', 'app.' || p_sequence) into v_next;
  v_text := v_next::text;
  -- Pad to the width, and NEVER truncate past it.
  return p_prefix || case when char_length(v_text) >= p_width
                          then v_text
                          else lpad(v_text, p_width, '0') end;
end;
$$;

comment on function app.next_reference(text, text, integer) is
  'Allocates the next human-readable reference. Pads to p_width and grows beyond it rather than truncating, as String.padStart does in the reference implementation.';

-- A sequence for the regression test, so it never disturbs a real counter.
create sequence if not exists app.test_reference_seq as bigint start 1;
