# Up For It

Burlington, Vermont: say what you'd go to, and a real host picks it up. The
whole loop, in the app's own words:

- **Idea** — a hostable unit: *Sunset paddle from North Beach, a calm
  weeknight*. The deck asks "Up for it?" twelve cards at a time; you tap
  **Pass / Maybe / I'd go**. Five "I'd go" and the idea **tips** ("5 would
  go") — only then is its count public, and hosts see it first.
- **Plan** — a host (one of the Btown Brief IRL Meetup leaders) claims an
  idea or floats their own: real name, place, cap, threshold, a date or
  "needs a date". Readers say **"I'm in"** (first name + email — the only
  place we ask). Threshold reached + a date = **it's on**, and everyone who's
  in gets an email. Then it **happened** ("9 came"), or it was called off.
- **Your three** — at the end of the deck you pick the three you'd most go
  to, optionally leave an email ("we'll tell you when a host picks one up"),
  and say when you're usually free. The only number shown before a tip is
  "N neighbors weighed in this week".
- **Host desk** (`host.html`) — demand by momentum (this week's "I'd go"
  taps, not all-time), claim, set a date, make it official, mark it done.
  Stephen mints host keys in the back room (`mod.html`).
- **Four emails, that's all** — "a host picked this up", "it's on",
  "tomorrow", and "called off" (only to people who were in). No accounts,
  no DMs, no swipe gestures, no GPS.

Live: https://play.btownbrief.com/up-for-it/ — try
`?demo=1` for a seeded sample that saves nothing to the server or this device
(host desk: `host.html?demo=1`, key `deadbeefdeadbeefdeadbeefdeadbeef`;
back room: `mod.html?demo=1`, secret `demo`).

Plain static site, no build step, no accounts. Same Supabase project and
security model as the rest of the Btown fleet.

## Files

| | |
|---|---|
| `index.html`, `css/style.css`, `js/app.js` | the reader: deck, plans, wishes, Mine |
| `host.html`, `mod.html`, `css/desk.css`, `js/desk.js` | the host desk and the back room (linked from nowhere) |
| `css/tokens.css` | tokens + base shared by every page; don't redefine tokens |
| `js/core.js` | **pure**: option lists, validators, deck order, status copy, Meetup description. Mirrored by the SQL. |
| `js/fake-backend.js` | in-memory twin of the SQL — runs `?demo=1` and the tests |
| `js/net.js` | Supabase RPC client, device token, `notify()`, plain-language error copy |
| `data/ideas.json` | the seed deck (30 ideas; edit here, then `node scripts/build-seed-sql.mjs`) |
| `data/meetup.json` | the IRL Meetup calendar, refreshed every 6h by `meetup.yml` (output, don't hand-edit) |
| `supabase/up-for-it-SETUP.sql` | the whole backend; paste once |
| `supabase/functions/uf-notify/` | the four emails (Resend): claimed · it's on · tomorrow · called off |
| `scripts/test-core.mjs` | core + backend-mirror tests (`node --test`) |
| `scripts/test-sql.sh` | runs the SQL on a local Postgres as the anon role, end to end |
| `scripts/build-seed-sql.mjs` | regenerates the seed block at the bottom of the SQL from `data/ideas.json` |
| `scripts/meetup-ical.mjs` | fetches the Meetup iCal → `data/meetup.json` (`--print` to list) |
| `scripts/newsletter-block.mjs` | this week's plans as an edition block (`--html` for Beehiiv) |
| `scripts/playtest.mjs`, `scripts/playtest-desk.mjs` | Playwright runs of the real UI in demo mode, with screenshots |
| `.github/workflows/` | `checks` (tests on push), `remind` (daily "tomorrow" email), `meetup` (calendar refresh) |

## Run it

```
node --test scripts/test-core.mjs
for f in js/*.js scripts/*.mjs; do node --check "$f"; done
python3 -m http.server 8000      # then open http://localhost:8000/?demo=1
bash scripts/test-sql.sh          # needs a local Postgres 17 with psql
node scripts/meetup-ical.mjs --print
node scripts/newsletter-block.mjs [--html] [5]
```

## Ship checklist (Stephen)

1. **Repo + Pages.** Create `btownbrief/up-for-it` on GitHub, push `main`,
   Settings → Pages → deploy from branch `main` / root. It appears at
   `play.btownbrief.com/up-for-it/` like every other arcade repo.
2. **Backend.** Supabase → SQL Editor. First make your moderator hash:
   `select extensions.crypt('YOUR-SECRET', extensions.gen_salt('bf', 12));`
   (if that errors, run `create extension if not exists pgcrypto with schema extensions;` first).
   Paste the result into `uf_mod_hash()` in `supabase/up-for-it-SETUP.sql`,
   then paste and run the whole file. Use a long random secret — the gate
   locks for 15 minutes after 20 wrong guesses, but it is reachable by
   anyone. Keep the plaintext in `~/.config/btownbrief/secrets.env`
   (`UP_FOR_IT_MOD_SECRET`) and your password manager, never in the repo.
   Until the SQL runs, the app says "isn't switched on yet" and the static
   parts still render.
3. **Hosts.** Open `/up-for-it/mod.html`, enter the secret, **Add host** —
   start with you. The key shows once: send yourself the host link and
   open `host.html`; it remembers the key on that device. Repeat for each
   Meetup leader (text them their link; a lost key is a **Rekey**).
4. **Email — treat as required.** From the repo root:
   `supabase functions deploy uf-notify --no-verify-jwt --project-ref jnouvwxomrcffqwilqkq`
   then `supabase secrets set UF_NOTIFY_FROM="Up For It <hello@btownbrief.com>" --project-ref jnouvwxomrcffqwilqkq`
   (`RESEND_API_KEY` is already on the project from Who's Playing). Then
   claim one idea from your own host desk and check the function logs once:
   the browser swallows every failure, so a misconfiguration is otherwise
   silent. Without it the app still works — people see "it's on" in the app
   — but nobody is told.
5. **The daily reminder.** GitHub → Settings → Secrets and variables →
   Actions → new repository secret `SUPABASE_ANON_KEY` = the publishable key
   in `js/net.js`. That lets `remind.yml` poke the function every morning
   without the key sitting in a workflow file. Run it once by hand (Actions
   → remind → Run workflow) and expect `{"sent":true,"plans":0,"emails":0}`.
6. **Register it** (three places, like Table Talk taught us):
   - hub `index.html` + btown-brief `data/catalog.json` (a "Join in" card:
     *Up For It — say what you'd go to; a real host picks it up*),
   - `btownbrief.github.io/games.json` so the ⌘K palette and arcade know it
     (`{"slug":"up-for-it","name":"Up For It","emoji":"🙋","pitch":"Say what you'd go to. Five neighbors agree, a real host picks it up, and it's on. Burlington only.","section":"local-more","live":true,"leaderboard":false}`),
   - newsletter: link the deck (`?deck=1`) and single plans (`?plan=<id>`).
7. **Before the newsletter link goes out: 6–8 host-authored plans and 3
   hosts.** Ask the Meetup leaders for real plans with places and dates so
   the first visitor never lands on an empty home. Never fake taps or plans.
   Then `node scripts/newsletter-block.mjs` each Monday and Friday for the
   edition block.
8. **Keep the deck honest.** Every idea in `data/ideas.json` names a real
   place and a real season; "already a thing" ideas link to the real group.
   Edit the JSON, run `node scripts/build-seed-sql.mjs`, re-paste the SQL
   (re-running never clobbers a live idea's status or taps).

## Design rules

- Materials come from the City Guide: warm paper, navy ink, lake teal,
  Instrument Serif over DM Sans. The masthead photo is one of Stephen's and
  follows the season (`MASTHEADS` in core.js: Virtue Field at dusk for
  Apr–Sep, the park in foliage for Oct–Nov, the snowy shoreline at dawn
  for Dec–Mar); it fades into the page so the cards ride up into it. Swap
  a photo by dropping a ~1600px JPEG into `assets/img/` and pointing the
  entry at it.
- One thing on screen, about three screens. You never land on an empty
  screen: no plans → the deck card is the home; deck exhausted → "you've
  seen them all — here's what's tipping" and the Wishes.
- Many dimensions, few controls: when, category, season, host all live on
  the card's meta line. The only filter on Wishes is category chips, and
  only for categories that have ideas.
- Counts are hidden before the tip. The one number you see first is "N
  neighbors weighed in this week" — no rich-get-richer, no position bias
  (each device sees the deck in its own fixed order).
- Tap buttons, never swipes. No accounts, no DMs, no GPS. Email is asked at
  two moments only: end of the deck (optional) and "I'm in" (required), and
  the device remembers it.
- The host's word is the plan. The app governs the listing, not the
  relationship: hosts set cap and threshold, make it official, call it off,
  mark it done. "Already a thing" is a redirect, not a competitor.
- Copy is short, warm and specific; no exclamation points, no emoji in UI
  chrome. Footer: "A Btown Brief thing."

## The plans contract for sibling apps

Other Btown apps (Small Talk's Plans tab reads this today) get plans from
one public RPC, nothing else:

```
POST https://jnouvwxomrcffqwilqkq.supabase.co/rest/v1/rpc/uf_plans_public
apikey: <publishable key>   Content-Type: application/json   body: {}
```

It returns a JSON array of plans, ordered by `starts_at` (undated last),
then `created_at`:

| field | meaning |
|---|---|
| `id` | uuid, stable for the life of the plan; deep link is `https://play.btownbrief.com/up-for-it/?plan=<id>` |
| `idea_id` | uuid or null (a host floated their own) |
| `title`, `place`, `detail` | plain text, URL-stripped, ≤56 / ≤80 / ≤200 chars |
| `category` | one of `outdoors` `food-drink` `games` `music` `arts` `learning` `wellness` `sports` `community` `social` `words` `film` |
| `starts_at` | ISO timestamp or null ("needs a date"). Show in America/New_York. |
| `cap`, `threshold` | spots, and "I'm in"s needed before it's on |
| `status` | `tipping` · `on` · `done` · `cancelled` |
| `meetup_url` | https link or `''` |
| `showed` | how many came (set when done) or null |
| `created_at`, `tipped_at`, `on_at` | ISO timestamps or null |
| `host_name` | the host's first name only |
| `in_count`, `wait_count` | counts only — never who |

Rules of the road:

- **Show `status = 'on'` plans that have a `starts_at`, and recent `done`
  ones** ("happened · 9 came"). `tipping` plans are Up For It's own business
  (they need the "I'm in" flow); `cancelled` never appears in this feed.
  `done` plans appear for 14 days after they happened.
- Counts only, first names only. There is no email, no token, no who in
  this projection and there never will be — that is the privacy shape.
- Ids are stable; link to `?plan=<id>` and let Up For It handle "I'm in".
- The call is cheap and cached nowhere; fetch on load, not on a timer.
- The shape above is the whole contract. If you need something else, ask
  for a new RPC — don't reach for the tables (anon can't read them anyway).
