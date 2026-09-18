-- COME ALONG — backend. 2026-09-06.
-- Paste this WHOLE file into the Supabase SQL Editor (same project as Up
-- For It) AFTER supabase/up-for-it-SETUP.sql has been run. Safe to re-run.
-- Brand-new ca_* tables and functions only. It calls exactly two Up For It
-- functions and reads none of its tables:
--   uf_host_id(key)  — is this a live Up For It host key? (hosts create)
--   uf_hash(text)    — the fleet's sha256 for device tokens and edit keys
--
-- A come-along is a Btown group going to someone ELSE's event. A host picks
-- an event from the City Guide calendar, adds a meeting point, a meet time
-- and one line of invitation, and gets one link: /up-for-it/go/?c=ABCDEF.
-- Readers tap "I'm coming" with a FIRST NAME ONLY — no email, no account,
-- the device token is the identity. It is always "on" (no threshold), and
-- it ends itself when the event ends (computed, never a job).
--
-- Privacy shape: first names and counts are public; the device token is
-- stored hashed; the host's edit key is stored hashed and returned ONCE at
-- create. No emails anywhere in ca_*.
--
-- Rules mirrored by js/along-core.js and js/along-backend.js (change all
-- three together): field limits, meet window (−24h … +6h of event start),
-- cap 0..60, one name per device per plan, 20 open joins per device, 20
-- creates per host per day, sweep 30 days after the event ended.

create table if not exists public.ca_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$'),
  host_id uuid not null references public.uf_hosts(id) on delete cascade,
  host_name text not null check (length(host_name) between 1 and 32),
  event_id text not null default '' check (length(event_id) <= 40),
  event_title text not null check (length(event_title) between 2 and 120),
  event_url text not null default '' check (length(event_url) <= 300),
  event_venue text not null default '' check (length(event_venue) <= 80),
  event_address text not null default '' check (length(event_address) <= 120),
  event_start timestamptz not null,
  event_end timestamptz check (event_end is null or event_end >= event_start),
  meet_place text not null check (length(meet_place) between 2 and 80),
  meet_at timestamptz not null,
  invite text not null check (length(invite) between 1 and 140),
  look_for text not null default '' check (length(look_for) <= 80),
  cap int not null default 0 check (cap between 0 and 60),
  status text not null default 'open' check (status in ('open','cancelled')),
  edit_hash text not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check (meet_at >= event_start - interval '24 hours' and meet_at <= event_start + interval '6 hours')
);
create index if not exists ca_plans_event on public.ca_plans (event_id);
create index if not exists ca_plans_host on public.ca_plans (host_id, created_at desc);
create index if not exists ca_plans_time on public.ca_plans (status, event_start);

create table if not exists public.ca_going (
  plan_id uuid not null references public.ca_plans(id) on delete cascade,
  token_hash text not null,
  name text not null check (length(name) between 1 and 24),
  created_at timestamptz not null default now(),
  primary key (plan_id, token_hash)
);
create index if not exists ca_going_token on public.ca_going (token_hash);

alter table public.ca_plans enable row level security;
alter table public.ca_going enable row level security;
-- no policies: anon reaches the data only through the functions below

-- --------------------------------------------------------------- helpers
create or replace function public.ca_clean(p text, p_max int) returns text
language sql immutable as $$
  select left(btrim(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''), '[[:cntrl:]]', ' ', 'g'),
         '\m(https?://|www\.)\S+', '', 'gi'), '\s+', ' ', 'g')), p_max);
$$;
create or replace function public.ca_end_of(p ca_plans) returns timestamptz
language sql immutable as $$ select coalesce(p.event_end, p.event_start + interval '3 hours'); $$;

create or replace function public.ca_mint_code() returns text
language plpgsql as $$
declare a text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; c text; i int;
begin
  for i in 1..50 loop
    c := '';
    for i in 1..6 loop c := c || substr(a, 1 + floor(random() * length(a))::int, 1); end loop;
    if not exists (select 1 from ca_plans where code = c) then return c; end if;
  end loop;
  raise exception 'error';
end $$;

create or replace function public.ca_sweep() returns void
language sql security definer set search_path = public as $$
  delete from ca_plans p where ca_end_of(p) < now() - interval '30 days';
$$;

create or replace function public.ca_find(p_code text) returns ca_plans
language plpgsql stable security definer set search_path = public as $$
declare c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); p ca_plans;
begin
  if c !~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$' then raise exception 'bad_code'; end if;
  select * into p from ca_plans where code = c;
  if p.id is null then raise exception 'not_found'; end if;
  return p;
end $$;

create or replace function public.ca_public_plan(p ca_plans, h text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'code', p.code, 'host_name', p.host_name,
    'event_id', p.event_id, 'event_title', p.event_title, 'event_url', p.event_url, 'event_venue', p.event_venue, 'event_address', p.event_address,
    'event_start', p.event_start, 'event_end', p.event_end,
    'meet_place', p.meet_place, 'meet_at', p.meet_at, 'invite', p.invite, 'look_for', p.look_for, 'cap', p.cap,
    'status', p.status, 'created_at', p.created_at, 'cancelled_at', p.cancelled_at,
    'going', coalesce((select jsonb_agg(g.name order by g.created_at) from ca_going g where g.plan_id = p.id), '[]'::jsonb),
    'going_count', (select count(*) from ca_going g where g.plan_id = p.id),
    'you', h is not null and exists (select 1 from ca_going g where g.plan_id = p.id and g.token_hash = h));
$$;

-- Validates and cleans the writable fields. p_existing carries the row for a
-- patch so the meet window is checked against the real event time.
create or replace function public.ca_plan_fields(p jsonb, p_existing ca_plans default null)
returns table (event_id text, event_title text, event_url text, event_venue text, event_address text, event_start timestamptz, event_end timestamptz,
               meet_place text, meet_at timestamptz, invite text, look_for text, cap int)
language plpgsql immutable as $$
begin
  event_id := ca_clean(coalesce(p->>'event_id', p_existing.event_id, ''), 40);
  event_title := ca_clean(coalesce(p->>'event_title', p_existing.event_title, ''), 120);
  event_url := left(btrim(coalesce(p->>'event_url', p_existing.event_url, '')), 300);
  event_venue := ca_clean(coalesce(p->>'event_venue', p_existing.event_venue, ''), 80);
  event_address := ca_clean(coalesce(p->>'event_address', p_existing.event_address, ''), 120);
  begin
    event_start := coalesce((p->>'event_start')::timestamptz, p_existing.event_start);
    event_end := coalesce((p->>'event_end')::timestamptz, p_existing.event_end);
    meet_at := coalesce((p->>'meet_at')::timestamptz, p_existing.meet_at);
  exception when others then raise exception 'bad_plan'; end;
  meet_place := ca_clean(coalesce(p->>'meet_place', p_existing.meet_place, ''), 80);
  invite := ca_clean(coalesce(p->>'invite', p_existing.invite, ''), 140);
  if invite = '' then invite := 'Coming alone is normal. Look for the Btown sign.'; end if;
  look_for := ca_clean(coalesce(p->>'look_for', p_existing.look_for, ''), 80);
  begin cap := coalesce(nullif(p->>'cap', '')::int, p_existing.cap, 0); exception when others then raise exception 'bad_plan'; end;
  if length(event_title) < 2 or event_start is null or meet_at is null or length(meet_place) < 2 then raise exception 'bad_plan'; end if;
  if event_url <> '' and event_url !~* '^https://\S+$' then raise exception 'bad_plan'; end if;
  if event_end is not null and event_end < event_start then raise exception 'bad_plan'; end if;
  if meet_at < event_start - interval '24 hours' or meet_at > event_start + interval '6 hours' then raise exception 'bad_plan'; end if;
  if cap < 0 or cap > 60 then raise exception 'bad_plan'; end if;
  return next;
end $$;

-- ------------------------------------------------------------- host side
-- Create. p_key is an Up For It host key (uf_host_id handles the lockout).
-- Returns the code and the edit key ONCE; the edit key is stored hashed.
create or replace function public.ca_create(p_key text, p_plan jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_host uuid; v_name text; f record; v_edit text; v_row ca_plans;
begin
  v_host := uf_host_id(p_key);
  if v_host is null then return jsonb_build_object('error', 'bad_key'); end if;
  select name into v_name from uf_hosts where id = v_host;
  if (select count(*) from ca_plans where host_id = v_host and created_at > now() - interval '1 day') >= 20 then raise exception 'slow_down'; end if;
  select * into f from ca_plan_fields(coalesce(p_plan, '{}'::jsonb));
  if coalesce(f.event_end, f.event_start + interval '3 hours') < now() then raise exception 'happened'; end if;
  v_edit := encode(extensions.gen_random_bytes(16), 'hex');
  insert into ca_plans (code, host_id, host_name, event_id, event_title, event_url, event_venue, event_address, event_start, event_end, meet_place, meet_at, invite, look_for, cap, edit_hash)
  values (ca_mint_code(), v_host, v_name, f.event_id, f.event_title, f.event_url, f.event_venue, f.event_address, f.event_start, f.event_end, f.meet_place, f.meet_at, f.invite, f.look_for, f.cap, uf_hash(v_edit))
  returning * into v_row;
  return jsonb_build_object('code', v_row.code, 'edit_key', v_edit, 'plan', ca_public_plan(v_row));
end $$;

create or replace function public.ca_editable(p_code text, p_edit text) returns ca_plans
language plpgsql stable security definer set search_path = public as $$
declare p ca_plans;
begin
  p := ca_find(p_code);
  if coalesce(p_edit, '') !~ '^[a-f0-9]{32}$' or p.edit_hash <> uf_hash(p_edit) then raise exception 'bad_edit'; end if;
  return p;
end $$;

-- Only meet_place, meet_at, invite, look_for, cap can change. The event can't.
create or replace function public.ca_edit(p_code text, p_edit text, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p ca_plans; f record; v_going int;
begin
  p := ca_editable(p_code, p_edit);
  if p.status = 'cancelled' then raise exception 'cancelled'; end if;
  select * into f from ca_plan_fields(coalesce(p_patch, '{}'::jsonb) - 'event_id' - 'event_title' - 'event_url' - 'event_venue' - 'event_address' - 'event_start' - 'event_end', p);
  select count(*) into v_going from ca_going where plan_id = p.id;
  if f.cap > 0 and f.cap < v_going then raise exception 'cap_too_small'; end if;
  update ca_plans set meet_place = f.meet_place, meet_at = f.meet_at, invite = f.invite, look_for = f.look_for, cap = f.cap where id = p.id returning * into p;
  return ca_public_plan(p);
end $$;

create or replace function public.ca_cancel(p_code text, p_edit text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p ca_plans;
begin
  p := ca_editable(p_code, p_edit);
  if p.status <> 'cancelled' then update ca_plans set status = 'cancelled', cancelled_at = now() where id = p.id returning * into p; end if;
  return ca_public_plan(p);
end $$;

-- A host's own come-alongs, newest first, with their edit keys? No — the
-- edit key is never stored in plain, so it can't come back. The host keeps
-- the edit link from create (host.html shows it under "Come alongs").
create or replace function public.ca_host_plans(p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_host uuid;
begin
  v_host := uf_host_id(p_key);
  if v_host is null then return jsonb_build_object('error', 'bad_key'); end if;
  perform ca_sweep();
  return coalesce((select jsonb_agg(ca_public_plan(p) order by p.created_at desc) from ca_plans p where p.host_id = v_host), '[]'::jsonb);
end $$;

-- ------------------------------------------------------------ guest side
create or replace function public.ca_get(p_code text, p_token text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p ca_plans; h text := null;
begin
  perform ca_sweep();
  p := ca_find(p_code);
  if p_token is not null and p_token ~ '^[a-f0-9]{32}$' then h := uf_hash(p_token); end if;
  return ca_public_plan(p, h);
end $$;

create or replace function public.ca_join(p_code text, p_token text, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p ca_plans; h text; n text; v_going int; v_open int;
begin
  if coalesce(p_token, '') !~ '^[a-f0-9]{32}$' then raise exception 'bad_token'; end if;
  h := uf_hash(p_token);
  p := ca_find(p_code);
  if p.status = 'cancelled' then raise exception 'cancelled'; end if;
  if ca_end_of(p) < now() then raise exception 'happened'; end if;
  n := ca_clean(p_name, 24);
  if length(n) < 1 then raise exception 'bad_name'; end if;
  if exists (select 1 from ca_going where plan_id = p.id and token_hash = h) then
    update ca_going set name = n where plan_id = p.id and token_hash = h;
    return ca_public_plan(p, h);
  end if;
  select count(*) into v_going from ca_going where plan_id = p.id;
  if p.cap > 0 and v_going >= p.cap then raise exception 'full'; end if;
  select count(*) into v_open from ca_going g join ca_plans q on q.id = g.plan_id where g.token_hash = h and ca_end_of(q) > now();
  if v_open >= 20 then raise exception 'too_many_open'; end if;
  insert into ca_going (plan_id, token_hash, name) values (p.id, h, n);
  return ca_public_plan(p, h);
end $$;

create or replace function public.ca_leave(p_code text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p ca_plans; h text;
begin
  if coalesce(p_token, '') !~ '^[a-f0-9]{32}$' then raise exception 'bad_token'; end if;
  h := uf_hash(p_token);
  p := ca_find(p_code);
  delete from ca_going where plan_id = p.id and token_hash = h;
  return ca_public_plan(p, h);
end $$;

create or replace function public.ca_mine(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h text;
begin
  if coalesce(p_token, '') !~ '^[a-f0-9]{32}$' then raise exception 'bad_token'; end if;
  h := uf_hash(p_token);
  perform ca_sweep();
  return coalesce((select jsonb_agg(ca_public_plan(p, h) order by p.meet_at) from ca_plans p where exists (select 1 from ca_going g where g.plan_id = p.id and g.token_hash = h)), '[]'::jsonb);
end $$;

-- The City Guide reads this to place a "Going with Btown? → come along" chip
-- ONLY where a come-along exists: open plans whose event hasn't ended.
-- Codes, event ids/urls, times, counts. No names, ever.
create or replace function public.ca_public() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform ca_sweep();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'code', p.code, 'event_id', p.event_id, 'event_url', p.event_url, 'event_title', p.event_title,
      'event_start', p.event_start, 'event_end', p.event_end, 'meet_at', p.meet_at, 'meet_place', p.meet_place,
      'going_count', (select count(*) from ca_going g where g.plan_id = p.id), 'cap', p.cap) order by p.meet_at)
    from ca_plans p where p.status = 'open' and ca_end_of(p) > now()), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------- grants
revoke all on function public.ca_clean(text, int) from public, anon, authenticated;
revoke all on function public.ca_end_of(ca_plans) from public, anon, authenticated;
revoke all on function public.ca_mint_code() from public, anon, authenticated;
revoke all on function public.ca_sweep() from public, anon, authenticated;
revoke all on function public.ca_find(text) from public, anon, authenticated;
revoke all on function public.ca_public_plan(ca_plans, text) from public, anon, authenticated;
revoke all on function public.ca_plan_fields(jsonb, ca_plans) from public, anon, authenticated;
revoke all on function public.ca_editable(text, text) from public, anon, authenticated;
revoke all on function public.ca_create(text, jsonb) from public;
revoke all on function public.ca_edit(text, text, jsonb) from public;
revoke all on function public.ca_cancel(text, text) from public;
revoke all on function public.ca_host_plans(text) from public;
revoke all on function public.ca_get(text, text) from public;
revoke all on function public.ca_join(text, text, text) from public;
revoke all on function public.ca_leave(text, text) from public;
revoke all on function public.ca_mine(text) from public;
revoke all on function public.ca_public() from public;
grant execute on function public.ca_create(text, jsonb) to anon;
grant execute on function public.ca_edit(text, text, jsonb) to anon;
grant execute on function public.ca_cancel(text, text) to anon;
grant execute on function public.ca_host_plans(text) to anon;
grant execute on function public.ca_get(text, text) to anon;
grant execute on function public.ca_join(text, text, text) to anon;
grant execute on function public.ca_leave(text, text) to anon;
grant execute on function public.ca_mine(text) to anon;
grant execute on function public.ca_public() to anon;
