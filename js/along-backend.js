// COME ALONG — in-memory twin of supabase/come-along-SETUP.sql, op for op:
// same RPC names (ca_*), same error codes, same limits, same shapes. Runs
// ?demo=1 in the browser and scripts/test-along.mjs in Node. No DOM, no
// fetch; `now` is injected. If a rule changes here it changes in the SQL too.
import {
  validatePlan, validatePatch, validateJoin, validCode, normalizeCode, validEditKey, endOf,
  CODE_ALPHABET, CODE_LEN, MAX_OPEN_JOINS, CREATES_PER_DAY, pickEvents, planFromEvent,
} from './along-core.js';
import { validToken } from './core.js';

const DAY = 86400000;
export class AlongError extends Error {
  constructor(code) { super(code); this.name = 'AlongError'; this.code = code; }
}
const hexOf = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
let seq = 0;
const uid = () => `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`;
export const bumpSeq = (n) => { seq = Math.max(seq, n); };

export class FakeAlongBackend {
  // hosts: [{ id, name, key }] — in the real project this is uf_hosts,
  // checked through uf_host_id(); the fake takes the list directly.
  constructor({ now = () => Date.now(), hosts = [], random = Math.random } = {}) {
    this.now = now; this.hosts = hosts; this.random = random;
    this.plans = [];   // {id, code, host_id, host_name, event_*, meet_place, meet_at, invite, look_for, cap, status, edit_key, created_at, cancelled_at}
    this.going = [];   // {plan_id, token, name, created_at}
  }
  iso(ms = this.now()) { return new Date(ms).toISOString(); }
  async rpc(fn, args = {}) {
    const m = this[`op_${fn.replace(/^ca_/, '')}`];
    if (!m) throw new AlongError('not_ready');
    return m.call(this, args);
  }
  mintCode() {
    for (let tries = 0; tries < 50; tries++) {
      let c = '';
      for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)];
      if (!this.plans.some((p) => p.code === c)) return c;
    }
    throw new AlongError('error');
  }
  find(code) {
    const c = normalizeCode(code);
    if (!validCode(c)) throw new AlongError('bad_code');
    const p = this.plans.find((x) => x.code === c);
    if (!p) throw new AlongError('not_found');
    return p;
  }
  goingFor(p) { return this.going.filter((g) => g.plan_id === p.id).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)); }
  publicPlan(p, token = null) {
    const g = this.goingFor(p);
    return {
      code: p.code, host_name: p.host_name,
      event_id: p.event_id, event_title: p.event_title, event_url: p.event_url, event_venue: p.event_venue, event_address: p.event_address,
      event_start: p.event_start, event_end: p.event_end,
      meet_place: p.meet_place, meet_at: p.meet_at, invite: p.invite, look_for: p.look_for, cap: p.cap,
      status: p.status, created_at: p.created_at, cancelled_at: p.cancelled_at,
      going: g.map((x) => x.name), going_count: g.length,
      you: token ? g.some((x) => x.token === token) : false,
    };
  }
  sweep() {
    // a plan and its names are gone 30 days after the event ended
    const cut = this.now() - 30 * DAY;
    const dead = new Set(this.plans.filter((p) => endOf(p) < cut).map((p) => p.id));
    if (dead.size) { this.plans = this.plans.filter((p) => !dead.has(p.id)); this.going = this.going.filter((g) => !dead.has(g.plan_id)); }
  }

  // ------------------------------------------------------------- host side
  host(key) { return this.hosts.find((h) => h.key === key) || null; }
  op_create({ p_key, p_plan }) {
    const host = this.host(p_key);
    if (!host) throw new AlongError('bad_key');
    const since = this.now() - DAY;
    if (this.plans.filter((p) => p.host_id === host.id && Date.parse(p.created_at) > since).length >= CREATES_PER_DAY) throw new AlongError('slow_down');
    const r = validatePlan(p_plan || {});
    if (!r.ok) throw new AlongError('bad_plan');
    if (endOf(r.value) < this.now()) throw new AlongError('happened');
    const plan = { id: uid(), code: this.mintCode(), host_id: host.id, host_name: host.name, ...r.value, status: 'open', edit_key: hexOf(32), created_at: this.iso(), cancelled_at: null };
    this.plans.push(plan);
    return { code: plan.code, edit_key: plan.edit_key, plan: this.publicPlan(plan) };
  }
  editable(p_code, p_edit) {
    const p = this.find(p_code);
    if (!validEditKey(p_edit) || p.edit_key !== p_edit) throw new AlongError('bad_edit');
    return p;
  }
  op_edit({ p_code, p_edit, p_patch }) {
    const p = this.editable(p_code, p_edit);
    if (p.status === 'cancelled') throw new AlongError('cancelled');
    const r = validatePatch(p, p_patch || {});
    if (!r.ok) throw new AlongError('bad_plan');
    if ('cap' in r.value && r.value.cap > 0 && r.value.cap < this.goingFor(p).length) throw new AlongError('cap_too_small');
    Object.assign(p, r.value);
    return this.publicPlan(p);
  }
  op_cancel({ p_code, p_edit }) {
    const p = this.editable(p_code, p_edit);
    if (p.status !== 'cancelled') { p.status = 'cancelled'; p.cancelled_at = this.iso(); }
    return this.publicPlan(p);
  }
  op_host_plans({ p_key }) {
    const host = this.host(p_key);
    if (!host) throw new AlongError('bad_key');
    this.sweep();
    return this.plans.filter((p) => p.host_id === host.id).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map((p) => ({ ...this.publicPlan(p), edit_key: p.edit_key }));
  }

  // ----------------------------------------------------------- guest side
  op_get({ p_code, p_token = null }) {
    this.sweep();
    const p = this.find(p_code);
    return this.publicPlan(p, p_token);
  }
  op_join({ p_code, p_token, p_name }) {
    if (!validToken(p_token)) throw new AlongError('bad_token');
    const p = this.find(p_code);
    if (p.status === 'cancelled') throw new AlongError('cancelled');
    if (endOf(p) < this.now()) throw new AlongError('happened');
    const r = validateJoin({ name: p_name });
    if (!r.ok) throw new AlongError('bad_name');
    const mine = this.going.find((g) => g.plan_id === p.id && g.token === p_token);
    if (mine) { mine.name = r.value.name; return this.publicPlan(p, p_token); }
    if (p.cap > 0 && this.goingFor(p).length >= p.cap) throw new AlongError('full');
    const open = this.going.filter((g) => g.token === p_token && endOf(this.plans.find((x) => x.id === g.plan_id) || { event_start: 0 }) > this.now()).length;
    if (open >= MAX_OPEN_JOINS) throw new AlongError('too_many_open');
    this.going.push({ plan_id: p.id, token: p_token, name: r.value.name, created_at: this.iso() });
    return this.publicPlan(p, p_token);
  }
  op_leave({ p_code, p_token }) {
    if (!validToken(p_token)) throw new AlongError('bad_token');
    const p = this.find(p_code);
    this.going = this.going.filter((g) => !(g.plan_id === p.id && g.token === p_token));
    return this.publicPlan(p, p_token);
  }
  op_mine({ p_token }) {
    if (!validToken(p_token)) throw new AlongError('bad_token');
    this.sweep();
    return this.going.filter((g) => g.token === p_token).map((g) => this.plans.find((p) => p.id === g.plan_id)).filter(Boolean)
      .sort((a, b) => Date.parse(a.meet_at) - Date.parse(b.meet_at)).map((p) => this.publicPlan(p, p_token));
  }
  // The guide reads this to decide where a "come along" chip belongs: open
  // plans whose event hasn't ended. Codes, event ids, times, counts. No names.
  op_public() {
    this.sweep();
    const now = this.now();
    return this.plans.filter((p) => p.status === 'open' && endOf(p) > now)
      .sort((a, b) => Date.parse(a.meet_at) - Date.parse(b.meet_at))
      .map((p) => ({ code: p.code, event_id: p.event_id, event_url: p.event_url, event_title: p.event_title, event_start: p.event_start, event_end: p.event_end, meet_at: p.meet_at, meet_place: p.meet_place, going_count: this.goingFor(p).length, cap: p.cap }));
  }
}

// The demo lives in one browser tab: after every call the state is written
// to sessionStorage so "Open it" on the create page lands on a join page
// that knows the code. Closing the tab forgets everything.
export function snapshotAlong(be) { return { seq, hosts: be.hosts, plans: be.plans, going: be.going }; }
export function restoreAlong(be, snap) {
  if (!snap || !Array.isArray(snap.plans)) return false;
  be.hosts = snap.hosts || be.hosts; be.plans = snap.plans; be.going = snap.going || [];
  bumpSeq(Number(snap.seq) || 0);
  return true;
}

// ---------------------------------------------------------------- demo
// Two come-alongs built from REAL upcoming events in the guide feed (the
// caller passes the feed, live or the bundled snapshot). Prefers a couple of
// known-good picks, then falls back to the soonest free things.
export const DEMO_PREFERRED = ['21ed6f4288b7', '1bda86a25014', '68faf4787c33', 'e1df34fbd7a9', '78831b9a3bda'];
export function seedAlongDemo(be, events, { hostKey, hostName = 'Stephen' } = {}) {
  const now = be.now();
  if (!be.hosts.length) be.hosts.push({ id: uid(), name: hostName, key: hostKey });
  const host = be.hosts[0];
  const future = pickEvents(events, { nowMs: now, limit: 200 });
  const preferred = DEMO_PREFERRED.map((id) => future.find((e) => e.id === id)).filter(Boolean);
  const chosen = [...preferred, ...future.filter((e) => e.free === true && !preferred.includes(e))].slice(0, 2);
  const names = [['Priya', 'Tom', 'Maddie', 'Jonathon'], ['Alex', 'Sam']];
  chosen.forEach((e, i) => {
    const base = planFromEvent(e);
    const plan = i === 0
      ? { ...base, meet_place: base.meet_place || 'By the entrance', invite: 'Coming alone is normal. Look for the Btown sign.', look_for: 'Stephen, tall, brown jacket' }
      : { ...base, meet_place: base.meet_place || 'By the entrance', invite: 'First timers welcome; we will save you a spot.', look_for: '', cap: 12 };
    const r = be.op_create({ p_key: host.key, p_plan: plan });
    const p = be.plans.find((x) => x.code === r.code);
    p.created_at = be.iso(now - (2 - i) * DAY);
    names[i].forEach((n, k) => be.going.push({ plan_id: p.id, token: `${(k + 1).toString(16).padStart(2, '0')}`.repeat(16), name: n, created_at: be.iso(now - (1.5 - k * 0.3) * DAY) }));
  });
  return be;
}
