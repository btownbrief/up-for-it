// Turns data/ideas.json into the seed block at the bottom of
// supabase/up-for-it-SETUP.sql (everything after the @@SEEDS@@ marker is
// regenerated). Run after editing the deck, then re-paste/re-run the SQL.
// `on conflict (slug) do nothing` keeps a live idea's status and tips.
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const SQL = ROOT + 'supabase/up-for-it-SETUP.sql';
const { ideas } = JSON.parse(readFileSync(ROOT + 'data/ideas.json', 'utf8'));

const q = (s) => `$s$${String(s ?? '').replace(/\$s\$/g, '')}$s$`;
const WHENS = new Set(['weeknight', 'sat-am', 'sat-pm', 'sunday', 'any']);
const CATS = new Set(['outdoors', 'food-drink', 'games', 'music', 'arts', 'learning', 'wellness', 'sports', 'community', 'social', 'words', 'film']);
const seen = new Set();
const rows = ideas.map((i) => {
  if (!/^[a-z0-9-]{3,60}$/.test(i.slug) || seen.has(i.slug)) throw new Error(`bad/duplicate slug ${i.slug}`);
  seen.add(i.slug);
  if (i.title.length < 4 || i.title.length > 56) throw new Error(`title length ${i.slug}`);
  if ((i.blurb || '').length > 120) throw new Error(`blurb length ${i.slug}`);
  if (!WHENS.has(i.when)) throw new Error(`when ${i.slug}`);
  if (!CATS.has(i.category)) throw new Error(`category ${i.slug}`);
  const months = (i.months || []).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
  if ((i.origin || '').length > 60) throw new Error(`origin too long ${i.slug}`);
  const ex = i.exists;
  if (ex && (!/^https:\/\/\S+$/.test(ex.url) || (ex.note || '').length > 80)) throw new Error(`exists ${i.slug}`);
  return `(${q(i.slug)}, ${q(i.title)}, ${q(i.blurb || '')}, ${q(i.when)}, ${q(i.category)}, '{${months.join(',')}}'::int[], ` +
    `${q(ex ? 'exists' : 'live')}, ${q(ex ? ex.url : '')}, ${q(ex ? ex.note : '')}, ${q(i.origin || 'editor')})`;
});

const block = [
  `-- ${ideas.length} ideas, generated ${new Date().toISOString().slice(0, 10)}`,
  'insert into public.uf_ideas (slug, title, blurb, when_hint, category, months, status, exists_url, exists_note, origin) values',
  rows.join(',\n'),
  'on conflict (slug) do nothing;',
  '',
].join('\n');

const sql = readFileSync(SQL, 'utf8');
const marker = '-- @@SEEDS@@';
const at = sql.indexOf(marker);
if (at < 0) throw new Error('marker missing');
writeFileSync(SQL, sql.slice(0, at + marker.length) + '\n' + block);
console.log(`wrote ${ideas.length} seed ideas into ${SQL}`);
