// COME ALONG — the create page (go/new.html). Three screens, one at a time:
// 1. which event (search the guide's calendar; upcoming only)
// 2. the meeting plan (place, time, one line, who to look for, cap)
// 3. the link (copy it, plus the edit link and the paste-ready announcement)
// Creating needs an Up For It host key. host.html already remembers it on
// this device (same origin), so most hosts never see the gate.
import { h, $, clear, toast, copyText, setFieldErrors } from './desk.js';
import { backend, loadFeed, isDemo, savedHostKey, explain, DEMO_HOST_KEY } from './along-net.js';
import {
  pickEvents, planFromEvent, validatePlan, defaultMeetAt, formatWhen, msToWall, wallToMs,
  linkFor, editLinkFor, announceText, LIMITS, MEET_BEFORE_MIN, DEFAULT_INVITE,
} from './along-core.js';

const params = new URLSearchParams(location.search);
const be = backend();
const state = { step: 1, key: '', events: [], feedSource: '', query: '', event: null, result: null };
const steps = () => { for (const [i, el] of [...$('steps').children].entries()) el.classList.toggle('on', i < state.step); };
function say(msg, bad = false) { const s = $('status'); s.textContent = msg || ''; s.classList.toggle('bad', Boolean(bad)); }

async function start() {
  state.key = isDemo() ? DEMO_HOST_KEY : (params.get('key') || savedHostKey.get());
  if (!state.key) { gate(); return; }
  say(isDemo() ? 'Demo — pick a real event, get a sample link; nothing is saved past this tab.' : 'Loading the calendar…');
  const feed = await loadFeed({ live: !globalThis.__ALONG_OFFLINE__ });
  state.events = feed.events; state.feedSource = feed.source;
  say(isDemo() ? 'Demo — pick a real event, get a sample link; nothing is saved past this tab.' : (feed.source === 'live' ? '' : feed.source === 'snapshot' ? "Couldn't reach the live calendar; showing a recent copy." : "Couldn't load the calendar. Try again in a minute."));
  renderPick();
}

// ------------------------------------------------------------------ gate
function gate() {
  state.step = 1; steps();
  const input = h('input', { class: 'input', id: 'key', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: '32 letters and numbers', maxlength: '40' });
  const err = h('p', { class: 'form-err', id: 'gate-err', role: 'alert' });
  clear($('stage')).append(h('section', { class: 'card gate' },
    h('h2', {}, 'Hosts only'),
    h('p', {}, 'Paste the host key Stephen sent you. Opening the ', h('a', { href: '../host.html' }, 'host desk'), ' on this phone once remembers it for here too.'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const k = input.value.trim().toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(k)) { err.textContent = 'A key is 32 letters and numbers.'; return; }
      savedHostKey.set(k); state.key = k; err.textContent = '';
      start();
    } }, h('div', { class: 'field' }, h('label', { class: 'label', for: 'key' }, 'Host key'), input), err,
      h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn primary' }, 'Continue')))));
}

// ---------------------------------------------------------------- 1. pick
function renderPick() {
  state.step = 1; steps();
  const now = Date.now();
  const list = h('ul', { class: 'picks', id: 'picks' });
  const search = h('input', { class: 'input', id: 'q', type: 'search', placeholder: 'Search the calendar: trivia, Pride, bird walk…', value: state.query, autocomplete: 'off' });
  const fill = () => {
    clear(list);
    const picks = pickEvents(state.events, { query: search.value, nowMs: now, limit: 12 });
    if (!picks.length) { list.append(h('li', { class: 'meta' }, state.events.length ? 'Nothing upcoming matches. Try one word.' : 'The calendar is empty right now.')); return; }
    for (const e of picks) {
      const [day, time] = formatWhen(e.start).split(' · ');
      list.append(h('li', {}, h('button', { type: 'button', class: 'pick', onclick: () => choose(e) },
        h('span', { class: 'd' }, h('b', {}, day), time),
        h('span', { class: 't' }, h('b', {}, e.title), h('span', {}, [e.venue, e.town && e.town !== 'Burlington' ? e.town : null].filter(Boolean).join(' · ') || ' ', e.free === true ? h('span', { class: 'free' }, ' · Free') : e.price ? ` · ${e.price}` : '')))));
    }
  };
  search.addEventListener('input', () => { state.query = search.value; fill(); });
  clear($('stage')).append(h('section', { class: 'card' },
    h('h2', {}, 'Which event?'),
    h('p', { class: 'meta' }, "Anything already on the guide's calendar. You're not running it; you're the reason people won't walk in alone."),
    h('div', { class: 'search' }, search), list));
  fill();
}

// ---------------------------------------------------------------- 2. plan
function choose(e) { state.event = e; renderPlan(planFromEvent(e)); }
function field(name, label, input, hint) { return h('div', { class: 'field', dataset: { field: name } }, h('label', { class: 'label' }, label), input, hint ? h('div', { class: 'hint' }, hint) : null, h('div', { class: 'err' })); }
function renderPlan(draft) {
  state.step = 2; steps();
  const e = state.event;
  const form = h('form', { id: 'plan-form', novalidate: true },
    field('meet_place', 'Where exactly will people find you?', h('input', { class: 'input', name: 'meet_place', maxlength: String(LIMITS.meetPlace), value: draft.meet_place, placeholder: 'Outside the front door, by the ticket table…' })),
    field('meet_at', 'Meet time (Burlington time)', h('input', { class: 'input', name: 'meet_at', type: 'datetime-local', value: msToWall(draft.meet_at) }), `${MEET_BEFORE_MIN} minutes before is the default; people need a face before they need a seat.`),
    field('invite', 'The one line', h('input', { class: 'input', name: 'invite', maxlength: String(LIMITS.invite), value: draft.invite }), `Default: “${DEFAULT_INVITE}”`),
    field('look_for', 'Who to look for (optional)', h('input', { class: 'input', name: 'look_for', maxlength: String(LIMITS.lookFor), value: draft.look_for, placeholder: 'Stephen, tall, brown jacket' })),
    field('cap', 'Cap (optional, 0 = none)', h('input', { class: 'input', name: 'cap', type: 'number', inputmode: 'numeric', min: '0', max: String(LIMITS.cap), value: String(draft.cap) }), 'Only if the venue or the table has a real limit.'),
    h('p', { class: 'form-err', id: 'plan-err', role: 'alert' }),
    h('div', { class: 'actions between' },
      h('button', { type: 'button', class: 'btn quiet', onclick: renderPick }, '← Different event'),
      h('button', { type: 'submit', class: 'btn primary', id: 'make' }, 'Make the link')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const input = { ...draft, meet_place: fd.get('meet_place'), invite: fd.get('invite'), look_for: fd.get('look_for'), cap: fd.get('cap') };
    const ms = wallToMs(String(fd.get('meet_at') || ''));
    input.meet_at = Number.isNaN(ms) ? '' : new Date(ms).toISOString();
    const v = validatePlan(input);
    setFieldErrors(form, v.errors);
    if (!v.ok) { $('plan-err').textContent = 'Check the highlighted fields.'; return; }
    $('make').disabled = true;
    try {
      state.result = await be.rpc('ca_create', { p_key: state.key, p_plan: v.value });
      renderLink();
    } catch (err) {
      $('plan-err').textContent = explain(err); $('make').disabled = false;
      if (err.code === 'bad_key') { savedHostKey.set(''); }
    }
  });
  clear($('stage')).append(h('section', { class: 'card' },
    h('div', { class: 'chosen' }, h('div', {}, h('h3', {}, 'Going to'), h('h2', {}, e.title), h('p', { class: 'meta' }, `${formatWhen(e.start)}${e.venue ? ' · ' + e.venue : ''}`))),
    form));
}

// ---------------------------------------------------------------- 3. link
function renderLink() {
  state.step = 3; steps();
  const { code, edit_key, plan } = state.result;
  const link = linkFor(code); const edit = editLinkFor(code, edit_key);
  const copyBtn = (text, label) => h('button', { type: 'button', class: 'btn small', onclick: async () => toast((await copyText(text)) ? 'Copied' : 'Select it and copy') }, label);
  clear($('stage')).append(h('section', { class: 'card' },
    h('h2', {}, 'Here\'s your link'),
    h('p', { class: 'meta' }, 'Put it in the edition, the Telegram, the Meetup description. Anyone who taps it sees the plan and can say they\'re coming, first name only.'),
    h('div', { class: 'linkbox' }, h('div', { class: 'k', id: 'link' }, link)),
    h('div', { class: 'actions' }, copyBtn(link, 'Copy link'), h('a', { class: 'btn primary small', href: `./?c=${code}${isDemo() ? '&demo=1' : ''}`, id: 'open' }, 'Open it'), copyBtn(announceText(plan, { link }), 'Copy the announcement')),
    h('h3', { style: 'margin-top:18px' }, 'Paste-ready'),
    h('pre', { class: 'paste', id: 'announce' }, announceText(plan, { link })),
    h('h3', { style: 'margin-top:18px' }, 'Your edit link (keep it private)'),
    h('p', { class: 'meta' }, 'Change the meet time or place, or call it off. This is the only copy; it isn\'t stored anywhere we can read.'),
    h('div', { class: 'linkbox' }, h('div', { class: 'small', id: 'edit-link' }, edit)),
    h('div', { class: 'actions' }, copyBtn(edit, 'Copy edit link'), h('a', { class: 'btn small', href: `./?c=${code}&edit=${edit_key}${isDemo() ? '&demo=1' : ''}` }, 'Open the edit page')),
    h('div', { class: 'actions', style: 'margin-top:22px' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => { state.event = null; state.result = null; renderPick(); } }, 'Make another'))));
}

start();
