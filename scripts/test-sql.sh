#!/usr/bin/env bash
# Runs supabase/up-for-it-SETUP.sql on a local Postgres (17) and exercises the
# whole loop AS THE anon ROLE: tap → tip, finish, suggest, mod approve, host
# key, claim, "I'm in" → on, waitlist, done, lockouts. Needs psql; set
# PGHOST/PGPORT/PGUSER or pass a conninfo in $1. Makes a throwaway DB.
set -u
CONN="${1:-host=/tmp port=54329 user=postgres}"
DB="uf_test_$$"
psql "$CONN" -q -c "create database $DB;"
trap 'psql "$CONN" -q -c "drop database if exists $DB;"' EXIT
P() { psql "$CONN dbname=$DB" -v ON_ERROR_STOP=1 -q -X -t -A "$@"; }
P -c "create schema if not exists extensions; do \$\$ begin create role anon nologin; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticated nologin; exception when duplicate_object then null; end \$\$; create extension if not exists pgcrypto with schema extensions;" >/dev/null
HASH=$(P -c "select extensions.crypt('test-secret', extensions.gen_salt('bf', 6));")
# swap whatever hash is baked into uf_mod_hash() for the test secret's
HASH="$HASH" python3 - <<'PY'
import os,re
s=open('supabase/up-for-it-SETUP.sql').read()
h=os.environ['HASH']
s2,n=re.subn(r"(function public\.uf_mod_hash\(\) returns text\nlanguage sql immutable as \$\$ select ')[^']*('::text; \$\$;)", lambda m: m.group(1)+h+m.group(2), s)
assert n==1, n
open('/tmp/uf-setup-test.sql','w').write(s2)
PY
grep -q "$HASH" /tmp/uf-setup-test.sql || { echo "could not swap mod hash"; exit 1; }
P -f /tmp/uf-setup-test.sql >/dev/null 2>/tmp/uf-setup-err.log || { echo "setup SQL failed:"; tail -5 /tmp/uf-setup-err.log; exit 1; }
pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $3 — got [$1] want [$2]"; fi; }
A() { P -c "set role anon; $1"; }        # run as anon
S() { P -c "$1"; }                        # superuser peek at tables (tests only)
AE() { P -c "set role anon; $1" 2>&1 | sed -n 's/^ERROR:  \([a-z_]*\).*/\1/p' | head -1; }  # expect error code
T1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; T2=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; T3=cccccccccccccccccccccccccccccccc; T4=dddddddddddddddddddddddddddddddd; T5=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee; T6=ffffffffffffffffffffffffffffffff

# tables are not readable directly
ok "$(AE "select count(*) from uf_ideas;")" "permission" "anon cannot read tables"
ok "$(A "select jsonb_array_length(uf_ideas_public());")" "30" "30 public ideas"
ok "$(A "select (uf_home(null)->>'deck_left');")" "27" "deck_left counts live ideas only"
IDEA=$(S "select id from uf_ideas where slug='sunset-paddle-north-beach';")
# five yeses tip it; count hidden before
ok "$(A "select uf_tap('$T1','$IDEA','yes')->>'tipped';")" "false" "1 yes not tipped"
ok "$(S "select (uf_idea_public(i)->>'yes_count') is null from uf_ideas i where id='$IDEA';")" "t" "count hidden before tip"
A "select uf_tap('$T2','$IDEA','yes');" >/dev/null; A "select uf_tap('$T3','$IDEA','maybe');" >/dev/null; A "select uf_tap('$T4','$IDEA','yes');" >/dev/null; A "select uf_tap('$T5','$IDEA','yes');" >/dev/null
ok "$(A "select uf_tap('$T3','$IDEA','yes')->>'tipped';")" "true" "5th yes tips (retap maybe→yes)"
ok "$(S "select uf_idea_public(i)->>'yes_count' from uf_ideas i where id='$IDEA';")" "5" "count public after tip"
ok "$(A "select (uf_home('$T1')->>'deck_left');")" "26" "tapped idea leaves the deck"
ok "$(A "select (uf_home('$T1')->>'weigh_in');")" "5" "five devices weighed in"
ok "$(AE "select uf_tap('$T1','$IDEA','nope');")" "bad_tap" "bad answer rejected"
ok "$(AE "select uf_tap('zz','$IDEA','yes');")" "bad_token" "bad token rejected"
# finish: top + email + whens
A "select uf_finish('$T1', '{\"top\":[\"$IDEA\"],\"email\":\"A@Example.com\",\"whens\":[\"sunday\",\"weeknight\",\"bogus\"]}');" >/dev/null
ok "$(A "select (uf_mine('$T1')->>'email');")" "a@example.com" "email lowercased + stored"
ok "$(A "select (uf_mine('$T1')->'whens')::text;")" '["weeknight", "sunday"]' "whens canonical order"
ok "$(A "select (uf_mine('$T1')->'taps'->0->>'top');")" "true" "top pick marked"
ok "$(AE "select uf_finish('$T1', '{\"email\":\"nope\"}');")" "bad_finish" "bad email rejected"
# suggest → pending → mod approve
SUG=$(A "select uf_suggest('$T6', '{\"title\":\"Karaoke at the Monkey House\",\"when\":\"weeknight\",\"note\":\"see http://spam.example for more\"}')->>'id';")
ok "$(S "select status||'|'||blurb from uf_ideas where id='$SUG';")" "pending|see for more" "suggestion pending, URL stripped"
ok "$(A "select jsonb_array_length(uf_ideas_public());")" "30" "pending not public"
ok "$(A "select uf_mod_queue('wrong')->>'error';")" "bad_secret" "wrong mod secret"
ok "$(A "select jsonb_array_length(uf_mod_queue('test-secret')->'pending');")" "1" "mod sees pending"
A "select uf_mod_idea('test-secret','$SUG','approve');" >/dev/null
ok "$(S "select status from uf_ideas where id='$SUG';")" "live" "approved → live"
A "select uf_suggest('$T6', '{\"title\":\"Second idea\",\"when\":\"any\"}');" >/dev/null; A "select uf_suggest('$T6', '{\"title\":\"Third idea\",\"when\":\"any\"}');" >/dev/null
ok "$(AE "select uf_suggest('$T6', '{\"title\":\"Fourth idea\",\"when\":\"any\"}');")" "slow_down" "3 suggestions/day"
# host via mod
KEY=$(A "select uf_mod_host('test-secret','add','{\"name\":\"Jonathon\",\"email\":\"j@example.com\"}')->>'key';")
ok "${#KEY}" "32" "host key minted"
ok "$(A "select uf_host_me('$KEY')->>'name';")" "Jonathon" "host key works"
ok "$(A "select uf_host_me('00000000000000000000000000000000')->>'error';")" "bad_key" "wrong key"
ok "$(A "select (uf_host_wants('$KEY')->'ideas'->0->>'yes') is not null;")" "t" "host sees counts"
# claim the tipped idea, needs a date
PLAN=$(A "select uf_host_claim('$KEY', '{\"idea_id\":\"$IDEA\",\"title\":\"Sunset paddle from North Beach\",\"place\":\"North Beach boathouse\",\"cap\":6,\"threshold\":3}')->>'id';")
ok "$(S "select status from uf_ideas where id='$IDEA';")" "claimed" "idea claimed"
ok "$(AE "select uf_host_claim('$KEY', '{\"idea_id\":\"$IDEA\",\"title\":\"Duplicate claim\",\"place\":\"Same beach\"}');")" "already_claimed" "one live plan per idea"
ok "$(S "select uf_idea_public(i)->>'host_name' from uf_ideas i where id='$IDEA';")" "Jonathon" "host name public (first name)"
# commits: name+email required, threshold 3 but no date → tipped not on
ok "$(AE "select uf_commit('$PLAN','$T1','{\"name\":\"Pri\"}');")" "bad_commit" "email required"
ok "$(A "select uf_commit('$PLAN','$T1','{\"name\":\"Pri\",\"email\":\"p@x.io\"}')->>'status';")" "in" "first in"
A "select uf_commit('$PLAN','$T2','{\"name\":\"Sam\",\"email\":\"s@x.io\"}');" >/dev/null
ok "$(S "select count(*) from uf_commits where plan_id='$PLAN' and notified = false;")" "2" "commits start un-notified (uf-notify flips per person)"
ok "$(S "select count(*) from information_schema.columns where table_name='uf_commits' and column_name='notified' and column_default='false';")" "1" "notified defaults false"
ok "$(A "select uf_commit('$PLAN','$T3','{\"name\":\"Lee\",\"email\":\"l@x.io\"}')->>'on';")" "false" "threshold met but undated → not on"
ok "$(S "select status||'|'||(tipped_at is not null) from uf_plans where id='$PLAN';")" "tipping|true" "plan tipped, still tipping"
# host sets a date → goes on
ok "$(A "select uf_host_update('$KEY','$PLAN','{\"starts_at\":\"2030-09-04T22:00:00Z\"}')->>'on';")" "true" "dating a tipped plan flips it on"
ok "$(S "select status from uf_plans where id='$PLAN';")" "on" "plan on"
# cap 6: fill to 6 then waitlist
A "select uf_commit('$PLAN','$T4','{\"name\":\"Ana\",\"email\":\"a@x.io\"}');" >/dev/null; A "select uf_commit('$PLAN','$T5','{\"name\":\"Bo\",\"email\":\"b@x.io\"}');" >/dev/null
A "select uf_commit('$PLAN','$T6','{\"name\":\"Cy\",\"email\":\"c@x.io\"}');" >/dev/null
T7=abababababababababababababababab
ok "$(A "select uf_commit('$PLAN','$T7','{\"name\":\"Di\",\"email\":\"d@x.io\"}')->>'status';")" "wait" "7th is waitlisted"
ok "$(S "select uf_plan_public(p)->>'in_count' from uf_plans p where id='$PLAN';")" "6" "in_count 6"
A "select uf_uncommit('$PLAN','$T1');" >/dev/null
ok "$(S "select status from uf_commits where plan_id='$PLAN' and token_hash=uf_hash('$T7');")" "in" "waitlist promoted on uncommit"
ok "$(A "select (uf_host_plans('$KEY')->'mine'->0->'people'->0) ? 'email';")" "f" "host never sees emails"
ok "$(A "select uf_plans_public()->0->>'host_name';")" "Jonathon" "plans_public host first name"
ok "$(A "select (uf_plans_public()->0) ? 'email';")" "f" "plans_public has no emails"
# meetup link validation, cap raise promotes
ok "$(AE "select uf_host_update('$KEY','$PLAN','{\"meetup_url\":\"http://meetup.com/x\"}');")" "bad_plan" "http link rejected"
A "select uf_host_update('$KEY','$PLAN','{\"meetup_url\":\"https://www.meetup.com/burlington-social-activites-group/events/1/\"}');" >/dev/null
# done with showed; idea back to live
A "select uf_host_action('$KEY','$PLAN','done','{\"showed\":5}');" >/dev/null
ok "$(S "select status||'|'||showed from uf_plans where id='$PLAN';")" "done|5" "done with showed"
ok "$(S "select status from uf_ideas where id='$IDEA';")" "live" "idea back to live after done"
ok "$(A "select uf_plans_public()->0->>'showed';")" "5" "showed public on done rows"
# release an empty plan, cancel
P2=$(A "select uf_host_claim('$KEY', '{\"title\":\"Floated idea with no idea\",\"place\":\"Somewhere\",\"category\":\"games\"}')->>'id';")
ok "$(S "select category from uf_plans where id='$P2';")" "games" "host-floated plan keeps category"
A "select uf_host_action('$KEY','$P2','release');" >/dev/null
ok "$(S "select count(*) from uf_plans where id='$P2';")" "0" "released plan gone"
# mod host disable
HID=$(S "select id from uf_hosts limit 1;")
A "select uf_mod_host('test-secret','disable','{\"id\":\"$HID\"}');" >/dev/null
ok "$(A "select uf_host_me('$KEY')->>'error';")" "bad_key" "disabled host locked out"
A "select uf_mod_host('test-secret','enable','{\"id\":\"$HID\"}');" >/dev/null
# lockout: 20 bad keys shuts the gate
for i in $(seq 1 20); do A "select uf_host_me('0000000000000000000000000000000$((i%10))');" >/dev/null; done
ok "$(A "select uf_host_me('00000000ffffffffffffffffffffffff')->>'error';")" "bad_key" "host gate locks a prefix after 20 bad keys"
ok "$(A "select uf_host_me('$KEY')->>'name';")" "Jonathon" "real key (other prefix) still works"

# --- review round: stuck claimed, on-without-date, cap floor, per-prefix lockout
P -c "delete from uf_host_fails;" >/dev/null
KEY2=$(A "select uf_mod_host('test-secret','add','{\"name\":\"Maya\"}')->>'key';")
I2=$(S "select id from uf_ideas where slug='pinball-co-op-wednesday';")
P3=$(A "select uf_host_claim('$KEY2', '{\"idea_id\":\"$I2\",\"title\":\"Pinball night\",\"place\":\"Pinball Co-op\",\"starts_at\":\"2030-01-01T23:00:00Z\",\"cap\":4,\"threshold\":2}')->>'id';")
A "select uf_commit('$P3','$T1','{\"name\":\"A\",\"email\":\"a1@x.io\"}');" >/dev/null; A "select uf_commit('$P3','$T2','{\"name\":\"B\",\"email\":\"b1@x.io\"}');" >/dev/null
ok "$(S "select status from uf_plans where id='$P3';")" "on" "threshold + date → on"
A "select uf_commit('$P3','$T3','{\"name\":\"C\",\"email\":\"c1@x.io\"}');" >/dev/null
ok "$(AE "select uf_host_update('$KEY2','$P3','{\"cap\":2}');")" "cap_too_small" "cap below in_count refused"
A "select uf_host_update('$KEY2','$P3','{\"starts_at\":null}');" >/dev/null
ok "$(S "select status||'|'||coalesce(on_at::text,'null')||'|'||notified_on from uf_plans where id='$P3';")" "tipping|null|false" "clearing the date demotes on → tipping"
A "select uf_host_update('$KEY2','$P3','{\"starts_at\":\"2030-01-02T23:00:00Z\"}');" >/dev/null
ok "$(S "select status from uf_plans where id='$P3';")" "on" "re-dating re-announces"
# stuck claimed: simulate a plan that finished via the sweep (on, started long ago)
P -c "update uf_plans set starts_at = now() - interval '3 days' where id='$P3';" >/dev/null
A "select uf_plans_public();" >/dev/null
ok "$(S "select p.status||'|'||i.status from uf_plans p join uf_ideas i on i.id=p.idea_id where p.id='$P3';")" "done|live" "sweep finishes the plan AND releases the idea"
# cast garbage → clean codes
ok "$(AE "select uf_host_claim('$KEY2', '{\"title\":\"Cast test plan\",\"place\":\"Here\",\"cap\":\"lots\"}');")" "bad_plan" "garbage cap → bad_plan"
ok "$(AE "select uf_mod_host('test-secret','disable','{\"id\":\"nope\"}');")" "not_found" "garbage host id → not_found"
# per-prefix lockout: 20 misses on one prefix don't lock a different key
for i in $(seq 1 20); do A "select uf_host_me('1111111100000000000000000000000$((i%10))');" >/dev/null; done
ok "$(A "select uf_host_me('$KEY2')->>'name';")" "Maya" "other prefixes unaffected by a locked prefix"
ok "$(A "select uf_host_me('11111111ffffffffffffffffffffffff')->>'error';")" "bad_key" "locked prefix stays locked"

# seeds re-run is idempotent
P -f /tmp/uf-setup-test.sql >/dev/null 2>&1
ok "$(S "select count(*) from uf_ideas_public() x, jsonb_array_elements(x) e;")" "31" "re-run keeps 30 seeds + 1 approved"
echo "sql tests: $pass passed, $fail failed"; [ "$fail" = 0 ]
