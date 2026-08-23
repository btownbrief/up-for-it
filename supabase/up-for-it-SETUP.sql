-- UP FOR IT — backend. 2026-08-23.
-- Paste this WHOLE file into the Supabase SQL Editor (same btown-games
-- project as Who's Playing, rooms, party, lake-breath) and click Run. Safe
-- to re-run. Brand-new uf_* tables and functions only — nothing here
-- touches any other app's objects.
--
-- The loop, in the same words the UI uses:
--   idea   "Sunset paddle from Oakledge · weeknights". Readers tap Pass /
--          Maybe / I'd go from a device token that is stored only hashed.
--          Five "I'd go" and the idea TIPS (tipped_at); only then is its
--          count public, and hosts see it first.
--   plan   A host claims an idea (or floats their own): real host, place,
--          cap, threshold, a date or "needs a date". Readers say "I'm in"
--          (name + email, the only place we ask). Threshold reached + a
--          date = it's ON; the edge function emails everyone who's in.
--          Then it's DONE ("9 came"), or cancelled.
--   person one token: optional email ("tell me when a host picks one up")
--          and when they're usually free (four chips).
--   host   one of the Meetup leaders. Stephen mints a 32-hex key in
--          mod.html; the key is stored sha256-hashed; host.html keeps it.
--
-- Privacy shape (load-bearing): emails live in uf_people and uf_commits
-- and are returned by NO public or host RPC. Hosts see counts and first
-- names of people who are "in" — never emails. Only the edge function
-- (service role) reads emails, to send the four messages: "a host picked
-- this up", "it's on", "tomorrow", and "called off" (only to people who
-- were in on a plan that was already on).
--
-- Honest threat model, same as the fleet: the anon key is public, so a
-- determined prankster can mint tokens and tap junk. One tap per idea per
-- token, 3 suggestions/day, 10 open "I'm in" per token, server-side
-- validation identical to js/core.js, URL stripping, and the back room
-- stop casual mischief; they do not stop a determined Sybil. Nothing is
-- presented as integrity-protected.
--
-- The moderator secret's bcrypt hash goes in uf_mod_hash() below; the
-- plaintext lives ONLY in ~/.config/btownbrief/secrets.env
-- (UP_FOR_IT_MOD_SECRET) and a password manager. Never commit it.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

create table if not exists public.uf_ideas (
  id uuid primary key default gen_random_uuid(),
  slug text unique,                                   -- seeds have one; suggestions don't
  title text not null check (length(title) between 4 and 56),
  blurb text not null default '' check (length(blurb) <= 120),
  when_hint text not null default 'any' check (when_hint in ('weeknight','sat-am','sat-pm','sunday','any')),
  category text not null default 'social' check (category in ('outdoors','food-drink','games','music','arts','learning','wellness','sports','community','social','words','film')),
  months int[] not null default '{}',                 -- 1..12; empty = year-round
  status text not null default 'live' check (status in ('live','claimed','exists','archived','pending','rejected')),
  exists_url text not null default '' check (length(exists_url) <= 200),
  exists_note text not null default '' check (length(exists_note) <= 80),
  origin text not null default 'editor' check (length(origin) <= 60),
  source text not null default 'seed' check (source in ('seed','suggested','host')),
  token_hash text,                                    -- the suggester, if any
  tipped_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists uf_ideas_status on public.uf_ideas (status, created_at desc);

create table if not exists public.uf_taps (
  idea_id uuid not null references public.uf_ideas(id) on delete cascade,
  token_hash text not null,
  answer text not null check (answer in ('yes','maybe','pass')),
  top boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (idea_id, token_hash)
);
create index if not exists uf_taps_token on public.uf_taps (token_hash, created_at desc);
create index if not exists uf_taps_recent on public.uf_taps (created_at desc);

create table if not exists public.uf_people (
  token_hash text primary key,
  email text not null default '' check (length(email) <= 120),   -- PRIVATE
  name text not null default '' check (length(name) <= 24),
  whens text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.uf_hosts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 32),    -- first name, the public face
  email text not null default '' check (length(email) <= 120),  -- PRIVATE, for Stephen
  key_hash text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.uf_plans (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid references public.uf_ideas(id) on delete set null,
  host_id uuid not null references public.uf_hosts(id) on delete cascade,
  title text not null check (length(title) between 4 and 56),
  place text not null check (length(place) between 2 and 80),
  detail text not null default '' check (length(detail) <= 200),
  category text not null default 'social' check (category in ('outdoors','food-drink','games','music','arts','learning','wellness','sports','community','social','words','film')),
  starts_at timestamptz,                              -- null = needs a date
  cap int not null default 8 check (cap between 2 and 60),
  threshold int not null default 5 check (threshold between 2 and 60),
  status text not null default 'tipping' check (status in ('tipping','on','done','cancelled')),
  meetup_url text not null default '' check (length(meetup_url) <= 200),
  showed int check (showed between 0 and 500),
  created_at timestamptz not null default now(),
  tipped_at timestamptz,
  on_at timestamptz,
  notified_claim boolean not null default false,
  notified_on boolean not null default false,
  reminded boolean not null default false,
  notified_cancel boolean not null default false
);
create index if not exists uf_plans_status on public.uf_plans (status, starts_at);
alter table public.uf_plans add column if not exists notified_cancel boolean not null default false;
create index if not exists uf_plans_host on public.uf_plans (host_id, created_at desc);

create table if not exists public.uf_commits (
  plan_id uuid not null references public.uf_plans(id) on delete cascade,
  token_hash text not null,
  name text not null check (length(name) between 1 and 24),
  email text not null check (length(email) between 5 and 120),  -- PRIVATE: edge function only
  status text not null default 'in' check (status in ('in','wait')),
  created_at timestamptz not null default now(),
  primary key (plan_id, token_hash)
);
create index if not exists uf_commits_token on public.uf_commits (token_hash);
-- notified: this person has had the "it's on" email (set by uf-notify; lets a
-- late "I'm in" on an already-on plan get the email without re-sending to all)
alter table public.uf_commits add column if not exists notified boolean not null default false;

create table if not exists public.uf_mod_fails (at timestamptz not null default now());
create table if not exists public.uf_host_fails (at timestamptz not null default now(), prefix text not null default '');
alter table public.uf_host_fails add column if not exists prefix text not null default '';

alter table public.uf_ideas enable row level security;
alter table public.uf_taps enable row level security;
alter table public.uf_people enable row level security;
alter table public.uf_hosts enable row level security;
alter table public.uf_plans enable row level security;
alter table public.uf_commits enable row level security;
alter table public.uf_mod_fails enable row level security;
alter table public.uf_host_fails enable row level security;
revoke all on table public.uf_ideas, public.uf_taps, public.uf_people, public.uf_hosts,
  public.uf_plans, public.uf_commits, public.uf_mod_fails, public.uf_host_fails from anon, authenticated;

-- --------------------------------------------------------------- helpers

create or replace function public.uf_hash(p text) returns text
language sql immutable as $$
  select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex');
$$;

create or replace function public.uf_check_token(p_token text) returns void
language plpgsql immutable as $$
begin
  if coalesce(p_token, '') !~ '^[a-f0-9]{32}$' then
    raise exception using message = 'bad_token';
  end if;
end $$;

-- Mirrors core.js cleanText: control chars → space, whitespace collapsed,
-- trimmed, URLs stripped, clipped.
create or replace function public.uf_clean(p text, p_max int) returns text
language sql immutable as $$
  select left(btrim(regexp_replace(
           regexp_replace(
             regexp_replace(coalesce(p, ''), '[[:cntrl:]]', ' ', 'g'),
             '\m(https?://|www\.)\S+', '', 'gi'),
           '\s+', ' ', 'g')), p_max);
$$;
create or replace function public.uf_clean_email(p text) returns text
language sql immutable as $$ select left(lower(btrim(coalesce(p, ''))), 120); $$;
create or replace function public.uf_valid_email(p text) returns boolean
language sql immutable as $$ select p ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'; $$;
create or replace function public.uf_valid_when(p text) returns boolean
language sql immutable as $$ select p in ('weeknight','sat-am','sat-pm','sunday'); $$;
create or replace function public.uf_valid_category(p text) returns boolean
language sql immutable as $$
  select p in ('outdoors','food-drink','games','music','arts','learning','wellness','sports','community','social','words','film');
$$;
-- canonical order of the four whens, deduped, unknown dropped
create or replace function public.uf_whens(p jsonb) returns text[]
language sql immutable as $$
  select coalesce(array_agg(c.k order by c.ord), '{}')
    from (values ('weeknight', 1), ('sat-am', 2), ('sat-pm', 3), ('sunday', 4)) c(k, ord)
   where c.k in (select jsonb_array_elements_text(coalesce(p, '[]'::jsonb)));
$$;

-- Opportunistic sweep, rides along on reads and writes.
--  • a tipping plan with no date and nobody in, older than 14 days, is
--    released (idea goes back to live) — claims can't rot;
--  • an "on" plan is done a day after it started;
--  • cancelled plans are pruned after 30 days; suggestions rejected > 30d.
create or replace function public.uf_sweep() returns void
language plpgsql security definer set search_path = public as $$
begin
  update uf_ideas i set status = 'live'
    from uf_plans p
   where p.idea_id = i.id and i.status = 'claimed' and p.status = 'tipping'
     and p.starts_at is null and p.created_at < now() - interval '14 days'
     and not exists (select 1 from uf_commits c where c.plan_id = p.id);
  delete from uf_plans p
   where p.status = 'tipping' and p.starts_at is null and p.created_at < now() - interval '14 days'
     and not exists (select 1 from uf_commits c where c.plan_id = p.id);
  update uf_plans set status = 'done'
   where status = 'on' and starts_at is not null and starts_at < now() - interval '24 hours';
  -- an idea whose plan finished, vanished, or was cancelled any other way goes back in the deck
  update uf_ideas i set status = 'live'
   where i.status = 'claimed'
     and not exists (select 1 from uf_plans q where q.idea_id = i.id and q.status in ('tipping','on'));
  delete from uf_plans where status = 'cancelled' and created_at < now() - interval '30 days';
  delete from uf_ideas where status = 'rejected' and created_at < now() - interval '30 days';
end $$;

-- ------------------------------------------------------------ projections

create or replace function public.uf_idea_public(i uf_ideas) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', i.id, 'slug', i.slug, 'title', i.title, 'blurb', i.blurb, 'when', i.when_hint,
    'category', i.category, 'months', to_jsonb(i.months), 'status', i.status,
    'exists_url', i.exists_url, 'exists_note', i.exists_note, 'tipped_at', i.tipped_at,
    'created_at', i.created_at,
    -- the count is public only after the tip (no rich-get-richer before it)
    'yes_count', case when i.tipped_at is null then null
                      else (select count(*) from uf_taps t where t.idea_id = i.id and t.answer = 'yes') end,
    'plan_id', (select p.id from uf_plans p where p.idea_id = i.id and p.status in ('tipping','on') order by p.created_at desc limit 1),
    'host_name', (select h.name from uf_plans p join uf_hosts h on h.id = p.host_id
                   where p.idea_id = i.id and p.status in ('tipping','on') order by p.created_at desc limit 1));
$$;

create or replace function public.uf_plan_public(p uf_plans) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', p.id, 'idea_id', p.idea_id, 'title', p.title, 'place', p.place, 'detail', p.detail,
    'category', p.category, 'starts_at', p.starts_at, 'cap', p.cap, 'threshold', p.threshold,
    'status', p.status, 'meetup_url', p.meetup_url, 'showed', p.showed,
    'created_at', p.created_at, 'tipped_at', p.tipped_at, 'on_at', p.on_at,
    'host_name', (select h.name from uf_hosts h where h.id = p.host_id),
    'in_count', (select count(*) from uf_commits c where c.plan_id = p.id and c.status = 'in'),
    'wait_count', (select count(*) from uf_commits c where c.plan_id = p.id and c.status = 'wait'));
$$;

-- ---------------------------------------------------------------- public

-- Everyone's plans. The Small Talk Plans tab reads this too: place + time
-- + counts only, host first name only, never who. Statuses: tipping | on |
-- done | cancelled. Dated-and-on is what other apps should show.
create or replace function public.uf_plans_public() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform uf_sweep();
  return coalesce((select jsonb_agg(uf_plan_public(p) order by p.starts_at nulls last, p.created_at)
                     from uf_plans p
                    where p.status in ('tipping','on')
                       or (p.status = 'done' and p.starts_at > now() - interval '14 days')), '[]'::jsonb);
end $$;

create or replace function public.uf_ideas_public() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_agg(uf_idea_public(i) order by i.created_at desc)
                     from uf_ideas i where i.status in ('live','claimed','exists')), '[]'::jsonb);
$$;

-- Everything this device owns: its taps, its "I'm in"s, its email/whens.
create or replace function public.uf_my_json(h text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'taps', coalesce((select jsonb_agg(jsonb_build_object('idea_id', t.idea_id, 'answer', t.answer, 'top', t.top, 'created_at', t.created_at) order by t.created_at desc)
                        from uf_taps t where t.token_hash = h), '[]'::jsonb),
    'commits', coalesce((select jsonb_agg(jsonb_build_object('plan_id', c.plan_id, 'status', c.status, 'name', c.name, 'created_at', c.created_at) order by c.created_at desc)
                           from uf_commits c where c.token_hash = h), '[]'::jsonb),
    'email', coalesce((select p.email from uf_people p where p.token_hash = h), ''),
    'name', coalesce((select p.name from uf_people p where p.token_hash = h), ''),
    'whens', coalesce((select to_jsonb(p.whens) from uf_people p where p.token_hash = h), '[]'::jsonb));
$$;

-- One call for the home screen. p_token may be null (first visit, nothing
-- owned yet). deck_left = live, in-season-agnostic ideas this device hasn't
-- tapped; the client orders and cuts to 12.
create or replace function public.uf_home(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h text := null;
begin
  if p_token is not null then perform uf_check_token(p_token); h := uf_hash(p_token); end if;
  perform uf_sweep();
  return jsonb_build_object(
    'plans', uf_plans_public(),
    'ideas', uf_ideas_public(),
    'mine', case when h is null then null else uf_my_json(h) end,
    'weigh_in', (select count(distinct token_hash) from uf_taps where created_at > now() - interval '7 days'),
    'deck_left', (select count(*) from uf_ideas i where i.status = 'live'
                    and (h is null or not exists (select 1 from uf_taps t where t.idea_id = i.id and t.token_hash = h))));
end $$;

create or replace function public.uf_mine(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform uf_check_token(p_token);
  perform uf_sweep();
  return uf_my_json(uf_hash(p_token));
end $$;

-- The deck: live ideas this device hasn't answered. Order is the client's
-- (deterministic per token).
create or replace function public.uf_deck(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h text;
begin
  perform uf_check_token(p_token);
  h := uf_hash(p_token);
  return coalesce((select jsonb_agg(uf_idea_public(i) order by i.created_at)
                     from uf_ideas i
                    where i.status = 'live'
                      and not exists (select 1 from uf_taps t where t.idea_id = i.id and t.token_hash = h)), '[]'::jsonb);
end $$;

-- One tap per idea per device (re-tapping changes the answer). Returns
-- whether the idea has tipped — the client never sees a count before that.
create or replace function public.uf_tap(p_token text, p_idea uuid, p_answer text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h text; i uf_ideas%rowtype; n int;
begin
  perform uf_check_token(p_token);
  h := uf_hash(p_token);
  if p_answer not in ('yes','maybe','pass') then raise exception using message = 'bad_tap'; end if;
  select * into i from uf_ideas where id = p_idea;
  if not found or i.status not in ('live','claimed','exists') then raise exception using message = 'not_found'; end if;
  perform pg_advisory_xact_lock(hashtext('uft|' || h));
  if not exists (select 1 from uf_taps where idea_id = p_idea and token_hash = h)
     and (select count(*) from uf_taps where token_hash = h and created_at > now() - interval '24 hours') >= 300 then
    raise exception using message = 'slow_down';
  end if;
  insert into uf_taps (idea_id, token_hash, answer) values (p_idea, h, p_answer)
  on conflict (idea_id, token_hash) do update set answer = excluded.answer, created_at = now(),
    top = case when excluded.answer = 'yes' then uf_taps.top else false end;
  insert into uf_people (token_hash) values (h) on conflict do nothing;
  select count(*) into n from uf_taps where idea_id = p_idea and answer = 'yes';
  if i.tipped_at is null and n >= 5 then
    update uf_ideas set tipped_at = now() where id = p_idea and tipped_at is null;
    i.tipped_at := now();
  end if;
  return jsonb_build_object('tipped', i.tipped_at is not null,
                            'yes_count', case when i.tipped_at is null then null else n end);
end $$;

-- End of a sitting: your three (marks top on your yes taps), email, whens.
create or replace function public.uf_finish(p_token text, p_finish jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h text; v_email text; v_whens text[]; v_top uuid[];
begin
  perform uf_check_token(p_token);
  h := uf_hash(p_token);
  v_email := uf_clean_email(p_finish->>'email');
  if v_email <> '' and not uf_valid_email(v_email) then raise exception using message = 'bad_finish'; end if;
  v_whens := uf_whens(p_finish->'whens');
  select coalesce(array_agg(x::uuid), '{}') into v_top
    from (select distinct jsonb_array_elements_text(coalesce(p_finish->'top', '[]'::jsonb)) x limit 3) s
   where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  insert into uf_people (token_hash, email, whens) values (h, v_email, v_whens)
  on conflict (token_hash) do update
    set email = case when excluded.email = '' then uf_people.email else excluded.email end,
        whens = case when cardinality(excluded.whens) = 0 then uf_people.whens else excluded.whens end,
        updated_at = now();
  update uf_taps set top = (idea_id = any(v_top)) and answer = 'yes' where token_hash = h;
  return '{}'::jsonb;
end $$;

create or replace function public.uf_suggest(p_token text, p_suggestion jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h text; v_title text; v_when text; v_note text; v_email text; v_id uuid;
begin
  perform uf_check_token(p_token);
  h := uf_hash(p_token);
  v_title := uf_clean(p_suggestion->>'title', 56);
  v_when := p_suggestion->>'when';
  v_note := uf_clean(p_suggestion->>'note', 120);
  v_email := uf_clean_email(p_suggestion->>'email');
  if length(v_title) < 4 or v_when not in ('weeknight','sat-am','sat-pm','sunday','any')
     or (v_email <> '' and not uf_valid_email(v_email)) then
    raise exception using message = 'bad_suggestion';
  end if;
  perform pg_advisory_xact_lock(hashtext('ufs|' || h));
  if (select count(*) from uf_ideas where token_hash = h and created_at > now() - interval '24 hours') >= 3 then
    raise exception using message = 'slow_down';
  end if;
  insert into uf_ideas (title, blurb, when_hint, status, origin, source, token_hash)
  values (v_title, v_note, v_when, 'pending', 'reader', 'suggested', h)
  returning id into v_id;
  -- the suggester wants in, obviously; the tap rides along once approved
  insert into uf_taps (idea_id, token_hash, answer) values (v_id, h, 'yes') on conflict do nothing;
  insert into uf_people (token_hash, email) values (h, v_email)
  on conflict (token_hash) do update set email = case when excluded.email = '' then uf_people.email else excluded.email end, updated_at = now();
  return jsonb_build_object('id', v_id);
end $$;

-- "I'm in." Name + email required. Past the cap you're on the waitlist.
-- Reaching the threshold on a dated plan flips it ON; the client then
-- pokes the edge function (kind 'on'), which emails everyone who's in.
create or replace function public.uf_commit(p_plan uuid, p_token text, p_commit jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h text; p uf_plans%rowtype; v_name text; v_email text; v_status text; n int; went_on boolean := false;
begin
  perform uf_check_token(p_token);
  h := uf_hash(p_token);
  v_name := uf_clean(p_commit->>'name', 24);
  v_email := uf_clean_email(p_commit->>'email');
  if length(v_name) < 1 or not uf_valid_email(v_email) then raise exception using message = 'bad_commit'; end if;
  perform uf_sweep();
  perform pg_advisory_xact_lock(hashtext('ufp|' || p_plan::text));
  select * into p from uf_plans where id = p_plan;
  if not found or p.status not in ('tipping','on') then raise exception using message = 'not_found'; end if;
  if not exists (select 1 from uf_commits where plan_id = p_plan and token_hash = h)
     and (select count(*) from uf_commits c join uf_plans q on q.id = c.plan_id
           where c.token_hash = h and q.status in ('tipping','on')) >= 10 then
    raise exception using message = 'too_many_open';
  end if;
  select count(*) into n from uf_commits where plan_id = p_plan and status = 'in';
  v_status := case when exists (select 1 from uf_commits where plan_id = p_plan and token_hash = h)
                   then (select status from uf_commits where plan_id = p_plan and token_hash = h)
                   when n >= p.cap then 'wait' else 'in' end;
  insert into uf_commits (plan_id, token_hash, name, email, status) values (p_plan, h, v_name, v_email, v_status)
  on conflict (plan_id, token_hash) do update set name = excluded.name, email = excluded.email;
  insert into uf_people (token_hash, email, name) values (h, v_email, v_name)
  on conflict (token_hash) do update set email = excluded.email, name = excluded.name, updated_at = now();
  select count(*) into n from uf_commits where plan_id = p_plan and status = 'in';
  if p.status = 'tipping' and n >= p.threshold then
    update uf_plans set tipped_at = coalesce(tipped_at, now()) where id = p_plan;
    if p.starts_at is not null then
      update uf_plans set status = 'on', on_at = now() where id = p_plan;
      went_on := true;
    end if;
  end if;
  return jsonb_build_object('status', v_status, 'in_count', n, 'on', went_on or p.status = 'on');
end $$;

create or replace function public.uf_uncommit(p_plan uuid, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h text;
begin
  perform uf_check_token(p_token);
  h := uf_hash(p_token);
  perform pg_advisory_xact_lock(hashtext('ufp|' || p_plan::text));
  delete from uf_commits where plan_id = p_plan and token_hash = h;
  -- the waitlist moves up, in order, as far as the cap allows
  update uf_commits c set status = 'in'
    from (select token_hash from uf_commits where plan_id = p_plan and status = 'wait' order by created_at
           limit greatest(0, coalesce((select cap from uf_plans where id = p_plan), 0)
                             - (select count(*) from uf_commits where plan_id = p_plan and status = 'in'))) w
   where c.plan_id = p_plan and c.token_hash = w.token_hash;
  return '{}'::jsonb;
end $$;

-- ------------------------------------------------------------------ hosts
-- A host key is 32 hex chars Stephen mints in mod.html (shown once); only
-- its sha256 is stored. Wrong keys are counted: 20 in 15 minutes shuts the
-- gate for everyone until they age out. Host RPCs RETURN {"error":
-- "bad_key"} rather than raising so the failure row persists.

create or replace function public.uf_host_id(p_key text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if coalesce(p_key, '') !~ '^[a-f0-9]{32}$' then return null; end if;
  delete from uf_host_fails where at < now() - interval '15 minutes';
  -- the counter is per key prefix, so random guessing can't lock the real
  -- hosts out; 20 misses on one prefix rest that prefix for 15 minutes
  if (select count(*) from uf_host_fails where prefix = left(p_key, 8)) >= 20 then return null; end if;
  select id into v_id from uf_hosts where key_hash = uf_hash(p_key) and active;
  if v_id is null then insert into uf_host_fails (prefix) values (left(p_key, 8)); end if;
  return v_id;
end $$;
revoke all on function public.uf_host_id(text) from public, anon, authenticated;

create or replace function public.uf_host_me(p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  v_id := uf_host_id(p_key);
  if v_id is null then return jsonb_build_object('error', 'bad_key'); end if;
  return (select jsonb_build_object('id', h.id, 'name', h.name) from uf_hosts h where h.id = v_id);
end $$;

-- What people want: every live/claimed idea with its counts, momentum
-- (yes in the last 7 days), how many of the yes-pile left an email (a
-- number, never the addresses), and the when-spread of the yes-pile.
create or replace function public.uf_host_wants(p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  v_id := uf_host_id(p_key);
  if v_id is null then return jsonb_build_object('error', 'bad_key'); end if;
  perform uf_sweep();
  return jsonb_build_object(
    'weigh_in', (select count(distinct token_hash) from uf_taps where created_at > now() - interval '7 days'),
    'people', (select count(*) from uf_people),
    'emails', (select count(*) from uf_people where email <> ''),
    'ideas', coalesce((select jsonb_agg(uf_idea_public(i) || jsonb_build_object(
        'yes', (select count(*) from uf_taps t where t.idea_id = i.id and t.answer = 'yes'),
        'maybe', (select count(*) from uf_taps t where t.idea_id = i.id and t.answer = 'maybe'),
        'pass', (select count(*) from uf_taps t where t.idea_id = i.id and t.answer = 'pass'),
        'top', (select count(*) from uf_taps t where t.idea_id = i.id and t.top),
        'yes_7d', (select count(*) from uf_taps t where t.idea_id = i.id and t.answer = 'yes' and t.created_at > now() - interval '7 days'),
        'emails', (select count(*) from uf_taps t join uf_people pe on pe.token_hash = t.token_hash
                    where t.idea_id = i.id and t.answer = 'yes' and pe.email <> ''),
        'whens', (select coalesce(jsonb_object_agg(w, n), '{}'::jsonb) from (
                    select w, count(*) n from uf_taps t join uf_people pe on pe.token_hash = t.token_hash
                      cross join lateral unnest(pe.whens) w
                     where t.idea_id = i.id and t.answer = 'yes' group by w) s),
        'source', i.source, 'origin', i.origin)
      order by i.created_at desc)
      from uf_ideas i where i.status in ('live','claimed','exists')), '[]'::jsonb));
end $$;

-- Plans: mine in full (who's in, first names only), everyone else's brief
-- so hosts don't double-book a night.
create or replace function public.uf_host_plans(p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  v_id := uf_host_id(p_key);
  if v_id is null then return jsonb_build_object('error', 'bad_key'); end if;
  perform uf_sweep();
  return jsonb_build_object(
    'mine', coalesce((select jsonb_agg(uf_plan_public(p) || jsonb_build_object(
        'notified_claim', p.notified_claim, 'notified_on', p.notified_on, 'reminded', p.reminded, 'notified_cancel', p.notified_cancel,
        'people', coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'status', c.status, 'created_at', c.created_at) order by c.created_at)
                              from uf_commits c where c.plan_id = p.id), '[]'::jsonb))
      order by p.status, p.starts_at nulls last, p.created_at desc)
      from uf_plans p where p.host_id = v_id and (p.status in ('tipping','on') or p.created_at > now() - interval '60 days')), '[]'::jsonb),
    'others', coalesce((select jsonb_agg(uf_plan_public(p) order by p.starts_at nulls last)
      from uf_plans p where p.host_id <> v_id and p.status in ('tipping','on')), '[]'::jsonb));
end $$;

-- Validates a plan body the way core.js validatePlan does. Returns the
-- cleaned fields or raises bad_plan.
create or replace function public.uf_plan_fields(p jsonb)
returns table (title text, place text, detail text, category text, starts_at timestamptz, cap int, threshold int, meetup_url text, idea_id uuid)
language plpgsql stable as $$
begin
  title := uf_clean(p->>'title', 56);
  place := uf_clean(p->>'place', 80);
  detail := uf_clean(p->>'detail', 200);
  category := case when uf_valid_category(p->>'category') then p->>'category' else 'social' end;
  begin
    starts_at := case when coalesce(p->>'starts_at', '') = '' then null else (p->>'starts_at')::timestamptz end;
    cap := coalesce((p->>'cap')::int, 8);
    threshold := coalesce((p->>'threshold')::int, 5);
    idea_id := case when coalesce(p->>'idea_id', '') = '' then null else (p->>'idea_id')::uuid end;
  exception when others then raise exception using message = 'bad_plan'; end;
  meetup_url := left(btrim(coalesce(p->>'meetup_url', '')), 200);
  if length(title) < 4 or length(place) < 2 or cap < 2 or cap > 60 or threshold < 2 or threshold > cap
     or (meetup_url <> '' and meetup_url !~* '^https://\S+$') then
    raise exception using message = 'bad_plan';
  end if;
  return next;
end $$;

-- Claim an idea (idea_id set) or float your own (null). One live plan per
-- idea. The client then pokes the edge function (kind 'claimed') so the
-- idea's yes-pile hears a host picked it up.
create or replace function public.uf_host_claim(p_key text, p_plan jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_host uuid; f record; v_id uuid; i uf_ideas%rowtype;
begin
  v_host := uf_host_id(p_key);
  if v_host is null then return jsonb_build_object('error', 'bad_key'); end if;
  select * into f from uf_plan_fields(p_plan);
  perform uf_sweep();
  if f.idea_id is not null then
    perform pg_advisory_xact_lock(hashtext('ufi|' || f.idea_id::text));
    select * into i from uf_ideas where id = f.idea_id;
    if not found or i.status not in ('live','claimed','exists') then raise exception using message = 'not_found'; end if;
    if exists (select 1 from uf_plans where idea_id = f.idea_id and status in ('tipping','on')) then
      raise exception using message = 'already_claimed';
    end if;
    update uf_ideas set status = 'claimed' where id = f.idea_id;
  end if;
  insert into uf_plans (idea_id, host_id, title, place, detail, category, starts_at, cap, threshold, meetup_url)
  values (f.idea_id, v_host, f.title, f.place, f.detail,
          case when f.idea_id is not null then coalesce((select category from uf_ideas where id = f.idea_id), f.category) else f.category end,
          f.starts_at, f.cap, f.threshold, f.meetup_url)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- Edit a plan you own. Setting a date on a plan that already reached its
-- threshold flips it on (the client pokes 'on').
create or replace function public.uf_host_update(p_key text, p_plan uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_host uuid; p uf_plans%rowtype; f record; n int; went_on boolean := false;
begin
  v_host := uf_host_id(p_key);
  if v_host is null then return jsonb_build_object('error', 'bad_key'); end if;
  perform pg_advisory_xact_lock(hashtext('ufp|' || p_plan::text));
  select * into p from uf_plans where id = p_plan and host_id = v_host;
  if not found or p.status not in ('tipping','on') then raise exception using message = 'not_found'; end if;
  select * into f from uf_plan_fields(jsonb_build_object(
    'title', coalesce(p_patch->>'title', p.title), 'place', coalesce(p_patch->>'place', p.place),
    'detail', coalesce(p_patch->>'detail', p.detail), 'category', coalesce(p_patch->>'category', p.category),
    'starts_at', case when p_patch ? 'starts_at' then p_patch->>'starts_at' else p.starts_at::text end,
    'cap', coalesce(p_patch->>'cap', p.cap::text), 'threshold', coalesce(p_patch->>'threshold', p.threshold::text),
    'meetup_url', coalesce(p_patch->>'meetup_url', p.meetup_url)));
  if f.cap < (select count(*) from uf_commits where plan_id = p_plan and status = 'in') then
    raise exception using message = 'cap_too_small';
  end if;
  update uf_plans set title = f.title, place = f.place, detail = f.detail, category = f.category,
         starts_at = f.starts_at, cap = f.cap, threshold = f.threshold, meetup_url = f.meetup_url,
         reminded = case when f.starts_at is distinct from p.starts_at then false else reminded end,
         -- taking the date off an "on" plan puts it back to tipping; re-dating re-announces
         status = case when f.starts_at is null and p.status = 'on' then 'tipping' else status end,
         on_at = case when f.starts_at is null and p.status = 'on' then null else on_at end,
         notified_on = case when f.starts_at is null and p.status = 'on' then false else notified_on end
   where id = p_plan;
  -- cap grew: promote from the waitlist in order
  update uf_commits c set status = 'in'
    from (select token_hash from uf_commits where plan_id = p_plan and status = 'wait' order by created_at
           limit greatest(0, f.cap - (select count(*) from uf_commits where plan_id = p_plan and status = 'in'))) w
   where c.plan_id = p_plan and c.token_hash = w.token_hash;
  select count(*) into n from uf_commits where plan_id = p_plan and status = 'in';
  if p.status = 'tipping' and f.starts_at is not null and n >= f.threshold then
    update uf_plans set status = 'on', on_at = now(), tipped_at = coalesce(tipped_at, now()) where id = p_plan;
    went_on := true;
  end if;
  return jsonb_build_object('on', went_on);
end $$;

-- on: make it official now (host's call, threshold or not; needs a date)
-- cancel: call it off (idea goes back to live)   release: drop an empty tipping plan
-- done: it happened, with how many showed
create or replace function public.uf_host_action(p_key text, p_plan uuid, p_action text, p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_host uuid; p uf_plans%rowtype;
begin
  v_host := uf_host_id(p_key);
  if v_host is null then return jsonb_build_object('error', 'bad_key'); end if;
  perform pg_advisory_xact_lock(hashtext('ufp|' || p_plan::text));
  select * into p from uf_plans where id = p_plan and host_id = v_host;
  if not found then raise exception using message = 'not_found'; end if;
  if p_action = 'on' then
    if p.status <> 'tipping' then raise exception using message = 'not_found'; end if;
    if p.starts_at is null then raise exception using message = 'needs_date'; end if;
    update uf_plans set status = 'on', on_at = now(), tipped_at = coalesce(tipped_at, now()) where id = p_plan;
  elsif p_action = 'cancel' then
    if p.status not in ('tipping','on') then raise exception using message = 'not_found'; end if;
    update uf_plans set status = 'cancelled' where id = p_plan;
    if p.idea_id is not null then update uf_ideas set status = 'live' where id = p.idea_id and status = 'claimed'; end if;
  elsif p_action = 'release' then
    if p.status <> 'tipping' or exists (select 1 from uf_commits where plan_id = p_plan) then
      raise exception using message = 'has_people';
    end if;
    delete from uf_plans where id = p_plan;
    if p.idea_id is not null then update uf_ideas set status = 'live' where id = p.idea_id and status = 'claimed'; end if;
  elsif p_action = 'done' then
    if p.status not in ('on','done') then raise exception using message = 'not_found'; end if;
    begin
      update uf_plans set status = 'done', showed = nullif(p_payload->>'showed', '')::int where id = p_plan;
    exception when others then raise exception using message = 'bad_showed'; end;
    -- the idea goes back in the deck; its tip stays so hosts can run it again
    if p.idea_id is not null then update uf_ideas set status = 'live' where id = p.idea_id and status = 'claimed'; end if;
  else
    raise exception using message = 'bad_action';
  end if;
  return '{}'::jsonb;
end $$;

-- ------------------------------------------------------------ moderation
-- mod.html is Stephen's back room: approve suggested ideas, edit/archive
-- ideas, mark "already a thing", mint host keys, cancel plans.
-- 1. Pick a long random secret (password manager).
-- 2. In the SQL editor: select extensions.crypt('YOUR-SECRET', extensions.gen_salt('bf', 12));
-- 3. Paste the $2a$12$... result between the quotes below; run this file.
create or replace function public.uf_mod_hash() returns text
language sql immutable as $$ select '$2a$12$oeYkpK7TUg4iYSLgfAOoFO8iJv2TNZITMUAd9r15TzPZdXI33jPA2'::text; $$;
revoke all on function public.uf_mod_hash() from public, anon, authenticated;

create or replace function public.uf_mod_ok(p_secret text) returns boolean
language plpgsql security definer set search_path = public as $$
declare good boolean;
begin
  if coalesce(p_secret, '') = '' or uf_mod_hash() not like '$2%' then return false; end if;
  delete from uf_mod_fails where at < now() - interval '15 minutes';
  if (select count(*) from uf_mod_fails) >= 20 then return false; end if;
  good := extensions.crypt(p_secret, uf_mod_hash()) = uf_mod_hash();
  if not good then insert into uf_mod_fails default values; end if;
  return good;
end $$;
revoke all on function public.uf_mod_ok(text) from public, anon, authenticated;

create or replace function public.uf_mod_queue(p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not uf_mod_ok(p_secret) then return jsonb_build_object('error', 'bad_secret'); end if;
  perform uf_sweep();
  return jsonb_build_object(
    'pending', coalesce((select jsonb_agg(uf_idea_public(i) || jsonb_build_object('origin', i.origin) order by i.created_at desc)
                           from uf_ideas i where i.status = 'pending'), '[]'::jsonb),
    'ideas', coalesce((select jsonb_agg(uf_idea_public(i) || jsonb_build_object(
                 'yes', (select count(*) from uf_taps t where t.idea_id = i.id and t.answer = 'yes'),
                 'maybe', (select count(*) from uf_taps t where t.idea_id = i.id and t.answer = 'maybe'),
                 'origin', i.origin, 'source', i.source) order by i.status, i.created_at desc)
                 from uf_ideas i where i.status in ('live','claimed','exists','archived')), '[]'::jsonb),
    'hosts', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name, 'email', h.email, 'active', h.active,
                 'created_at', h.created_at,
                 'plans', (select count(*) from uf_plans p where p.host_id = h.id)) order by h.created_at)
                 from uf_hosts h), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(uf_plan_public(p) order by p.created_at desc) from uf_plans p), '[]'::jsonb),
    'stats', jsonb_build_object(
      'people', (select count(*) from uf_people), 'emails', (select count(*) from uf_people where email <> ''),
      'taps', (select count(*) from uf_taps), 'weigh_in', (select count(distinct token_hash) from uf_taps where created_at > now() - interval '7 days')));
end $$;

-- approve | reject | archive | restore | exists {url, note} | edit {title, blurb, when, category, months} | add {title, blurb, when, category, months}
create or replace function public.uf_mod_idea(p_secret text, p_idea uuid, p_action text, p_patch jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_months int[];
begin
  if not uf_mod_ok(p_secret) then return jsonb_build_object('error', 'bad_secret'); end if;
  if jsonb_typeof(p_patch->'months') = 'array' then
    select coalesce(array_agg(x::int), '{}') into v_months
      from jsonb_array_elements_text(p_patch->'months') x where x ~ '^\d+$' and x::int between 1 and 12;
  end if;
  if p_action = 'add' then
    insert into uf_ideas (title, blurb, when_hint, category, months, status, origin, source)
    values (uf_clean(p_patch->>'title', 56), uf_clean(p_patch->>'blurb', 120),
            case when (p_patch->>'when') in ('weeknight','sat-am','sat-pm','sunday','any') then p_patch->>'when' else 'any' end,
            case when uf_valid_category(p_patch->>'category') then p_patch->>'category' else 'social' end,
            coalesce(v_months, '{}'), 'live', 'editor', 'seed')
    returning id into v_id;
    return jsonb_build_object('id', v_id);
  end if;
  if not exists (select 1 from uf_ideas where id = p_idea) then raise exception using message = 'not_found'; end if;
  if p_action = 'approve' then update uf_ideas set status = 'live' where id = p_idea and status = 'pending';
  elsif p_action = 'reject' then update uf_ideas set status = 'rejected' where id = p_idea;
  elsif p_action = 'archive' then update uf_ideas set status = 'archived' where id = p_idea;
  elsif p_action = 'restore' then update uf_ideas set status = 'live' where id = p_idea;
  elsif p_action = 'exists' then
    if coalesce(p_patch->>'url', '') !~* '^https://\S+$' then raise exception using message = 'bad_patch'; end if;
    update uf_ideas set status = 'exists', exists_url = left(btrim(p_patch->>'url'), 200), exists_note = uf_clean(p_patch->>'note', 80) where id = p_idea;
  elsif p_action = 'edit' then
    update uf_ideas set
      title = coalesce(nullif(uf_clean(p_patch->>'title', 56), ''), title),
      blurb = case when p_patch ? 'blurb' then uf_clean(p_patch->>'blurb', 120) else blurb end,
      when_hint = case when (p_patch->>'when') in ('weeknight','sat-am','sat-pm','sunday','any') then p_patch->>'when' else when_hint end,
      category = case when uf_valid_category(p_patch->>'category') then p_patch->>'category' else category end,
      months = coalesce(v_months, months)
    where id = p_idea;
  elsif p_action = 'delete' then delete from uf_ideas where id = p_idea;
  else raise exception using message = 'bad_action';
  end if;
  return '{}'::jsonb;
end $$;

-- add {name, email} → {id, key}  (the key is shown ONCE; only its hash is kept)
-- rekey {id} → {key}   disable {id}   enable {id}   delete {id}
create or replace function public.uf_mod_host(p_secret text, p_action text, p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_key text; v_id uuid; v_name text;
begin
  if not uf_mod_ok(p_secret) then return jsonb_build_object('error', 'bad_secret'); end if;
  v_key := encode(extensions.gen_random_bytes(16), 'hex');
  if p_action = 'add' then
    v_name := uf_clean(p_payload->>'name', 32);
    if length(v_name) < 1 then raise exception using message = 'bad_host'; end if;
    insert into uf_hosts (name, email, key_hash) values (v_name, uf_clean_email(p_payload->>'email'), uf_hash(v_key)) returning id into v_id;
    return jsonb_build_object('id', v_id, 'key', v_key);
  end if;
  begin v_id := (p_payload->>'id')::uuid; exception when others then raise exception using message = 'not_found'; end;
  if not exists (select 1 from uf_hosts where id = v_id) then raise exception using message = 'not_found'; end if;
  if p_action = 'rekey' then update uf_hosts set key_hash = uf_hash(v_key), active = true where id = v_id; return jsonb_build_object('key', v_key);
  elsif p_action = 'disable' then update uf_hosts set active = false where id = v_id;
  elsif p_action = 'enable' then update uf_hosts set active = true where id = v_id;
  elsif p_action = 'delete' then delete from uf_hosts where id = v_id;
  else raise exception using message = 'bad_action';
  end if;
  return '{}'::jsonb;
end $$;

create or replace function public.uf_mod_plan(p_secret text, p_plan uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p uf_plans%rowtype;
begin
  if not uf_mod_ok(p_secret) then return jsonb_build_object('error', 'bad_secret'); end if;
  select * into p from uf_plans where id = p_plan;
  if not found then raise exception using message = 'not_found'; end if;
  if p_action = 'cancel' then
    update uf_plans set status = 'cancelled' where id = p_plan;
    if p.idea_id is not null then update uf_ideas set status = 'live' where id = p.idea_id and status = 'claimed'; end if;
  elsif p_action = 'delete' then
    delete from uf_plans where id = p_plan;
    if p.idea_id is not null then update uf_ideas set status = 'live' where id = p.idea_id and status = 'claimed'; end if;
  else raise exception using message = 'bad_action';
  end if;
  return '{}'::jsonb;
end $$;

-- ---------------------------------------------------------------- grants
revoke all on function public.uf_plans_public() from public;
revoke all on function public.uf_ideas_public() from public;
revoke all on function public.uf_home(text) from public;
revoke all on function public.uf_mine(text) from public;
revoke all on function public.uf_deck(text) from public;
revoke all on function public.uf_tap(text, uuid, text) from public;
revoke all on function public.uf_finish(text, jsonb) from public;
revoke all on function public.uf_suggest(text, jsonb) from public;
revoke all on function public.uf_commit(uuid, text, jsonb) from public;
revoke all on function public.uf_uncommit(uuid, text) from public;
revoke all on function public.uf_host_me(text) from public;
revoke all on function public.uf_host_wants(text) from public;
revoke all on function public.uf_host_plans(text) from public;
revoke all on function public.uf_host_claim(text, jsonb) from public;
revoke all on function public.uf_host_update(text, uuid, jsonb) from public;
revoke all on function public.uf_host_action(text, uuid, text, jsonb) from public;
revoke all on function public.uf_mod_queue(text) from public;
revoke all on function public.uf_mod_idea(text, uuid, text, jsonb) from public;
revoke all on function public.uf_mod_host(text, text, jsonb) from public;
revoke all on function public.uf_mod_plan(text, uuid, text) from public;
revoke all on function public.uf_sweep() from public, anon, authenticated;
revoke all on function public.uf_idea_public(uf_ideas) from public, anon, authenticated;
revoke all on function public.uf_plan_public(uf_plans) from public, anon, authenticated;
revoke all on function public.uf_my_json(text) from public, anon, authenticated;
revoke all on function public.uf_plan_fields(jsonb) from public, anon, authenticated;
revoke all on function public.uf_hash(text) from public, anon, authenticated;
revoke all on function public.uf_check_token(text) from public, anon, authenticated;
revoke all on function public.uf_clean(text, int) from public, anon, authenticated;
revoke all on function public.uf_clean_email(text) from public, anon, authenticated;
revoke all on function public.uf_valid_email(text) from public, anon, authenticated;
revoke all on function public.uf_valid_when(text) from public, anon, authenticated;
revoke all on function public.uf_valid_category(text) from public, anon, authenticated;
revoke all on function public.uf_whens(jsonb) from public, anon, authenticated;
grant execute on function public.uf_plans_public() to anon;
grant execute on function public.uf_ideas_public() to anon;
grant execute on function public.uf_home(text) to anon;
grant execute on function public.uf_mine(text) to anon;
grant execute on function public.uf_deck(text) to anon;
grant execute on function public.uf_tap(text, uuid, text) to anon;
grant execute on function public.uf_finish(text, jsonb) to anon;
grant execute on function public.uf_suggest(text, jsonb) to anon;
grant execute on function public.uf_commit(uuid, text, jsonb) to anon;
grant execute on function public.uf_uncommit(uuid, text) to anon;
-- the hashed key / secret is the gate on these, not the grant
grant execute on function public.uf_host_me(text) to anon;
grant execute on function public.uf_host_wants(text) to anon;
grant execute on function public.uf_host_plans(text) to anon;
grant execute on function public.uf_host_claim(text, jsonb) to anon;
grant execute on function public.uf_host_update(text, uuid, jsonb) to anon;
grant execute on function public.uf_host_action(text, uuid, text, jsonb) to anon;
grant execute on function public.uf_mod_queue(text) to anon;
grant execute on function public.uf_mod_idea(text, uuid, text, jsonb) to anon;
grant execute on function public.uf_mod_host(text, text, jsonb) to anon;
grant execute on function public.uf_mod_plan(text, uuid, text) to anon;

-- ------------------------------------------------------------------ seeds
-- The starting deck. Generated from data/ideas.json by scripts/build-seed-
-- sql.mjs — edit the JSON, re-run the script, re-paste. `on conflict do
-- nothing` so re-running never clobbers a live idea's status or tips.
-- @@SEEDS@@
-- 30 ideas, generated 2026-08-23
insert into public.uf_ideas (slug, title, blurb, when_hint, category, months, status, exists_url, exists_note, origin) values
($s$sunset-hike-mt-philo$s$, $s$Golden-hour hike up Mt. Philo, a September weeknight$s$, $s$Short climb to the lake-and-Adirondacks view; the park gate closes at dusk so we're down by then. Carpool, $5 day-use.$s$, $s$weeknight$s$, $s$outdoors$s$, '{9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:hiking$s$),
($s$foliage-walk-ethan-allen-tower$s$, $s$Foliage walk to the Ethan Allen Park tower$s$, $s$Easy forested loop in the New North End up to the 1905 stone tower and the city-and-lake view. Free, an hour, all paces.$s$, $s$sunday$s$, $s$outdoors$s$, '{9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:hiking$s$),
($s$causeway-ride-to-the-cut$s$, $s$Ride the Causeway to the cut before the ferry stops$s$, $s$Flat 3.5-mile ride out into the lake on the Island Line. Rent at Local Motion on the waterfront; $4 ferry hop optional.$s$, $s$sat-am$s$, $s$outdoors$s$, '{9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:causeway-biking$s$),
($s$sunset-paddle-north-beach$s$, $s$Sunset paddle from North Beach, a calm weeknight$s$, $s$Kayaks and boards rent right on the sand at North Beach; hug the shore, watch the sun drop. Calm-water only.$s$, $s$weeknight$s$, $s$outdoors$s$, '{8,9}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:paddling$s$),
($s$intervale-fog-walk-then-coffee$s$, $s$Fog-morning walk at the Intervale, then coffee$s$, $s$Free trails through the farm fields while the autumn fog sits in the basin. Early alarm, easy pace, coffee after nearby.$s$, $s$sat-am$s$, $s$outdoors$s$, '{9,10,11}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$editor$s$),
($s$delta-park-fall-birding$s$, $s$Fall migration birding on the Delta Park boardwalk$s$, $s$Flat boardwalk to where the Winooski meets the lake — herons and waterfowl. Any binoculars work; free, an hour.$s$, $s$sat-am$s$, $s$outdoors$s$, '{9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:birding$s$),
($s$lakeview-cemetery-sunset-walk$s$, $s$Sunset walk along the Lakeview Cemetery bluffs$s$, $s$Quiet Victorian garden paths on the bluffs above the lake — one of the best under-visited sunsets in town. Free, flat.$s$, $s$weeknight$s$, $s$outdoors$s$, '{8,9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:sunset-chasing$s$),
($s$apple-picking-shelburne-orchards$s$, $s$Apple picking at Shelburne Orchards, a Saturday morning$s$, $s$Pick-your-own with the Adirondacks behind the rows, fresh cider at the ciderhouse. Pay by the bag; carpool from town.$s$, $s$sat-am$s$, $s$food-drink$s$, '{9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$editor$s$),
($s$route-100-cider-donut-run$s$, $s$Cider donut run up Route 100, a foliage Sunday$s$, $s$Carpool to Cold Hollow for donuts warm from the fryer, Ben & Jerry's next door, leaves the whole way. Cheap, half a day.$s$, $s$sunday$s$, $s$food-drink$s$, '{9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$editor$s$),
($s$old-north-end-cheap-eats-crawl$s$, $s$Old North End cheap-eats crawl, a weeknight$s$, $s$Walk between Pho Hong, Taco Gordo and Ms. Weinerz, one small thing at each. Walkable, under $15 a stop, no reservations.$s$, $s$weeknight$s$, $s$food-drink$s$, '{}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$meetup$s$),
($s$oakledge-golden-hour-picnic$s$, $s$Golden-hour picnic at Oakledge, bring one thing$s$, $s$Blankets on the grass by the Earth Clock, everyone brings one dish or snack to share. Free, sunset included.$s$, $s$sat-pm$s$, $s$social$s$, '{8,9}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$editor$s$),
($s$forties-plus-lakeside-coffee-walk$s$, $s$40s and up: lakeside coffee walk from Perkins Pier$s$, $s$Coffee from Burlington Bay Café, then a stroll up the Greenway at talking pace. No agenda, for the 40-plus crowd.$s$, $s$sunday$s$, $s$social$s$, '{}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$club:Burlington Social Activities Group (BTown Brief IRL)$s$),
($s$twenties-thirties-pine-street-patio-hang$s$, $s$20s and 30s: after-work hang on a Pine Street patio$s$, $s$Meet at a Pine Street brewery or cidery patio after work, grab a table, meet people your age. Walkable, no cover.$s$, $s$weeknight$s$, $s$social$s$, '{8,9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$club:Burlington Social Activities Group (BTown Brief IRL)$s$),
($s$new-in-town-walking-tour$s$, $s$New in town? Locals-led walk, waterfront to Church St$s$, $s$An hour on foot from Waterfront Park up to Church Street, locals pointing out the good stuff. Free; newcomers first.$s$, $s$sat-pm$s$, $s$community$s$, '{}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$editor$s$),
($s$pinball-co-op-wednesday$s$, $s$Pinball night at the Pinball Co-op, a Wednesday$s$, $s$Forty machines on free play for one flat fee, alcohol-free, regulars explain the old games. Carpool to So. Burlington.$s$, $s$weeknight$s$, $s$games$s$, '{}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:pinball$s$),
($s$sunset-drive-in-double-feature$s$, $s$Double feature at the Sunset Drive-In, a Saturday$s$, $s$Carpool to Colchester, tune the radio, split the ~$12-a-car admission. Blankets and lawn chairs; one of Vermont's last.$s$, $s$sat-pm$s$, $s$film$s$, '{8,9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$editor$s$),
($s$art-hop-pine-street-walk$s$, $s$Art Hop walk down Pine Street, opening night$s$, $s$Studios and galleries open along the South End during Art Hop weekend. Free, walkable, meet at the top of Pine.$s$, $s$any$s$, $s$arts$s$, '{9}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$editor$s$),
($s$film-photo-walk-old-north-end$s$, $s$Film photo walk through the Old North End$s$, $s$One roll each, any camera (LeZot has cheap ones and develops). Wander the ONE together, compare prints next week.$s$, $s$sat-pm$s$, $s$arts$s$, '{9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:film-photography$s$),
($s$silent-book-club-sunday$s$, $s$Silent book club: read an hour, then talk, a Sunday$s$, $s$Bring whatever you're reading to a downtown café, read quietly together, chat after. No assigned book, no prep.$s$, $s$sunday$s$, $s$words$s$, '{}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:reading$s$),
($s$radio-bean-open-mic-cheer-squad$s$, $s$Cheer squad at the Radio Bean open mic, a weeknight$s$, $s$Go as a table to the long-running open mic; sign up if you dare, applaud if you don't. Small cover at most.$s$, $s$weeknight$s$, $s$music$s$, '{}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:live-music$s$),
($s$live-music-maquam-winery$s$, $s$Live music night at Maquam Winery, after work$s$, $s$The group has done this before and it worked: a live set, a glass or a soda, a table for ten. Carpool north.$s$, $s$weeknight$s$, $s$music$s$, '{9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$meetup$s$),
($s$disc-golf-schifilliti-after-work$s$, $s$After-work disc golf round at Schifilliti Park$s$, $s$Free course in the New North End; a starter set costs about what lunch does, or share discs. Beginners welcome.$s$, $s$weeknight$s$, $s$sports$s$, '{8,9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:disc-golf$s$),
($s$beginner-pickleball-leddy-courts$s$, $s$Beginner pickleball on the Leddy Park courts$s$, $s$Four free lit courts, first come first served; rotate in, learn the rules in ten minutes. Bring or borrow a paddle.$s$, $s$weeknight$s$, $s$sports$s$, '{8,9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$sport:pickleball$s$),
($s$sangha-yoga-then-brunch$s$, $s$Beginner yoga at Sangha Studio, then brunch$s$, $s$Drop into a donation-based beginner class on Pine Street or in the ONE, then walk to brunch. Pay what you can.$s$, $s$sat-am$s$, $s$wellness$s$, '{}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:yoga$s$),
($s$savu-sauna-circuit$s$, $s$Sauna circuit at Savu, a chilly weeknight$s$, $s$Heat, plunge, Adirondack chair, repeat, on the waterfront. Everyone books their own slot; meet in the chairs.$s$, $s$weeknight$s$, $s$wellness$s$, '{10,11,12}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$hobby:sauna$s$),
($s$generator-makerspace-tour$s$, $s$Tour Generator makerspace on a Saturday$s$, $s$See the woodshop, laser cutters and 3D printers on Sears Lane at a Saturday enrollment session. Free to look.$s$, $s$sat-am$s$, $s$learning$s$, '{}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$club:Generator Makerspace$s$),
($s$fotw-trail-work-day$s$, $s$Trail work morning with Fellowship of the Wheel$s$, $s$Join a volunteer trail day on local singletrack — tools provided, no bike required. Free, outdoors, you built that.$s$, $s$sat-am$s$, $s$community$s$, '{9,10}'::int[], $s$live$s$, $s$$s$, $s$$s$, $s$club:Fellowship of the Wheel$s$),
($s$vermont-ultimate-thursday-pickup$s$, $s$Thursday pickup ultimate with Vermont Ultimate$s$, $s$Free, all-levels summer pickup; the field is announced weekly. Cleats optional, running shoes fine.$s$, $s$weeknight$s$, $s$sports$s$, '{8,9}'::int[], $s$exists$s$, $s$https://vermontultimate.org/pickup$s$, $s$Already a thing: Vermont Ultimate pickup, Thursdays all summer$s$, $s$club:Vermont Ultimate (Green Mountain Disc Alliance)$s$),
($s$queen-city-contras-beginner-night$s$, $s$Try a contra dance at Shelburne Town Hall$s$, $s$Every dance is taught, no partner needed — come 15 minutes early for the beginner walkthrough. Live band, small fee.$s$, $s$weeknight$s$, $s$social$s$, '{}'::int[], $s$exists$s$, $s$https://queencitycontras.com/schedule/$s$, $s$Already a thing: Queen City Contras, monthly Fridays 6:45pm$s$, $s$club:Queen City Contras$s$),
($s$friendly-tabletop-game-night$s$, $s$Learn-to-play board game night at The Boardroom$s$, $s$Burlington's big board game Meetup runs learn-to-play and open gaming several nights a week at the Main St game café.$s$, $s$weeknight$s$, $s$games$s$, '{}'::int[], $s$exists$s$, $s$https://www.meetup.com/friendlytabletopgamers/$s$, $s$Already a thing: The Friendly Tabletop Gamers at The Boardroom$s$, $s$club:The Friendly Tabletop Gamers$s$)
on conflict (slug) do nothing;
