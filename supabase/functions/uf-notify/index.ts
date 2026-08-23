// uf-notify — the three emails Up For It sends. Without this function (or
// without RESEND_API_KEY) nothing breaks: people still see everything in
// the app; they just aren't told by email. The client fires and forgets
// (js/net.js notify()), so every failure here is silent from the browser.
//
//   kind 'claimed' {plan_id}  a host picked up an idea → tell the idea's
//                              "I'd go" pile (people who left an email),
//                              minus anyone already in on the plan
//   kind 'on'      {plan_id}  a plan is official → tell everyone who's in
//                              (waitlisted folks get their own line)
//   kind 'remind'  (no id)    daily cron: "Tomorrow: …" to everyone in on a
//                              plan that starts in 10–38 hours
//
// Idempotent via three booleans on uf_plans (notified_claim, notified_on,
// reminded): the first caller flips the flag atomically; everyone else gets
// {sent:false, why:'already'}. If Resend fails outright the flag is flipped
// back so a later call retries. Emails are never logged.
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
  notified_claim: boolean; notified_on: boolean; reminded: boolean;
};
type Mail = { from: string; to: string[]; subject: string; text: string };

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

// Send a list of one-recipient emails. Batch in chunks; if a batch call
// fails, fall back to single sends for that chunk. Returns how many went.
async function send(key: string, mails: Mail[]): Promise<number> {
  let sent = 0;
  for (let i = 0; i < mails.length; i += BATCH) {
    const chunk = mails.slice(i, i + BATCH);
    let batched = false;
    try {
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      });
      if (res.ok) { sent += chunk.length; batched = true; }
    } catch { /* fall through to singles */ }
    if (batched) continue;
    for (const m of chunk) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(m),
        });
        if (res.ok) sent += 1;
      } catch { /* counted as not sent */ }
    }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { kind, plan_id } = await req.json().catch(() => ({}));
    if (!['claimed', 'on', 'remind'].includes(kind)) return ok({ sent: false, why: 'bad_kind' });
    if (kind !== 'remind' && (typeof plan_id !== 'string' || !/^[0-9a-f-]{36}$/.test(plan_id))) return ok({ sent: false, why: 'bad_id' });
    const key = Deno.env.get('RESEND_API_KEY');
    if (!key) return ok({ sent: false, why: 'no_key' });
    const from = Deno.env.get('UF_NOTIFY_FROM') || 'Up For It <hello@btownbrief.com>';
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const PLAN_COLS = 'id, idea_id, host_id, title, place, detail, starts_at, cap, threshold, status, meetup_url, notified_claim, notified_on, reminded';
    const hostName = async (id: string) => {
      const { data } = await db.from('uf_hosts').select('name').eq('id', id).maybeSingle();
      return data?.name || 'A Btown Brief IRL host';
    };
    const inCount = async (id: string) => {
      const { count } = await db.from('uf_commits').select('*', { count: 'exact', head: true }).eq('plan_id', id).eq('status', 'in');
      return count || 0;
    };

    // ------------------------------------------------------------ claimed
    if (kind === 'claimed') {
      const { data: plan } = await db.from('uf_plans').select(PLAN_COLS).eq('id', plan_id).in('status', ['tipping', 'on']).maybeSingle() as { data: Plan | null };
      if (!plan) return ok({ sent: false, why: 'not_found' });
      if (!plan.idea_id) return ok({ sent: false, why: 'no_idea' });
      const { data: claimed } = await db.from('uf_plans').update({ notified_claim: true })
        .eq('id', plan.id).eq('notified_claim', false).select('id').maybeSingle();
      if (!claimed) return ok({ sent: false, why: 'already' });
      const unclaim = () => db.from('uf_plans').update({ notified_claim: false }).eq('id', plan.id);

      const [{ data: idea }, host, { data: yesTaps }, { data: commits }] = await Promise.all([
        db.from('uf_ideas').select('title').eq('id', plan.idea_id).maybeSingle(),
        hostName(plan.host_id),
        db.from('uf_taps').select('token_hash').eq('idea_id', plan.idea_id).eq('answer', 'yes'),
        db.from('uf_commits').select('email').eq('plan_id', plan.id),
      ]);
      const hashes = (yesTaps || []).map((t: { token_hash: string }) => t.token_hash);
      let emails: string[] = [];
      if (hashes.length) {
        const { data: people } = await db.from('uf_people').select('email').in('token_hash', hashes).neq('email', '');
        emails = uniqEmails((people || []).map((p: { email: string }) => p.email));
      }
      const already = new Set(uniqEmails((commits || []).map((c: { email: string }) => c.email)));
      const to = emails.filter((e) => !already.has(e));
      if (!to.length) return ok({ sent: true, count: 0 });

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
      const count = await send(key, to.map((e) => ({ from, to: [e], subject, text })));
      if (!count) { await unclaim(); return ok({ sent: false, why: 'resend' }); }
      return ok({ sent: true, count, failed: to.length - count });
    }

    // ----------------------------------------------------------------- on
    if (kind === 'on') {
      const { data: plan } = await db.from('uf_plans').select(PLAN_COLS).eq('id', plan_id).eq('status', 'on').maybeSingle() as { data: Plan | null };
      if (!plan) return ok({ sent: false, why: 'not_found' });
      if (!plan.starts_at) return ok({ sent: false, why: 'needs_date' });
      const { data: claimed } = await db.from('uf_plans').update({ notified_on: true })
        .eq('id', plan.id).eq('notified_on', false).select('id').maybeSingle();
      if (!claimed) return ok({ sent: false, why: 'already' });
      const unclaim = () => db.from('uf_plans').update({ notified_on: false }).eq('id', plan.id);

      const [host, { data: commits }] = await Promise.all([
        hostName(plan.host_id),
        db.from('uf_commits').select('email, status').eq('plan_id', plan.id),
      ]);
      const rows = (commits || []) as { email: string; status: string }[];
      const inN = rows.filter((c) => c.status === 'in').length;
      const when = formatWhen(plan.starts_at);
      const body = (wait: boolean) => [
        wait ? `Hi — you're on the waitlist for this one; we'll email if a spot opens. Here's the plan:`
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
      const subject = `It's on: ${plan.title} · ${when}`;
      const seen = new Set<string>();
      const mails: Mail[] = [];
      for (const c of rows) {
        const e = String(c.email || '').trim().toLowerCase();
        if (!e.includes('@') || seen.has(e)) continue;
        seen.add(e);
        mails.push({ from, to: [e], subject, text: body(c.status === 'wait') });
      }
      if (!mails.length) return ok({ sent: true, count: 0 });
      const count = await send(key, mails);
      if (!count) { await unclaim(); return ok({ sent: false, why: 'resend' }); }
      return ok({ sent: true, count, failed: mails.length - count });
    }

    // ------------------------------------------------------------- remind
    // Tomorrow's plans: anything on that starts in 10–38 hours from now.
    // Run once a day (remind.yml, 9:10am ET) so every plan lands in that
    // window exactly once.
    const now = Date.now();
    const lo = new Date(now + 10 * 3600000).toISOString();
    const hi = new Date(now + 38 * 3600000).toISOString();
    const { data: due } = await db.from('uf_plans').select(PLAN_COLS)
      .eq('status', 'on').eq('reminded', false).gte('starts_at', lo).lte('starts_at', hi) as { data: Plan[] | null };
    let plans = 0, emails = 0;
    for (const plan of due || []) {
      const { data: claimed } = await db.from('uf_plans').update({ reminded: true })
        .eq('id', plan.id).eq('reminded', false).select('id').maybeSingle();
      if (!claimed) continue;
      const [host, n, { data: commits }] = await Promise.all([
        hostName(plan.host_id),
        inCount(plan.id),
        db.from('uf_commits').select('email').eq('plan_id', plan.id).eq('status', 'in'),
      ]);
      const to = uniqEmails((commits || []).map((c: { email: string }) => c.email));
      if (!to.length) { plans += 1; continue; }
      const when = formatWhen(plan.starts_at);
      const text = [
        `Hi — a reminder that this is tomorrow:`,
        '',
        `  ${plan.title}`,
        `  ${when} · ${plan.place}`,
        plan.detail ? `  ${plan.detail}` : null,
        '',
        `Hosted by ${host}. ${n} in, cap ${plan.cap}.`,
        plan.meetup_url ? `Meetup page: ${plan.meetup_url}` : null,
        '',
        `If you can't make it, step out under Mine so someone else can: ${planLink(plan.id)}`,
        '',
        '— Btown Brief',
      ].filter((l) => l !== null).join('\n');
      const subject = `Tomorrow: ${plan.title} · ${when}`;
      const count = await send(key, to.map((e) => ({ from, to: [e], subject, text })));
      if (!count) { await db.from('uf_plans').update({ reminded: false }).eq('id', plan.id); continue; }
      plans += 1; emails += count;
    }
    return ok({ sent: true, plans, emails });
  } catch (_e) {
    return ok({ sent: false, why: 'error' });
  }
});
