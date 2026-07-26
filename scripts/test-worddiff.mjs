#!/usr/bin/env node
/**
 * Word diff (spec §6, #98).
 *
 * The invariant that matters is reversibility: whatever the diff decides,
 * reassembling it must reproduce both inputs exactly. A diff that renders
 * nicely but drops a space has quietly misreported what an edit does.
 *
 *   node scripts/test-worddiff.mjs
 */
import { rmSync } from 'fs';
import { load, reporter } from './lib/compile.mjs';

const { mod, dir } = await load('src/shared/worddiff.ts');
const { wordDiff, beforeText, afterText } = mod;
const { t, head, done } = reporter();

/** Compact rendering: [-deleted-] and {+inserted+}. */
const show = (a, b) =>
  wordDiff(a, b)
    .map((p) => (p.kind === 'same' ? p.text : p.kind === 'del' ? `[-${p.text}-]` : `{+${p.text}+}`))
    .join('');

head('only what changed is marked');
t('the C+I case from #98',
  show('moved from C+I, where', 'moved from Commerce & Identity (C&I), where'),
  'moved from [-C+I, -]{+Commerce & Identity (C&I), +}where');
t('one word in the middle', show('the quick brown fox', 'the quick red fox'),
  'the quick [-brown -]{+red +}fox');
t('a word appended', show('the quick fox', 'the quick brown fox'),
  'the quick {+brown +}fox');
t('a word removed', show('the quick brown fox', 'the quick fox'),
  'the quick [-brown -]fox');
t('identical text has nothing marked', show('no change here', 'no change here'), 'no change here');

head('whole-string operations');
t('a pure deletion', show(', and it was well received', ''), '[-, and it was well received-]');
t('a pure insertion', show('', 'brand new text'), '{+brand new text+}');
t('nothing in common', show('alpha beta', 'gamma delta'),
  '[-alpha beta-]{+gamma delta+}');

head('reversibility — the invariant');
const cases = [
  ['moved from C+I, where', 'moved from Commerce & Identity (C&I), where'],
  ['the quick brown fox', 'the quick red fox'],
  ['a  b   c', 'a b c'],
  ['line one\nline two', 'line one\nline 2\nline three'],
  ['trailing space ', 'trailing space'],
  ['', 'x'],
  ['x', ''],
  ['same', 'same'],
];
let ok = true;
for (const [a, b] of cases) {
  const parts = wordDiff(a, b);
  if (beforeText(parts) !== a || afterText(parts) !== b) ok = false;
}
t('every case reassembles to both inputs exactly', ok, true);
t('irregular whitespace is preserved, not normalized',
  beforeText(wordDiff('a  b   c', 'a b c')), 'a  b   c');
t('newlines survive', afterText(wordDiff('one\ntwo', 'one\ntwo\nthree')), 'one\ntwo\nthree');

head('a rewrite is shown whole, not shredded');
const long = Array.from({ length: 450 }, (_, i) => `w${i}`).join(' ');
const other = Array.from({ length: 450 }, (_, i) => `v${i}`).join(' ');
const big = wordDiff(long, other);
t('past the token cap it degrades to one del and one ins',
  big.map((p) => p.kind), ['del', 'ins']);
t('and still reassembles', [beforeText(big) === long, afterText(big) === other], [true, true]);

rmSync(dir, { recursive: true, force: true });
done('word-diff');
