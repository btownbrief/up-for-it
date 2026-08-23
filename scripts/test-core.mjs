// Core + fake-backend mirror tests. Run: node --test scripts/test-core.mjs
// The same scenarios live in scripts/test-sql.sh against the real SQL — if
// you change a rule, both must agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  IDEA_THRESHOLD, DECK_SIZE, TOP_PICKS, WHENS, CATEGORIES,
  cleanText, looksLikeEmail, validToken, isUuid,
  validateTap, validateFinish, validateSuggestion, validateCommit, validatePlan,
  deckOrder, inSeason, ideasView, plansView, ideaStatus, planState, planProgress,
  wantsOrder, heat, meetupDescription, formatWhen, timeAgo, mastheadFor,
} from '../js/core.js';
import { FakeBackend, BackendError, seedDemo, DEMO_HOST_KEY } from '../js/fake-backend.js';

const { ideas: SEED } = JSON.parse(readFileSync(new URL('../data/ideas.json', import.meta.url), 'utf8'));
const T = (c) => c.repeat(32);
const NOW = Date.parse('2026-09-01T16:00:00Z');

// ------------------------------------------------------------------ core
test('cleanText strips control chars, collapses space, drops URLs, clips', () => {
  assert.equal(cleanText('  hi there   see https://x.y/z and www.q.com ok ', 40), 'hi there see and ok');
  assert.equal(cleanText('a'.repeat(100), 10).length, 10);
});
test('email / token / uuid shapes', () => {
  assert.ok(looksLikeEmail('a@b.co')); assert.ok(!looksLikeEmail('a@b')); assert.ok(!looksLikeEmail('nope'));
  assert.ok(validToken(T('a'))); assert.ok(!validToken('xyz'));
  assert.ok(isUuid('00000000-0000-4000-8000-000000000001')); assert.ok(!isUuid('nope'));
});
test('validators', () => {
  assert.ok(!validateTap({ idea_id: 'x', answer: 'yes' }).ok);
  assert.ok(!validateTap({ idea_id: '00000000-0000-4000-8000-000000000001', answer: 'nah' }).ok);
  assert.ok(validateTap({ idea_id: '00000000-0000-4000-8000-000000000001', answer: 'pass' }).ok);
  const f = validateFinish({ top: ['00000000-0000-4000-8000-000000000001', 'bad', '00000000-0000-4000-8000-000000000001'], email: ' A@B.CO ', whens: ['sunday', 'weeknight', 'x'] });
  assert.ok(f.ok); assert.equal(f.value.top.length, 1); assert.equal(f.value.email, 'a@b.co'); assert.deepEqual(f.value.whens, ['weeknight', 'sunday']);
  assert.ok(!validateFinish({ email: 'nope' }).ok);
  assert.ok(!validateSuggestion({ title: 'ab', when: 'any' }).ok);
  assert.ok(validateSuggestion({ title: 'Karaoke night', when: 'weeknight', note: 'see http://x.y' }).value.note === 'see');
  assert.ok(!validateCommit({ name: 'Pri' }).ok);
  assert.ok(validateCommit({ name: ' Pri ', email: 'P@x.io' }).value.email === 'p@x.io');
  const p = validatePlan({ title: 'Sunset paddle', place: 'North Beach', cap: 6, threshold: 3, starts_at: '2030-09-04T18:00', meetup_url: '' });
  assert.ok(p.ok); assert.equal(p.value.category, 'social'); assert.ok(p.value.starts_at.endsWith('Z'));
  assert.ok(!validatePlan({ title: 'Sunset paddle', place: 'x' }).ok);
  assert.ok(!validatePlan({ title: 'Sunset paddle', place: 'North Beach', cap: 4, threshold: 5 }).ok);
  assert.ok(!validatePlan({ title: 'Sunset paddle', place: 'North Beach', meetup_url: 'http://meetup.com' }).ok);
  assert.ok(!validatePlan({ title: 'Sunset paddle', place: 'North Beach', starts_at: 'garbage' }).ok);
  assert.equal(validatePlan({ title: 'Sunset paddle', place: 'North Beach', starts_at: '' }).value.starts_at, null);
});
test('deckOrder is deterministic per token, live + in-season only, cut to DECK_SIZE', () => {
  const ideas = SEED.map((i, k) => ({ id: String(k), status: i.exists ? 'exists' : 'live', months: i.months, tipped_at: null }));
  const a = deckOrder(ideas, T('a'), { month: 8 }); const b = deckOrder(ideas, T('a'), { month: 8 }); const c = deckOrder(ideas, T('b'), { month: 8 });
  assert.equal(a.length, DECK_SIZE);
  assert.deepEqual(a.map((i) => i.id), b.map((i) => i.id));
  assert.notDeepEqual(a.map((i) => i.id), c.map((i) => i.id));
  assert.ok(a.every((i) => i.status === 'live' && inSeason(i, 8)));
  assert.ok(!inSeason({ months: [10, 11] }, 8)); assert.ok(inSeason({ months: [] }, 0));
});
test('ideasView: claimed, then tipped newest-first, then live, then exists', () => {
  const v = ideasView([
    { id: 'a', status: 'live', created_at: '2026-08-01', months: [] },
    { id: 'b', status: 'exists', created_at: '2026-08-02', months: [] },
    { id: 'c', status: 'live', tipped_at: '2026-08-10', created_at: '2026-08-01', months: [] },
    { id: 'd', status: 'claimed', created_at: '2026-08-01', months: [] },
    { id: 'e', status: 'live', tipped_at: '2026-08-20', created_at: '2026-08-01', months: [] },
    { id: 'f', status: 'archived', created_at: '2026-08-01', months: [] },
  ], { month: 7 });
  assert.deepEqual(v.map((i) => i.id), ['d', 'e', 'c', 'a', 'b']);
});
test('plansView keeps tipping/on, soonest first, undated last, drops old', () => {
  const v = plansView([
    { id: 'a', status: 'on', starts_at: '2026-09-10T00:00:00Z', created_at: '2026-08-01' },
    { id: 'b', status: 'tipping', starts_at: null, created_at: '2026-08-02' },
    { id: 'c', status: 'tipping', starts_at: '2026-09-03T00:00:00Z', created_at: '2026-08-01' },
    { id: 'd', status: 'done', starts_at: '2026-08-20T00:00:00Z', created_at: '2026-08-01' },
    { id: 'e', status: 'on', starts_at: '2026-08-01T00:00:00Z', created_at: '2026-07-01' },
  ], { nowMs: NOW });
  assert.deepEqual(v.map((p) => p.id), ['c', 'a', 'b']);
});
test('status copy', () => {
  assert.equal(ideaStatus({ status: 'exists', exists_note: 'Already a thing: X' }).kind, 'exists');
  assert.equal(ideaStatus({ status: 'claimed', host_name: 'Jo' }).line, 'Jo is hosting this');
  assert.equal(ideaStatus({ status: 'live', tipped_at: 'x', yes_count: 7 }).line, '7 would go · looking for a host');
  assert.equal(ideaStatus({ status: 'live' }).kind, 'open');
  assert.equal(planState({ status: 'tipping', in_count: 4, threshold: 6, starts_at: '2030-01-01T00:00:00Z' }, NOW).line, "4 of 6 · 2 more until it's on");
  assert.equal(planState({ status: 'tipping', in_count: 1, threshold: 4, starts_at: null }, NOW).state, 'needs-date');
  assert.equal(planState({ status: 'tipping', in_count: 6, threshold: 6, starts_at: '2030-01-01T00:00:00Z' }, NOW).state, 'tipped');
  assert.equal(planState({ status: 'on', in_count: 6, cap: 8, starts_at: '2030-01-01T00:00:00Z' }, NOW).line, "It's on · 6 in · 2 spots left");
  assert.equal(planState({ status: 'on', in_count: 8, cap: 8, wait_count: 2, starts_at: '2030-01-01T00:00:00Z' }, NOW).state, 'full');
  assert.equal(planState({ status: 'done', showed: 9 }, NOW).line, 'Happened · 9 came');
  assert.equal(planProgress({ in_count: 3, threshold: 6 }), 0.5);
});
test('host helpers', () => {
  assert.deepEqual(wantsOrder([{ id: 'a', yes_7d: 1, yes: 9 }, { id: 'b', yes_7d: 4, yes: 4 }, { id: 'c', yes_7d: 1, yes: 12 }]).map((i) => i.id), ['b', 'c', 'a']);
  assert.equal(heat(0, 10), 0); assert.equal(heat(10, 10), 4); assert.equal(heat(4, 10), 2);
  const d = meetupDescription({ title: 'Sunset paddle', place: 'North Beach', starts_at: '2026-09-04T22:30:00Z', in_count: 6, cap: 8, host_name: 'Stephen' });
  assert.match(d, /Sunset paddle\n\nFri, Sep 4 · 6:30pm · North Beach/); assert.match(d, /6 neighbors said/); assert.match(d, /Cap is 8/);
  assert.equal(formatWhen('2026-09-04T23:00:00Z'), 'Fri, Sep 4 · 7pm');
  assert.equal(timeAgo(new Date(NOW - 3 * 3600000).toISOString(), NOW), '3h ago');
  assert.equal(mastheadFor(0).id, 'winter'); assert.equal(mastheadFor(9).id, 'fall'); assert.equal(mastheadFor(6).id, 'summer');
});
test('lists are sane', () => {
  assert.equal(WHENS.length, 4); assert.equal(CATEGORIES.length, 12); assert.equal(TOP_PICKS, 3);
  for (const i of SEED) { assert.ok(i.title.length <= 56, i.slug); assert.ok((i.blurb || '').length <= 120, i.slug); }
});

// --------------------------------------------------------- fake backend
function fresh() {
  let t = NOW;
  const be = new FakeBackend({ now: () => t, modSecret: 'test-secret' });
  for (const i of SEED) be.ideas.push({ id: `ffffffff-0000-4000-8000-${String(be.ideas.length + 1).padStart(12, '0')}`, slug: i.slug, title: i.title, blurb: i.blurb, when: i.when, category: i.category, months: i.months, status: i.exists ? 'exists' : 'live', exists_url: i.exists ? i.exists.url : '', exists_note: i.exists ? i.exists.note : '', origin: i.origin, source: 'seed', token: null, tipped_at: null, created_at: new Date(t - 86400000).toISOString() });
  return { be, tick: (ms) => { t += ms; } };
}
const rejects = async (p, code) => { try { await p; assert.fail(`expected ${code}`); } catch (e) { assert.equal(e.code, code); } };

test('backend: taps tip at 5, counts hidden before, deck shrinks', async () => {
  const { be } = fresh();
  const idea = be.ideas.find((i) => i.slug === 'sunset-paddle-north-beach').id;
  assert.equal((await be.rpc('uf_home', { p_token: null })).deck_left, 27);
  assert.equal((await be.rpc('uf_tap', { p_token: T('a'), p_idea: idea, p_answer: 'yes' })).tipped, false);
  assert.equal(be.publicIdea(be.ideas.find((i) => i.id === idea)).yes_count, null);
  for (const c of ['b', 'd', 'e']) await be.rpc('uf_tap', { p_token: T(c), p_idea: idea, p_answer: 'yes' });
  await be.rpc('uf_tap', { p_token: T('c'), p_idea: idea, p_answer: 'maybe' });
  assert.equal((await be.rpc('uf_tap', { p_token: T('c'), p_idea: idea, p_answer: 'yes' })).tipped, true);
  assert.equal(be.publicIdea(be.ideas.find((i) => i.id === idea)).yes_count, IDEA_THRESHOLD);
  const home = await be.rpc('uf_home', { p_token: T('a') });
  assert.equal(home.deck_left, 26); assert.equal(home.weigh_in, 5);
  assert.equal((await be.rpc('uf_deck', { p_token: T('a') })).length, 26);
  await rejects(be.rpc('uf_tap', { p_token: T('a'), p_idea: idea, p_answer: 'nope' }), 'bad_tap');
  await rejects(be.rpc('uf_tap', { p_token: 'zz', p_idea: idea, p_answer: 'yes' }), 'bad_token');
});
test('backend: finish stores email/whens/top; suggest → pending → approve; 3/day', async () => {
  const { be } = fresh();
  const idea = be.ideas[0].id;
  await be.rpc('uf_tap', { p_token: T('a'), p_idea: idea, p_answer: 'yes' });
  await be.rpc('uf_finish', { p_token: T('a'), p_finish: { top: [idea], email: 'A@Example.com', whens: ['sunday', 'weeknight', 'bogus'] } });
  const mine = await be.rpc('uf_mine', { p_token: T('a') });
  assert.equal(mine.email, 'a@example.com'); assert.deepEqual(mine.whens, ['weeknight', 'sunday']); assert.equal(mine.taps[0].top, true);
  await rejects(be.rpc('uf_finish', { p_token: T('a'), p_finish: { email: 'nope' } }), 'bad_finish');
  const { id } = await be.rpc('uf_suggest', { p_token: T('f'), p_suggestion: { title: 'Karaoke at the Monkey House', when: 'weeknight', note: 'see http://spam.x for more' } });
  assert.equal(be.ideas.find((i) => i.id === id).status, 'pending');
  assert.equal(be.ideas.find((i) => i.id === id).blurb, 'see for more');
  assert.equal((await be.rpc('uf_ideas_public')).length, 30);
  assert.equal((await be.rpc('uf_mod_queue', { p_secret: 'wrong' })).error, 'bad_secret');
  assert.equal((await be.rpc('uf_mod_queue', { p_secret: 'test-secret' })).pending.length, 1);
  await be.rpc('uf_mod_idea', { p_secret: 'test-secret', p_idea: id, p_action: 'approve' });
  assert.equal(be.ideas.find((i) => i.id === id).status, 'live');
  await be.rpc('uf_suggest', { p_token: T('f'), p_suggestion: { title: 'Second idea', when: 'any' } });
  await be.rpc('uf_suggest', { p_token: T('f'), p_suggestion: { title: 'Third idea', when: 'any' } });
  await rejects(be.rpc('uf_suggest', { p_token: T('f'), p_suggestion: { title: 'Fourth idea', when: 'any' } }), 'slow_down');
});
test('backend: host key, claim, commit → on, waitlist, update, done, release, lockout', async () => {
  const { be } = fresh();
  const idea = be.ideas.find((i) => i.slug === 'sunset-paddle-north-beach').id;
  for (const c of ['a', 'b', 'c', 'd', 'e']) await be.rpc('uf_tap', { p_token: T(c), p_idea: idea, p_answer: 'yes' });
  const { key } = await be.rpc('uf_mod_host', { p_secret: 'test-secret', p_action: 'add', p_payload: { name: 'Jonathon', email: 'j@x.io' } });
  assert.equal(key.length, 32);
  assert.equal((await be.rpc('uf_host_me', { p_key: key })).name, 'Jonathon');
  assert.equal((await be.rpc('uf_host_me', { p_key: T('0') })).error, 'bad_key');
  const wants = await be.rpc('uf_host_wants', { p_key: key });
  assert.equal(wants.ideas.find((i) => i.id === idea).yes, 5);
  const { id: plan } = await be.rpc('uf_host_claim', { p_key: key, p_plan: { idea_id: idea, title: 'Sunset paddle from North Beach', place: 'North Beach boathouse', cap: 6, threshold: 3 } });
  assert.equal(be.ideas.find((i) => i.id === idea).status, 'claimed');
  await rejects(be.rpc('uf_host_claim', { p_key: key, p_plan: { idea_id: idea, title: 'Duplicate claim', place: 'Same beach' } }), 'already_claimed');
  assert.equal(be.publicIdea(be.ideas.find((i) => i.id === idea)).host_name, 'Jonathon');
  await rejects(be.rpc('uf_commit', { p_plan: plan, p_token: T('a'), p_commit: { name: 'Pri' } }), 'bad_commit');
  assert.equal((await be.rpc('uf_commit', { p_plan: plan, p_token: T('a'), p_commit: { name: 'Pri', email: 'p@x.io' } })).status, 'in');
  await be.rpc('uf_commit', { p_plan: plan, p_token: T('b'), p_commit: { name: 'Sam', email: 's@x.io' } });
  assert.equal((await be.rpc('uf_commit', { p_plan: plan, p_token: T('c'), p_commit: { name: 'Lee', email: 'l@x.io' } })).on, false);
  let p = be.plans.find((x) => x.id === plan);
  assert.equal(p.status, 'tipping'); assert.ok(p.tipped_at);
  assert.equal((await be.rpc('uf_host_update', { p_key: key, p_plan: plan, p_patch: { starts_at: '2030-09-04T22:00:00Z' } })).on, true);
  assert.equal(p.status, 'on');
  for (const [c, n] of [['d', 'Ana'], ['e', 'Bo'], ['f', 'Cy']]) await be.rpc('uf_commit', { p_plan: plan, p_token: T(c), p_commit: { name: n, email: `${n}@x.io` } });
  assert.equal((await be.rpc('uf_commit', { p_plan: plan, p_token: 'ab'.repeat(16), p_commit: { name: 'Di', email: 'd@x.io' } })).status, 'wait');
  assert.equal(be.publicPlan(p).in_count, 6);
  await be.rpc('uf_uncommit', { p_plan: plan, p_token: T('a') });
  assert.equal(be.commits.find((c) => c.token === 'ab'.repeat(16)).status, 'in');
  const hp = await be.rpc('uf_host_plans', { p_key: key });
  assert.ok(!('email' in hp.mine[0].people[0]));
  assert.equal((await be.rpc('uf_plans_public'))[0].host_name, 'Jonathon');
  assert.ok(!('email' in (await be.rpc('uf_plans_public'))[0]));
  await rejects(be.rpc('uf_host_update', { p_key: key, p_plan: plan, p_patch: { meetup_url: 'http://meetup.com/x' } }), 'bad_plan');
  await be.rpc('uf_host_action', { p_key: key, p_plan: plan, p_action: 'done', p_payload: { showed: 5 } });
  assert.equal(p.status, 'done'); assert.equal(p.showed, 5);
  assert.equal(be.ideas.find((i) => i.id === idea).status, 'live');
  const { id: p2 } = await be.rpc('uf_host_claim', { p_key: key, p_plan: { title: 'Floated idea with no idea', place: 'Somewhere', category: 'games' } });
  assert.equal(be.plans.find((x) => x.id === p2).category, 'games');
  await rejects(be.rpc('uf_host_action', { p_key: key, p_plan: p2, p_action: 'on' }), 'needs_date');
  await be.rpc('uf_host_action', { p_key: key, p_plan: p2, p_action: 'release' });
  assert.ok(!be.plans.find((x) => x.id === p2));
  const hid = be.hosts[0].id;
  await be.rpc('uf_mod_host', { p_secret: 'test-secret', p_action: 'disable', p_payload: { id: hid } });
  assert.equal((await be.rpc('uf_host_me', { p_key: key })).error, 'bad_key');
  await be.rpc('uf_mod_host', { p_secret: 'test-secret', p_action: 'enable', p_payload: { id: hid } });
  for (let i = 0; i < 20; i++) await be.rpc('uf_host_me', { p_key: '00000000' + String(i % 10).repeat(24) });
  assert.equal((await be.rpc('uf_host_me', { p_key: '00000000' + 'f'.repeat(24) })).error, 'bad_key'); // that prefix rests
  assert.equal((await be.rpc('uf_host_me', { p_key: key })).name, 'Jonathon');                          // others don't
});
test('backend: sweep releases a stale undated empty claim; on → done after a day', async () => {
  const { be, tick } = fresh();
  const idea = be.ideas[0].id;
  const { key } = await be.rpc('uf_mod_host', { p_secret: 'test-secret', p_action: 'add', p_payload: { name: 'S' } });
  const { id } = await be.rpc('uf_host_claim', { p_key: key, p_plan: { idea_id: idea, title: 'Some plan here', place: 'Here' } });
  assert.equal(be.ideas[0].status, 'claimed');
  tick(15 * 86400000);
  await be.rpc('uf_plans_public');
  assert.ok(!be.plans.find((p) => p.id === id)); assert.equal(be.ideas[0].status, 'live');
  const { id: p2 } = await be.rpc('uf_host_claim', { p_key: key, p_plan: { title: 'Dated plan', place: 'Here', starts_at: new Date(be.now() + 3600000).toISOString() } });
  await be.rpc('uf_host_action', { p_key: key, p_plan: p2, p_action: 'on' });
  tick(2 * 86400000);
  await be.rpc('uf_plans_public');
  assert.equal(be.plans.find((p) => p.id === p2).status, 'done');
});
test('backend: review-round rules — cap floor, on→tipping on date clear, stuck-claimed release, prefix lockout, showed range', async () => {
  const { be, tick } = fresh();
  const idea = be.ideas[3].id;
  const { key } = await be.rpc('uf_mod_host', { p_secret: 'test-secret', p_action: 'add', p_payload: { name: 'Maya' } });
  const { id } = await be.rpc('uf_host_claim', { p_key: key, p_plan: { idea_id: idea, title: 'Pinball night', place: 'Pinball Co-op', starts_at: '2030-01-01T23:00:00Z', cap: 4, threshold: 2 } });
  for (const [c, n] of [['a', 'A'], ['b', 'B'], ['c', 'C']]) await be.rpc('uf_commit', { p_plan: id, p_token: T(c), p_commit: { name: n, email: `${n}@x.io` } });
  const p = be.plans.find((x) => x.id === id);
  assert.equal(p.status, 'on');
  await rejects(be.rpc('uf_host_update', { p_key: key, p_plan: id, p_patch: { cap: 2 } }), 'cap_too_small');
  await be.rpc('uf_host_update', { p_key: key, p_plan: id, p_patch: { starts_at: null } });
  assert.equal(p.status, 'tipping'); assert.equal(p.on_at, null); assert.equal(p.notified_on, false);
  assert.equal((await be.rpc('uf_host_update', { p_key: key, p_plan: id, p_patch: { starts_at: '2030-01-02T23:00:00Z' } })).on, true);
  // finished via sweep → idea released
  p.starts_at = new Date(be.now() - 3 * 86400000).toISOString();
  await be.rpc('uf_plans_public');
  assert.equal(p.status, 'done'); assert.equal(be.ideas[3].status, 'live');
  await rejects(be.rpc('uf_host_action', { p_key: key, p_plan: id, p_action: 'done', p_payload: { showed: 900 } }), 'bad_showed');
  // per-prefix lockout
  for (let i = 0; i < 20; i++) await be.rpc('uf_host_me', { p_key: '11111111' + String(i % 10).repeat(24) });
  assert.equal((await be.rpc('uf_host_me', { p_key: '11111111' + 'f'.repeat(24) })).error, 'bad_key');
  assert.equal((await be.rpc('uf_host_me', { p_key: key })).name, 'Maya');
  // mod add rejects a 1-char title like the SQL check constraint
  await rejects(be.rpc('uf_mod_idea', { p_secret: 'test-secret', p_idea: null, p_action: 'add', p_patch: { title: 'x' } }), 'bad_patch');
  tick(0);
});
test('demo seed: whole loop visible, host key works', async () => {
  const be = seedDemo(new FakeBackend({ now: () => NOW, modSecret: 'demo' }), SEED);
  const home = await be.rpc('uf_home', { p_token: null });
  assert.ok(home.plans.some((p) => p.status === 'on')); assert.ok(home.plans.some((p) => p.status === 'tipping' && !p.starts_at));
  assert.ok(home.ideas.some((i) => i.tipped_at && i.status === 'live')); assert.ok(home.ideas.some((i) => i.status === 'claimed'));
  assert.ok(home.weigh_in >= 10);
  const hp = await be.rpc('uf_host_plans', { p_key: DEMO_HOST_KEY });
  assert.ok(hp.mine.length >= 2);
  assert.equal((await be.rpc('uf_mod_queue', { p_secret: 'demo' })).hosts.length, 2);
});
