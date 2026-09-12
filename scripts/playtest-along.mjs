// Drives Come along in ?demo=1 with Playwright, offline (the FakeAlongBackend
// and the bundled event snapshot; never the real project): host creates
// (gate → pick → plan → link), guest opens the link, says "I'm coming", the
// name shows in the list, "Can't make it" removes it, the edit link edits,
// and the no-backend fail-soft. Screenshots to OUT (default ./playtest-out).
// Run: NODE_PATH=<dir with playwright> node scripts/playtest-along.mjs
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  try { const body = await readFile(join(ROOT, path)); res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/go/`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const errors = [];
const must = (c, m) => { if (!c) errors.push(`[assert] ${m}`); };
const text = async (p, sel) => ((await p.textContent(sel)) || '').trim();
const shot = (p, name) => p.screenshot({ path: join(OUT, `along-${name}.png`), fullPage: true });
async function page(ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ...ctxOpts });
  // never let the page reach the guide feed or the real project
  await ctx.route(/guide\.btownbrief\.com|supabase\.co|fonts\.g|gc\.zgo\.at/, (r) => r.abort());
  await ctx.addInitScript(() => { globalThis.__ALONG_OFFLINE__ = true; });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|Failed to fetch|net::ERR/.test(m.text())) errors.push(`[console] ${m.text()}`); });
  p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return { ctx, p };
}

// ------------------------------------------------------------- host creates
let { ctx, p } = await page();
await p.goto(`${base}new.html?demo=1`);
await p.waitForSelector('.pick');
must((await p.$$('.pick')).length >= 3, 'event picker lists upcoming events');
await shot(p, '01-pick');
await p.fill('#q', 'pride');
await p.waitForTimeout(100);
const picks = await p.$$('.pick');
must(picks.length >= 1, 'search narrows the list');
await picks[0].click();
await p.waitForSelector('#plan-form');
must(/Pride/i.test(await text(p, '.chosen h2')), 'chosen event shows');
must(/Outside/.test(await p.inputValue('input[name="meet_place"]')), 'meeting point prefilled from venue');
const meetVal = await p.inputValue('input[name="meet_at"]');
must(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(meetVal), `meet time prefilled (${meetVal})`);
await p.fill('input[name="meet_place"]', 'City Hall Park, by the fountain');
await p.fill('input[name="look_for"]', 'Stephen, tall, brown jacket');
await shot(p, '02-plan');
await p.click('#make');
await p.waitForSelector('#link');
const link = await text(p, '#link');
must(/go\/\?c=[23456789A-HJKMNP-Z]{6}$/.test(link), `link minted (${link})`);
const code = link.split('c=')[1];
must(/Say you're coming/.test(await text(p, '#announce')), 'announcement is paste-ready');
const editLink = await text(p, '#edit-link');
const editKey = editLink.split('edit=')[1];
must(/^[a-f0-9]{32}$/.test(editKey), 'edit key shown once');
await shot(p, '03-link');

// ---------------------------------------------------------- guest joins
// "Open it" navigates the same tab; the demo state rides sessionStorage, so
// the code minted above is there. (A new tab would not have it: in-memory demo.)
await p.click('#open');
await p.waitForSelector('#im-coming');
must(/Demo/.test(await text(p, '#status')), 'demo notice on the join page');
must((await text(p, '#h1')).length > 3, 'event title is the headline');
must(/City Hall Park, by the fountain/.test(await text(p, '.big:has-text("Meet at")')), 'meeting point from the form');
must(/15 min before/.test(await text(p, '.meta:has-text("before")')), 'meet offset line');
must(/Stephen, tall, brown jacket/.test(await text(p, '.lookfor')), 'who to look for');
must(/Coming alone is normal/.test(await text(p, '.invite')), 'default invitation line');
must(await p.$('.ribbon'), 'state ribbon');
must(await p.$('a[href^="https://calendar.google.com"]'), 'Google Calendar link');
must(await p.$('a[href*="t.me"]'), 'where-changes-appear points at Telegram');
must(/Be the first name here/.test(await text(p, '#plan')), 'empty list copy');
await shot(p, '04-join');
await p.click('#im-coming');
await p.waitForSelector('#name');
await p.fill('#name', 'Priya');
await p.click('#join');
await p.waitForSelector('.names li.you');
must((await text(p, '.names li.you')) === 'Priya', 'my name is in the list and marked');
must(/1 coming/.test(await text(p, '.count')), 'count updates');
must(/You're coming/.test(await text(p, '.actions')), 'button flips to coming');
await shot(p, '05-coming');
// reload: same tab, same token? no — demo mints a token per load, so the
// list keeps Priya but this "device" is new. That is the honest demo shape.
await p.reload(); await p.waitForSelector('#im-coming');
must((await p.$$('.names li')).length === 1, 'name persisted across the reload (sessionStorage demo)');
// a remembered name joins in one tap; forget it so the second "device" is asked
await p.evaluate(() => localStorage.removeItem('uf-name'));
await p.click('#im-coming'); await p.waitForSelector('#name'); await p.fill('#name', 'Tom'); await p.click('#join');
await p.waitForSelector('.names li.you');
must((await p.$$('.names li')).length === 2, 'second device joins → two names');
await p.click('.btn.danger');
await p.waitForSelector('#im-coming');
must((await p.$$('.names li')).length === 1 && !(await p.$('.names li.you')), "can't make it removes only me");

// ------------------------------------------------------------ host edits
await p.goto(`${base}?c=${code}&edit=${editKey}&demo=1`);
await p.waitForSelector('#edit-form');
await p.fill('input[name="meet_place"]', 'By the fountain, north side');
await p.fill('input[name="cap"]', '0');
await p.click('#save');
await p.waitForSelector('.big:has-text("north side")');
must(/north side/.test(await text(p, '.big:has-text("Meet at")')), 'edit saved and re-rendered');
await p.fill('input[name="cap"]', '0'); // (cap floor is unit-tested; here: wrong key path)
await shot(p, '06-edit');
await p.click('#cancel-plan');
await p.waitForSelector('#confirm .btn.danger-solid');
await p.click('#confirm .btn.danger-solid');
await p.waitForSelector('.ribbon.cancelled');
must(/Called off/.test(await text(p, '.ribbon')), 'call it off flips the ribbon');
must(!(await p.$('#im-coming')), 'no I\'m coming on a cancelled plan');
await shot(p, '07-cancelled');

// wrong edit key is refused in place
const seeded = await p.evaluate(async () => (await import('../js/along-net.js')).backend().rpc('ca_public'));
must(seeded.length === 2, `demo seeds two come-alongs (${seeded.length})`);
const code2 = seeded[0].code;
await p.goto(`${base}?c=${code2}&edit=${'f'.repeat(32)}&demo=1`);
await p.waitForSelector('#edit-form');
await p.fill('input[name="meet_place"]', 'Nope');
await p.click('#save');
await p.waitForSelector('#edit-err:not(:empty)');
must(/edit link doesn't work/.test(await text(p, '#edit-err')), 'wrong edit key is refused');
must((await p.$$('.names li')).length >= 2, 'seeded names show on the seeded plan');

// unknown code → a plain card, not a blank page
await p.goto(`${base}?c=ZZZZZZ&demo=1`);
await p.waitForSelector('#plan .card');
must(/Nothing here/.test(await text(p, '#plan')), 'unknown code says so');
await shot(p, '08-unknown');
await ctx.close();

// ------------------------------------------------------ no backend yet
({ ctx, p } = await page());
await p.goto(`${base}?c=ABC234`);   // no demo → network → aborted → not_ready/offline
await p.waitForSelector('#status:not(:empty)');
must(/isn't switched on|offline/.test(await text(p, '#status')), `fail-soft: ${await text(p, '#status')}`);
await shot(p, '09-not-ready');
await ctx.close();

// ------------------------------------------------------------- dark
({ ctx, p } = await page({ colorScheme: 'dark' }));
await p.goto(`${base}?demo=1`);
await p.waitForSelector('#plan .card');
const dark = await p.evaluate(async () => (await import('../js/along-net.js')).backend().rpc('ca_public'));
await p.goto(`${base}?c=${dark[1].code}&demo=1`);
await p.waitForSelector('#im-coming');
await shot(p, '10-dark');
await ctx.close();

await browser.close();
server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`ok — ${OUT}`);
