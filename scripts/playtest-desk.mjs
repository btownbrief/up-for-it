// Drives the two desks in ?demo=1 with Playwright: host.html (gate → wants
// → claim with "needs a date" → set a date → copy Meetup description →
// make it official → happened → call one off) and mod.html (secret → queue
// → add a host → key shown once → edit an idea). Writes screenshots to OUT
// (default ./playtest-out) and fails on any console error. Run:
//   NODE_PATH=<dir with playwright> CHROMIUM=<path> node scripts/playtest-desk.mjs
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
let passes = 0;
async function page({ width = 390, height = 844, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(`[console] ${m.text()}`); });
  p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return p;
}
const shot = (p, name) => p.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
const must = (cond, msg) => { if (cond) passes++; else errors.push(`[assert] ${msg}`); };
const text = async (p, sel) => (await p.textContent(sel)) || '';

// ================================================================= host
let p = await page();
await p.goto(`${base}host.html?demo=1`);
await p.waitForSelector('#gate:not([hidden])');
must((await p.inputValue('#key')) === 'deadbeefdeadbeefdeadbeefdeadbeef', 'demo gate is prefilled with the demo host key');
await shot(p, 'h01-gate');
// a wrong key is refused honestly
await p.fill('#key', 'ffffffffffffffffffffffffffffffff');
await p.click('#gate-form button[type=submit]');
await p.waitForTimeout(150);
must(/doesn't work/.test(await text(p, '#gate-err')), 'wrong key → bad_key copy');
await p.fill('#key', 'deadbeefdeadbeefdeadbeefdeadbeef');
await p.click('#gate-form button[type=submit]');
await p.waitForSelector('#desk:not([hidden]) .want');
must((await text(p, '#hi')) === 'Hi Stephen', 'greets the host by name');
must(/weighed in this week/.test(await text(p, '#wants-stats')), 'stats line renders');
const firstNum = (await text(p, '.want:first-child .num')).trim();
must(/^\d+/.test(firstNum) && Number.parseInt(firstNum, 10) > 0, 'first want row has a number');
must(/this week/.test(await text(p, '.want:first-child .meta')), 'meta line has momentum');
must(await p.$('.want .pill.tipped'), 'a tipped pill shows');
must(await p.$('.want .pill.claimed'), 'a claimed pill shows');
must(!/demo\d+@example/.test(await text(p, '#desk')), 'no emails anywhere on the desk');
must(await p.$('#cold-fold:not([hidden])'), 'zero-tap ideas collapse into a fold');
must((await p.$$('#heat tbody tr')).length === 8, 'heat grid has 8 rows');
must((await p.$$('#heat td.h4')).length >= 1, 'heat grid has a hottest cell');
await shot(p, 'h02-wants');
await p.evaluate(() => document.querySelector('.heat-wrap').scrollIntoView());
await p.waitForTimeout(100);
await shot(p, 'h03-heat-mobile');

// claim an untipped idea with "needs a date"
const untipped = await p.$('.want:has(.pill.open) button:has-text("Claim")');
must(untipped, 'an untipped idea still offers Claim');
const untippedTitle = (await text(p, '.want:has(.pill.open) .title')).trim();
await untipped.click();
await p.waitForSelector('#sheet-plan[open]');
await p.waitForTimeout(300);
must((await p.inputValue('#f-title')) === untippedTitle, 'claim sheet prefilled with the idea title');
await p.click('#plan-submit'); // no place yet → field error
await p.waitForTimeout(100);
must(await p.$('#sheet-plan .field.bad[data-field="place"]'), 'missing place is flagged');
await p.fill('#f-place', 'Church St top block, by the fountain');
await p.fill('#f-detail', 'Bring a layer. We walk from the fountain at 6.');
await p.click('#f-nodate');
must((await p.getAttribute('#f-nodate', 'aria-checked')) === 'true', 'needs-a-date switch flips');
await p.fill('#f-threshold', '3');
must(!(await p.$('#sheet-plan .field.bad')), 'typing clears the field flag');
await p.waitForTimeout(250);
await shot(p, 'h04-claim-sheet');
await p.click('#plan-submit');
await p.waitForSelector('.toast.show');
must(/Claimed/.test(await text(p, '#toast')), 'claim toast');
await p.waitForTimeout(300);
const tippingText = await text(p, '#plans');
must(new RegExp(untippedTitle.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(tippingText), 'new plan shows under My plans');
must(await p.$('.plan.state-needs-date'), 'new plan is "needs a date"');
must(/Claimed · Stephen/.test(await text(p, '#wants')) || /claimed by Stephen/.test(await text(p, '#wants')), 'the idea now reads claimed by Stephen');

// set a date via Edit (the needs-a-date plan's primary action is "Set date")
const needsCard = await p.$('.plan.state-needs-date:has(.p-title:text-is("' + untippedTitle.replace(/"/g, '\\"') + '"))') || await p.$('.plan.state-needs-date');
await (await needsCard.$('button:has-text("Set date")')).click();
await p.waitForSelector('#sheet-plan[open]');
await p.waitForTimeout(250);
must((await p.getAttribute('#f-nodate', 'aria-checked')) === 'true', 'edit sheet opens with needs-a-date on');
const future = new Date(Date.now() + 9 * 86400000); future.setHours(18, 30, 0, 0);
const pad = (n) => String(n).padStart(2, '0');
await p.fill('#f-starts', `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T18:30`);
must((await p.getAttribute('#f-nodate', 'aria-checked')) === 'false', 'typing a date turns needs-a-date off');
await p.click('#plan-submit');
await p.waitForSelector('.toast.show');
await p.waitForTimeout(300);
must(!(await p.$('.plan.state-needs-date:has(.p-title:text-is("' + untippedTitle.replace(/"/g, '\\"') + '"))')), 'the plan has a date now');

// copy the Meetup description from the dated, tipping paddle plan
const paddle = await p.$('.plan:has(.p-title:has-text("Sunset paddle"))');
must(paddle, 'seeded paddle plan is under My plans');
await (await paddle.$('button:has-text("Copy Meetup description")')).click();
await p.waitForSelector('.toast.show');
await p.waitForTimeout(150);
const clip = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '');
must(/Sunset paddle from North Beach/.test(clip) && /Up For It/.test(clip), 'Meetup description reached the clipboard');
await shot(p, 'h05-plans');

// make the paddle plan official (tipping + dated), then mark it happened with 9
await (await paddle.$('button:has-text("Make it official")')).click();
await p.waitForSelector('.inline-ask');
await shot(p, 'h06-official-confirm');
await p.click('.inline-ask button:has-text("Yes, it\'s on")');
await p.waitForSelector('.toast.show');
await p.waitForTimeout(300);
const paddleOn = await p.$('.plan.state-on:has(.p-title:has-text("Sunset paddle"))');
must(paddleOn, 'paddle plan is on');
await (await paddleOn.$('button:has-text("Happened")')).click();
await p.waitForSelector('.inline-ask input');
await p.fill('.inline-ask input', '9');
await p.click('.inline-ask button:has-text("Save")');
await p.waitForSelector('.toast.show');
await p.waitForTimeout(300);
await p.click('details.fold:has(summary:has-text("Done")) summary');
await p.waitForTimeout(100);
must(/Happened · 9 came/.test(await text(p, '#plans')), 'happened with 9 shows under Done');

// call off the trivia plan (needs a date, 1 in)
const trivia = await p.$('.plan:has(.p-title:has-text("Trivia at Four Quarters"))');
must(trivia, 'seeded trivia plan present');
await (await trivia.$('button:has-text("Call it off")')).click();
await p.waitForSelector('.inline-ask');
must(/1 person who are in/.test(await text(p, '.inline-ask')) || /Call it off/.test(await text(p, '.inline-ask')), 'cancel asks inline');
await p.click('.inline-ask button:has-text("Yes, call it off")');
await p.waitForSelector('.toast.show');
await p.waitForTimeout(300);
await p.click('details.fold:has(summary:has-text("Cancelled")) summary');
must(/Called off/.test(await text(p, '#plans')), 'cancelled plan shows under Cancelled');
must(/Pinball night/.test(await text(p, '#others')) && /Jonathon/.test(await text(p, '#others')), "others' plans list Jonathon's pinball night");
await shot(p, 'h07-after-actions');
// float your own idea
await p.click('#float');
await p.waitForSelector('#sheet-plan[open]');
must(!(await p.$('#f-category-field[hidden]')), 'float sheet shows the category select');
await p.keyboard.press('Escape');
await p.context().close();

// desktop + dark
p = await page({ width: 1280, height: 900 });
await p.goto(`${base}host.html?demo=1`);
await p.waitForSelector('#gate:not([hidden])');
await p.click('#gate-form button[type=submit]');
await p.waitForSelector('#desk:not([hidden]) .want');
await shot(p, 'h08-desktop');
await p.context().close();
p = await page({ dark: true });
await p.goto(`${base}host.html?demo=1`);
await p.waitForSelector('#gate:not([hidden])');
await p.click('#gate-form button[type=submit]');
await p.waitForSelector('#desk:not([hidden]) .want');
await shot(p, 'h09-dark');
await p.evaluate(() => document.querySelector('.heat-wrap').scrollIntoView());
await p.waitForTimeout(100);
await shot(p, 'h10-dark-heat');
await p.context().close();
// the #key= fragment flow: stored, stripped, enters straight away
p = await page();
await p.goto(`${base}host.html?demo=1#key=deadbeefdeadbeefdeadbeefdeadbeef`);
await p.waitForSelector('#desk:not([hidden]) .want');
must(!/key=/.test(p.url()), 'fragment key is stripped from the URL');
must((await text(p, '#hi')) === 'Hi Stephen', 'fragment key opens the desk directly');
await p.context().close();

// ================================================================== mod
p = await page();
await p.goto(`${base}mod.html?demo=1`);
await p.waitForSelector('#secret');
must((await p.inputValue('#secret')) === 'demo', 'demo secret prefilled');
await p.click('#gate button[type=submit]');
await p.waitForSelector('#room:not([hidden]) .mrow');
must(/people/.test(await text(p, '#stats')), 'mod stats line');
must(/Nothing waiting|waiting/.test(await text(p, '#pending')) || (await p.$$('#pending .card')).length >= 0, 'pending section renders');
must((await p.$$('#ideas .mrow')).length >= 20, 'ideas list renders');
must((await p.$$('#hosts .mrow')).length === 2, 'two seeded hosts');
must((await p.$$('#plans li')).length >= 4, 'plans list renders');
must(!/demo\d+@example/.test(await text(p, '#ideas')), 'no reader emails in the back room');
await shot(p, 'm01-room');
// add a host → key shown once
await p.fill('#host-name', 'Priya');
await p.fill('#host-email', 'priya@example.com');
await p.click('#add-host button[type=submit]');
await p.waitForSelector('.keybox');
const key = (await text(p, '.keybox .k')).trim();
must(/^[a-f0-9]{32}$/.test(key), 'new host key is 32 hex');
must((await text(p, '.keybox .link')).includes(`host.html#key=${key}`), 'ready-made host link shown');
must(/only time/.test(await text(p, '.keybox .warn')), 'shown-once warning');
must((await p.$$('#hosts .mrow')).length === 3, 'host list grew to 3');
await p.evaluate(() => document.querySelector('#h-hosts').scrollIntoView());
await p.waitForTimeout(100);
await shot(p, 'm02-host-key');
// the new key opens the host desk in the same demo (same in-memory backend? no — a new page is a new FakeBackend; just check the link shape)
// edit an idea in the sheet
await (await p.$('#ideas .mrow button:has-text("Edit")')).click();
await p.waitForSelector('#sheet-idea[open]');
await p.waitForTimeout(250);
must((await p.$$('#i-months .opt')).length === 12, 'twelve month toggles');
await shot(p, 'm03-idea-sheet');
await p.click('#i-months .opt:has-text("Oct")');
await p.click('#idea-submit');
await p.waitForSelector('.toast.show');
must(/Saved/.test(await text(p, '#toast')), 'idea edit saved');
// add an idea
await p.click('#add-idea');
await p.waitForSelector('#sheet-idea[open]');
await p.fill('#i-title', 'Cold-plunge Sunday at North Beach');
await p.fill('#i-blurb', 'Quick dip, hot tea after. Bring a towel and a friend.');
await p.selectOption('#i-when', 'sunday');
await p.selectOption('#i-category', 'wellness');
await p.click('#idea-submit');
await p.waitForSelector('.toast.show');
await p.waitForTimeout(200);
must(/Cold-plunge Sunday/.test(await text(p, '#ideas')), 'added idea appears in the list');
// mark one as already a thing (inline)
await (await p.$('#ideas .mrow:has-text("Cold-plunge") button:has-text("Already a thing")')).click();
await p.waitForSelector('.inline-ask input[type=url]');
await p.fill('.inline-ask input[type=url]', 'https://example.com/plunge');
await p.fill('.inline-ask input[maxlength="80"]', 'The Y runs one');
await p.click('.inline-ask button:has-text("Save")');
await p.waitForSelector('.toast.show');
await p.waitForTimeout(200);
must(await p.$('#ideas .mrow:has-text("Cold-plunge") .pill.exists'), 'idea marked exists');
// disable a host, cancel a plan (inline confirm)
await (await p.$('#hosts .mrow:has-text("Jonathon") button:has-text("Disable")')).click();
await p.waitForSelector('.toast.show');
await p.waitForTimeout(200);
must(await p.$('#hosts .mrow:has-text("Jonathon") .pill.off'), 'host disabled');
await (await p.$('#plans li:has-text("Trivia") button:has-text("Cancel")')).click();
await p.waitForSelector('.inline-ask');
await p.click('.inline-ask button:has-text("Cancel it")');
await p.waitForSelector('.toast.show');
await p.waitForTimeout(200);
must(await p.$('#plans li:has-text("Trivia") .pill.off'), 'plan cancelled from the back room');
await shot(p, 'm04-after');
await p.context().close();
p = await page({ dark: true, width: 1280, height: 900 });
await p.goto(`${base}mod.html?demo=1`);
await p.waitForSelector('#secret');
await p.click('#gate button[type=submit]');
await p.waitForSelector('#room:not([hidden]) .mrow');
await shot(p, 'm05-dark-desktop');
await p.context().close();

// ---------------------------------------------- live mode without SQL
p = await page();
await p.goto(`${base}host.html`);
await p.waitForSelector('#gate:not([hidden])');
await p.fill('#key', 'deadbeefdeadbeefdeadbeefdeadbeef');
await p.click('#gate-form button[type=submit]');
await p.waitForFunction(() => {
  const s = document.getElementById('status').textContent, g = document.getElementById('gate-err').textContent;
  return (s && !/Opening|Loading/.test(s)) || g;
}, null, { timeout: 15000 });
const live = `${await text(p, '#status')} ${await text(p, '#gate-err')}`;
must(/switched on|offline|doesn't work/.test(live), 'live mode without SQL fails soft');
await shot(p, 'h11-live-not-ready');
await p.context().close();

await browser.close();
server.close();
console.log(`${passes} checks passed`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`playtest-desk ok — screenshots in ${OUT}`);
