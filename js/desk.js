// UP FOR IT — small DOM helpers shared by the two desks (host.html and
// mod.html). No data logic lives here; that is core.js and net.js. Every
// piece of text goes in through textContent (h() appends strings as text
// nodes), never innerHTML, so a title like "<b>hi</b>" stays literal.

// h('div', { class: 'x', onclick: fn, disabled: true }, 'text', child, [kids])
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

export const $ = (id) => document.getElementById(id);
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

// ------------------------------------------------------------------ toast
let toastTimer = 0;
export function toast(msg, ms = 3200) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// The status line under the header: plain text, aria-live in the markup.
export function say(msg) {
  const s = $('status');
  if (s) s.textContent = msg || '';
}

// --------------------------------------------------------- inline confirm
// Replaces the contents of `slot` with a one-line question and two small
// buttons. No window.confirm anywhere on the desks: a host on a phone
// should see what they are about to do in place, next to the thing.
//   inlineConfirm(slot, { text: 'Call it off?', yes: 'Yes, call it off', onYes })
export function inlineConfirm(slot, { text, yes = 'Yes', no = 'Keep it', danger = true, onYes, onNo }) {
  clear(slot);
  slot.hidden = false;
  const done = () => { clear(slot); slot.hidden = true; };
  const yesBtn = h('button', { class: `btn small${danger ? ' danger-solid' : ' primary'}`, type: 'button', onclick: async () => {
    yesBtn.disabled = true;
    try { await onYes(); } catch { /* the caller already showed the error */ } finally { done(); }
  } }, yes);
  slot.append(h('div', { class: 'inline-ask' },
    h('span', { class: 'ask-text' }, text),
    yesBtn,
    h('button', { class: 'btn small', type: 'button', onclick: () => { done(); if (onNo) onNo(); } }, no)));
  yesBtn.focus();
}

// One small input + Save, in place. `parse` turns the raw value into what
// onSave receives (return undefined to show `bad`).
//   inlinePrompt(slot, { label: 'How many came?', type: 'number', min: 0, onSave })
export function inlinePrompt(slot, { label, type = 'text', placeholder = '', value = '', min, max, inputmode, save = 'Save', parse = (v) => v, bad = "That doesn't look right.", onSave }) {
  clear(slot);
  slot.hidden = false;
  const done = () => { clear(slot); slot.hidden = true; };
  const input = h('input', { class: 'input small', type, placeholder, value, min, max, inputmode, 'aria-label': label });
  const err = h('span', { class: 'err', role: 'alert' });
  const go = async () => {
    const v = parse(input.value);
    if (v === undefined) { err.textContent = bad; input.focus(); return; }
    btn.disabled = true;
    try { await onSave(v); done(); } catch (e) { err.textContent = e && e.message ? e.message : bad; btn.disabled = false; }
  };
  const btn = h('button', { class: 'btn small primary', type: 'button', onclick: go }, save);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  slot.append(h('div', { class: 'inline-ask' },
    h('label', { class: 'ask-text' }, label),
    input, btn,
    h('button', { class: 'btn small', type: 'button', onclick: done }, 'Never mind'),
    err));
  input.focus();
}

// ------------------------------------------------------------- clipboard
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the textarea trick */ }
  try {
    const ta = h('textarea', { class: 'sr-only', 'aria-hidden': 'true' }, text);
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// ----------------------------------------------------------------- sheets
// <dialog class="sheet"> with the Who's Playing shape: a .sheet-inner box,
// a grab handle on phones, a close button. Closes on backdrop tap + Escape.
export function wireSheet(dialog) {
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  for (const b of dialog.querySelectorAll('[data-close]')) b.addEventListener('click', () => dialog.close());
  return dialog;
}

// Field error helpers for forms built with .field > .label + .input + .err
export function setFieldErrors(form, errors = {}) {
  for (const f of form.querySelectorAll('.field')) {
    const name = f.dataset.field;
    const msg = name && errors[name];
    f.classList.toggle('bad', Boolean(msg));
    const err = f.querySelector('.err');
    if (err) err.textContent = msg || '';
  }
  const first = form.querySelector('.field.bad .input, .field.bad input, .field.bad select');
  if (first) first.focus();
  return Boolean(Object.keys(errors).length);
}

// Once a field is flagged, typing in it clears the flag (re-validated on submit).
export function clearErrorsOnInput(form) {
  form.addEventListener('input', (e) => {
    const f = e.target.closest ? e.target.closest('.field.bad') : null;
    if (f) { f.classList.remove('bad'); const err = f.querySelector('.err'); if (err) err.textContent = ''; }
  });
}

// "5 people", "1 person"
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// datetime-local wants local 'YYYY-MM-DDTHH:MM'; plans carry ISO (UTC).
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
