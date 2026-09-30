// COME ALONG — backend client. Same project, same publishable key and the
// same device token as Up For It (imported from net.js), talking to the
// ca_* RPCs in supabase/come-along-SETUP.sql. ?demo=1 swaps in the
// FakeAlongBackend seeded from real upcoming events (live guide feed, or the
// bundled snapshot when offline) and saves nothing.
import { rpcNetwork, token, isDemo, NetError, savedName, savedHostKey } from './net.js';
import { DEMO_HOST_KEY } from './fake-backend.js';
import { FakeAlongBackend, seedAlongDemo, snapshotAlong, restoreAlong } from './along-backend.js';
import { GUIDE_FEED } from './along-core.js';

export { token, isDemo, NetError, savedName, savedHostKey, DEMO_HOST_KEY };

const SNAPSHOT = new URL('../data/come-along-demo.json', import.meta.url).href;

// The guide's calendar. Live first (2–3 MB, host side only), snapshot second,
// empty last — the create page says so instead of erroring.
export async function loadFeed({ live = true } = {}) {
  if (live) {
    try {
      const r = await fetch(GUIDE_FEED, { cache: 'no-cache' });
      if (r.ok) { const d = await r.json(); if (Array.isArray(d.events) && d.events.length) return { events: d.events, source: 'live' }; }
    } catch { /* fall through */ }
  }
  try {
    const r = await fetch(SNAPSHOT);
    if (r.ok) { const d = await r.json(); return { events: d.events || [], source: 'snapshot' }; }
  } catch { /* fall through */ }
  return { events: [], source: 'none' };
}

const DEMO_KEY = 'ca-demo';
let demo = null;
async function demoBackend() {
  if (!demo) {
    demo = (async () => {
      const be = new FakeAlongBackend();
      let restored = false;
      try { restored = restoreAlong(be, JSON.parse(sessionStorage.getItem(DEMO_KEY) || 'null')); } catch { /* fresh */ }
      if (!restored) {
        const { events } = await loadFeed({ live: !globalThis.__ALONG_OFFLINE__ });
        seedAlongDemo(be, events, { hostKey: DEMO_HOST_KEY });
      }
      return be;
    })();
  }
  return demo;
}
function persistDemo(be) { try { sessionStorage.setItem(DEMO_KEY, JSON.stringify(snapshotAlong(be))); } catch { /* private mode: in-memory only */ } }

export function backend() {
  if (isDemo()) {
    return {
      rpc: async (fn, args) => {
        const be = await demoBackend();
        try { const out = await be.rpc(fn, args); persistDemo(be); return out; }
        catch (e) { throw e instanceof NetError ? e : new NetError(e.code || 'error'); }
      },
    };
  }
  return { rpc: rpcNetwork };
}

export function explain(err) {
  const code = err && err.code ? err.code : 'error';
  return ({
    offline: "You're offline. Try again in a moment.",
    not_ready: "Come along isn't switched on yet. Check back soon.",
    not_found: "That link doesn't go anywhere. Ask whoever sent it.",
    bad_code: "That link doesn't look right.",
    bad_key: "That host key doesn't work (or the gate is resting after too many wrong tries).",
    bad_edit: "That edit link doesn't work.",
    bad_plan: "Something's missing — check the highlighted fields.",
    bad_name: 'A first name is enough.',
    bad_token: 'This browser lost its identity. Reload and try again.',
    full: "It's full. The host can raise the cap.",
    cancelled: 'This one was called off.',
    happened: 'This already happened.',
    too_many_open: "You're coming to twenty things already. Drop one first.",
    cap_too_small: "The cap can't go below the number already coming.",
    slow_down: "That's plenty for today — try again tomorrow.",
  })[code] || 'Something went wrong. Try again.';
}
