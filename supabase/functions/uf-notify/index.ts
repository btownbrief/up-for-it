// uf-notify — the four emails Up For It sends. Without this function (or
// without RESEND_API_KEY) nothing breaks: people still see everything in
// the app; they just aren't told by email. The client fires and forgets
// (js/net.js notify()), so every failure here is silent from the browser.
//
//   kind 'claimed' {plan_id}  a host picked up an idea → tell the idea's
//                              "I'd go" pile (people who left an email),
//                              minus anyone already in on the plan
//   kind 'on'      {plan_id}  a plan is official → tell everyone who's in
//                              (waitlisted folks get their own line). Poked
//                              again after a late "I'm in", only addresses
//                              that haven't had it hear.
//   kind 'cancelled' {plan_id} an on plan was called off → tell everyone
//   kind 'remind'  (no id)    daily cron: "Tomorrow: …" to everyone in on a
//                              plan dated tomorrow (Eastern calendar day)
//
// Idempotent per RECIPIENT via the uf_sent ledger (plan, kind, address):
// deliver() claims rows with ON CONFLICT DO NOTHING and sends only what it
// claimed, so client retries, concurrent calls and step-out/re-join can't
// repeat an email; a failed send releases its row so a later call retries
// just that address. The plan flags (notified_claim/_on/_cancel, reminded)
// mean "fully delivered once" and short-circuit repeat pokes. MAX_PER_PLAN_KIND
// bounds how many addresses one plan can ever be made to email. Addresses
// are never logged or returned.
//
// Runs with the service role (default for edge functions) — the ONLY thing
// in the fleet that reads uf_people.email / uf_commits.email.
//
// Deploy (from the repo root, Supabase CLI logged in):
//   supabase functions deploy uf-notify --no-verify-jwt --project-ref jnouvwxomrcffqwilqkq
//   (NOTIFY_FROM is Who's Playing's — secrets are project-wide, so this one has its own name)
//   supabase secrets set UF_NOTIFY_FROM="Up For It <hello@btownbrief.com>" --project-ref jnouvwxomrcffqwilqkq
//   (RESEND_API_KEY is already set on the project for wp-notify; shared.)
// --no-verify-jwt because the browser and the cron send the publishable key,
// not a user JWT; the function trusts nothing from the caller anyway — it
// only acts on rows that exist and haven't been notified yet.
//
// Test each kind (K = the publishable key from js/net.js; P = a plan uuid):
//   curl -s -X POST https://jnouvwxomrcffqwilqkq.supabase.co/functions/v1/uf-notify \
//     -H "Content-Type: application/json" -H "apikey: $K" -H "Authorization: Bearer $K" \
//     -d '{"kind":"claimed","plan_id":"'$P'"}'
//   … -d '{"kind":"on","plan_id":"'$P'"}'
//   … -d '{"kind":"remind"}'
// Expect {"sent":true,...} once, then {"sent":false,"why":"already"}. To
// re-test, reset the flag in the SQL editor:
//   update uf_plans set notified_claim=false where id='…';

import { createClient } from 'npm:@supabase/supabase-js@2';

const APP_URL = 'https://play.btownbrief.com/up-for-it/';
const TZ = 'America/New_York';
const BATCH = 50; // Resend allows 100 per batch call; stay comfortably under

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { ...cors, 'Content-Type': 'application/json' } });

type Plan = {
  id: string; idea_id: string | null; host_id: string; title: string; place: string; detail: string;
  starts_at: string | null; cap: number; threshold: number; status: string; meetup_url: string;
  notified_claim: boolean; notified_on: boolean; reminded: boolean; notified_cancel: boolean;
};
type Mail = { from: string; to: string[]; subject: string; text: string };

// Eastern wall clock ↔ epoch, same as core.js wallToMs (two passes cover the
// DST offset change). Used to find "tomorrow" by Burlington's calendar.
function zoneParts(ms: number) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute };
}
function wallToMs(y: number, mo: number, d: number, h = 0, mi = 0): number {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 2; i++) { const p = zoneParts(guess); guess += want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi); }
  return guess;
}
// [start of tomorrow, start of the day after) in Eastern time, as ISO.
function tomorrowBounds(nowMs: number): { lo: string; hi: string } {
  const t = zoneParts(nowMs);
  const day = (n: number) => { const d = new Date(Date.UTC(t.y, t.mo - 1, t.d + n)); return wallToMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); };
  return { lo: new Date(day(1)).toISOString(), hi: new Date(day(2)).toISOString() };
}

// Same shape as core.js formatWhen: "Thu, Sep 4 · 6:30pm" (or "· 6pm").
function formatWhen(iso: string | null): string {
  if (!iso) return 'date to be set';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'date to be set';
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ })
    .replace(':00', '').replace(' ', '').toLowerCase();
  return `${day} · ${time}`;
}
const planLink = (id: string) => `${APP_URL}?plan=${id}`;
const uniqEmails = (list: (string | null | undefined)[]) => {
  const seen = new Set<string>();
  for (const e of list) { const v = String(e || '').trim().toLowerCase(); if (v.includes('@')) seen.add(v); }
  return [...seen];
};

// Send one-recipient emails. Batch in chunks; if a batch call fails, fall
// back to single sends for that chunk. Reports per-recipient outcome so the
// caller can release exactly the ones that didn't go.
async function send(key: string, mails: Mail[]): Promise<{ ok: string[]; failed: string[] }> {
  const okList: string[] = [], failed: string[] = [];
  for (let i = 0; i < mails.length; i += BATCH) {
    const chunk = mails.slice(i, i + BATCH);
    let batched = false;
    try {
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      });
      if (res.ok) { for (const m of chunk) okList.push(m.to[0]); batched = true; }
    } catch { /* fall through to singles */ }
    if (batched) continue;
    for (const m of chunk) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(m),
        });
        (res.ok ? okList : failed).push(m.to[0]);
      } catch { failed.push(m.to[0]); }
    }
  }
  return { ok: okList, failed };
}

// Any real plan is far below this (cap ≤ 60 + a waitlist; a yes-pile of a
// few dozen). It bounds how many addresses a loop of fake sign-ups can make
// one plan email, per message kind.
const MAX_PER_PLAN_KIND = 200;

// deno-lint-ignore no-explicit-any
type Db = any;
const q = async <T>(p: PromiseLike<{ data: T; error: unknown }>): Promise<T> => {
  const r = await p;
  if (r.error) throw r.error;
  return r.data;
};

// Per-recipient idempotence. Claims (plan, kind, email) rows in uf_sent
// with ON CONFLICT DO NOTHING — only the rows THIS call inserted are ours
// to send, so concurrent calls, client retries and step-out/re-join can't
// earn anyone the same email twice. Failed sends release their rows so a
// later call retries exactly those. Returns counts; never addresses.
async function deliver(db: Db, key: string, planId: string, kind: string, mails: Mail[]) {
  const byEmail = new Map<string, Mail>();
  for (const m of mails) byEmail.set(m.to[0], m);
  const want = [...byEmail.keys()];
  if (!want.length) return { count: 0, failed: 0, capped: false };
  const { count: have } = await db.from('uf_sent').select('*', { count: 'exact', head: true }).eq('plan_id', planId).eq('kind', kind);
  const room = Math.max(0, MAX_PER_PLAN_KIND - (have || 0));
  const capped = want.length > room;
  const ask = want.slice(0, room);
  if (!ask.length) return { count: 0, failed: 0, capped };
  const claimed = await q<{ email: string }[] | null>(
    db.from('uf_sent').upsert(ask.map((email) => ({ plan_id: planId, kind, email })), { onConflict: 'plan_id,kind,email', ignoreDuplicates: true }).select('email'),
  );
  const mine = (claimed || []).map((r) => r.email);
  if (!mine.length) return { count: 0, failed: 0, capped };
  const out = await send(key, mine.map((e) => byEmail.get(e)!));
  if (out.failed.length) await db.from('uf_sent').delete().eq('plan_id', planId).eq('kind', kind).in('email', out.failed);
  return { count: out.ok.length, failed: out.failed.length, capped };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { kind, plan_id } = await req.json().catch(() => ({}));
    if (!['claimed', 'on', 'remind', 'cancelled'].includes(kind)) return ok({ sent: false, why: 'bad_kind' });
    if (kind !== 'remind' && (typeof plan_id !== 'string' || !/^[0-9a-f-]{36}$/.test(plan_id))) return ok({ sent: false, why: 'bad_id' });
    const key = Deno.env.get('RESEND_API_KEY');
    if (!key) return ok({ sent: false, why: 'no_key' });
    const from = Deno.env.get('UF_NOTIFY_FROM') || 'Up For It <hello@btownbrief.com>';
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const PLAN_COLS = 'id, idea_id, host_id, title, place, detail, starts_at, cap, threshold, status, meetup_url, notified_claim, notified_on, reminded, notified_cancel';
    const hostName = async (id: string) => {
      const { data } = await db.from('uf_hosts').select('name').eq('id', id).maybeSingle();
      return data?.name || 'A Btown Brief IRL host';
    };
    type Commit = { email: string; status: string };
    const commitsOf = (id: string) => q<Commit[] | null>(db.from('uf_commits').select('email, status').eq('plan_id', id)).then((r) => r || []);
    // one Mail per distinct address; `text` may depend on the row (waitlist copy)
    const mailsFor = (rows: Commit[], subject: string, text: (c: Commit) => string) => {
      const seen = new Set<string>();
      const mails: Mail[] = [];
      for (const c of rows) {
        const e = String(c.email || '').trim().toLowerCase();
        if (!e.includes('@') || seen.has(e)) continue;
        seen.add(e);
        mails.push({ from, to: [e], subject, text: text(c) });
      }
      return mails;
    };
    // the plan-level flag means "fully delivered once"; it short-circuits
    // repeat pokes and is only set when nothing failed
    const finish = (id: string, flag: string, r: { failed: number }) =>
      r.failed ? Promise.resolve() : db.from('uf_plans').update({ [flag]: true }).eq('id', id);

    // ------------------------------------------------------------ claimed
    if (kind === 'claimed') {
      const plan = await q<Plan | null>(db.from('uf_plans').select(PLAN_COLS).eq('id', plan_id).in('status', ['tipping', 'on']).maybeSingle());
      if (!plan) return ok({ sent: false, why: 'not_found' });
      if (!plan.idea_id) return ok({ sent: false, why: 'no_idea' });
      if (plan.notified_claim) return ok({ sent: false, why: 'already' });

      const [{ data: idea }, host, { data: yesTaps }, commits] = await Promise.all([
        db.from('uf_ideas').select('title').eq('id', plan.idea_id).maybeSingle(),
        hostName(plan.host_id),
        db.from('uf_taps').select('token_hash').eq('idea_id', plan.idea_id).eq('answer', 'yes'),
        commitsOf(plan.id),
      ]);
      const hashes = (yesTaps || []).map((t: { token_hash: string }) => t.token_hash);
      let emails: string[] = [];
      if (hashes.length) {
        const people = await q<{ email: string }[] | null>(db.from('uf_people').select('email').in('token_hash', hashes).neq('email', ''));
        emails = uniqEmails((people || []).map((p) => p.email));
      }
      const already = new Set(uniqEmails(commits.map((c) => c.email)));
      const to = emails.filter((e) => !already.has(e));

      const ideaTitle = idea?.title || plan.title;
      const text = [
        `Hi — you said you'd go to "${ideaTitle}" on Up For It.`,
        '',
        `${host} just picked it up:`,
        `  ${plan.title} · ${formatWhen(plan.starts_at)} · ${plan.place}`,
        plan.detail ? `  ${plan.detail}` : null,
        '',
        `Say "I'm in" here (cap ${plan.cap}): ${planLink(plan.id)}`,
        '',
        `You're getting this once because you tapped "I'd go" on this idea.`,
        '',
        '— Btown Brief',
      ].filter((l) => l !== null).join('\n');
      const subject = `${host} is hosting: ${plan.title}`;
      const r = await deliver(db, key, plan.id, 'claimed', to.map((e) => ({ from, to: [e], subject, text })));
      await finish(plan.id, 'notified_claim', r);
      return ok({ sent: true, ...r });
    }

    // ---------------------------------------------------------- cancelled
    if (kind === 'cancelled') {
      const plan = await q<Plan | null>(db.from('uf_plans').select(PLAN_COLS).eq('id', plan_id).eq('status', 'cancelled').maybeSingle());
      if (!plan) return ok({ sent: false, why: 'not_found' });
      if (plan.notified_cancel) return ok({ sent: false, why: 'already' });
      const [host, commits] = await Promise.all([hostName(plan.host_id), commitsOf(plan.id)]);
      const when = plan.starts_at ? formatWhen(plan.starts_at) : 'date TBD';
      const text = [
        `Hi — this one is called off:`,
        '',
        `  ${plan.title}`,
        `  ${when} · ${plan.place}`,
        '',
        `${host} had to cancel it. Sorry — nothing to do on your end.`,
        '',
        `See what else is tipping: ${APP_URL}`,
        '',
        '— Btown Brief',
      ].join('\n');
      const r = await deliver(db, key, plan.id, 'cancelled', mailsFor(commits, `Called off: ${plan.title}`, () => text));
      await finish(plan.id, 'notified_cancel', r);
      return ok({ sent: true, ...r });
    }

    // ----------------------------------------------------------------- on
    // "It's on" to everyone who's in (waitlisted folks get their own line).
    // Poked again after a late "I'm in", the ledger means only the new
    // address hears — never a repeat to anyone. Clearing the date wipes the
    // ledger (SQL), so re-dating announces again.
    if (kind === 'on') {
      const plan = await q<Plan | null>(db.from('uf_plans').select(PLAN_COLS).eq('id', plan_id).eq('status', 'on').maybeSingle());
      if (!plan) return ok({ sent: false, why: 'not_found' });
      if (!plan.starts_at) return ok({ sent: false, why: 'needs_date' });
      const [host, commits] = await Promise.all([hostName(plan.host_id), commitsOf(plan.id)]);
      const inN = commits.filter((c) => c.status === 'in').length;
      const when = formatWhen(plan.starts_at);
      const body = (wait: boolean) => [
        wait ? `Hi — you're on the waitlist for this one. If a spot opens you move up automatically; check Mine in the app (we don't email for that). Here's the plan:`
             : `Hi — it's on. Here's the plan:`,
        '',
        `  ${plan.title}`,
        `  ${when} · ${plan.place}`,
        plan.detail ? `  ${plan.detail}` : null,
        '',
        `Hosted by ${host}. ${inN} in, cap ${plan.cap}.`,
        plan.meetup_url ? `Meetup page: ${plan.meetup_url}` : null,
        '',
        `Can't make it after all? Step out under Mine so someone else can: ${planLink(plan.id)}`,
        '',
        'One reminder comes the day before.',
        '',
        '— Btown Brief',
      ].filter((l) => l !== null).join('\n');
      const r = await deliver(db, key, plan.id, 'on', mailsFor(commits, `It's on: ${plan.title} · ${when}`, (c) => body(c.status === 'wait')));
      if (!plan.notified_on) await finish(plan.id, 'notified_on', r);
      if (!r.count && !r.failed) return ok({ sent: false, why: 'already' });
      return ok({ sent: true, ...r, late: plan.notified_on });
    }

    // ------------------------------------------------------------- remind
    // Tomorrow's plans: anything on whose start falls on tomorrow's Eastern
    // calendar date, so "Tomorrow:" is literally true (an 11pm start tonight
    // is not tomorrow). Run once a day (remind.yml, 9:10am ET); `reminded`
    // flips when everyone got it, the ledger keeps retries from repeating.
    const { lo, hi } = tomorrowBounds(Date.now());
    const due = await q<Plan[] | null>(db.from('uf_plans').select(PLAN_COLS)
      .eq('status', 'on').eq('reminded', false).gte('starts_at', lo).lt('starts_at', hi));
    let plans = 0, emails = 0;
    for (const plan of due || []) {
      const [host, commits] = await Promise.all([hostName(plan.host_id), commitsOf(plan.id)]);
      const inRows = commits.filter((c) => c.status === 'in');
      const when = formatWhen(plan.starts_at);
      const text = [
        `Hi — a reminder that this is tomorrow:`,
        '',
        `  ${plan.title}`,
        `  ${when} · ${plan.place}`,
        plan.detail ? `  ${plan.detail}` : null,
        '',
        `Hosted by ${host}. ${inRows.length} in, cap ${plan.cap}.`,
        plan.meetup_url ? `Meetup page: ${plan.meetup_url}` : null,
        '',
        `If you can't make it, step out under Mine so someone else can: ${planLink(plan.id)}`,
        '',
        '— Btown Brief',
      ].filter((l) => l !== null).join('\n');
      const r = await deliver(db, key, plan.id, 'remind', mailsFor(inRows, `Tomorrow: ${plan.title} · ${when}`, () => text));
      await finish(plan.id, 'reminded', r);
      plans += 1; emails += r.count;
    }
    return ok({ sent: true, plans, emails });
  } catch (_e) {
    return ok({ sent: false, why: 'error' });
  }
});
