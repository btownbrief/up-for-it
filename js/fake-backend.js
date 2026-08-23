// UP FOR IT — an in-memory backend that mirrors supabase/up-for-it-SETUP.sql
// op for op: same RPC names, same error codes, same limits, same shapes.
// It runs ?demo=1 in the browser (seeded so Stephen can see the whole loop
// before the SQL is pasted) and it is what scripts/test-core.mjs drives in
// Node. No DOM, no fetch; `now` is injected.
//
// If a rule changes here it must change in the SQL too, and vice versa.

import {
  IDEA_THRESHOLD, CLAIM_DAYS, validToken, isUuid, cleanText, cleanEmail, looksLikeEmail,
  validateTap, validateFinish, validateSuggestion, validateCommit, validatePlan, WHENS, validCategory,
} from './core.js';

const RATE = { tapsPerDay: 300, suggestionsPerDay: 3, openCommits: 10, gateFails: 20 };
const DAY = 86400000;
const HEX32 = /^[a-f0-9]{32}$/;

export class BackendError extends Error {
  constructor(code) { super(code); this.name = 'BackendError'; this.code = code; }
}

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const hexOf = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

export class FakeBackend {
  constructor({ now = () => Date.now(), modSecret = null } = {}) {
    this.now = now;
    this.modSecret = modSecret;
    this.ideas = [];     // {id, slug, title, blurb, when, category, months, status, exists_url, exists_note, origin, source, token, tipped_at, created_at}
    this.taps = [];      // {idea_id, token, answer, top, created_at}
    this.people = new Map(); // token → {email, name, whens, created_at}
    this.hosts = [];     // {id, name, email, key, active, created_at}
    this.plans = [];     // {id, idea_id, host_id, title, place, detail, category, starts_at, cap, threshold, status, meetup_url, showed, created_at, tipped_at, on_at, notified_claim, notified_on, reminded}
    this.commits = [];   // {plan_id, token, name, email, status, created_at}
    this.modFails = []; this.hostFails = [];
  }
  iso(ms = this.now()) { return new Date(ms).toISOString(); }
  checkToken(t) { if (!validToken(t)) throw new BackendError('bad_token'); }
  person(t) { if (!this.people.has(t)) this.people.set(t, { email: '', name: '', whens: [], created_at: this.iso() }); return this.people.get(t); }

  sweep() {
    const old = this.now() - CLAIM_DAYS * DAY;
    for (const p of [...this.plans]) {
      if (p.status === 'tipping' && !p.starts_at && Date.parse(p.created_at) < old && !this.commits.some((c) => c.plan_id === p.id)) {
        this.plans = this.plans.filter((x) => x !== p);
        const i = this.ideas.find((x) => x.id === p.idea_id); if (i && i.status === 'claimed') i.status = 'live';
      }
      if (p.status === 'on' && p.starts_at && Date.parse(p.starts_at) < this.now() - DAY) p.status = 'done';
    }
    this.plans = this.plans.filter((p) => !(p.status === 'cancelled' && Date.parse(p.created_at) < this.now() - 30 * DAY));
    this.ideas = this.ideas.filter((i) => !(i.status === 'rejected' && Date.parse(i.created_at) < this.now() - 30 * DAY));
  }

  // ------------------------------------------------------- projections
  yesCount(id) { return this.taps.filter((t) => t.idea_id === id && t.answer === 'yes').length; }
  livePlanFor(ideaId) { return [...this.plans].reverse().find((p) => p.idea_id === ideaId && ['tipping', 'on'].includes(p.status)) || null; }
  hostName(id) { return (this.hosts.find((h) => h.id === id) || {}).name || null; }
  publicIdea(i) {
    const plan = this.livePlanFor(i.id);
    return {
      id: i.id, slug: i.slug || null, title: i.title, blurb: i.blurb, when: i.when, category: i.category,
      months: i.months, status: i.status, exists_url: i.exists_url || '', exists_note: i.exists_note || '',
      tipped_at: i.tipped_at || null, created_at: i.created_at,
      yes_count: i.tipped_at ? this.yesCount(i.id) : null,
      plan_id: plan ? plan.id : null, host_name: plan ? this.hostName(plan.host_id) : null,
    };
  }
  publicPlan(p) {
    return {
      id: p.id, idea_id: p.idea_id || null, title: p.title, place: p.place, detail: p.detail, category: p.category,
      starts_at: p.starts_at || null, cap: p.cap, threshold: p.threshold, status: p.status, meetup_url: p.meetup_url || '',
      showed: p.showed ?? null, created_at: p.created_at, tipped_at: p.tipped_at || null, on_at: p.on_at || null,
      host_name: this.hostName(p.host_id),
      in_count: this.commits.filter((c) => c.plan_id === p.id && c.status === 'in').length,
      wait_count: this.commits.filter((c) => c.plan_id === p.id && c.status === 'wait').length,
    };
  }
  myJson(t) {
    const pe = this.people.get(t) || { email: '', name: '', whens: [] };
    return {
      taps: this.taps.filter((x) => x.token === t).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .map((x) => ({ idea_id: x.idea_id, answer: x.answer, top: x.top, created_at: x.created_at })),
      commits: this.commits.filter((c) => c.token === t).map((c) => ({ plan_id: c.plan_id, status: c.status, name: c.name, created_at: c.created_at })),
      email: pe.email, name: pe.name, whens: pe.whens,
    };
  }
  weighIn() { const cut = this.now() - 7 * DAY; return new Set(this.taps.filter((t) => Date.parse(t.created_at) > cut).map((t) => t.token)).size; }

  async rpc(fn, args = {}) {
    const m = this[`op_${fn.replace(/^uf_/, '')}`];
    if (!m) throw new BackendError('not_ready');
    return m.call(this, args);
  }

  // ------------------------------------------------------------ public
  op_plans_public() {
    this.sweep();
    const cut = this.now() - 14 * DAY;
    return this.plans.filter((p) => ['tipping', 'on'].includes(p.status) || (p.status === 'done' && p.starts_at && Date.parse(p.starts_at) > cut))
      .sort((a, b) => (a.starts_at ? Date.parse(a.starts_at) : Infinity) - (b.starts_at ? Date.parse(b.starts_at) : Infinity) || Date.parse(a.created_at) - Date.parse(b.created_at))
      .map((p) => this.publicPlan(p));
  }
  op_ideas_public() {
    return this.ideas.filter((i) => ['live', 'claimed', 'exists'].includes(i.status))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).map((i) => this.publicIdea(i));
  }
  op_home({ p_token }) {
    if (p_token != null) this.checkToken(p_token);
    this.sweep();
    return {
      plans: this.op_plans_public(), ideas: this.op_ideas_public(),
      mine: p_token == null ? null : this.myJson(p_token),
      weigh_in: this.weighIn(),
      deck_left: this.ideas.filter((i) => i.status === 'live' && (p_token == null || !this.taps.some((t) => t.idea_id === i.id && t.token === p_token))).length,
    };
  }
  op_mine({ p_token }) { this.checkToken(p_token); this.sweep(); return this.myJson(p_token); }
  op_deck({ p_token }) {
    this.checkToken(p_token);
    return this.ideas.filter((i) => i.status === 'live' && !this.taps.some((t) => t.idea_id === i.id && t.token === p_token))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).map((i) => this.publicIdea(i));
  }
  op_tap({ p_token, p_idea, p_answer }) {
    this.checkToken(p_token);
    const v = validateTap({ idea_id: p_idea, answer: p_answer });
    if (!v.ok) throw new BackendError(v.errors.answer ? 'bad_tap' : 'not_found');
    const i = this.ideas.find((x) => x.id === p_idea);
    if (!i || !['live', 'claimed', 'exists'].includes(i.status)) throw new BackendError('not_found');
    const existing = this.taps.find((t) => t.idea_id === p_idea && t.token === p_token);
    if (!existing && this.taps.filter((t) => t.token === p_token && Date.parse(t.created_at) > this.now() - DAY).length >= RATE.tapsPerDay) throw new BackendError('slow_down');
    if (existing) { existing.answer = p_answer; existing.created_at = this.iso(); if (p_answer !== 'yes') existing.top = false; }
    else this.taps.push({ idea_id: p_idea, token: p_token, answer: p_answer, top: false, created_at: this.iso() });
    this.person(p_token);
    const n = this.yesCount(p_idea);
    if (!i.tipped_at && n >= IDEA_THRESHOLD) i.tipped_at = this.iso();
    return { tipped: Boolean(i.tipped_at), yes_count: i.tipped_at ? n : null };
  }
  op_finish({ p_token, p_finish }) {
    this.checkToken(p_token);
    const v = validateFinish(p_finish);
    if (!v.ok) throw new BackendError('bad_finish');
    const pe = this.person(p_token);
    if (v.value.email) pe.email = v.value.email;
    if (v.value.whens.length) pe.whens = v.value.whens;
    for (const t of this.taps) if (t.token === p_token) t.top = t.answer === 'yes' && v.value.top.includes(t.idea_id);
    return {};
  }
  op_suggest({ p_token, p_suggestion }) {
    this.checkToken(p_token);
    const v = validateSuggestion(p_suggestion);
    if (!v.ok) throw new BackendError('bad_suggestion');
    if (this.ideas.filter((i) => i.token === p_token && Date.parse(i.created_at) > this.now() - DAY).length >= RATE.suggestionsPerDay) throw new BackendError('slow_down');
    const id = uid();
    this.ideas.push({ id, slug: null, title: v.value.title, blurb: v.value.note, when: v.value.when, category: 'social', months: [], status: 'pending', exists_url: '', exists_note: '', origin: 'reader', source: 'suggested', token: p_token, tipped_at: null, created_at: this.iso() });
    this.taps.push({ idea_id: id, token: p_token, answer: 'yes', top: false, created_at: this.iso() });
    const pe = this.person(p_token); if (v.value.email) pe.email = v.value.email;
    return { id };
  }
  op_commit({ p_plan, p_token, p_commit }) {
    this.checkToken(p_token);
    const v = validateCommit(p_commit);
    if (!v.ok) throw new BackendError('bad_commit');
    this.sweep();
    const p = this.plans.find((x) => x.id === p_plan);
    if (!p || !['tipping', 'on'].includes(p.status)) throw new BackendError('not_found');
    const mine = this.commits.find((c) => c.plan_id === p_plan && c.token === p_token);
    if (!mine) {
      const open = this.commits.filter((c) => c.token === p_token && ['tipping', 'on'].includes((this.plans.find((x) => x.id === c.plan_id) || {}).status)).length;
      if (open >= RATE.openCommits) throw new BackendError('too_many_open');
    }
    const inN = this.commits.filter((c) => c.plan_id === p_plan && c.status === 'in').length;
    let status;
    if (mine) { status = mine.status; mine.name = v.value.name; mine.email = v.value.email; }
    else { status = inN >= p.cap ? 'wait' : 'in'; this.commits.push({ plan_id: p_plan, token: p_token, name: v.value.name, email: v.value.email, status, created_at: this.iso() }); }
    const pe = this.person(p_token); pe.email = v.value.email; pe.name = v.value.name;
    const n = this.commits.filter((c) => c.plan_id === p_plan && c.status === 'in').length;
    let wentOn = false;
    if (p.status === 'tipping' && n >= p.threshold) {
      p.tipped_at = p.tipped_at || this.iso();
      if (p.starts_at) { p.status = 'on'; p.on_at = this.iso(); wentOn = true; }
    }
    return { status, in_count: n, on: wentOn || p.status === 'on' };
  }
  op_uncommit({ p_plan, p_token }) {
    this.checkToken(p_token);
    this.commits = this.commits.filter((c) => !(c.plan_id === p_plan && c.token === p_token));
    this.promote(p_plan);
    return {};
  }
  promote(planId) {
    const p = this.plans.find((x) => x.id === planId); if (!p) return;
    const waiting = this.commits.filter((c) => c.plan_id === planId && c.status === 'wait').sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const w of waiting) {
      if (this.commits.filter((c) => c.plan_id === planId && c.status === 'in').length >= p.cap) break;
      w.status = 'in';
    }
  }

  // ------------------------------------------------------------- hosts
  hostId(key) {
    if (!HEX32.test(key || '')) return null;
    this.hostFails = this.hostFails.filter((t) => t > this.now() - 15 * 60000);
    if (this.hostFails.length >= RATE.gateFails) return null;
    const h = this.hosts.find((x) => x.key === key && x.active);
    if (!h) { this.hostFails.push(this.now()); return null; }
    return h.id;
  }
  op_host_me({ p_key }) {
    const id = this.hostId(p_key); if (!id) return { error: 'bad_key' };
    const h = this.hosts.find((x) => x.id === id); return { id: h.id, name: h.name };
  }
  op_host_wants({ p_key }) {
    const id = this.hostId(p_key); if (!id) return { error: 'bad_key' };
    this.sweep();
    const cut = this.now() - 7 * DAY;
    return {
      weigh_in: this.weighIn(), people: this.people.size, emails: [...this.people.values()].filter((p) => p.email).length,
      ideas: this.ideas.filter((i) => ['live', 'claimed', 'exists'].includes(i.status)).map((i) => {
        const taps = this.taps.filter((t) => t.idea_id === i.id);
        const yes = taps.filter((t) => t.answer === 'yes');
        const whens = {};
        for (const t of yes) for (const w of (this.people.get(t.token) || { whens: [] }).whens) whens[w] = (whens[w] || 0) + 1;
        return {
          ...this.publicIdea(i), yes: yes.length, maybe: taps.filter((t) => t.answer === 'maybe').length,
          pass: taps.filter((t) => t.answer === 'pass').length, top: taps.filter((t) => t.top).length,
          yes_7d: yes.filter((t) => Date.parse(t.created_at) > cut).length,
          emails: yes.filter((t) => (this.people.get(t.token) || {}).email).length, whens, source: i.source, origin: i.origin,
        };
      }),
    };
  }
  op_host_plans({ p_key }) {
    const id = this.hostId(p_key); if (!id) return { error: 'bad_key' };
    this.sweep();
    const rank = { tipping: 0, on: 1, done: 2, cancelled: 3 };
    return {
      mine: this.plans.filter((p) => p.host_id === id && (['tipping', 'on'].includes(p.status) || Date.parse(p.created_at) > this.now() - 60 * DAY))
        .sort((a, b) => rank[a.status] - rank[b.status] || (a.starts_at ? Date.parse(a.starts_at) : Infinity) - (b.starts_at ? Date.parse(b.starts_at) : Infinity))
        .map((p) => ({
          ...this.publicPlan(p), notified_claim: p.notified_claim, notified_on: p.notified_on, reminded: p.reminded,
          people: this.commits.filter((c) => c.plan_id === p.id).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).map((c) => ({ name: c.name, status: c.status, created_at: c.created_at })),
        })),
      others: this.plans.filter((p) => p.host_id !== id && ['tipping', 'on'].includes(p.status)).map((p) => this.publicPlan(p)),
    };
  }
  planFields(body) {
    const v = validatePlan(body);
    if (!v.ok) throw new BackendError('bad_plan');
    return v.value;
  }
  op_host_claim({ p_key, p_plan }) {
    const hostId = this.hostId(p_key); if (!hostId) return { error: 'bad_key' };
    const f = this.planFields(p_plan);
    this.sweep();
    let category = f.category;
    if (f.idea_id) {
      const i = this.ideas.find((x) => x.id === f.idea_id);
      if (!i || !['live', 'claimed', 'exists'].includes(i.status)) throw new BackendError('not_found');
      if (this.livePlanFor(i.id)) throw new BackendError('already_claimed');
      i.status = 'claimed'; category = i.category || category;
    }
    const id = uid();
    this.plans.push({ id, idea_id: f.idea_id, host_id: hostId, title: f.title, place: f.place, detail: f.detail, category, starts_at: f.starts_at, cap: f.cap, threshold: f.threshold, status: 'tipping', meetup_url: f.meetup_url, showed: null, created_at: this.iso(), tipped_at: null, on_at: null, notified_claim: false, notified_on: false, reminded: false });
    return { id };
  }
  op_host_update({ p_key, p_plan, p_patch }) {
    const hostId = this.hostId(p_key); if (!hostId) return { error: 'bad_key' };
    const p = this.plans.find((x) => x.id === p_plan && x.host_id === hostId);
    if (!p || !['tipping', 'on'].includes(p.status)) throw new BackendError('not_found');
    const merged = {
      title: p_patch.title ?? p.title, place: p_patch.place ?? p.place, detail: p_patch.detail ?? p.detail,
      category: p_patch.category ?? p.category, starts_at: 'starts_at' in p_patch ? p_patch.starts_at : p.starts_at,
      cap: p_patch.cap != null ? Number(p_patch.cap) : p.cap, threshold: p_patch.threshold != null ? Number(p_patch.threshold) : p.threshold,
      meetup_url: p_patch.meetup_url ?? p.meetup_url,
    };
    const f = this.planFields(merged);
    if (f.starts_at !== p.starts_at) p.reminded = false;
    Object.assign(p, { title: f.title, place: f.place, detail: f.detail, category: validCategory(merged.category) ? merged.category : p.category, starts_at: f.starts_at, cap: f.cap, threshold: f.threshold, meetup_url: f.meetup_url });
    this.promote(p.id);
    const n = this.commits.filter((c) => c.plan_id === p.id && c.status === 'in').length;
    let wentOn = false;
    if (p.status === 'tipping' && p.starts_at && n >= p.threshold) { p.status = 'on'; p.on_at = this.iso(); p.tipped_at = p.tipped_at || this.iso(); wentOn = true; }
    return { on: wentOn };
  }
  op_host_action({ p_key, p_plan, p_action, p_payload = {} }) {
    const hostId = this.hostId(p_key); if (!hostId) return { error: 'bad_key' };
    const p = this.plans.find((x) => x.id === p_plan && x.host_id === hostId);
    if (!p) throw new BackendError('not_found');
    const releaseIdea = () => { const i = this.ideas.find((x) => x.id === p.idea_id); if (i && i.status === 'claimed') i.status = 'live'; };
    if (p_action === 'on') {
      if (p.status !== 'tipping') throw new BackendError('not_found');
      if (!p.starts_at) throw new BackendError('needs_date');
      p.status = 'on'; p.on_at = this.iso(); p.tipped_at = p.tipped_at || this.iso();
    } else if (p_action === 'cancel') {
      if (!['tipping', 'on'].includes(p.status)) throw new BackendError('not_found');
      p.status = 'cancelled'; releaseIdea();
    } else if (p_action === 'release') {
      if (p.status !== 'tipping' || this.commits.some((c) => c.plan_id === p.id)) throw new BackendError('has_people');
      this.plans = this.plans.filter((x) => x !== p); releaseIdea();
    } else if (p_action === 'done') {
      if (!['on', 'done'].includes(p.status)) throw new BackendError('not_found');
      p.status = 'done'; p.showed = p_payload.showed === '' || p_payload.showed == null ? null : Number(p_payload.showed); releaseIdea();
    } else throw new BackendError('bad_action');
    return {};
  }

  // --------------------------------------------------------- moderation
  modOk(secret) {
    if (!this.modSecret || !secret) return false;
    this.modFails = this.modFails.filter((t) => t > this.now() - 15 * 60000);
    if (this.modFails.length >= RATE.gateFails) return false;
    const good = secret === this.modSecret;
    if (!good) this.modFails.push(this.now());
    return good;
  }
  op_mod_queue({ p_secret }) {
    if (!this.modOk(p_secret)) return { error: 'bad_secret' };
    this.sweep();
    const counts = (i) => ({ yes: this.yesCount(i.id), maybe: this.taps.filter((t) => t.idea_id === i.id && t.answer === 'maybe').length, origin: i.origin, source: i.source });
    return {
      pending: this.ideas.filter((i) => i.status === 'pending').map((i) => ({ ...this.publicIdea(i), origin: i.origin })),
      ideas: this.ideas.filter((i) => ['live', 'claimed', 'exists', 'archived'].includes(i.status)).map((i) => ({ ...this.publicIdea(i), ...counts(i) })),
      hosts: this.hosts.map((h) => ({ id: h.id, name: h.name, email: h.email, active: h.active, created_at: h.created_at, plans: this.plans.filter((p) => p.host_id === h.id).length })),
      plans: [...this.plans].reverse().map((p) => this.publicPlan(p)),
      stats: { people: this.people.size, emails: [...this.people.values()].filter((p) => p.email).length, taps: this.taps.length, weigh_in: this.weighIn() },
    };
  }
  op_mod_idea({ p_secret, p_idea, p_action, p_patch = {} }) {
    if (!this.modOk(p_secret)) return { error: 'bad_secret' };
    const months = Array.isArray(p_patch.months) ? p_patch.months.map(Number).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12) : null;
    if (p_action === 'add') {
      const id = uid();
      this.ideas.push({ id, slug: null, title: cleanText(p_patch.title, 56), blurb: cleanText(p_patch.blurb, 120), when: ['weeknight', 'sat-am', 'sat-pm', 'sunday', 'any'].includes(p_patch.when) ? p_patch.when : 'any', category: validCategory(p_patch.category) ? p_patch.category : 'social', months: months || [], status: 'live', exists_url: '', exists_note: '', origin: 'editor', source: 'seed', token: null, tipped_at: null, created_at: this.iso() });
      return { id };
    }
    const i = this.ideas.find((x) => x.id === p_idea);
    if (!i) throw new BackendError('not_found');
    if (p_action === 'approve') { if (i.status === 'pending') i.status = 'live'; }
    else if (p_action === 'reject') i.status = 'rejected';
    else if (p_action === 'archive') i.status = 'archived';
    else if (p_action === 'restore') i.status = 'live';
    else if (p_action === 'exists') {
      if (!/^https:\/\/\S+$/i.test(p_patch.url || '')) throw new BackendError('bad_patch');
      i.status = 'exists'; i.exists_url = String(p_patch.url).trim().slice(0, 200); i.exists_note = cleanText(p_patch.note, 80);
    } else if (p_action === 'edit') {
      if (cleanText(p_patch.title, 56)) i.title = cleanText(p_patch.title, 56);
      if ('blurb' in p_patch) i.blurb = cleanText(p_patch.blurb, 120);
      if (['weeknight', 'sat-am', 'sat-pm', 'sunday', 'any'].includes(p_patch.when)) i.when = p_patch.when;
      if (validCategory(p_patch.category)) i.category = p_patch.category;
      if (months) i.months = months;
    } else if (p_action === 'delete') this.ideas = this.ideas.filter((x) => x !== i);
    else throw new BackendError('bad_action');
    return {};
  }
  op_mod_host({ p_secret, p_action, p_payload = {} }) {
    if (!this.modOk(p_secret)) return { error: 'bad_secret' };
    const key = hexOf(32);
    if (p_action === 'add') {
      const name = cleanText(p_payload.name, 32);
      if (!name) throw new BackendError('bad_host');
      const id = uid();
      this.hosts.push({ id, name, email: cleanEmail(p_payload.email), key, active: true, created_at: this.iso() });
      return { id, key };
    }
    const h = this.hosts.find((x) => x.id === p_payload.id);
    if (!h) throw new BackendError('not_found');
    if (p_action === 'rekey') { h.key = key; h.active = true; return { key }; }
    if (p_action === 'disable') h.active = false;
    else if (p_action === 'enable') h.active = true;
    else if (p_action === 'delete') { this.hosts = this.hosts.filter((x) => x !== h); this.plans = this.plans.filter((p) => p.host_id !== h.id); }
    else throw new BackendError('bad_action');
    return {};
  }
  op_mod_plan({ p_secret, p_plan, p_action }) {
    if (!this.modOk(p_secret)) return { error: 'bad_secret' };
    const p = this.plans.find((x) => x.id === p_plan);
    if (!p) throw new BackendError('not_found');
    const releaseIdea = () => { const i = this.ideas.find((x) => x.id === p.idea_id); if (i && i.status === 'claimed') i.status = 'live'; };
    if (p_action === 'cancel') { p.status = 'cancelled'; releaseIdea(); }
    else if (p_action === 'delete') { this.plans = this.plans.filter((x) => x !== p); releaseIdea(); }
    else throw new BackendError('bad_action');
    return {};
  }
}

// --------------------------------------------------------------- demo seed
// The deck from data/ideas.json is loaded by the caller (the browser fetches
// the JSON; tests import it). seedDemo adds two hosts, taps from a small
// crowd so a few ideas have tipped, and three plans at different stages —
// enough to see the whole loop on one screen. The demo host key and mod
// secret are fixed so Stephen can open host.html?demo=1 and mod.html?demo=1.
export const DEMO_HOST_KEY = 'deadbeefdeadbeefdeadbeefdeadbeef';
export const DEMO_HOST_KEY_2 = 'cafebabecafebabecafebabecafebabe';
export function seedDemo(be, ideas) {
  const now = be.now();
  // daysAgo may be fractional (for "created_at" spacing); h pins a local
  // clock hour (6.5 = 6:30) so demo plans read like real evenings
  const at = (daysAgo, h = 12) => {
    const d = new Date(now - daysAgo * DAY);
    d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
    return d.toISOString();
  };
  for (const i of ideas) {
    be.ideas.push({ id: uid(), slug: i.slug, title: i.title, blurb: i.blurb || '', when: i.when, category: i.category, months: i.months || [],
      status: i.exists ? 'exists' : 'live', exists_url: i.exists ? i.exists.url : '', exists_note: i.exists ? i.exists.note : '',
      origin: i.origin || 'editor', source: 'seed', token: null, tipped_at: null, created_at: at(20) });
  }
  be.hosts.push({ id: uid(), name: 'Stephen', email: '', key: DEMO_HOST_KEY, active: true, created_at: at(30) });
  be.hosts.push({ id: uid(), name: 'Jonathon', email: '', key: DEMO_HOST_KEY_2, active: true, created_at: at(30) });
  const [stephen, jonathon] = be.hosts;
  const crowd = Array.from({ length: 14 }, (_, k) => `${k.toString(16).padStart(2, '0')}`.repeat(16));
  const whensPool = [['weeknight'], ['weeknight', 'sunday'], ['sat-am'], ['sat-pm', 'sunday'], ['weeknight', 'sat-am'], ['sunday']];
  crowd.forEach((t, k) => { be.people.set(t, { email: k % 2 ? `demo${k}@example.com` : '', name: '', whens: whensPool[k % whensPool.length], created_at: at(10) }); });
  const find = (slug) => be.ideas.find((i) => i.slug === slug);
  const tapN = (slug, yes, maybe = 0, daysAgo = 5) => {
    const i = find(slug); if (!i) return;
    crowd.slice(0, yes).forEach((t, k) => be.taps.push({ idea_id: i.id, token: t, answer: 'yes', top: k < 3, created_at: at(daysAgo - (k % 4) * 0.5) }));
    crowd.slice(yes, yes + maybe).forEach((t) => be.taps.push({ idea_id: i.id, token: t, answer: 'maybe', top: false, created_at: at(daysAgo) }));
    if (yes >= IDEA_THRESHOLD) i.tipped_at = at(daysAgo - 1);
  };
  tapN('beginner-pickleball-leddy-courts', 11, 2, 6);
  tapN('sunset-paddle-north-beach', 9, 1, 4);
  tapN('pinball-co-op-wednesday', 7, 3, 3);
  tapN('oakledge-golden-hour-picnic', 6, 0, 2);
  tapN('apple-picking-shelburne-orchards', 5, 4, 1);
  tapN('sunset-hike-mt-philo', 4, 2, 2);
  tapN('silent-book-club-sunday', 3, 1, 8);
  tapN('causeway-ride-to-the-cut', 2, 2, 1);
  // plan 1: claimed + dated + on (tipped), Jonathon — pinball
  const pin = find('pinball-co-op-wednesday');
  if (pin) {
    pin.status = 'claimed';
    const p = { id: uid(), idea_id: pin.id, host_id: jonathon.id, title: 'Pinball night at the Pinball Co-op', place: 'Pinball Co-op, South Burlington', detail: 'Meet by the door at 6:45; $20 flat for unlimited play. Carpool from the Church St top block at 6:20.', category: 'games',
      starts_at: at(-9, 19), cap: 10, threshold: 5, status: 'on', meetup_url: '', showed: null, created_at: at(3), tipped_at: at(2), on_at: at(2), notified_claim: true, notified_on: true, reminded: false };
    be.plans.push(p);
    ['Priya', 'Sam', 'Lee', 'Ana', 'Bo', 'Cy'].forEach((n, k) => be.commits.push({ plan_id: p.id, token: crowd[k], name: n, email: `demo${k}@example.com`, status: 'in', created_at: at(2.5 - k * 0.2) }));
  }
  // plan 2: claimed, dated, still tipping (3 of 5), Stephen — paddle
  const pad = find('sunset-paddle-north-beach');
  if (pad) {
    pad.status = 'claimed';
    const p = { id: uid(), idea_id: pad.id, host_id: stephen.id, title: 'Sunset paddle from North Beach', place: 'North Beach boathouse', detail: 'Rentals on the sand (~$25/hr), or bring your own. Calm-water only; we call it if it blows.', category: 'outdoors',
      starts_at: at(-5, 18.5), cap: 8, threshold: 5, status: 'tipping', meetup_url: '', showed: null, created_at: at(1.5), tipped_at: null, on_at: null, notified_claim: true, notified_on: false, reminded: false };
    be.plans.push(p);
    ['Maya', 'Theo', 'Jess'].forEach((n, k) => be.commits.push({ plan_id: p.id, token: crowd[k + 6], name: n, email: `demo${k + 6}@example.com`, status: 'in', created_at: at(1 - k * 0.2) }));
  }
  // plan 3: host-floated, needs a date, 1 in — Stephen
  const p3 = { id: uid(), idea_id: null, host_id: stephen.id, title: 'Trivia at Four Quarters, the Btown table', place: 'Four Quarters Brewing, Winooski', detail: 'We hold a table; teams of up to 6. Kitchen is open.', category: 'games',
    starts_at: null, cap: 12, threshold: 4, status: 'tipping', meetup_url: '', showed: null, created_at: at(0.5), tipped_at: null, on_at: null, notified_claim: false, notified_on: false, reminded: false };
  be.plans.push(p3);
  be.commits.push({ plan_id: p3.id, token: crowd[10], name: 'Noor', email: 'demo10@example.com', status: 'in', created_at: at(0.3) });
  // plan 4: done last week — 9 came
  const p4 = { id: uid(), idea_id: null, host_id: stephen.id, title: 'Foliage walk to the Ethan Allen tower', place: 'Ethan Allen Park, North Ave', detail: '', category: 'outdoors',
    starts_at: at(6, 10), cap: 12, threshold: 5, status: 'done', meetup_url: '', showed: 9, created_at: at(12), tipped_at: at(9), on_at: at(9), notified_claim: true, notified_on: true, reminded: true };
  be.plans.push(p4);
  return be;
}
