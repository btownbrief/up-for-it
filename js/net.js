// UP FOR IT — backend client. Same Supabase project + publishable key as
// the whole Btown fleet; the uf_* RPCs live in supabase/up-for-it-SETUP.sql.
// Until that file is run, every call fails with code 'not_ready' and the UI
// says so plainly instead of erroring.
//
// Two transports behind one `backend()`:
//   network (default) — fetch to /rest/v1/rpc/<fn>
//   ?demo=1           — the in-memory FakeBackend seeded from data/ideas.json
// The per-device token is minted once, kept in localStorage, and only ever
// stored hashed on the server. It is the only "account" there is. Hosts
// carry a separate 32-hex key (host.html) that Stephen mints in mod.html.

import { FakeBackend, seedDemo } from './fake-backend.js';

const SUPABASE_URL = 'https://jnouvwxomrcffqwilqkq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_RkMJQopffWlV6DSwCRkndQ_Xw6GJMf3';
const NOTIFY_FN = 'uf-notify'; // edge function; see supabase/functions/uf-notify
export const DEMO_MOD_SECRET = 'demo';

export class NetError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'NetError';
    this.code = code;
    this.detail = detail;
  }
}

const params = () => new URLSearchParams(globalThis.location?.search ?? '');
export const isDemo = () => params().get('demo') === '1';

function stored(key, make) {
  try {
    let v = localStorage.getItem(key);
    if (!v) { v = make(); localStorage.setItem(key, v); }
    return v;
  } catch {
    return make(); // private mode with storage blocked: a session-only identity
  }
}
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
let demoToken = null;
export const token = () => (isDemo() ? (demoToken ||= hex(16)) : stored('uf-token', () => hex(16)));
const remember = (k) => ({
  get: () => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (v) => { try { localStorage.setItem(k, String(v).slice(0, 120)); } catch { /* fine */ } },
});
export const savedName = remember('uf-name');
export const savedEmail = remember('uf-email');
export const savedHostKey = remember('uf-host-key');

async function networkRpc(fn, args) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new NetError('offline');
  }
  if (res.status === 404) throw new NetError('not_ready');
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const raw = (body && body.message) || `http_${res.status}`;
    throw new NetError(String(raw).split(':')[0].trim());
  }
  // host/mod RPCs report a wrong key/secret as a body, not a raise, so the
  // server-side failure counter survives; same error to callers
  if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string') {
    throw new NetError(body.error);
  }
  return body;
}

let demo = null;
async function demoBackend() {
  if (!demo) {
    demo = (async () => {
      let ideas = [];
      try { ideas = (await (await fetch('data/ideas.json')).json()).ideas || []; } catch { /* empty deck is still a demo */ }
      return seedDemo(new FakeBackend({ modSecret: DEMO_MOD_SECRET }), ideas);
    })();
  }
  return demo;
}
export function backend() {
  if (isDemo()) {
    return {
      rpc: async (fn, args) => {
        const be = await demoBackend();
        try {
          const out = await be.rpc(fn, args);
          if (out && typeof out === 'object' && !Array.isArray(out) && typeof out.error === 'string') throw new NetError(out.error);
          return out;
        } catch (e) { throw e instanceof NetError ? e : new NetError(e.code || 'error'); }
      },
    };
  }
  return { rpc: networkRpc };
}

// Best-effort pokes at the edge function. Fire-and-forget: the row is
// already saved; this only asks the function to send the email(s). Missing
// function, missing key, or any failure → silence, which is the documented
// baseline (people still see everything in the app).
//   kind 'claimed' — a host picked up an idea: tell the idea's yes-pile
//   kind 'on'      — a plan is official: tell everyone who's in
//   kind 'cancelled' — an on plan was called off: tell everyone who was in
export function notify(kind, planId) {
  if (isDemo() || !planId) return;
  try {
    fetch(`${SUPABASE_URL}/functions/v1/${NOTIFY_FN}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, plan_id: planId }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* fine */ }
}

// Plain-language copy for every error code the backend can return.
export function explain(err) {
  const code = err && err.code ? err.code : 'error';
  return ({
    offline: "You're offline. Try again in a moment.",
    not_ready: "This isn't switched on yet. Check back soon.",
    slow_down: "That's plenty for today — try again tomorrow.",
    too_many_open: "You're in on ten plans already. Step out of one first.",
    not_found: "That one's gone.",
    already_claimed: 'Another host already has this one.',
    needs_date: 'Set a date first.',
    cap_too_small: "The cap can't go below the number already in.",
    bad_showed: 'How many came — a number from 0 to 500.',
    has_people: "People are already in — cancel it instead of releasing it.",
    bad_tap: "Pass, maybe, or go?",
    bad_finish: "That email doesn't look right.",
    bad_suggestion: "Something's missing — check the highlighted fields.",
    bad_commit: "We need your first name and an email.",
    bad_plan: "Something's missing — check the highlighted fields.",
    bad_patch: 'Paste the full https:// link.',
    bad_host: 'A host needs a first name.',
    bad_action: "That action doesn't exist.",
    bad_secret: "That's not the moderator secret.",
    bad_key: "That host key doesn't work (or the gate is resting after too many wrong tries).",
    bad_token: 'This browser lost its identity. Reload and try again.',
  })[code] || 'Something went wrong. Try again.';
}
