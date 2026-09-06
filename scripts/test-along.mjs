// Come along: core + fake-backend mirror tests. Run: node --test scripts/test-along.mjs
// The same rules live in supabase/come-along-SETUP.sql; change both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validatePlan, validatePatch, validateJoin, validCode, normalizeCode, defaultMeetAt, planState, isOpen, isFull,
  meetOffset, pickEvents, planFromEvent, icsFor, gcalUrl, announceText, nextGathering, linkFor, LIMITS, DEFAULT_INVITE,
} from '../js/along-core.js';
import { FakeAlongBackend, AlongError, seedAlongDemo, DEMO_PREFERRED } from '../js/along-backend.js';

const SNAP = JSON.parse(readFileSync(new URL('../data/come-along-demo.json', import.meta.url), 'utf8')).events;
const NOW = Date.parse('2026-09-08T16:00:00Z');       // Sept 8, noon Eastern; the snapshot's events are ahead of it
const T = (c) => c.repeat(32);
const HOST = { id: 'h1', name: 'Stephen', key: 'a'.repeat(32) };
const ev = SNAP.find((e) => e.id === '1bda86a25014') || SNAP[5];   // Pride parade, Sun Sept 13 noon
const draft = () => planFromEvent(ev);
const fresh = () => new FakeAlongBackend({ now: () => NOW, hosts: [HOST], random: (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })() });
const rejects = async (fn, code) => { try { await fn(); assert.fail(`expected ${code}`); } catch (e) { assert.ok(e instanceof AlongError, `${e}`); assert.equal(e.code, code); } };

test('codes: alphabet, normalisation', () => {
  assert.ok(validCode('ABC234')); assert.ok(!validCode('ABC10O')); assert.ok(!validCode('abc234'));
  assert.equal(normalizeCode(' abc-234 '), 'ABC234');
});

test('validatePlan: defaults, limits, meet window', () => {
  const ok = validatePlan(draft());
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  assert.equal(ok.value.invite, DEFAULT_INVITE);
  assert.equal(ok.value.meet_at, defaultMeetAt(ev.start));
  assert.equal(ok.value.cap, 0);
  assert.ok(!validatePlan({ ...draft(), meet_place: 'x' }).ok, 'short place');
  assert.ok(!validatePlan({ ...draft(), event_url: 'http://x' }).ok, 'http link');
  assert.ok(!validatePlan({ ...draft(), meet_at: new Date(Date.parse(ev.start) + 7 * 3600000).toISOString() }).ok, 'meet after event');
  assert.ok(!validatePlan({ ...draft(), cap: 61 }).ok, 'cap');
  assert.ok(validatePlan({ ...draft(), cap: '' }).ok, 'blank cap = 0');
  const long = validatePlan({ ...draft(), invite: 'x'.repeat(300), look_for: 'see https://spam.example now' });
  assert.equal(long.value.invite.length, LIMITS.invite);
  assert.equal(long.value.look_for, 'see now');
});

test('validatePatch only touches the five patchable fields', () => {
  const p = { ...validatePlan(draft()).value, code: 'ABC234' };
  const r = validatePatch(p, { meet_place: 'By the fountain', event_title: 'nope', cap: 5 });
  assert.ok(r.ok); assert.deepEqual(Object.keys(r.value).sort(), ['cap', 'meet_place']);
  assert.ok(!validatePatch(p, { meet_at: 'garbage' }).ok);
  assert.ok(validateJoin({ name: '  Priya ' }).ok); assert.ok(!validateJoin({ name: '' }).ok);
});

test('planState walks upcoming → soon → happening → happened; cancelled wins', () => {
  const p = { ...validatePlan(draft()).value, status: 'open', going_count: 0 };
  const meet = Date.parse(p.meet_at);
  assert.equal(planState(p, meet - 3 * 86400000).key, 'upcoming');
  assert.equal(planState(p, meet - 3600000).key, 'soon');
  assert.equal(planState(p, meet + 60000).key, 'happening');
  assert.equal(planState(p, Date.parse(p.event_end) + 60000).key, 'happened');
  assert.equal(planState({ ...p, status: 'cancelled' }, meet - 86400000).key, 'cancelled');
  assert.ok(isOpen(p, meet - 3600000)); assert.ok(!isOpen(p, Date.parse(p.event_end) + 1));
  assert.ok(isFull({ ...p, cap: 2, going_count: 2 })); assert.ok(!isFull({ ...p, cap: 0, going_count: 99 }));
  assert.equal(meetOffset(p), '15 min before');
  assert.equal(meetOffset({ ...p, meet_at: new Date(Date.parse(p.event_start) - 3600000).toISOString() }), '1 hour before');
});

test('pickEvents: future only, query on title/venue, soonest first, capped', () => {
  const all = pickEvents(SNAP, { nowMs: NOW, limit: 100 });
  assert.ok(all.length > 5);
  assert.ok(all.every((e) => Date.parse(e.start) > NOW));
  for (let i = 1; i < all.length; i++) assert.ok(Date.parse(all[i].start) >= Date.parse(all[i - 1].start));
  assert.equal(pickEvents(SNAP, { nowMs: NOW, limit: 3 }).length, 3);
  const pride = pickEvents(SNAP, { query: 'pride parade', nowMs: NOW });
  assert.ok(pride.length >= 1 && /pride/i.test(pride[0].title));
  assert.equal(pickEvents(SNAP, { nowMs: Date.parse('2027-01-01') }).length, 0);
});

test('calendar + copy helpers are well formed and carry the link', () => {
  const p = { ...validatePlan(draft()).value, code: 'ABC234', created_at: new Date(NOW).toISOString() };
  const ics = icsFor(p);
  assert.match(ics, /BEGIN:VCALENDAR[\s\S]*DTSTART:\d{8}T\d{6}Z[\s\S]*END:VCALENDAR/);
  assert.ok(ics.includes('go/?c=ABC234'));
  assert.ok(gcalUrl(p).startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE'));
  assert.ok(announceText(p).includes(linkFor('ABC234')));
  const ng = nextGathering(NOW);
  assert.ok(ng && ng.at > NOW && /coffee|basketball/i.test(ng.title));
});

test('backend: create needs a host key; returns code + edit key once; get is public', async () => {
  const be = fresh();
  await rejects(() => be.rpc('ca_create', { p_key: 'b'.repeat(32), p_plan: draft() }), 'bad_key');
  await rejects(() => be.rpc('ca_create', { p_key: HOST.key, p_plan: { ...draft(), meet_place: '' } }), 'bad_plan');
  const r = await be.rpc('ca_create', { p_key: HOST.key, p_plan: draft() });
  assert.ok(validCode(r.code)); assert.match(r.edit_key, /^[a-f0-9]{32}$/);
  assert.equal(r.plan.host_name, 'Stephen'); assert.equal(r.plan.going_count, 0); assert.equal(r.plan.status, 'open');
  assert.ok(!('edit_key' in r.plan) && !('edit_hash' in r.plan) && !('host_id' in r.plan), 'public plan carries no secrets');
  const got = await be.rpc('ca_get', { p_code: r.code.toLowerCase(), p_token: T('1') });
  assert.equal(got.code, r.code); assert.equal(got.you, false);
  await rejects(() => be.rpc('ca_get', { p_code: 'ZZZZZZ' }), 'not_found');
  await rejects(() => be.rpc('ca_get', { p_code: 'nope' }), 'bad_code');
  // an event that already ended can't be created
  await rejects(() => be.rpc('ca_create', { p_key: HOST.key, p_plan: { ...draft(), event_start: '2026-09-01T16:00:00Z', event_end: '2026-09-01T18:00:00Z', meet_at: '2026-09-01T15:45:00Z' } }), 'happened');
});

test('backend: join → in the list; rename in place; leave; full; per-device limit; one name per device', async () => {
  const be = fresh();
  const { code } = await be.rpc('ca_create', { p_key: HOST.key, p_plan: { ...draft(), cap: 2 } });
  let p = await be.rpc('ca_join', { p_code: code, p_token: T('1'), p_name: ' Priya ' });
  assert.deepEqual(p.going, ['Priya']); assert.equal(p.you, true); assert.equal(p.going_count, 1);
  p = await be.rpc('ca_join', { p_code: code, p_token: T('1'), p_name: 'Priya S' });
  assert.deepEqual(p.going, ['Priya S'], 'same device renames, does not duplicate');
  await rejects(() => be.rpc('ca_join', { p_code: code, p_token: T('2'), p_name: '' }), 'bad_name');
  await rejects(() => be.rpc('ca_join', { p_code: code, p_token: 'xyz', p_name: 'Tom' }), 'bad_token');
  p = await be.rpc('ca_join', { p_code: code, p_token: T('2'), p_name: 'Tom' });
  assert.equal(p.going_count, 2);
  await rejects(() => be.rpc('ca_join', { p_code: code, p_token: T('3'), p_name: 'Late' }), 'full');
  p = await be.rpc('ca_leave', { p_code: code, p_token: T('1') });
  assert.deepEqual(p.going, ['Tom']); assert.equal(p.you, false);
  const mine = await be.rpc('ca_mine', { p_token: T('2') });
  assert.equal(mine.length, 1); assert.equal(mine[0].code, code);
  // 20 creates per host per day, and 20 open joins per device
  const HOST2 = { id: 'h2', name: 'Jonathon', key: 'c'.repeat(32) };
  const be2 = new FakeAlongBackend({ now: () => NOW, hosts: [HOST, HOST2] });
  for (let i = 0; i < 20; i++) { const r = await be2.rpc('ca_create', { p_key: HOST.key, p_plan: draft() }); await be2.rpc('ca_join', { p_code: r.code, p_token: T('9'), p_name: 'Max' }); }
  await rejects(() => be2.rpc('ca_create', { p_key: HOST.key, p_plan: draft() }), 'slow_down');
  const extra = await be2.rpc('ca_create', { p_key: HOST2.key, p_plan: draft() });
  await rejects(() => be2.rpc('ca_join', { p_code: extra.code, p_token: T('9'), p_name: 'Max' }), 'too_many_open');
});

test('backend: edit needs the edit key, patches five fields, cap floor; cancel closes joins; public feed for the chip', async () => {
  const be = fresh();
  const { code, edit_key } = await be.rpc('ca_create', { p_key: HOST.key, p_plan: draft() });
  await be.rpc('ca_join', { p_code: code, p_token: T('1'), p_name: 'Priya' });
  await be.rpc('ca_join', { p_code: code, p_token: T('2'), p_name: 'Tom' });
  await rejects(() => be.rpc('ca_edit', { p_code: code, p_edit: 'f'.repeat(32), p_patch: { meet_place: 'x' } }), 'bad_edit');
  await rejects(() => be.rpc('ca_edit', { p_code: code, p_edit: edit_key, p_patch: { cap: 1 } }), 'cap_too_small');
  let p = await be.rpc('ca_edit', { p_code: code, p_edit: edit_key, p_patch: { meet_place: 'By the fountain', look_for: 'the Btown sign', event_title: 'ignored' } });
  assert.equal(p.meet_place, 'By the fountain'); assert.equal(p.look_for, 'the Btown sign'); assert.equal(p.event_title, ev.title);
  const pub = await be.rpc('ca_public');
  assert.equal(pub.length, 1); assert.equal(pub[0].event_id, ev.id); assert.equal(pub[0].going_count, 2);
  assert.ok(!('going' in pub[0]) && !('host_name' in pub[0]), 'chip feed has counts, no names');
  p = await be.rpc('ca_cancel', { p_code: code, p_edit: edit_key });
  assert.equal(p.status, 'cancelled');
  await rejects(() => be.rpc('ca_join', { p_code: code, p_token: T('3'), p_name: 'Late' }), 'cancelled');
  await rejects(() => be.rpc('ca_edit', { p_code: code, p_edit: edit_key, p_patch: { cap: 4 } }), 'cancelled');
  assert.equal((await be.rpc('ca_public')).length, 0, 'cancelled leaves the chip feed');
});

test('backend: after the event ends it reads as happened, joins close, and 30 days later it is swept', async () => {
  let now = NOW;
  const be = new FakeAlongBackend({ now: () => now, hosts: [HOST] });
  const { code } = await be.rpc('ca_create', { p_key: HOST.key, p_plan: draft() });
  await be.rpc('ca_join', { p_code: code, p_token: T('1'), p_name: 'Priya' });
  now = Date.parse(ev.end) + 3600000;
  const p = await be.rpc('ca_get', { p_code: code });
  assert.equal(planState(p, now).key, 'happened');
  await rejects(() => be.rpc('ca_join', { p_code: code, p_token: T('2'), p_name: 'Tom' }), 'happened');
  assert.equal((await be.rpc('ca_public')).length, 0);
  now = Date.parse(ev.end) + 31 * 86400000;
  await rejects(() => be.rpc('ca_get', { p_code: code }), 'not_found');
});

test('demo seed: two come-alongs from real upcoming events, names on the first', async () => {
  const be = seedAlongDemo(new FakeAlongBackend({ now: () => NOW }), SNAP, { hostKey: HOST.key });
  const pub = await be.rpc('ca_public');
  assert.equal(pub.length, 2);
  assert.ok(pub.some((p) => DEMO_PREFERRED.includes(p.event_id)), 'a preferred pick is used when it is upcoming');
  const first = await be.rpc('ca_get', { p_code: pub[0].code });
  assert.ok(first.going_count >= 2 && first.host_name === 'Stephen');
  // with nothing upcoming the demo is empty rather than broken
  const be2 = seedAlongDemo(new FakeAlongBackend({ now: () => Date.parse('2027-06-01') }), SNAP, { hostKey: HOST.key });
  assert.equal((await be2.rpc('ca_public')).length, 0);
});
