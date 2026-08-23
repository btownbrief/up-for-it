// UP FOR IT — the reader app. Renders and dispatches; every rule lives in
// core.js and every network call in net.js. One `state` object; `load()`
// asks the backend for the whole home screen once and re-renders; after
// any write we load again. No innerHTML with data — everything is built
// with h() and textContent.

import {
  WHENS, WHEN_HINTS, CATEGORIES, LIMITS, DECK_SIZE, TOP_PICKS,
  whenLabel, categoryLabel, mastheadFor,
  validateFinish, validateSuggestion, validateCommit,
  deckOrder, inSeason, ideasView, plansView, ideaStatus, planState, planProgress, formatWhen,
} from './core.js';
import { backend, token, isDemo, notify, explain, savedName, savedEmail } from './net.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* fine */ } },
};
// name + email, remembered on the device (session-only in ?demo=1 so the
// demo never writes a pretend email into someone's real browser)
const mem = { name: savedName.get(), email: savedEmail.get() };
function remember(name, email) {
  if (name != null) { mem.name = name; if (!isDemo()) savedName.set(name); }
  if (email != null) { mem.email = email; if (!isDemo()) savedEmail.set(email); }
}

// tiny element builder: h('div', {class:'x', onclick}, 'text', node, ...)
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------ state
const params = new URLSearchParams(location.search);
const EMPTY_HOME = { plans: [], ideas: [], mine: null, weigh_in: 0, deck_left: 0 };
const state = {
  view: ['plans', 'wishes'].includes(params.get('view')) ? params.get('view') : store.get('uf-view', 'plans'),
  category: 'all',
  home: null,        // null = loading
  error: null,       // NetError from uf_home (not_ready, offline…)
  wantPlan: params.get('plan') || null,  // ?plan=<id> → scroll to + highlight
  confirmOut: null,  // plan id whose "You're in" button is showing Step out / Stay
  choosing: null,    // idea id whose "You'd go" button is showing Pass / Maybe / I'd go
};
const be = backend();
const month = () => new Date().getMonth();
const mine = () => state.home?.mine || { taps: [], commits: [], email: '', name: '', whens: [] };
const myTap = (ideaId) => mine().taps.find((t) => t.idea_id === ideaId) || null;
const myCommit = (planId) => mine().commits.find((c) => c.plan_id === planId) || null;
// Cards this device could still see: live, in season, not yet tapped. The
// server's deck_left counts out-of-season ideas too (deckOrder hides those),
// so count it here from the ideas we already have.
const deckLeft = () => {
  const home = state.home;
  if (!home) return 0;
  if (!Array.isArray(home.ideas) || !home.ideas.length) return home.deck_left || 0;
  const m = month();
  return home.ideas.filter((i) => i.status === 'live' && inSeason(i, m) && !myTap(i.id)).length;
};

// ------------------------------------------------------------------ toast
let toastTimer = 0;
function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const announce = (msg) => { $('announce').textContent = msg; };

// ----------------------------------------------------------------- sheets
function openSheet(id) {
  const d = $(id);
  if (!d.open) d.showModal();
  d.querySelector('.sheet-inner').scrollTop = 0;
}
function closeSheet(id) { const d = $(id); if (d.open) d.close(); }
for (const d of document.querySelectorAll('dialog.sheet')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });           // tap the backdrop to dismiss
  d.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) d.close(); });
}
function sheetHead(titleId, title, sheetId, closeLabel = 'Cancel') {
  return [
    h('div', { class: 'grab' }),
    h('div', { class: 'sheet-head' },
      h('h2', { id: titleId }, title),
      h('button', { class: 'close', type: 'button', onclick: () => closeSheet(sheetId) }, closeLabel)),
  ];
}

// A field with pill options. single: {v}; multi: Set.
function optField({ label, options, value, multi = false, onChange, hint, name }) {
  const box = h('div', { class: 'field', dataset: { field: name } });
  const opts = h('div', { class: 'opts', role: 'group', 'aria-label': label });
  const render = () => {
    clear(opts);
    for (const o of options) {
      const pressed = multi ? value.has(o.id) : value.v === o.id;
      opts.append(h('button', {
        type: 'button', class: 'opt', 'aria-pressed': String(pressed),
        onclick: () => {
          if (multi) { value.has(o.id) ? value.delete(o.id) : value.add(o.id); } else value.v = o.id;
          clearError(box); render(); onChange && onChange();
        },
      }, o.label));
    }
  };
  render();
  box.append(h('span', { class: 'label' }, label), opts);
  if (hint) box.append(h('div', { class: 'hint' }, hint));
  return box;
}
function textField({ label, name, value = '', placeholder, max, hint, multiline, type = 'text', autocomplete, inputmode }) {
  const input = multiline
    ? h('textarea', { class: 'input', name, placeholder, maxlength: max, autocomplete })
    : h('input', { class: 'input', name, type, placeholder, maxlength: max, autocomplete, inputmode, autocapitalize: type === 'email' ? 'off' : 'words' });
  input.value = value;
  const box = h('div', { class: 'field', dataset: { field: name } }, h('label', { class: 'label' }, label, input));
  input.addEventListener('input', () => clearError(box));
  if (hint) box.append(h('div', { class: 'hint' }, hint));
  return box;
}
function clearError(field) { field.classList.remove('bad'); field.querySelector('.err')?.remove(); }
function showErrors(root, errors) {
  for (const f of root.querySelectorAll('.field')) {
    f.classList.remove('bad');
    f.querySelector('.err')?.remove();
    const msg = errors[f.dataset.field];
    if (msg) { f.classList.add('bad'); f.append(h('div', { class: 'err' }, msg)); }
  }
  const first = root.querySelector('.field.bad');
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ------------------------------------------------------------------ views
function setView(v) {
  state.view = v;
  store.set('uf-view', v);
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
  render();
}

function render() {
  const root = $('home'); clear(root);
  const status = $('status'); status.textContent = '';
  if (state.view === 'plans') renderPlans(root); else renderWishes(root);
  if (isDemo()) status.textContent = 'Demo — sample plans and taps, nothing is saved.';
}

// ----------------------------------------------------------------- plans
function deckCard() {
  const home = state.home || EMPTY_HOME;
  const weigh = home.weigh_in;
  const weighLine = weigh ? `${plural(weigh, 'neighbor')} weighed in this week` : 'Be the first to weigh in';
  const card = h('section', { class: 'deck-cta', 'aria-label': 'The deck' });
  if (state.error) {
    card.classList.add('off');
    card.append(
      h('h2', {}, 'Up for it?'),
      h('p', {}, explain(state.error)),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Start'),
        h('button', { type: 'button', class: 'link', onclick: load }, 'Try again')));
    return card;
  }
  if (state.home === null) {
    card.append(h('h2', {}, 'Up for it?'), h('p', {}, 'Loading…'));
    return card;
  }
  const tapped = mine().taps.length > 0;
  const left = deckLeft();
  if (left > 0) {
    card.append(
      h('h2', {}, 'Up for it?'),
      h('p', {}, `${DECK_SIZE} quick taps. Tell us what you'd actually go to — hosts see what tips.`),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', id: 'deck-start', onclick: () => openDeck() },
          tapped ? `Keep going · ${left} left` : 'Start'),
        h('span', { class: 'weigh' }, weighLine)));
  } else {
    card.append(
      h('h2', {}, "You've seen them all"),
      h('p', {}, weigh ? `${plural(weigh, 'neighbor')} weighed in this week. The ones that tip show up in Wishes, and hosts pick from there.` : 'Check back — new ideas join the deck as Stephen adds them.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => setView('wishes') }, "See what's tipping →"),
        h('span', { class: 'weigh' }, weighLine)));
  }
  return card;
}

function planCard(plan, now) {
  const st = planState(plan, now);
  const commit = myCommit(plan.id);
  const when = plan.starts_at ? formatWhen(plan.starts_at) : 'Needs a date';
  const done = ['done', 'past', 'cancelled'].includes(st.state);
  const card = h('article', { class: `card plan${done ? ' done' : ''}`, dataset: { id: plan.id } },
    h('h3', { class: 'title' }, plan.title),
    h('div', { class: 'meta' }, `${when} · ${plan.place}${plan.host_name ? ` · hosted by ${plan.host_name}` : ''}`),
    !done && plan.detail ? h('p', { class: 'detail' }, plan.detail) : null,
    h('div', { class: `line ${st.state === 'on' || st.state === 'full' ? 'on' : ''}${done ? ' past' : ''}` }, st.line),
  );
  if (['tipping', 'needs-date', 'tipped'].includes(st.state)) {
    card.append(h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '1', 'aria-valuenow': String(planProgress(plan)), 'aria-label': st.line },
      h('i', { style: `width:${Math.round(planProgress(plan) * 100)}%` })));
  }
  if (done) return card;

  const foot = h('div', { class: 'foot' });
  if (st.state === 'on' || st.state === 'full') {
    if (plan.meetup_url) foot.append(h('a', { class: 'meetup', href: plan.meetup_url, target: '_blank', rel: 'noopener' }, 'RSVP on Meetup →'));
  }
  foot.append(h('span', { class: 'spacer' }));
  if (commit) {
    if (state.confirmOut === plan.id) {
      foot.append(h('span', { class: 'pair' },
        h('button', { type: 'button', class: 'btn danger', onclick: () => stepOut(plan) }, 'Step out'),
        h('button', { type: 'button', class: 'btn small', onclick: () => { state.confirmOut = null; render(); } }, 'Stay')));
    } else {
      foot.append(h('button', { type: 'button', class: 'btn in', 'aria-label': commit.status === 'wait' ? "You're on the waitlist — tap to step out" : "You're in — tap to step out",
        onclick: () => { state.confirmOut = plan.id; render(); } }, commit.status === 'wait' ? 'On the waitlist ✓' : "You're in ✓"));
    }
  } else if (st.state === 'full') {
    foot.append(h('button', { type: 'button', class: 'btn', onclick: () => openIn(plan) }, 'Waitlist me'));
  } else {
    foot.append(h('button', { type: 'button', class: 'btn primary', onclick: () => openIn(plan) }, "I'm in"));
  }
  card.append(foot);
  return card;
}

function renderPlans(root) {
  root.append(deckCard());
  if (state.home === null || state.error) { if (!state.error) $('status').textContent = 'Loading…'; return; }
  const now = Date.now();
  const plans = plansView(state.home.plans, { nowMs: now });
  announce(plans.length ? plural(plans.length, 'plan') : 'No plans yet');
  const list = h('div', { class: 'list' });
  if (plans.length) for (const p of plans) list.append(planCard(p, now));
  else list.append(h('p', { class: 'quiet' }, 'No plans yet. Every plan starts as an idea that tipped — the deck is where that happens.'));
  root.append(list);
  const done = (state.home.plans || []).filter((p) => p.status === 'done')
    .sort((a, b) => Date.parse(b.starts_at || b.created_at) - Date.parse(a.starts_at || a.created_at)).slice(0, 3);
  if (done.length) {
    root.append(h('div', { class: 'group-head' }, 'Happened'));
    const dl = h('div', { class: 'list' });
    for (const p of done) dl.append(planCard(p, now));
    root.append(dl);
  }
  if (state.wantPlan) { const id = state.wantPlan; state.wantPlan = null; requestAnimationFrame(() => highlightPlan(id)); }
}

function highlightPlan(id) {
  const card = document.querySelector(`.card.plan[data-id="${CSS.escape(id)}"]`);
  if (!card) { toast("That one's gone."); return; }
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.remove('hi'); void card.offsetWidth; card.classList.add('hi');
}
function showPlan(id) {
  state.wantPlan = id;
  if (state.view !== 'plans') setView('plans'); else render();
}

// ---------------------------------------------------------------- wishes
function renderWishes(root) {
  if (state.error) {
    root.append(h('div', { class: 'empty' }, h('strong', {}, explain(state.error)),
      h('div', {}, h('button', { type: 'button', class: 'btn', onclick: load }, 'Try again'))));
    return;
  }
  if (state.home === null) { $('status').textContent = 'Loading…'; return; }
  const m = month();
  const all = ideasView(state.home.ideas, { month: m });
  const present = new Set(all.map((i) => i.category));
  if (state.category !== 'all' && !present.has(state.category)) state.category = 'all';
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Category' });
  const items = [{ id: 'all', label: 'All' }, ...CATEGORIES.filter((c) => present.has(c.id))];
  for (const it of items) {
    chips.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.category === it.id),
      onclick: () => { state.category = it.id; render(); } }, it.label));
  }
  if (items.length > 2) root.append(chips);
  const rows = ideasView(state.home.ideas, { month: m, category: state.category });
  announce(plural(rows.length, 'idea'));
  const list = h('div', { class: 'list' });
  if (!rows.length) list.append(h('div', { class: 'empty' }, h('strong', {}, 'Nothing here yet'), 'Suggest something and it may join the deck.'));
  for (const idea of rows) list.append(ideaCard(idea));
  root.append(list,
    h('div', { class: 'wish-foot' },
      h('button', { type: 'button', class: 'btn', id: 'open-suggest', onclick: openSuggest }, 'Suggest something'),
      h('span', { class: 'hint' }, 'Counts stay hidden until an idea tips, so every idea gets a fair look.')));
}

function ideaCard(idea) {
  const st = ideaStatus(idea);
  const tap = myTap(idea.id);
  const card = h('article', { class: 'card idea', dataset: { id: idea.id } },
    h('h3', { class: 't' }, idea.title),
    idea.blurb ? h('p', { class: 'b' }, idea.blurb) : null,
    h('div', { class: 'm' }, `${whenLabel(idea.when)} · ${categoryLabel(idea.category)}`),
  );
  const row = h('div', { class: 'row' });
  if (st.kind === 'claimed') {
    row.append(h('button', { type: 'button', class: 'pill claimed', onclick: () => (idea.plan_id ? showPlan(idea.plan_id) : setView('plans')) }, `${st.line} →`));
  } else if (st.kind === 'tipped') {
    row.append(h('span', { class: 'pill tipped' }, st.line));
  } else if (st.kind === 'exists') {
    row.append(h('span', { class: 'pill exists' }, 'Already a thing'));
  }
  row.append(h('span', { class: 'spacer' }));
  if (st.kind === 'exists') {
    if (idea.exists_url) row.append(h('a', { class: 'go', href: idea.exists_url, target: '_blank', rel: 'noopener' }, 'Go →'));
  } else if (st.kind !== 'claimed') {
    row.append(goControl(idea, tap));
  }
  card.append(row);
  if (st.kind === 'exists' && idea.exists_note) card.append(h('p', { class: 'note' }, idea.exists_note));
  return card;
}

// "I'd go" on an idea row. Untapped (or tapped maybe/pass): one button that
// says yes. Already yes: "You'd go ✓"; tapping that opens Pass / Maybe /
// I'd go so you can change your mind without hunting.
function goControl(idea, tap) {
  const yes = tap && tap.answer === 'yes';
  if (state.choosing === idea.id) {
    const cur = tap ? tap.answer : null;
    const opt = (a, label) => h('button', { type: 'button', 'aria-pressed': String(cur === a), onclick: () => tapIdea(idea, a) }, label);
    return h('span', { class: 'choice', role: 'group', 'aria-label': 'Change your answer' }, opt('pass', 'Pass'), opt('maybe', 'Maybe'), opt('yes', "I'd go"));
  }
  if (yes) return h('button', { type: 'button', class: 'btn small in', onclick: () => { state.choosing = idea.id; render(); } }, "You'd go ✓");
  return h('button', { type: 'button', class: 'btn small', onclick: () => tapIdea(idea, 'yes') }, "I'd go");
}

async function tapIdea(idea, answer) {
  state.choosing = null;
  // optimistic: reflect it locally, then tell the backend
  const taps = mine().taps;
  const t = taps.find((x) => x.idea_id === idea.id);
  if (t) { t.answer = answer; if (answer !== 'yes') t.top = false; } else taps.unshift({ idea_id: idea.id, answer, top: false });
  render();
  try {
    const r = await be.rpc('uf_tap', { p_token: token(), p_idea: idea.id, p_answer: answer });
    if (r && r.tipped && answer === 'yes' && !idea.tipped_at) toast(`That one just tipped — ${r.yes_count} would go.`);
    await load();
  } catch (err) { toast(explain(err)); await load(); }
}

// --------------------------------------------------------------- the deck
// One card at a time, three buttons, twelve dashes. Optimistic: the card
// leaves as soon as you tap; the RPC rides behind it.
const deck = { ideas: [], i: 0, answers: new Map(), stage: 'loading', err: null, top: new Set(), whens: new Set(), note: '', leaving: false, email: '' };
const deckYes = () => deck.ideas.filter((i) => deck.answers.get(i.id) === 'yes');

async function openDeck() {
  Object.assign(deck, { ideas: [], i: 0, answers: new Map(), stage: 'loading', err: null, top: new Set(), whens: new Set(mine().whens || []), note: '', leaving: false, email: mem.email || mine().email || '' });
  renderDeck();
  openSheet('sheet-deck');
  try {
    const ideas = await be.rpc('uf_deck', { p_token: token() });
    deck.ideas = deckOrder(ideas || [], token(), { month: month() });
    deck.stage = deck.ideas.length ? 'cards' : 'empty';
  } catch (err) { deck.stage = 'error'; deck.err = err; }
  renderDeck();
}

function deckHead() {
  return [
    h('div', { class: 'sheet-head' },
      h('h2', { id: 'deck-title' }, 'Up for it?'),
      h('button', { class: 'close', type: 'button', onclick: () => closeSheet('sheet-deck') }, 'Close')),
  ];
}

function renderDeck() {
  const inner = $('deck-inner'); clear(inner);
  inner.append(...deckHead());
  const n = deck.ideas.length;
  if (deck.stage === 'loading') { inner.append(h('div', { class: 'deck-center' }, h('p', {}, 'Shuffling…'))); return; }
  if (deck.stage === 'error') {
    inner.append(h('div', { class: 'deck-center' }, h('h3', {}, 'Not right now'), h('p', {}, explain(deck.err)),
      h('div', { class: 'pair' }, h('button', { type: 'button', class: 'btn', onclick: openDeck }, 'Try again'))));
    return;
  }
  if (deck.stage === 'empty') {
    const w = (state.home || EMPTY_HOME).weigh_in;
    inner.append(h('div', { class: 'deck-center' }, h('h3', {}, "You've seen them all"),
      h('p', {}, w ? `${plural(w, 'neighbor')} weighed in this week. Here's what's tipping.` : 'New ideas join the deck as Stephen adds them.'),
      h('div', { class: 'pair' }, h('button', { type: 'button', class: 'btn primary', onclick: () => { closeSheet('sheet-deck'); setView('wishes'); } }, "See what's tipping"))));
    return;
  }
  if (deck.stage === 'cards') {
    const idea = deck.ideas[deck.i];
    const dashes = h('div', { class: 'dashes', 'aria-hidden': 'true' });
    for (let k = 0; k < n; k++) dashes.append(h('i', { class: k < deck.i ? 'done' : '' }));
    inner.append(
      h('div', { class: 'deck-prog' }, dashes, h('span', { class: 'deck-count' }, `${deck.i + 1} of ${n}`)),
      h('p', { class: 'deck-note', 'aria-live': 'polite' }, deck.note),
      h('div', { class: 'deck-stage' },
        h('article', { class: 'dcard', id: 'dcard', dataset: { cat: idea.category } },
          h('div', { class: 'band' }, h('span', {}, categoryLabel(idea.category))),
          h('div', { class: 'body' },
            h('h3', { class: 'dtitle' }, idea.title),
            idea.blurb ? h('p', { class: 'dblurb' }, idea.blurb) : null,
            h('div', { class: 'dmeta' }, `${whenLabel(idea.when)} · ${categoryLabel(idea.category)}`)))),
      h('div', { class: 'answers', role: 'group', 'aria-label': 'Your answer' },
        h('button', { type: 'button', class: 'ans pass', onclick: () => answer('pass') }, 'Pass'),
        h('button', { type: 'button', class: 'ans maybe', onclick: () => answer('maybe') }, 'Maybe'),
        h('button', { type: 'button', class: 'ans yes', onclick: () => answer('yes') }, "I'd go")),
      h('p', { class: 'deck-keys' }, '← Pass · ↓ Maybe · → I\'d go'),
    );
    deck.note = '';
    return;
  }
  if (deck.stage === 'top') { inner.append(finishTop()); return; }
  if (deck.stage === 'finish') { inner.append(finishForm()); return; }
  if (deck.stage === 'thanks') {
    const w = (state.home || EMPTY_HOME).weigh_in;
    inner.append(h('div', { class: 'deck-center' }, h('h3', {}, 'Thanks.'),
      h('p', {}, w ? `${plural(w, 'neighbor')} ${w === 1 ? 'has' : 'have'} weighed in this week.` : "You're the first to weigh in this week."),
      h('div', { class: 'pair' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => { closeSheet('sheet-deck'); setView('wishes'); } }, "See what's tipping"),
        h('button', { type: 'button', class: 'btn', onclick: () => { closeSheet('sheet-deck'); setView('plans'); } }, 'Back to plans'))));
  }
}

function answer(a) {
  if (deck.stage !== 'cards' || deck.leaving) return;
  const idea = deck.ideas[deck.i];
  deck.leaving = true;
  deck.answers.set(idea.id, a);
  // keep the local "mine" in step so Wishes/Mine are right before the reload
  const taps = mine().taps;
  const t = taps.find((x) => x.idea_id === idea.id);
  if (t) t.answer = a; else taps.unshift({ idea_id: idea.id, answer: a, top: false });
  be.rpc('uf_tap', { p_token: token(), p_idea: idea.id, p_answer: a })
    .then((r) => { if (r && r.tipped && a === 'yes' && !idea.tipped_at) { deck.note = `That one just tipped — ${r.yes_count} would go.`; const el = $('deck-inner').querySelector('.deck-note'); if (el) el.textContent = deck.note; } })
    .catch((err) => toast(explain(err)));
  const card = $('dcard');
  if (card) card.classList.add(`out-${a}`);
  setTimeout(() => {
    deck.leaving = false;
    deck.i += 1;
    if (deck.i >= deck.ideas.length) deck.stage = deckYes().length ? 'top' : 'finish';
    renderDeck();
  }, 190);
}

// Step "Your three": the yes pile, pick up to three you'd actually show up to.
function finishTop() {
  const yes = deckYes();
  const box = h('div', { class: 'fin' });
  const list = h('div', { class: 'picks', role: 'group', 'aria-label': 'Your three' });
  const renderList = () => {
    clear(list);
    for (const idea of yes) {
      const on = deck.top.has(idea.id);
      list.append(h('button', { type: 'button', class: 'pick', 'aria-pressed': String(on), disabled: !on && deck.top.size >= TOP_PICKS,
        onclick: () => { on ? deck.top.delete(idea.id) : deck.top.add(idea.id); renderList(); } },
        h('span', { class: 'chk', 'aria-hidden': 'true' }, on ? '✓' : ''),
        h('div', {}, h('div', { class: 'pt' }, idea.title), h('div', { class: 'pm' }, `${whenLabel(idea.when)} · ${categoryLabel(idea.category)}`))));
    }
  };
  renderList();
  box.append(
    h('h3', {}, 'Your three'),
    h('p', { class: 'sub' }, `Pick up to three you'd actually show up to. Hosts weigh these most.`),
    list,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'link', onclick: () => finish({ skip: true }) }, 'Skip'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => { deck.stage = 'finish'; renderDeck(); } }, 'Next')),
  );
  return box;
}

// Step "when you're free + how to reach you".
function finishForm() {
  const form = h('form', { class: 'fin', novalidate: true, onsubmit: (e) => { e.preventDefault(); finish({ form }); } });
  form.append(
    h('h3', {}, 'One more thing'),
    h('p', { class: 'sub' }, "So a host can pick a time that works, and tell you when one of yours gets picked up."),
    optField({ label: 'When are you usually free?', name: 'whens', options: WHENS, value: deck.whens, multi: true }),
    textField({ label: 'Email (optional)', name: 'email', value: deck.email, type: 'email', placeholder: 'you@example.com', max: LIMITS.email, autocomplete: 'email', inputmode: 'email',
      hint: "We'll tell you when a host picks one of yours up — nothing else." }),
    h('div', { class: 'form-err', id: 'finish-err' }),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'link', onclick: () => finish({ form, skip: true }) }, 'Skip'),
      h('button', { class: 'btn primary', type: 'submit', id: 'finish-done' }, 'Done')),
  );
  return form;
}

async function finish({ form = null, skip = false } = {}) {
  const email = form ? new FormData(form).get('email') : deck.email;
  const v = validateFinish({ top: [...deck.top], email, whens: [...deck.whens] });
  if (!v.ok && !skip && form) { showErrors(form, v.errors); return; }
  const payload = v.ok ? v.value : { top: [...deck.top], email: '', whens: [...deck.whens] }; // skip with a bad email: drop the email, keep the rest
  const btn = $('finish-done'); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await be.rpc('uf_finish', { p_token: token(), p_finish: payload });
    if (payload.email) remember(null, payload.email);
    await load();
    deck.stage = 'thanks';
    renderDeck();
  } catch (err) {
    const e = $('finish-err'); if (e) e.textContent = explain(err); else toast(explain(err));
    if (btn) { btn.disabled = false; btn.textContent = 'Done'; }
  }
}

// keyboard: ← Pass, ↓ Maybe, → I'd go (Esc closes the dialog natively)
document.addEventListener('keydown', (e) => {
  if (!$('sheet-deck').open || deck.stage !== 'cards') return;
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const map = { ArrowLeft: 'pass', ArrowDown: 'maybe', ArrowRight: 'yes' };
  if (map[e.key]) { e.preventDefault(); answer(map[e.key]); }
});
$('sheet-deck').addEventListener('close', () => { if (deck.answers.size) load(); });

// ------------------------------------------------------------ "I'm in"
function openIn(plan) {
  const inner = $('in-inner'); clear(inner);
  const st = planState(plan, Date.now());
  const wait = st.state === 'full';
  const when = plan.starts_at ? formatWhen(plan.starts_at) : 'Needs a date';
  const form = h('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('p', { class: 'sheet-sub' }, h('strong', {}, plan.title), ` — ${when} · ${plan.place}${plan.host_name ? ` · hosted by ${plan.host_name}` : ''}`),
    plan.detail ? h('p', { class: 'sheet-sub' }, plan.detail) : null,
    wait ? h('p', { class: 'sheet-sub' }, "It's full right now. Join the waitlist and you move up if someone steps out.") : null,
    textField({ label: 'First name', name: 'name', value: mem.name, placeholder: 'First name', max: LIMITS.name, autocomplete: 'given-name' }),
    textField({ label: 'Email', name: 'email', value: mem.email, type: 'email', placeholder: 'you@example.com', max: LIMITS.email, autocomplete: 'email', inputmode: 'email',
      hint: "Only the host sees your first name. Your email is how we tell you it's on — and remind you the day before." }),
    h('div', { class: 'actions' },
      h('div', { class: 'form-err', id: 'in-err' }),
      h('button', { class: 'btn primary', type: 'submit', id: 'in-submit' }, wait ? 'Waitlist me' : "I'm in")));
  inner.append(...sheetHead('in-title', wait ? 'Waitlist me' : "I'm in", 'sheet-in'), form);

  async function submit() {
    const fd = new FormData(form);
    const v = validateCommit({ name: fd.get('name'), email: fd.get('email') });
    showErrors(form, v.errors);
    $('in-err').textContent = '';
    if (!v.ok) return;
    const btn = $('in-submit'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await be.rpc('uf_commit', { p_plan: plan.id, p_token: token(), p_commit: v.value });
      remember(v.value.name, v.value.email);
      closeSheet('sheet-in');
      if (r && r.status === 'wait') toast("You're on the waitlist.");
      else if ((r && r.on) || plan.status === 'on') toast("You're in — it's on.");
      else toast("You're in. We'll email you when it's on.");
      if (r && r.on) notify('on', plan.id); // announces once, then welcomes anyone who joined after
      await load();
    } catch (err) {
      $('in-err').textContent = explain(err);
      btn.disabled = false; btn.textContent = wait ? 'Waitlist me' : "I'm in";
    }
  }
  openSheet('sheet-in');
}

async function stepOut(plan) {
  state.confirmOut = null;
  try {
    await be.rpc('uf_uncommit', { p_plan: plan.id, p_token: token() });
    toast("Stepped out. Thanks for saying so.");
    await load();
  } catch (err) { toast(explain(err)); render(); }
}

// ---------------------------------------------------------------- suggest
function openSuggest() {
  const inner = $('suggest-inner'); clear(inner);
  const draft = { when: { v: null } };
  const form = h('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } });
  form.append(
    h('p', { class: 'sheet-sub' }, 'An activity, a rough when, a place-type — something a host could actually run. Stephen reads every one.'),
    textField({ label: "What would you go to?", name: 'title', placeholder: 'e.g. Morning swim at Oakledge, then coffee', max: LIMITS.suggestTitle }),
    optField({ label: 'Roughly when?', name: 'when', options: WHEN_HINTS, value: draft.when }),
    textField({ label: 'Anything else (optional)', name: 'note', placeholder: 'Where, cost, what to bring', max: LIMITS.suggestNote, hint: `${LIMITS.suggestNote} characters. No links.` }),
    textField({ label: 'Email (optional)', name: 'email', value: mem.email, type: 'email', placeholder: 'you@example.com', max: LIMITS.email, autocomplete: 'email', inputmode: 'email',
      hint: "So we can tell you if it joins the deck." }),
    h('div', { class: 'actions' },
      h('div', { class: 'form-err', id: 'suggest-err' }),
      h('button', { class: 'btn primary', type: 'submit', id: 'suggest-submit' }, 'Suggest it')),
  );
  inner.append(...sheetHead('suggest-title', 'Suggest something', 'sheet-suggest'), form);

  async function submit() {
    const fd = new FormData(form);
    const v = validateSuggestion({ title: fd.get('title'), when: draft.when.v, note: fd.get('note'), email: fd.get('email') });
    showErrors(form, v.errors);
    $('suggest-err').textContent = '';
    if (!v.ok) return;
    const btn = $('suggest-submit'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await be.rpc('uf_suggest', { p_token: token(), p_suggestion: v.value });
      if (v.value.email) remember(null, v.value.email);
      closeSheet('sheet-suggest');
      toast("Got it — Stephen reads these. If it's a fit, it joins the deck.", 3400);
    } catch (err) {
      $('suggest-err').textContent = explain(err);
      btn.disabled = false; btn.textContent = 'Suggest it';
    }
  }
  openSheet('sheet-suggest');
}

// ------------------------------------------------------------------- mine
async function openMine() {
  const inner = $('mine-inner'); clear(inner);
  inner.append(...sheetHead('mine-title', 'Mine', 'sheet-mine', 'Done'), h('p', { class: 'status' }, 'Looking…'));
  openSheet('sheet-mine');
  let me;
  try { me = await be.rpc('uf_mine', { p_token: token() }); }
  catch (err) { inner.lastChild.textContent = explain(err); return; }
  if (state.home) state.home.mine = me;
  clear(inner);
  inner.append(...sheetHead('mine-title', 'Mine', 'sheet-mine', 'Done'));
  const now = Date.now();
  const plans = (state.home || EMPTY_HOME).plans;
  const ideas = (state.home || EMPTY_HOME).ideas;
  const planOf = (id) => plans.find((p) => p.id === id) || null;
  const ideaOf = (id) => ideas.find((i) => i.id === id) || null;

  // You're in
  const inRows = me.commits.map((c) => ({ c, p: planOf(c.plan_id) })).filter((x) => x.p && ['tipping', 'on'].includes(x.p.status));
  const sec1 = h('div', { class: 'mine-section' }, h('h3', {}, "You're in"));
  if (!inRows.length) sec1.append(h('p', { class: 'quiet', style: 'text-align:left;padding:0' }, "Nothing yet. Say \"I'm in\" on a plan and it shows up here."));
  for (const { c, p } of inRows) {
    const st = planState(p, now);
    sec1.append(h('div', { class: 'mine-row' },
      h('div', {}, h('div', { class: 'mt' }, p.title), h('div', { class: 'ms' }, `${c.status === 'wait' ? 'Waitlist · ' : ''}${st.line}`)),
      h('div', { class: 'mr' }, h('button', { type: 'button', class: 'btn danger', onclick: async () => { await stepOut(p); openMine(); } }, 'Step out'))));
  }
  inner.append(sec1);

  // You'd go
  const yes = me.taps.filter((t) => t.answer === 'yes').map((t) => ({ t, i: ideaOf(t.idea_id) })).filter((x) => x.i);
  const sec2 = h('div', { class: 'mine-section' }, h('h3', {}, "You'd go"));
  if (!yes.length) sec2.append(h('p', { class: 'quiet', style: 'text-align:left;padding:0' }, 'Nothing yet. The deck is twelve quick taps.'));
  for (const { t, i } of yes) {
    const st = ideaStatus(i);
    const right = st.kind === 'claimed'
      ? h('button', { type: 'button', class: 'pill claimed', onclick: () => { closeSheet('sheet-mine'); i.plan_id ? showPlan(i.plan_id) : setView('plans'); } }, 'See the plan →')
      : null;
    sec2.append(h('div', { class: 'mine-row' },
      h('div', {}, h('div', { class: 'mt' }, i.title), h('div', { class: 'ms' }, `${t.top ? 'One of your three · ' : ''}${st.kind === 'open' ? `Not tipped yet · ${whenLabel(i.when)}` : st.line}`)),
      right ? h('div', { class: 'mr' }, right) : null));
  }
  inner.append(sec2);

  // email + whens
  const whens = new Set(me.whens || []);
  const form = h('form', { novalidate: true, class: 'mine-section', onsubmit: (e) => { e.preventDefault(); save(); } });
  form.append(
    h('h3', {}, 'Your email / when you\'re free'),
    optField({ label: 'When are you usually free?', name: 'whens', options: WHENS, value: whens, multi: true }),
    textField({ label: 'Email', name: 'email', value: me.email || mem.email, type: 'email', placeholder: 'you@example.com', max: LIMITS.email, autocomplete: 'email', inputmode: 'email',
      hint: "One email when a host picks up one of yours; one when a plan you're in is on; one the day before." }),
    h('div', { class: 'actions' }, h('div', { class: 'form-err', id: 'mine-err' }), h('button', { class: 'btn primary', type: 'submit', id: 'mine-save' }, 'Save')),
  );
  inner.append(form, h('p', { class: 'sheet-foot' }, 'This browser is your only identity — no account, no password. Clear it and you start fresh.'));

  async function save() {
    const fd = new FormData(form);
    const top = me.taps.filter((t) => t.top).map((t) => t.idea_id);
    const v = validateFinish({ top, email: fd.get('email'), whens: [...whens] });
    showErrors(form, v.errors); $('mine-err').textContent = '';
    if (!v.ok) return;
    const btn = $('mine-save'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await be.rpc('uf_finish', { p_token: token(), p_finish: v.value });
      if (v.value.email) remember(null, v.value.email);
      toast('Saved.');
      btn.disabled = false; btn.textContent = 'Save';
      await load();
    } catch (err) { $('mine-err').textContent = explain(err); btn.disabled = false; btn.textContent = 'Save'; }
  }
}

// ------------------------------------------------------------------- data
let loading = null;
function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      state.home = await be.rpc('uf_home', { p_token: token() });
      state.error = null;
    } catch (err) {
      state.error = err;
      if (!state.home) state.home = { ...EMPTY_HOME };
    }
    loading = null;
    render();
  })();
  return loading;
}

// --------------------------------------------------------------- masthead
{
  const m = mastheadFor(month());
  const img = $('mast-img');
  img.src = m.src; img.alt = m.alt; img.style.objectPosition = m.focus;
  $('mast').dataset.season = m.id;
}

// ------------------------------------------------------------------- wire
for (const b of document.querySelectorAll('.seg button')) b.addEventListener('click', () => setView(b.dataset.view));
$('open-mine').addEventListener('click', openMine);
$('open-how').addEventListener('click', (e) => { e.preventDefault(); openSheet('sheet-how'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !document.querySelector('dialog[open]')) load(); });

if (state.wantPlan) state.view = 'plans';
setView(state.view);
load().then(() => { if (params.get('deck') === '1' && !state.error) openDeck(); });
