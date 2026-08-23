// Drives the reader app in ?demo=1 mode with Playwright: home + deck card,
// the deck (12 taps → your three → email/whens → thanks), Wishes + chips,
// "I'm in" → Step out, Suggest, Mine, dark mode, desktop, deep links, and
// the no-backend (not_ready) fail-soft. Writes screenshots to OUT (default:
// ./playtest-out) and fails on any console error or failed assertion.
// Run:  NODE_PATH=<dir with playwright> [CHROMIUM=<path>] node scripts/playtest.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = process.env.OUT || join(ROOT, 'playtest-out');
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const errors = [];
async function page({ width = 390, height = 844, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  // a 404 from the real project just means the SQL isn't pasted yet (not_ready) — not a bug
  p.on('console', (m) => { if (m.type() === 'error' && !/status of 404|ERR_NAME_NOT_RESOLVED|Failed to fetch/.test(m.text())) errors.push(`[console] ${m.text()}`); });
  p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return p;
}
const shot = (p, name) => p.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
const must = (cond, msg) => { if (!cond) errors.push(`[assert] ${msg}`); };
const text = async (p, sel) => ((await p.textContent(sel)) || '').trim();

// ------------------------------------------------------------------ home
let p = await page();
await p.goto(`${base}?demo=1`);
await p.waitForSelector('.card.plan');
must(await p.$('.deck-cta'), 'deck card renders');
must(/Up for it\?/.test(await text(p, '.deck-cta h2')), 'deck card title');
must(/Start/.test(await text(p, '#deck-start')), 'deck card says Start before any tap');
must(/neighbors weighed in this week/.test(await text(p, '.deck-cta .weigh')), 'weigh-in line is honest');
const planCards = await p.$$('.card.plan');
must(planCards.length >= 4, `plans render (${planCards.length})`);
must(await p.$('.card.plan .line:has-text("more until it\'s on")'), 'a tipping plan shows its line');
must(await p.$('.card.plan .line:has-text("It\'s on")'), 'an on plan shows its line');
must(await p.$('.card.plan .line:has-text("needs a date")'), 'a needs-a-date plan shows its line');
must(await p.$('.group-head:has-text("Happened")'), 'Happened section');
must(await p.$('.card.plan.done .line:has-text("9 came")'), 'done plan shows "9 came"');
must((await p.$$('.card.plan .bar')).length >= 2, 'progress bars on tipping plans');
const weighBefore = Number((await text(p, '.deck-cta .weigh')).match(/^(\d+)/)?.[1] || 0);
must(!/\bnull\b|undefined|NaN/.test(await text(p, 'main')), 'no stray null/undefined text on the home screen');
await shot(p, '01-home-plans');

// ------------------------------------------------------------------ deck
await p.click('#deck-start');
await p.waitForSelector('#sheet-deck[open] .dcard');
await p.waitForTimeout(350);
must((await p.$$('.dashes i')).length === 12, 'twelve dashes');
must((await text(p, '.deck-count')) === '1 of 12', 'count starts at 1 of 12');
const firstTitle = await text(p, '.dcard .dtitle');
await shot(p, '02-deck-card');
// a mix of answers: yes, maybe, pass, yes, yes, pass, maybe, yes, pass, yes, maybe, yes  (6 yes)
const plan = ['yes', 'maybe', 'pass', 'yes', 'yes', 'pass', 'maybe', 'yes', 'pass', 'yes', 'maybe', 'yes'];
const label = { yes: "I'd go", maybe: 'Maybe', pass: 'Pass' };
for (let k = 0; k < 12; k++) {
  if (k === 2) await p.keyboard.press('ArrowLeft');           // keyboard Pass
  else await p.click(`.answers .${plan[k]}`);
  await p.waitForTimeout(260);
  if (k === 5) { must((await text(p, '.deck-count')) === '7 of 12', 'count advances'); await shot(p, '03-deck-midway'); }
  if (k < 11) must((await text(p, '.dcard .dtitle')) !== firstTitle || k > 0, 'card changes after the first answer');
}
await p.waitForSelector('.fin .picks');
must((await p.$$('.pick')).length === 6, 'your three lists the yes pile (6)');
await p.click('.pick:nth-child(1)'); await p.click('.pick:nth-child(2)'); await p.click('.pick:nth-child(3)');
must((await p.$$('.pick[aria-pressed="true"]')).length === 3, 'three picked');
must(await p.$('.pick:nth-child(4):disabled'), 'fourth pick is disabled at three');
await shot(p, '04-deck-your-three');
await p.click('.fin .btn.primary:has-text("Next")');
await p.waitForSelector('#sheet-deck input[name="email"]');
await p.click('#sheet-deck .opt:has-text("Weeknights")');
await p.click('#sheet-deck .opt:has-text("Sundays")');
await p.fill('#sheet-deck input[name="email"]', 'not-an-email');
await p.click('#finish-done');
await p.waitForTimeout(150);
must(await p.$('#sheet-deck .field.bad'), 'bad email is flagged');
await p.fill('#sheet-deck input[name="email"]', 'stephen@example.com');
await shot(p, '05-deck-finish');
await p.click('#finish-done');
await p.waitForSelector('.deck-center h3:has-text("Thanks.")');
must(/weighed in this week/.test(await text(p, '.deck-center p')), 'thanks screen shows weigh-in');
await shot(p, '06-deck-thanks');
await p.click('.deck-center .btn:has-text("Back to plans")');
await p.waitForTimeout(300);
must(!(await p.$('#sheet-deck[open]')), 'deck sheet closed');
must(/Keep going · \d+ left/.test(await text(p, '#deck-start')), 'deck card now says Keep going · N left');
must(Number((await text(p, '.deck-cta .weigh')).match(/^(\d+)/)?.[1] || 0) === weighBefore + 1, 'weigh-in went up by one (this device)');

// ---------------------------------------------------------------- wishes
await p.click('#tab-wishes');
await p.waitForSelector('.card.idea');
await p.waitForTimeout(250);
must((await p.$$('.chip')).length >= 6, 'category chips present');
must((await text(p, '.chip:first-child')) === 'All', 'All chip first');
must(await p.$('.pill.claimed'), 'claimed pill present');
must(await p.$('.pill.tipped'), 'tipped pill present');
must(await p.$('.pill.exists'), 'exists pill present');
must(await p.$('.idea a.go[target="_blank"][rel="noopener"]'), 'exists link present');
must((await p.$$('.idea .btn:has-text("You\'d go ✓")')).length >= 1, 'my yes taps show You\'d go');
must(!(await p.$('.card.idea:has(.pill.exists) .btn')), 'exists ideas have no I\'d go button');
const claimedFirst = await p.$('.card.idea:first-child .pill.claimed');
must(claimedFirst, 'claimed ideas sort first');
await shot(p, '07-wishes');
await p.click('.chip:has-text("Games")');
await p.waitForTimeout(150);
const gamesMeta = await p.$$eval('.card.idea .m', (els) => els.map((e) => e.textContent));
must(gamesMeta.length >= 1 && gamesMeta.every((m) => /Games/.test(m)), 'Games chip filters to games');
await shot(p, '08-wishes-filtered');
await p.click('.chip:has-text("All")');
// tap I'd go on an open idea from the list, then change my mind
const openBtn = await p.$('.card.idea .btn:has-text("I\'d go")');
must(openBtn, 'an untapped idea has an I\'d go button');
await openBtn.click();
await p.waitForTimeout(250);
must((await p.$$('.idea .btn:has-text("You\'d go ✓")')).length >= 2, 'tap from the list registers');
await p.click('.idea .btn:has-text("You\'d go ✓")');
await p.waitForSelector('.choice');
must((await p.$$('.choice button')).length === 3, 'second tap opens Pass / Maybe / I\'d go');
await p.click('.choice button:has-text("Maybe")');
await p.waitForTimeout(250);
// claimed pill → Plans tab + highlight
await p.click('.pill.claimed');
await p.waitForSelector('.card.plan.hi');
must((await p.getAttribute('#tab-plans', 'aria-pressed')) === 'true', 'claimed pill jumps to Plans');
await p.waitForTimeout(300);

// ------------------------------------------------------------- "I'm in"
const tipping = await p.$('.card.plan:has(.line:has-text("more until it\'s on"))');
must(tipping, 'tipping plan found');
const tippingId = await tipping.getAttribute('data-id');
await tipping.$eval('.btn.primary', (b) => b.click());
await p.waitForSelector('#sheet-in[open]');
await p.waitForTimeout(300);
await p.click('#in-submit');
await p.waitForTimeout(120);
must(await p.$('#sheet-in .field.bad'), 'I\'m in validates name/email');
await p.fill('#sheet-in input[name="name"]', 'Stephen');
must(!/\bnull\b|undefined/.test(await text(p, '#sheet-in')), 'no stray null/undefined text in the sheet');
must((await p.inputValue('#sheet-in input[name="email"]')) === 'stephen@example.com', 'email prefilled from the deck finish');
await shot(p, '09-im-in');
await p.click('#in-submit');
await p.waitForSelector('.toast.show');
must(/You're in/.test(await text(p, '.toast')), 'I\'m in toast');
await p.waitForTimeout(300);
const card2 = await p.$(`.card.plan[data-id="${tippingId}"]`);
must(/4 of 5/.test(await card2.$eval('.line', (e) => e.textContent)), 'in_count went 3 → 4');
must(await card2.$('.btn.in:has-text("You\'re in ✓")'), 'button says You\'re in ✓');
await card2.$eval('.btn.in', (b) => b.click());
await p.waitForTimeout(100);
must(await p.$(`.card.plan[data-id="${tippingId}"] .btn.danger:has-text("Step out")`), 'tapping again offers Step out');
await shot(p, '10-step-out');
await p.click(`.card.plan[data-id="${tippingId}"] .btn.danger`);
await p.waitForSelector('.toast.show:has-text("Stepped out")');
await p.waitForTimeout(300);
must(/3 of 5/.test(await p.$eval(`.card.plan[data-id="${tippingId}"] .line`, (e) => e.textContent)), 'in_count back to 3');
// "I'm in" on the on plan → it's on toast; waitlist wording not reachable in seed (cap 10, 6 in)
const onPlan = await p.$('.card.plan:has(.line.on)');
await onPlan.$eval('.btn.primary', (b) => b.click());
await p.waitForSelector('#sheet-in[open]');
await p.fill('#sheet-in input[name="name"]', 'Stephen');
await p.click('#in-submit');
await p.waitForSelector('.toast.show');
must(/You're in — it's on\./.test(await text(p, '.toast')), 'joining an on plan says it\'s on');
await p.waitForTimeout(300);

// ---------------------------------------------------------------- suggest
await p.click('#tab-wishes');
await p.waitForSelector('#open-suggest');
await p.click('#open-suggest');
await p.waitForSelector('#sheet-suggest[open]');
await p.waitForTimeout(300);
await p.click('#suggest-submit');
await p.waitForTimeout(120);
must((await p.$$('#sheet-suggest .field.bad')).length >= 2, 'suggest validates title + when');
await p.fill('#sheet-suggest input[name="title"]', 'Morning swim at Oakledge, then coffee www.spam.example');
await p.click('#sheet-suggest .opt:has-text("Saturday mornings")');
await shot(p, '11-suggest');
await p.click('#suggest-submit');
await p.waitForSelector('.toast.show:has-text("Stephen reads these")');
await p.waitForTimeout(200);

// ------------------------------------------------------------------- mine
await p.click('#open-mine');
await p.waitForSelector('#sheet-mine[open] .mine-section');
await p.waitForTimeout(300);
const mineText = await text(p, '#sheet-mine');
must(/You're in/.test(mineText) && /You'd go/.test(mineText), 'Mine has both sections');
must(/Pinball night/.test(mineText), 'Mine lists the plan I joined');
must(/One of your three/.test(mineText), 'Mine marks top picks');
must(await p.$('#sheet-mine .opt[aria-pressed="true"]:has-text("Weeknights")'), 'Mine shows saved whens');
must((await p.inputValue('#sheet-mine input[name="email"]')) === 'stephen@example.com', 'Mine shows saved email');
must(/only identity/.test(mineText), 'identity copy');
await shot(p, '12-mine');
await p.click('#sheet-mine .opt:has-text("Saturday mornings")');
await p.click('#mine-save');
await p.waitForSelector('.toast.show:has-text("Saved")');
await p.keyboard.press('Escape');
await p.waitForTimeout(200);
// how it works
await p.click('#open-how');
await p.waitForSelector('#sheet-how[open]');
must((await p.$$('#sheet-how .rules li')).length === 5, 'five lines in How this works');
await shot(p, '13-how');
await p.keyboard.press('Escape');

// ----------------------------------------------------------- deep links
await p.goto(`${base}?demo=1&view=wishes`);
await p.waitForSelector('.card.idea');
must((await p.getAttribute('#tab-wishes', 'aria-pressed')) === 'true', '?view=wishes lands on Wishes');
await p.goto(`${base}?demo=1&deck=1`);
await p.waitForSelector('#sheet-deck[open] .dcard', { timeout: 5000 });
must(true, '?deck=1 opens the deck');
await p.keyboard.press('Escape');
await p.waitForTimeout(200);
await p.context().close();

// ---------------------------------------------------------- exhaustion
// a fresh demo context: answer every card across sittings until the deck is
// empty, then the deck card must say "seen them all" and point at Wishes
p = await page();
await p.goto(`${base}?demo=1`);
await p.waitForSelector('#deck-start');
for (let round = 0; round < 4; round++) {
  const startBtn = await p.$('#deck-start');
  if (!startBtn) break;
  await startBtn.click();
  await p.waitForSelector('#sheet-deck[open]');
  await p.waitForSelector('#sheet-deck .dcard, #sheet-deck .deck-center', { timeout: 5000 });
  while (await p.$('#sheet-deck .dcard')) { await p.click('.answers .pass'); await p.waitForTimeout(230); }
  if (await p.$('#sheet-deck .fin')) { await p.click('#sheet-deck .link:has-text("Skip")'); await p.waitForSelector('.deck-center h3:has-text("Thanks.")'); }
  await p.keyboard.press('Escape');
  await p.waitForTimeout(350);
}
must(/seen them all/.test(await text(p, '.deck-cta h2')), 'exhausted deck card says seen them all');
must(await p.$('.deck-cta .btn:has-text("See what\'s tipping")'), 'exhausted deck card links to Wishes');
await shot(p, '14-deck-exhausted');
await p.context().close();

// --------------------------------------------------- dark + desktop
p = await page({ dark: true });
await p.goto(`${base}?demo=1`);
await p.waitForSelector('.card.plan');
await shot(p, '15-home-dark');
await p.click('#deck-start'); await p.waitForSelector('#sheet-deck[open] .dcard'); await p.waitForTimeout(350); await shot(p, '16-deck-dark');
await p.keyboard.press('Escape');
await p.click('#tab-wishes'); await p.waitForSelector('.card.idea'); await p.waitForTimeout(250); await shot(p, '17-wishes-dark');
await p.context().close();
p = await page({ width: 1280, height: 900 });
await p.goto(`${base}?demo=1`);
await p.waitForSelector('.card.plan');
await shot(p, '18-desktop');
await p.click('#deck-start'); await p.waitForSelector('#sheet-deck[open] .dcard'); await p.waitForTimeout(350); await shot(p, '19-desktop-deck');
await p.keyboard.press('Escape');
await p.click('.card.plan .btn.primary'); await p.waitForSelector('#sheet-in[open]'); await p.waitForTimeout(350); await shot(p, '20-desktop-sheet');
await p.context().close();

// -------------------------------------------- live mode without SQL
// Simulate a project where the SQL isn't pasted yet: every RPC 404s
// (→ not_ready). The page must still render, with the deck card disabled
// and a plain message. (Also keeps the playtest from touching the real
// backend.)
p = await page();
await p.route('**/rest/v1/rpc/**', (r) => r.fulfill({ status: 404, body: '' }));
await p.goto(base);
await p.waitForSelector('.deck-cta.off', { timeout: 8000 });
must(await p.$('.deck-cta .btn.primary:disabled'), 'deck card disabled when the backend is not there');
must(/switched on yet/.test(await text(p, '.deck-cta p')), 'not_ready explained in plain language');
await p.click('#tab-wishes'); await p.waitForSelector('.empty'); await p.waitForTimeout(200);
must(await p.$('.empty'), 'wishes fail soft');
await shot(p, '21-live-not-ready');
await p.context().close();

await browser.close();
server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`playtest ok — screenshots in ${OUT}`);
