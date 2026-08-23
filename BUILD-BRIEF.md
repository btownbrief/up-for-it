# Up For It — build brief (shared by the parallel builders; delete before launch)

Repo: `~/btownbrief/up-for-it` (git, branch main). Plain static site, no build
step, ES modules, GitHub Pages at `https://play.btownbrief.com/up-for-it/`.
Backend: Supabase RPCs (anon key) defined in `supabase/up-for-it-SETUP.sql`.
House pattern = Who's Playing (`~/btownbrief/whos-playing`): read its
`AGENTS.md`, `README.md`, `index.html`, `css/style.css`, `js/app.js`,
`mod.html` first — mirror its structure, tone, and restraint. Stephen is
non-technical; comments and copy are plain language.

## The contract (already written, tested — do NOT change)
- `js/core.js` — pure: option lists (WHENS, WHEN_HINTS, CATEGORIES, ANSWERS),
  validators, `deckOrder`, `ideasView`, `plansView`, `ideaStatus`,
  `planState`, `planProgress`, `wantsOrder`, `heat`, `meetupDescription`,
  `formatWhen`, `timeAgo`, `mastheadFor`, MASTHEADS, LIMITS, thresholds.
- `js/net.js` — `backend().rpc(fn, args)`, `token()`, `isDemo()`,
  `notify(kind, planId)`, `explain(err)`, `savedName/savedEmail/savedHostKey`
  ({get,set}), `DEMO_MOD_SECRET='demo'`.
- `js/fake-backend.js` — in-memory twin + `seedDemo`; `DEMO_HOST_KEY =
  'deadbeefdeadbeefdeadbeefdeadbeef'`, `DEMO_HOST_KEY_2 = 'cafebabe…'`.
  `?demo=1` runs everything against it (fetches data/ideas.json).
- `supabase/up-for-it-SETUP.sql` — the backend. Error codes → `explain()`.
- `css/tokens.css` — tokens + base (both pages link it). Don't redefine tokens.
- `data/ideas.json` — 30 seed ideas.
- Tests: `node --test scripts/test-core.mjs`, `bash scripts/test-sql.sh`.

## Vocabulary (use these words in copy)
idea · tip / tipped ("5 would go") · plan · host · "I'm in" · it's on ·
happened · "needs a date" · "Up for it?" (the deck question) · Pass / Maybe /
I'd go (the three taps) · "Your three" · "N neighbors weighed in this week".

## RPCs (all via `backend().rpc(name, args)`)
Reader (token = `token()`):
- `uf_home {p_token|null}` → `{plans:[plan], ideas:[idea], mine|null, weigh_in, deck_left}`
- `uf_deck {p_token}` → `[idea]` (live, not yet tapped by this device; order with `deckOrder(ideas, token, {month})` and cut to 12)
- `uf_tap {p_token, p_idea, p_answer:'yes'|'maybe'|'pass'}` → `{tipped, yes_count|null}`
- `uf_finish {p_token, p_finish:{top:[ideaId≤3], email, whens:[...]}}` → `{}`
- `uf_suggest {p_token, p_suggestion:{title, when, note, email}}` → `{id}` (lands pending)
- `uf_commit {p_plan, p_token, p_commit:{name, email}}` → `{status:'in'|'wait', in_count, on:boolean}` — if `on` is true call `notify('on', planId)`
- `uf_uncommit {p_plan, p_token}` → `{}`
- `uf_mine {p_token}` → `{taps:[{idea_id,answer,top}], commits:[{plan_id,status,name}], email, name, whens}`
Host (key = 32 hex; `savedHostKey`; wrong key → NetError 'bad_key'):
- `uf_host_me {p_key}` → `{id, name}`
- `uf_host_wants {p_key}` → `{weigh_in, people, emails, ideas:[idea + {yes, maybe, pass, top, yes_7d, emails, whens:{weeknight:n,...}, source, origin}]}`
- `uf_host_plans {p_key}` → `{mine:[plan + {people:[{name,status}], notified_claim, notified_on, reminded}], others:[plan]}`
- `uf_host_claim {p_key, p_plan:{idea_id|null, title, place, detail, category, starts_at|null(ISO), cap, threshold, meetup_url}}` → `{id}` — then `notify('claimed', id)` if idea_id was set
- `uf_host_update {p_key, p_plan, p_patch:{any of the plan fields; starts_at:null allowed}}` → `{on:boolean}` — if on, `notify('on', planId)`
- `uf_host_action {p_key, p_plan, p_action:'on'|'cancel'|'release'|'done', p_payload:{showed}}` → `{}` — after 'on', `notify('on', planId)`
Mod (secret; wrong → 'bad_secret'; demo secret 'demo'):
- `uf_mod_queue {p_secret}` → `{pending:[idea], ideas:[idea+{yes,maybe,origin,source}], hosts:[{id,name,email,active,created_at,plans}], plans:[plan], stats:{people,emails,taps,weigh_in}}`
- `uf_mod_idea {p_secret, p_idea, p_action:'approve'|'reject'|'archive'|'restore'|'exists'|'edit'|'delete'|'add', p_patch}`
- `uf_mod_host {p_secret, p_action:'add'|'rekey'|'disable'|'enable'|'delete', p_payload:{name,email}|{id}}` → add/rekey return `{key}` (show ONCE)
- `uf_mod_plan {p_secret, p_plan, p_action:'cancel'|'delete'}`

Shapes: idea `{id, slug, title, blurb, when, category, months, status:'live'|'claimed'|'exists', exists_url, exists_note, tipped_at, created_at, yes_count|null, plan_id|null, host_name|null}`;
plan `{id, idea_id, title, place, detail, category, starts_at|null, cap, threshold, status:'tipping'|'on'|'done'|'cancelled', meetup_url, showed, created_at, tipped_at, on_at, host_name, in_count, wait_count}`.

## Design doctrine (Stephen's, non-negotiable)
- One thing on screen. ~3 screens. Many dimensions → few controls: facets go on the card's meta line, never into filter controls. The only filter on the Wishes tab is category chips (and only for categories that have ideas).
- Never land on an empty screen: if there are no plans, the deck card is the whole home; if the deck is exhausted, show "you've seen them all — here's what's tipping" and the Wishes.
- Counts are hidden before the tip (`yes_count` is null) — show "N neighbors weighed in this week" as the only pre-tip number.
- No swipe gestures (tap buttons only; it's fine to animate the card out). No accounts, no DMs, no GPS.
- Email is asked at two moments only: end of the deck (optional, "we'll tell you when a host picks one up") and "I'm in" (required). Remember name/email on device (`savedName/savedEmail`).
- Fail soft: `not_ready` → "isn't switched on yet" and the static parts still render.
- Build DOM with a tiny `h()` helper and textContent, never innerHTML with user text. a11y: dialogs are `<dialog>`, buttons have labels, live region for status, visible focus.
- Materials: warm paper, navy ink, lake teal accent, Instrument Serif for display, DM Sans body, seasonal photo masthead (`mastheadFor(month)` → assets/img), cards with 18px radius, one accent. Dark mode via tokens only.
- Copy: short, warm, specific, no exclamation points, no emoji in UI chrome. Footer: "A Btown Brief thing."

## File ownership (don't edit outside your lane)
- Builder A (reader): `index.html`, `css/style.css`, `js/app.js`, `scripts/playtest.mjs`
- Builder B (hosts + back room): `host.html`, `mod.html`, `css/desk.css`, `js/desk.js` (shared by both pages, if useful), `scripts/playtest-desk.mjs`
- Builder C (edge function, automation, docs): `supabase/functions/uf-notify/index.ts`, `scripts/newsletter-block.mjs`, `scripts/meetup-ical.mjs`, `data/meetup.json` (output), `.github/workflows/*.yml`, `README.md`, `AGENTS.md`
