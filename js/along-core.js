// COME ALONG — pure rules. No DOM, no fetch, no Date.now(): time is an
// argument. Mirrored one-for-one by supabase/come-along-SETUP.sql (ca_*)
// and js/along-backend.js. Change all three together and add a test.
//
// A come-along is a Btown group going to someone ELSE's event: a host picks
// an event from the guide's calendar, adds a meeting point, a meet time and
// one line of invitation, and gets one link. Readers say "I'm coming" with a
// first name only. It's always "on" (no threshold), and it ends itself when
// the event ends.
import { cleanText, validLink, formatWhen, wallToMs, msToWall, TZ } from './core.js';

export { cleanText, formatWhen, wallToMs, msToWall, TZ };

export const APP_URL = 'https://play.btownbrief.com/up-for-it/go/';
export const TELEGRAM_URL = 'https://t.me/+pULrkkS4vjBiZjEx';
export const GUIDE_FEED = 'https://guide.btownbrief.com/data/events/events.json';
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L
export const CODE_LEN = 6;
export const MEET_BEFORE_MIN = 15;
export const DEFAULT_INVITE = 'Coming alone is normal. Look for the Btown sign.';
export const DEFAULT_END_HOURS = 3;   // when the feed has no end time
export const LIMITS = { eventTitle: 120, eventVenue: 80, eventAddress: 120, eventUrl: 300, eventId: 40, meetPlace: 80, invite: 140, lookFor: 80, name: 24, cap: 60 };
export const MAX_OPEN_JOINS = 20;     // per device
export const CREATES_PER_DAY = 20;    // per host

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
export const normalizeCode = (s) => String(s ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
export const validCode = (s) => CODE_RE.test(String(s ?? ''));
const HEX32 = /^[a-f0-9]{32}$/;
export const validEditKey = (s) => HEX32.test(String(s ?? ''));

export const linkFor = (code, { appUrl = APP_URL } = {}) => `${appUrl}?c=${code}`;
export const editLinkFor = (code, editKey, { appUrl = APP_URL } = {}) => `${appUrl}?c=${code}&edit=${editKey}`;

const isoOk = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));
export const defaultMeetAt = (eventStartIso) => new Date(Date.parse(eventStartIso) - MEET_BEFORE_MIN * 60000).toISOString();
export const endOf = (plan) => plan.event_end ? Date.parse(plan.event_end) : Date.parse(plan.event_start) + DEFAULT_END_HOURS * 3600000;

// -------------------------------------------------------------- validate
// Returns { ok, value, errors } like core.validatePlan. `input` is the raw
// form/RPC payload; `value` is the cleaned row the backend stores.
export function validatePlan(input = {}) {
  const errors = {};
  const v = {
    event_id: cleanText(input.event_id, LIMITS.eventId),
    event_title: cleanText(input.event_title, LIMITS.eventTitle),
    event_url: String(input.event_url ?? '').trim().slice(0, LIMITS.eventUrl),
    event_venue: cleanText(input.event_venue, LIMITS.eventVenue),
    event_address: cleanText(input.event_address, LIMITS.eventAddress),
    event_start: String(input.event_start ?? ''),
    event_end: input.event_end ? String(input.event_end) : null,
    meet_place: cleanText(input.meet_place, LIMITS.meetPlace),
    meet_at: String(input.meet_at ?? ''),
    invite: cleanText(input.invite, LIMITS.invite) || DEFAULT_INVITE,
    look_for: cleanText(input.look_for, LIMITS.lookFor),
    cap: input.cap === '' || input.cap == null ? 0 : Number(input.cap),
  };
  if (v.event_title.length < 2) errors.event_title = 'Pick an event.';
  if (v.event_url && !validLink(v.event_url)) errors.event_url = 'The event link must start with https://';
  if (!isoOk(v.event_start)) errors.event_start = 'The event needs a start time.';
  if (v.event_end && (!isoOk(v.event_end) || Date.parse(v.event_end) < Date.parse(v.event_start))) errors.event_end = 'End is before start.';
  if (v.meet_place.length < 2) errors.meet_place = 'Where exactly will people find you?';
  if (!isoOk(v.meet_at)) errors.meet_at = 'When should people be there?';
  else if (isoOk(v.event_start)) {
    const d = Date.parse(v.meet_at) - Date.parse(v.event_start);
    if (d < -24 * 3600000) errors.meet_at = 'Meet time is more than a day before the event.';
    if (d > 6 * 3600000) errors.meet_at = 'Meet time is after the event.';
  }
  if (!Number.isInteger(v.cap) || v.cap < 0 || v.cap > LIMITS.cap) errors.cap = `Cap is 0 (none) to ${LIMITS.cap}.`;
  if (isoOk(v.event_start)) v.event_start = new Date(v.event_start).toISOString();
  if (v.event_end && isoOk(v.event_end)) v.event_end = new Date(v.event_end).toISOString();
  if (isoOk(v.meet_at)) v.meet_at = new Date(v.meet_at).toISOString();
  return { ok: Object.keys(errors).length === 0, value: v, errors };
}

// Only these can change after creation; the event itself can't (make a new one).
export const PATCHABLE = ['meet_place', 'meet_at', 'invite', 'look_for', 'cap'];
export function validatePatch(plan, patch = {}) {
  const merged = { ...plan };
  for (const k of PATCHABLE) if (k in patch) merged[k] = patch[k];
  const r = validatePlan(merged);
  const errors = {};
  for (const k of PATCHABLE) if (r.errors[k]) errors[k] = r.errors[k];
  const value = {};
  for (const k of PATCHABLE) if (k in patch) value[k] = r.value[k];
  return { ok: Object.keys(errors).length === 0, value, errors };
}

export function validateJoin(input = {}) {
  const name = cleanText(input.name, LIMITS.name);
  const errors = {};
  if (name.length < 1) errors.name = 'A first name is enough.';
  return { ok: !errors.name, value: { name }, errors };
}

// ------------------------------------------------------------------ state
// upcoming → soon (inside 24h) → happening (meet time reached, event not
// over) → happened. cancelled wins over everything.
export function planState(plan, nowMs) {
  if (plan.status === 'cancelled') return { key: 'cancelled', line: 'Called off.' };
  const meet = Date.parse(plan.meet_at);
  const ends = endOf(plan);
  if (nowMs > ends) return { key: 'happened', line: 'This happened.' };
  if (nowMs >= meet) return { key: 'happening', line: 'Happening now.' };
  const hrs = (meet - nowMs) / 3600000;
  if (hrs <= 24) return { key: 'soon', line: hrs < 1 ? 'In under an hour.' : `In about ${Math.round(hrs)} hours.` };
  return { key: 'upcoming', line: `Coming up · ${formatWhen(plan.meet_at).split(' · ')[0]}` };
}
export const isOpen = (plan, nowMs) => ['upcoming', 'soon', 'happening'].includes(planState(plan, nowMs).key);
export const isFull = (plan) => plan.cap > 0 && (plan.going_count || 0) >= plan.cap;

// How far ahead of the event the meet time is, in words: "15 min before".
export function meetOffset(plan) {
  const m = Math.round((Date.parse(plan.event_start) - Date.parse(plan.meet_at)) / 60000);
  if (m === 0) return 'when it starts';
  if (m < 0) return `${-m} min after it starts`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'} before`;
  return `${m} min before`;
}

// --------------------------------------------------------- event picking
// The guide's feed: events with id, title, start, end, date, venue, address,
// town, price, free, url. Future only, soonest first, a plain query on the
// title/venue/town. `limit` keeps the phone list short.
export function pickEvents(events, { query = '', nowMs, limit = 12 } = {}) {
  const q = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (events || [])
    .filter((e) => e && e.start && Date.parse(e.start) > nowMs && !e.allDay)
    .filter((e) => q.every((w) => `${e.title} ${e.venue || ''} ${e.town || ''}`.toLowerCase().includes(w)))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, limit);
}
// A feed event → the plan fields the form starts from.
export function planFromEvent(e) {
  return {
    event_id: e.id || '', event_title: e.title || '', event_url: e.url || '', event_venue: e.venue || '',
    event_address: e.address || '', event_start: e.start, event_end: e.end || null,
    meet_place: e.venue ? `Outside ${e.venue}` : '', meet_at: defaultMeetAt(e.start),
    invite: DEFAULT_INVITE, look_for: '', cap: 0,
  };
}

// ------------------------------------------------------------- calendar
const icsStamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEsc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => '\\' + m);
export function icsFor(plan, { link = linkFor(plan.code) } = {}) {
  const end = new Date(endOf(plan)).toISOString();
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Btown Brief//Come along//EN', 'BEGIN:VEVENT',
    `UID:come-along-${plan.code}@btownbrief.com`,
    `DTSTAMP:${icsStamp(plan.created_at || plan.meet_at)}`,
    `DTSTART:${icsStamp(plan.meet_at)}`, `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEsc(`Btown at ${plan.event_title}`)}`,
    `LOCATION:${icsEsc(plan.meet_place)}`,
    `DESCRIPTION:${icsEsc(`Meet ${meetOffset(plan)} at ${plan.meet_place}. ${plan.invite}${plan.look_for ? ' Look for ' + plan.look_for + '.' : ''}\n${link}`)}`,
    `URL:${link}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}
export function gcalUrl(plan, { link = linkFor(plan.code) } = {}) {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Btown at ${plan.event_title}`,
    dates: `${icsStamp(plan.meet_at)}/${icsStamp(new Date(endOf(plan)).toISOString())}`,
    location: plan.meet_place,
    details: `Meet ${meetOffset(plan)} at ${plan.meet_place}. ${plan.invite}\n${link}`,
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}
export function shareText(plan, { link = linkFor(plan.code) } = {}) {
  return `Going to ${plan.event_title} with Btown — ${formatWhen(plan.meet_at)}, meet at ${plan.meet_place}. ${plan.invite} ${link}`;
}

// -------------------------------------------------------- next gathering
// After a come-along has happened the page points at the next standing
// Btown thing. Computed, never stored, so it is never stale.
const STANDING = [
  { dow: 6, hour: 10, minute: 0, title: 'Saturday coffee at Zero Gravity, 10 AM', url: 'https://www.meetup.com/burlington-social-activites-group/' },
  { dow: 3, hour: 17, minute: 30, title: 'Wednesday pick-up basketball at Pomeroy Park, 5:30 PM', url: 'https://www.meetup.com/burlington-social-activites-group/' },
];
export function nextGathering(nowMs) {
  let best = null;
  for (const g of STANDING) {
    for (let d = 0; d < 8; d++) {
      const day = msToWall(nowMs + d * 86400000).slice(0, 10);
      const at = wallToMs(`${day}T${String(g.hour).padStart(2, '0')}:${String(g.minute).padStart(2, '0')}`);
      const dow = new Date(at).toLocaleDateString('en-US', { weekday: 'short', timeZone: TZ });
      const want = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][g.dow];
      if (dow === want && at > nowMs) { if (!best || at < best.at) best = { ...g, at }; break; }
    }
  }
  return best;
}

// Copy the host pastes into Meetup / Telegram / the edition.
export function announceText(plan, { link = linkFor(plan.code) } = {}) {
  return `A bunch of us are going to ${plan.event_title} (${formatWhen(plan.event_start)}${plan.event_venue ? ', ' + plan.event_venue : ''}). Meet ${meetOffset(plan)} at ${plan.meet_place}. ${plan.invite} Say you're coming: ${link}`;
}
