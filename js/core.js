// UP FOR IT — the pure core. No DOM, no fetch, no clocks (time is an
// argument). Everything the UI, the host desk and the backend agree on
// lives here: the option lists, the validators (mirrored one-for-one by
// supabase/up-for-it-SETUP.sql), the deck order, the status copy, and the
// Meetup description writer. scripts/test-core.mjs exercises all of it.
//
// Vocabulary (same words in the SQL and the UI):
//   idea   — a hostable unit: "Sunset paddle from Oakledge · weeknights".
//            Readers tap Pass / Maybe / I'd go. Five "I'd go" = it TIPS.
//   plan   — a host took an idea (or wrote one): real host, place, cap,
//            threshold, date or "needs a date". Readers say "I'm in".
//            Enough "I'm in" = it's ON. Then it happens, and it's DONE.
//   person — one device token (+ optional email + when they're free).
//   host   — one of the Btown Brief IRL leaders, with a key Stephen made.

export const APP = 'up-for-it';
export const APP_NAME = 'Up For It';
export const IDEA_THRESHOLD = 5;      // "I'd go" taps before an idea tips and hosts see it first
export const PLAN_THRESHOLD = 5;      // default "I'm in" count before a plan is on
export const PLAN_CAP = 8;            // default spots before "I'm in" becomes a waitlist
export const DECK_SIZE = 12;          // cards per sitting
export const TOP_PICKS = 3;           // "your three"
export const CLAIM_DAYS = 14;         // an undated, un-tipped plan is released after this
export const WEIGH_IN_DAYS = 7;       // "N neighbors weighed in this week"
export const SUGGEST_PER_DAY = 3;
export const LIMITS = {
  title: 56, blurb: 120, name: 24, email: 120, place: 80, detail: 200,
  meetup: 200, suggestTitle: 56, suggestNote: 120, hostName: 32,
};

// When a person is usually free — asked once, after the deck, four chips.
// Also the "when" hint on an idea/plan. 'any' is allowed on ideas only.
export const WHENS = [
  { id: 'weeknight', label: 'Weeknights',          short: 'Weeknight' },
  { id: 'sat-am',    label: 'Saturday mornings',   short: 'Sat AM' },
  { id: 'sat-pm',    label: 'Saturday afternoons', short: 'Sat PM' },
  { id: 'sunday',    label: 'Sundays',             short: 'Sunday' },
];
export const WHEN_HINTS = [...WHENS, { id: 'any', label: 'Anytime', short: 'Anytime' }];
export const whenLabel = (id) => (WHEN_HINTS.find((w) => w.id === id) || { label: id }).label;
export const whenShort = (id) => (WHEN_HINTS.find((w) => w.id === id) || { short: id }).short;

export const CATEGORIES = [
  { id: 'outdoors',   label: 'Outdoors' },
  { id: 'food-drink', label: 'Food & drink' },
  { id: 'games',      label: 'Games' },
  { id: 'music',      label: 'Music' },
  { id: 'arts',       label: 'Arts' },
  { id: 'learning',   label: 'Learning' },
  { id: 'wellness',   label: 'Wellness' },
  { id: 'sports',     label: 'Sports' },
  { id: 'community',  label: 'Community' },
  { id: 'social',     label: 'Social' },
  { id: 'words',      label: 'Words' },
  { id: 'film',       label: 'Film' },
];
export const categoryLabel = (id) => (CATEGORIES.find((c) => c.id === id) || { label: id }).label;
export const validCategory = (id) => CATEGORIES.some((c) => c.id === id);

export const ANSWERS = ['yes', 'maybe', 'pass'];

// The masthead photo follows the season (Stephen's City Guide photos,
// shared with Who's Playing). month is 0-based.
export const MASTHEADS = [
  { id: 'winter', src: 'assets/img/shore-winter.jpg', focus: '50% 62%', alt: 'First light over Lake Champlain, snow along the shore' },
  { id: 'fall',   src: 'assets/img/park-fall.jpg',    focus: '50% 38%', alt: 'Maples in full color over a Burlington park' },
  { id: 'summer', src: 'assets/img/field-dusk.jpg',   focus: '50% 72%', alt: 'A game under the lights at Virtue Field as the sky goes blue' },
];
export function mastheadFor(month) {
  if (month === 11 || month <= 2) return MASTHEADS[0];
  if (month === 9 || month === 10) return MASTHEADS[1];
  return MASTHEADS[2];
}

// --------------------------------------------------------------- cleaning
// Mirrors the SQL uf_clean: control characters → space, whitespace
// collapsed, trimmed, URLs stripped from public text (the board can never
// become a link farm), clipped. Links live only in the fields meant for
// them (exists_url, meetup_url) and those are validated as https URLs.
export function cleanText(s, max) {
  let t = String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\b(?:https?:\/\/|www\.)\S+/gi, '').replace(/\s+/g, ' ').trim();
  return max ? t.slice(0, max) : t;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const looksLikeEmail = (s) => EMAIL_RE.test(String(s ?? '').trim());
const TOKEN_RE = /^[a-f0-9]{32}$/;
export const validToken = (t) => TOKEN_RE.test(String(t ?? ''));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => UUID_RE.test(String(s ?? ''));
const HTTPS_RE = /^https:\/\/\S+$/i;
export const validLink = (s) => HTTPS_RE.test(String(s ?? '').trim());
export const cleanEmail = (s) => String(s ?? '').trim().toLowerCase().slice(0, LIMITS.email);
// Plans live in Burlington, so a wall-clock time with no zone on it
// ('YYYY-MM-DDTHH:MM', what <input type=datetime-local> gives) means
// Eastern time — whatever zone the host's phone happens to be in. Full ISO
// strings with a Z or offset are taken as written.
export const TZ = 'America/New_York';
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
function zoneParts(ms, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute };
}
// Wall clock in tz → epoch ms. NaN for a time that doesn't exist (Feb 31,
// or the hour the clocks spring forward). On the fall-back night, when a
// wall time happens twice, this is the FIRST one (still daylight time).
export function wallToMs(s, tz = TZ) {
  const m = WALL_RE.exec(String(s ?? '').trim());
  if (!m) return NaN;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(want).getUTCMonth() !== mo - 1 || new Date(want).getUTCDate() !== d) return NaN; // Feb 31 and friends
  const same = (ms) => { const p = zoneParts(ms, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) === want; };
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(guess, tz);
    guess += want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  if (!same(guess)) return NaN;                 // spring-forward gap: no such moment
  if (same(guess - 3600000)) return guess - 3600000; // fall-back overlap: take the earlier one
  return guess;
}
// Epoch/ISO → 'YYYY-MM-DDTHH:MM' wall clock in tz (what the desk's input shows).
export function msToWall(iso, tz = TZ) {
  const ms = typeof iso === 'number' ? iso : Date.parse(String(iso ?? ''));
  if (!Number.isFinite(ms)) return '';
  const p = zoneParts(ms, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}
export function parseWhen(s) {
  if (s == null || s === '') return null;
  const str = String(s).trim();
  const ms = WALL_RE.test(str) ? wallToMs(str) : Date.parse(str);
  return Number.isFinite(ms) ? ms : NaN;
}

// ------------------------------------------------------------- validation
// Each validator returns { ok, errors: {field: message}, value } where value
// is the cleaned record the backend should receive.

export function validateTap(input) {
  const errors = {};
  if (!isUuid(input?.idea_id)) errors.idea_id = 'Which idea?';
  const answer = ANSWERS.includes(input?.answer) ? input.answer : null;
  if (!answer) errors.answer = 'Pass, maybe, or go?';
  return { ok: !Object.keys(errors).length, errors, value: { idea_id: input?.idea_id, answer } };
}

// End of the deck: your three (from the yes pile), an email so we can
// tell you when a host picks one up, and when you're usually free.
export function validateFinish(input) {
  const errors = {};
  const top = Array.from(new Set((input?.top || []).filter(isUuid))).slice(0, TOP_PICKS);
  const emailRaw = cleanEmail(input?.email);
  if (emailRaw && !looksLikeEmail(emailRaw)) errors.email = "That email doesn't look right.";
  const whens = WHENS.filter((w) => (input?.whens || []).includes(w.id)).map((w) => w.id);
  return { ok: !Object.keys(errors).length, errors, value: { top, email: emailRaw, whens } };
}

export function validateSuggestion(input) {
  const errors = {};
  const title = cleanText(input?.title, LIMITS.suggestTitle);
  if (title.length < 4) errors.title = 'What would you go to?';
  const when = WHEN_HINTS.some((w) => w.id === input?.when) ? input.when : null;
  if (!when) errors.when = 'Roughly when?';
  const note = cleanText(input?.note, LIMITS.suggestNote);
  const emailRaw = cleanEmail(input?.email);
  if (emailRaw && !looksLikeEmail(emailRaw)) errors.email = "That email doesn't look right.";
  return { ok: !Object.keys(errors).length, errors, value: { title, when, note, email: emailRaw } };
}

// "I'm in" — the one place we ask for a name and require an email: this is
// the high-intent moment, and the email is how "it's on" and "tomorrow"
// reach you.
export function validateCommit(input) {
  const errors = {};
  const name = cleanText(input?.name, LIMITS.name);
  if (name.length < 1) errors.name = 'Your first name.';
  const email = cleanEmail(input?.email);
  if (!looksLikeEmail(email)) errors.email = "We need an email to tell you it's on.";
  return { ok: !Object.keys(errors).length, errors, value: { name, email } };
}

// A host's plan. idea_id is optional (hosts can float their own idea).
// starts_at null = "needs a date". Meetup link optional, https only.
export function validatePlan(input) {
  const errors = {};
  const title = cleanText(input?.title, LIMITS.title);
  if (title.length < 4) errors.title = 'Give it a name people will recognize.';
  const place = cleanText(input?.place, LIMITS.place);
  if (place.length < 2) errors.place = 'Where?';
  const detail = cleanText(input?.detail, LIMITS.detail);
  const startsMs = parseWhen(input?.starts_at);
  if (Number.isNaN(startsMs)) errors.starts_at = "That date doesn't exist — check it (and the hour the clocks change).";
  const cap = Number.isInteger(input?.cap) ? input.cap : PLAN_CAP;
  if (!(cap >= 2 && cap <= 60)) errors.cap = 'Between 2 and 60.';
  const threshold = Number.isInteger(input?.threshold) ? input.threshold : PLAN_THRESHOLD;
  if (!(threshold >= 2 && threshold <= cap)) errors.threshold = 'Between 2 and the cap.';
  const meetup = String(input?.meetup_url ?? '').trim().slice(0, LIMITS.meetup);
  if (meetup && !validLink(meetup)) errors.meetup_url = 'Paste the full https:// link.';
  const idea_id = input?.idea_id ? (isUuid(input.idea_id) ? input.idea_id : null) : null;
  if (input?.idea_id && !idea_id) errors.idea_id = 'That idea id is off.';
  const category = validCategory(input?.category) ? input.category : 'social';
  const value = {
    idea_id, title, place, detail, category,
    starts_at: startsMs == null || Number.isNaN(startsMs) ? null : new Date(startsMs).toISOString(),
    cap, threshold, meetup_url: meetup,
  };
  return { ok: !Object.keys(errors).length, errors, value };
}

// ------------------------------------------------------------------- deck
// A small deterministic shuffle seeded by the device token, so one person
// always sees the same order (no position bias across the crowd, no
// reshuffling mid-sitting). The server already excludes ideas this device
// has tapped; we just order and cut.
function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function deckOrder(ideas, token, { size = DECK_SIZE, month = 6 } = {}) {
  const rnd = mulberry32(seedFrom(String(token || 'deck')));
  const live = (ideas || []).filter((i) => i.status === 'live' && inSeason(i, month));
  const arr = live.map((i) => ({ i, r: rnd() }));
  // tipped-and-unclaimed ideas ride a little earlier: they're the ones a
  // few more taps would hand to a host
  arr.sort((a, b) => (Number(Boolean(b.i.tipped_at)) - Number(Boolean(a.i.tipped_at))) * 0.35 + (a.r - b.r));
  return arr.map((x) => x.i).slice(0, size);
}
// month is 0-based; idea.months is 1-based (from the seed JSON), [] = year-round
export function inSeason(idea, month) {
  const m = idea?.months || [];
  return !m.length || m.includes(month + 1);
}

// ------------------------------------------------------------------ board
// Wishes tab order: claimed first (there's a plan to say "I'm in" to), then
// tipped (newest tip first), then the rest — by season, then created.
// Counts are never shown before the tip, so un-tipped ideas can't rank by
// popularity (no rich-get-richer).
export function ideasView(ideas, { month = 6, category = 'all' } = {}) {
  const rank = (i) => (i.status === 'claimed' ? 0 : i.tipped_at ? 1 : i.status === 'exists' ? 3 : 2);
  return (ideas || [])
    .filter((i) => ['live', 'claimed', 'exists'].includes(i.status))
    .filter((i) => category === 'all' || i.category === category)
    .sort((a, b) => rank(a) - rank(b)
      || (rank(a) === 1 ? Date.parse(b.tipped_at) - Date.parse(a.tipped_at) : 0)
      || Number(inSeason(b, month)) - Number(inSeason(a, month))
      || Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
}

// Plans on the home screen: needs-your-"I'm in" first (tipping, soonest
// date or undated last), then on, by date.
export function plansView(plans, { nowMs }) {
  const live = (plans || []).filter((p) => ['tipping', 'on'].includes(p.status))
    .filter((p) => !p.starts_at || Date.parse(p.starts_at) > nowMs - 6 * 3600000);
  const key = (p) => (p.starts_at ? Date.parse(p.starts_at) : Infinity);
  return live.sort((a, b) => key(a) - key(b) || Date.parse(a.created_at) - Date.parse(b.created_at));
}

// Public per-idea copy.  yes_count is null before the tip (server-side).
export function ideaStatus(idea) {
  if (idea.status === 'exists') return { kind: 'exists', line: idea.exists_note || 'Already a thing' };
  if (idea.status === 'claimed') return { kind: 'claimed', line: idea.host_name ? `${idea.host_name} is hosting this` : 'A host has this' };
  if (idea.tipped_at) return { kind: 'tipped', line: `${idea.yes_count} would go · looking for a host` };
  return { kind: 'open', line: 'Not tipped yet' };
}

// Per-plan state + the one line under the title.
export function planState(plan, nowMs) {
  const inN = plan.in_count || 0;
  if (plan.status === 'cancelled') return { state: 'cancelled', line: 'Called off' };
  if (plan.status === 'done') return { state: 'done', line: plan.showed != null ? `Happened · ${plan.showed} came` : 'Happened' };
  if (plan.status === 'on') {
    if (plan.starts_at && Date.parse(plan.starts_at) < nowMs) return { state: 'past', line: 'Happened' };
    const left = Math.max(0, (plan.cap || PLAN_CAP) - inN);
    if (left === 0) return { state: 'full', line: `It's on · full${plan.wait_count ? ` · ${plan.wait_count} waiting` : ''}` };
    return { state: 'on', line: `It's on · ${inN} in · ${left} ${left === 1 ? 'spot' : 'spots'} left` };
  }
  // tipping
  const th = plan.threshold || PLAN_THRESHOLD;
  const more = Math.max(0, th - inN);
  if (!plan.starts_at) return { state: 'needs-date', line: `${inN} in so far · needs a date` };
  if (more === 0) return { state: 'tipped', line: `${inN} in · ready for the host to make it official` };
  return { state: 'tipping', line: `${inN} of ${th} · ${more} more until it's on` };
}
export const planProgress = (plan) => Math.min(1, (plan.in_count || 0) / (plan.threshold || PLAN_THRESHOLD));

// ----------------------------------------------------------------- host
// Momentum: yes taps in the last 7 days; hosts see demand sorted by it,
// not by all-time total, so old ideas don't sit on top forever.
export function wantsOrder(ideas) {
  return [...(ideas || [])].sort((a, b) =>
    (b.yes_7d || 0) - (a.yes_7d || 0) || (b.yes || 0) - (a.yes || 0) || (b.top || 0) - (a.top || 0));
}
// 0..4 heat bucket for a cell given the row max
export function heat(n, max) {
  if (!n || !max) return 0;
  const r = n / max;
  return r > 0.85 ? 4 : r > 0.6 ? 3 : r > 0.35 ? 2 : 1;
}

// What the host pastes into Meetup. Plain text, no markdown.
export function meetupDescription(plan, { appUrl = 'https://play.btownbrief.com/up-for-it/' } = {}) {
  const when = plan.starts_at ? formatWhen(plan.starts_at) : 'Date TBD';
  const lines = [
    plan.title,
    '',
    `${when} · ${plan.place}`,
    plan.detail ? '' : null,
    plan.detail || null,
    '',
    `This one started as an idea on Up For It — ${plan.in_count || 0} neighbors said they'd go before it was even scheduled. Hosted by ${plan.host_name || 'a Btown Brief IRL host'}.`,
    `Cap is ${plan.cap || PLAN_CAP}. Show up when you say you will; if you can't make it, un-RSVP so someone else can.`,
    '',
    `Say what you'd go to next: ${appUrl}`,
  ].filter((l) => l !== null);
  return lines.join('\n');
}

// ------------------------------------------------------------ formatting
export function formatWhen(iso, { tz = TZ } = {}) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
  let time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).replace(':00', '').replace(' ', '').toLowerCase();
  return `${day} · ${time}`;
}
export function timeAgo(iso, nowMs) {
  const mins = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
export function daysUntil(iso, nowMs) {
  return Math.ceil((Date.parse(iso) - nowMs) / 86400000);
}
