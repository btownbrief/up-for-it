// Pulls the Burlington Social Activities Group (Btown Brief IRL) Meetup
// calendar and writes data/meetup.json — the next 45 days, soonest first,
// capped at 40 — so the host desk can offer "Link a Meetup event" choices
// and the newsletter block can cross-reference. Runs every 6 hours from
// .github/workflows/meetup.yml; fails soft (keeps the old file, exit 0).
//   node scripts/meetup-ical.mjs            # refresh data/meetup.json
//   node scripts/meetup-ical.mjs --print    # refresh + list them
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ICAL_URL = 'https://www.meetup.com/burlington-social-activites-group/events/ical/';
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = ROOT + 'data/meetup.json';
const DAYS = 45;
const MAX = 40;
const print = process.argv.includes('--print');

// ------------------------------------------------------- minimal iCal
// Enough iCal to read Meetup's feed: unfold continuation lines, split into
// VEVENT blocks, read SUMMARY / DTSTART / URL / LOCATION / UID. Dates come
// as UTC ("20260904T223000Z"), with a TZID ("DTSTART;TZID=America/New_York:
// 20260904T183000"), or as all-day ("VALUE=DATE:20260904").
export function parseIcal(text) {
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const raw of lines) {
    if (raw === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (raw === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = raw.indexOf(':');
    if (i < 0) continue;
    const head = raw.slice(0, i);
    const value = raw.slice(i + 1);
    const [name, ...paramParts] = head.split(';');
    const params = Object.fromEntries(paramParts.map((p) => { const [k, v] = p.split('='); return [k.toUpperCase(), v]; }));
    cur[name.toUpperCase()] = { value, params };
  }
  return events.map((e) => ({
    uid: e.UID?.value || '',
    title: unescape(e.SUMMARY?.value || ''),
    starts_at: toIso(e.DTSTART),
    url: (e.URL?.value || '').trim(),
    location: unescape(e.LOCATION?.value || ''),
  })).filter((e) => e.title && e.starts_at);
}
const unescape = (s) => s.replace(/\\n/g, ' ').replace(/\\([,;\\])/g, '$1').replace(/\s+/g, ' ').trim();

function toIso(field) {
  if (!field) return null;
  const v = field.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, hh = '00', mm = '00', ss = '00', z] = m;
  if (z === 'Z') return new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`).toISOString();
  const tz = field.params.TZID || 'America/New_York';
  return zoned(`${y}-${mo}-${d}T${hh}:${mm}:${ss}`, tz);
}
// Local wall time in a named zone → ISO, without a tz library: guess UTC,
// measure that guess's offset in the zone, correct once (twice for DST edges).
function zoned(local, tz) {
  let guess = Date.parse(local + 'Z');
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess));
    const get = (t) => parts.find((p) => p.type === t).value;
    const seen = Date.parse(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`);
    guess -= seen - Date.parse(local + 'Z');
  }
  return new Date(guess).toISOString();
}

// ------------------------------------------------------------- run
async function main() {
  const now = Date.now();
  const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { fetched: null, events: [] };
  let events = old.events || [];
  let fetched = old.fetched;
  try {
    const res = await fetch(ICAL_URL, { headers: { 'User-Agent': 'btownbrief-up-for-it/1.0 (+https://btownbrief.com)' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('not an ical feed');
    events = parseIcal(text)
      .filter((e) => { const t = Date.parse(e.starts_at); return t >= now - 3600000 && t <= now + DAYS * 86400000; })
      .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
      .slice(0, MAX);
    fetched = new Date(now).toISOString();
    writeFileSync(OUT, JSON.stringify({ fetched, events }, null, 2) + '\n');
    console.log(`meetup: ${events.length} upcoming events → data/meetup.json`);
  } catch (e) {
    console.log(`meetup: couldn't fetch the calendar (${e.message}); keeping the old data/meetup.json (${events.length} events, fetched ${fetched || 'never'}).`);
  }
  if (print) {
    for (const e of events) {
      const when = new Date(e.starts_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
      console.log(`${when}  ${e.title}${e.location ? ` · ${e.location}` : ''}\n    ${e.url}`);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
