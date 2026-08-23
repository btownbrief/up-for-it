# Up For It — agent notes

Read `README.md` first. Stephen is non-technical — explain consequential
changes in plain language. Plain static site, no build step, ES modules.

## Rules that will trip you up

- **`js/core.js` is pure and that purity is the contract.** No DOM, no
  fetch, no `Date.now()` — time is an argument. Every validator and limit
  there is mirrored one-for-one by `supabase/up-for-it-SETUP.sql`
  (`uf_clean`, `uf_valid_when`, `uf_valid_category`, `uf_plan_fields`, the
  check constraints) and by `js/fake-backend.js`; the rate limits live in
  the SQL and the fake backend (`RATE`), not in core. **Change all three
  together**, and add a case to `scripts/test-core.mjs`. Adding a category
  or a "when" = `CATEGORIES`/`WHENS` in core + the two SQL check lists + the
  fake backend.
- **Privacy shape is load-bearing.** Reader emails live in `uf_people` and
  `uf_commits` and are returned by **no** public, host or mod RPC — the one
  exception is your own, back to your own device, in `uf_mine`
  (token-gated). `uf_host_wants` shows how many of an idea's yes-pile left
  an email, never which; `uf_mod_queue` shows counts (host emails in
  `uf_hosts` are Stephen's contact list and do show there, secret-gated).
  The only thing that reads reader emails in bulk is the edge function
  `uf-notify` (service role), for the four emails (claimed · on · tomorrow · called off). `uf_plans_public()`
  and `uf_ideas_public()` are the only public projections; never add a
  private column to either. Public text fields are URL-stripped server-side
  (`uf_clean`) so the board can't become a link farm; links live only in
  `exists_url` / `meetup_url` (https, validated).
- **The device token is the only identity.** 32 hex chars minted in
  localStorage, stored hashed (sha256) server-side, never shown. No login,
  no recovery: a new browser is a new person. Don't add accounts.
- **Host keys are sha256-hashed too, and the gate rests.** Stephen mints a
  32-hex key in `mod.html` (`uf_mod_host add/rekey` returns it ONCE);
  `host.html` keeps it in localStorage (`savedHostKey`); wrong keys count
  toward a 15-minute lockout after 20 failures (`uf_host_fails`). Host RPCs
  report a wrong key as `{error:'bad_key'}` in the body, not a raise, so the
  failure counter survives the transaction — `net.js` turns it into a
  `NetError` either way.
- **The moderator secret is bcrypt.** Its hash sits in `uf_mod_hash()`; the
  plaintext lives only in `~/.config/btownbrief/secrets.env` and a password
  manager. `mod.html` keeps it in sessionStorage. Same 20-wrong / 15-minute
  rest. Never log or commit it.
- **Fail soft, never error-state.** No SQL yet → `not_ready` → "isn't
  switched on yet", and the static parts keep rendering. Missing edge
  function → no email, nothing else changes (the client fires and forgets).
  `?demo=1` runs the whole thing against `FakeBackend` with seeded ideas,
  plans, hosts (`DEMO_HOST_KEY`) and mod secret `'demo'`, and saves nothing.
- **Email goes out from one place and is idempotent.** `uf-notify` flips
  `notified_claim` / `notified_on` / `reminded` atomically before sending and
  flips them back if Resend fails. If you add a fourth message, add a fourth
  flag — never re-send on a client retry. Never log addresses.
- **Design doctrine: one thing on screen, many dimensions → few controls.**
  A new facet goes on the card's meta line, not in a new filter control.
  Category chips are the only filter on Wishes. Counts stay hidden before the
  tip. Tap buttons, no swipe gestures. One accent, dark mode by tokens only
  (`css/tokens.css`; don't redefine tokens in page CSS). Build DOM with the
  `h()` helper and textContent — never innerHTML with user text.
- **Seeds come from `data/ideas.json` via `scripts/build-seed-sql.mjs`.**
  Edit the JSON, run the script, re-paste the SQL. Everything after the
  `@@SEEDS@@` marker is generated; don't hand-edit it. `on conflict (slug)
  do nothing` keeps a live idea's status and taps. Every idea names a real
  place; "already a thing" entries link to the real group.
- **`data/meetup.json` is output.** `scripts/meetup-ical.mjs` writes it and
  `meetup.yml` commits it every 6 hours. Don't hand-edit; don't make the UI
  depend on it existing.
- **Honest threat model.** The anon key is public; a determined Sybil can
  mint tokens and tap junk. One tap per idea per token, 3 suggestions/day,
  10 open "I'm in" per token, server-side validation, URL stripping and the
  back room stop casual mischief. Don't present anything here as
  integrity-protected.

## Before you finish

```
node --test scripts/test-core.mjs
for f in js/*.js scripts/*.mjs; do node --check "$f"; done
node -e "JSON.parse(require('fs').readFileSync('data/ideas.json','utf8'))"
bash scripts/test-sql.sh                       # needs a local Postgres 17 + psql (set PGHOST/PGPORT or pass a conninfo)
deno check supabase/functions/uf-notify/index.ts   # if you touched the edge function
NODE_PATH=<playwright dir> node scripts/playtest.mjs        # reader flow + screenshots
NODE_PATH=<playwright dir> node scripts/playtest-desk.mjs   # host desk + back room
```
