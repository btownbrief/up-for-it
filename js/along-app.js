// COME ALONG — the join page (go/?c=CODE). Renders one plan: the event, the
// meeting plan, who's coming, "I'm coming" / "Can't make it anymore",
// add-to-calendar, and where changes appear. With ?edit=KEY the host sees
// the edit form and the call-it-off button in place. DOM via h() and
// textContent only — never innerHTML with anything that came from a person.
import { h, $, clear, toast, inlineConfirm, copyText, setFieldErrors } from './desk.js';
import { backend, token, isDemo, savedName, explain, NetError } from './along-net.js';
import {
  normalizeCode, validCode, validEditKey, planState, isOpen, isFull, meetOffset, formatWhen, msToWall, wallToMs,
  icsFor, gcalUrl, shareText, linkFor, nextGathering, TELEGRAM_URL, PATCHABLE, validatePatch, LIMITS,
} from './along-core.js';

const params = new URLSearchParams(location.search);
const code = normalizeCode(params.get('c'));
const editKey = params.get('edit') || '';
const be = backend();
const state = { plan: null, askingName: false, editing: false };
const link = () => linkFor(code);

function dl(name, text) {
  const blob = new Blob([text], { type: 'text/calendar' });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
}

// the status line under the header; bad = red
function say(msg, bad = false) { const s = $('status'); s.textContent = msg || ''; s.classList.toggle('bad', Boolean(bad)); }

async function load() {
  if (!validCode(code)) {
    say('');
    clear($('plan')).append(h('section', { class: 'card quiet' },
      h('h2', {}, 'Which one?'),
      h('p', { class: 'meta' }, 'A come-along link looks like go/?c=ABC234. Ask whoever sent you here, or ', h('a', { href: 'new.html' }, 'host one'), '.')));
    return;
  }
  try {
    state.plan = await be.rpc('ca_get', { p_code: code, p_token: token() });
    say(isDemo() ? 'Demo — built from a real event; nothing is saved past this tab.' : '');
    render();
  } catch (e) {
    say(explain(e), true);
    const root = clear($('plan'));
    if (e instanceof NetError && e.code === 'not_ready') {
      root.append(h('section', { class: 'card quiet' }, h('p', { class: 'meta' }, "Come along isn't switched on yet. The event itself is probably in the ", h('a', { href: 'https://guide.btownbrief.com/events.html' }, 'guide calendar'), '.')));
    } else if (e instanceof NetError && (e.code === 'not_found' || e.code === 'bad_code')) {
      root.append(h('section', { class: 'card quiet' }, h('h2', {}, 'Nothing here'),
        h('p', { class: 'meta' }, 'Either the link is off by a letter or this one is more than a month gone. Ask whoever sent it, or ', h('a', { href: 'new.html' }, 'host one'), '.')));
    } else {
      root.append(h('section', { class: 'card quiet' }, h('p', { class: 'meta' }, explain(e))));
    }
  }
}

function render() {
  const p = state.plan; const now = Date.now();
  const st = planState(p, now);
  document.title = `Btown at ${p.event_title} — Come along`;
  $('h1').textContent = p.event_title;
  $('sub').textContent = `${p.host_name} is taking a group. ${st.key === 'happened' ? 'This one already happened.' : 'Come along.'}`;
  const root = clear($('plan'));

  // 1. the event
  const ev = h('section', { class: 'card' },
    h('span', { class: `ribbon ${st.key}` }, st.line),
    h('h3', {}, 'The event'),
    h('p', { class: 'big' }, h('b', {}, formatWhen(p.event_start)), p.event_end ? ` to ${formatWhen(p.event_end).split(' · ')[1]}` : ''),
    h('p', { class: 'meta' }, [p.event_venue, p.event_address && !p.event_address.startsWith(p.event_venue) ? p.event_address : null].filter(Boolean).join(' · ') || 'Venue on the event page'),
    p.event_url ? h('p', { class: 'meta' }, h('a', { href: p.event_url, target: '_blank', rel: 'noopener' }, 'Event details ↗')) : null);
  root.append(ev);

  // 2. the plan
  const plan = h('section', { class: 'card' },
    h('h3', {}, 'The plan'),
    h('p', { class: 'big' }, 'Meet at ', h('b', {}, p.meet_place)),
    h('p', { class: 'meta' }, `${formatWhen(p.meet_at)} — ${meetOffset(p)}. Then we go in together.`),
    h('p', { class: 'invite' }, p.invite),
    p.look_for ? h('p', { class: 'lookfor' }, 'Look for: ', p.look_for) : null,
    h('div', { class: 'cal' },
      h('a', { href: gcalUrl(p, { link: link() }), target: '_blank', rel: 'noopener' }, '+ Google Calendar'),
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); dl(`btown-${code}.ics`, icsFor(p, { link: link() })); } }, '+ Apple / .ics'),
      h('a', { href: '#', onclick: async (e) => { e.preventDefault(); if (navigator.share) { try { await navigator.share({ title: `Btown at ${p.event_title}`, text: shareText(p, { link: link() }), url: link() }); return; } catch (err) { if (err && err.name === 'AbortError') return; } } toast((await copyText(link())) ? 'Link copied' : link()); } }, 'Share')),
    h('p', { class: 'changes' }, 'If the plan changes it shows here first, and in the ', h('a', { href: TELEGRAM_URL, target: '_blank', rel: 'noopener' }, 'Btown Telegram'), '.'));
  root.append(plan);

  // 3. who's coming + the button
  const who = h('section', { class: 'card' }, h('h3', {}, st.key === 'happened' ? 'Who came along' : "Who's coming"));
  if (p.going.length) {
    // names come back in join order without tokens (privacy); yours is
    // recognised by the name this device saved, first match only
    const ul = h('ul', { class: 'names' });
    let marked = false;
    for (const n of p.going) {
      const you = p.you && !marked && n === savedName.get();
      if (you) marked = true;
      ul.append(h('li', { class: you ? 'you' : '' }, n));
    }
    who.append(ul, h('p', { class: 'count' }, `${p.going_count} coming${p.cap ? ` · cap ${p.cap}` : ''}${p.host_name ? ` · plus ${p.host_name}` : ''}`));
  } else {
    who.append(h('p', { class: 'meta' }, st.key === 'happened' ? 'Nobody said so here. Some just showed up.' : `Nobody yet besides ${p.host_name}. Be the first name here.`));
  }
  const slot = h('div', { class: 'actions' });
  if (isOpen(p, now)) {
    if (p.you) {
      slot.append(h('span', { class: 'meta' }, "You're coming ✓"),
        h('button', { type: 'button', class: 'btn danger', onclick: () => leave() }, "Can't make it anymore"));
    } else if (isFull(p)) {
      slot.append(h('span', { class: 'meta' }, "It's full. Come anyway if you like; you just won't be on the list."));
    } else if (state.askingName) {
      const input = h('input', { class: 'input', id: 'name', type: 'text', maxlength: String(LIMITS.name), placeholder: 'First name', value: savedName.get(), autocomplete: 'given-name', 'aria-label': 'First name' });
      const go = () => join(input.value);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      slot.append(h('div', { class: 'inline-name', style: 'width:100%' }, input, h('button', { type: 'button', class: 'btn primary', id: 'join', onclick: go }, "I'm coming")));
      setTimeout(() => input.focus(), 0);
    } else {
      slot.append(h('button', { type: 'button', class: 'btn primary big', id: 'im-coming', onclick: () => { if (savedName.get()) join(savedName.get()); else { state.askingName = true; render(); } } }, "I'm coming"));
    }
  } else if (st.key === 'happened') {
    const ng = nextGathering(now);
    slot.append(h('p', { class: 'meta' }, 'Missed it? The next Btown gathering is ', ng ? h('a', { href: ng.url, target: '_blank', rel: 'noopener' }, ng.title) : 'on the Meetup', '.'));
  } else if (st.key === 'cancelled') {
    slot.append(h('p', { class: 'meta' }, `${p.host_name} called this one off. The event itself may still be on; check the link above.`));
  }
  who.append(slot, h('p', { class: 'form-err', id: 'join-err', role: 'alert' }));
  root.append(who);

  // 4. host controls (?edit=KEY)
  if (validEditKey(editKey)) root.append(editCard(p));
}

async function join(name) {
  const err = $('join-err');
  try {
    state.plan = await be.rpc('ca_join', { p_code: code, p_token: token(), p_name: name });
    savedName.set(state.plan.going.includes(name.trim()) ? name.trim() : name);
    state.askingName = false;
    render();
    toast("You're on the list. See you there.");
  } catch (e) {
    if (err) err.textContent = explain(e);
    if (e.code === 'bad_name') { state.askingName = true; render(); const j = $('join-err'); if (j) j.textContent = explain(e); }
  }
}
async function leave() {
  try { state.plan = await be.rpc('ca_leave', { p_code: code, p_token: token() }); render(); toast('Taken off the list.'); }
  catch (e) { const err = $('join-err'); if (err) err.textContent = explain(e); }
}

// ------------------------------------------------------------- host edit
function editCard(p) {
  const wall = (iso) => msToWall(iso);
  const card = h('section', { class: 'card quiet' }, h('h3', {}, 'You made this one'),
    h('p', { class: 'meta' }, 'Keep this link private; it edits the plan. Changing the meet time or place updates everyone\'s page.'));
  if (p.status === 'cancelled') { card.append(h('p', { class: 'meta' }, 'Called off.')); return card; }
  const form = h('form', { id: 'edit-form', novalidate: true },
    field('meet_place', 'Meeting point', h('input', { class: 'input', name: 'meet_place', maxlength: String(LIMITS.meetPlace), value: p.meet_place })),
    field('meet_at', 'Meet time (Burlington time)', h('input', { class: 'input', name: 'meet_at', type: 'datetime-local', value: wall(p.meet_at) })),
    field('invite', 'The one line', h('input', { class: 'input', name: 'invite', maxlength: String(LIMITS.invite), value: p.invite })),
    field('look_for', 'Who to look for (optional)', h('input', { class: 'input', name: 'look_for', maxlength: String(LIMITS.lookFor), value: p.look_for, placeholder: 'e.g. Stephen, tall, brown jacket' })),
    field('cap', 'Cap (0 = none)', h('input', { class: 'input', name: 'cap', type: 'number', inputmode: 'numeric', min: '0', max: String(LIMITS.cap), value: String(p.cap) })),
    h('p', { class: 'form-err', id: 'edit-err', role: 'alert' }),
    h('div', { class: 'actions between' },
      h('button', { type: 'submit', class: 'btn primary', id: 'save' }, 'Save changes'),
      h('button', { type: 'button', class: 'btn danger', id: 'cancel-plan', onclick: () => inlineConfirm($('confirm'), { text: 'Call it off? Everyone on the list sees it here.', yes: 'Yes, call it off', onYes: cancelPlan }) }, 'Call it off')),
    h('div', { id: 'confirm', hidden: true }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const patch = {};
    for (const k of PATCHABLE) patch[k] = fd.get(k);
    if (patch.meet_at) { const ms = wallToMs(String(patch.meet_at)); patch.meet_at = Number.isNaN(ms) ? '' : new Date(ms).toISOString(); }
    const v = validatePatch(p, patch);
    setFieldErrors(form, v.errors);
    if (!v.ok) { $('edit-err').textContent = 'Check the highlighted fields.'; return; }
    try { state.plan = await be.rpc('ca_edit', { p_code: code, p_edit: editKey, p_patch: v.value }); render(); toast('Saved. Everyone sees the new plan.'); }
    catch (err) { $('edit-err').textContent = explain(err); }
  });
  card.append(form);
  return card;
}
function field(name, label, input) { return h('div', { class: 'field', dataset: { field: name } }, h('label', { class: 'label' }, label), input, h('div', { class: 'err' })); }
async function cancelPlan() {
  try { state.plan = await be.rpc('ca_cancel', { p_code: code, p_edit: editKey }); render(); toast('Called off.'); }
  catch (err) { $('edit-err').textContent = explain(err); throw err; }
}

load();
