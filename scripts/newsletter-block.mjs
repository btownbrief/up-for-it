// Renders this week's plans as a Monday/Friday edition block (plain text by
// default, --html for Beehiiv paste). Reads the PUBLIC uf_plans_public() RPC
// through js/net.js — the same projection the site shows, no private
// columns — so it can run anywhere. Fails soft: no SQL yet → one clear line.
//   node scripts/newsletter-block.mjs            # up to 5 plans, text
//   node scripts/newsletter-block.mjs --html 3   # 3 plans, html
import { backend, explain } from '../js/net.js';
import { plansView, planState, formatWhen } from '../js/core.js';

const APP = 'https://play.btownbrief.com/up-for-it/';
const html = process.argv.includes('--html');
const n = Number(process.argv.find((a) => /^\d+$/.test(a)) || 5);

let plans;
try {
  plans = await backend().rpc('uf_plans_public', {});
} catch (e) {
  console.error(`uf_plans_public: ${e.code || 'error'} — ${explain(e)}${e.code === 'not_ready' ? ' (SQL not pasted yet?)' : ''}`);
  process.exit(1);
}
const nowMs = Date.now();
const live = plansView(Array.isArray(plans) ? plans : [], { nowMs });
const pick = live.slice(0, n);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (p) => (p.starts_at ? formatWhen(p.starts_at) : 'Needs a date');
const line = (p) => `${when(p)} · ${p.title} · ${p.place} · hosted by ${p.host_name || 'a Btown Brief IRL host'} · ${planState(p, nowMs).line}`;
const link = (p) => `${APP}?plan=${p.id}`;
const deck = `${APP}?deck=1`;

if (!pick.length) {
  console.log(html
    ? `<p><strong>Up for it?</strong> Nothing's on the calendar yet — say what you'd go to and a host will pick it up: <a href="${deck}">Up For It</a>. Twelve taps, one minute.</p>`
    : `Up for it? Nothing's on the calendar yet — say what you'd go to and a host will pick it up: ${deck}\nTwelve taps, one minute.`);
  process.exit(0);
}
if (html) {
  console.log(`<p><strong>Up for it? This week's plans</strong> — ${live.length} ${live.length === 1 ? 'plan is' : 'plans are'} live on <a href="${APP}">Up For It</a>:</p>`);
  for (const p of pick) console.log(`<p>${esc(line(p))} → <a href="${link(p)}">I'm in</a></p>`);
  console.log(`<p>Say what you'd go to next: <a href="${deck}">${deck}</a></p>`);
} else {
  console.log(`Up for it? This week's plans — ${live.length} ${live.length === 1 ? 'plan is' : 'plans are'} live on Up For It (${APP}):\n`);
  for (const p of pick) console.log(`- ${line(p)} → ${link(p)}`);
  console.log(`\nSay what you'd go to next: ${deck}`);
}
