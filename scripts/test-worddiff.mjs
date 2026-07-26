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
  'moved from [-C+I-]{+Commerce & Identity (C&I)+}, where');
t('one word in the middle', show('the quick brown fox', 'the quick red fox'),
  'the quick [-brown-]{+red+} fox');
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
  // Everything discussed while the rules were being settled.
  ['(something parenthetical)', '(something in parentheses)'],
  ['alpha and beta', 'gamma and delta'],
  ['Start the alpha and beta projects.', 'Start the gamma and delta projects.'],
  ['the cat and the dog', 'the bird and the fish'],
  ['“alpha”', '“beta”'],
  ['running', 'runner'],
  ['v1', 'v2'],
  ['café', 'cafés'],
  ['日本語', '中国語'],
  ['done 🎉', 'ready 🎉'],
  ['...', '!!!'],
  ['a,', 'a'],
  ['   ', ' '],
  ['\n\n', '\n'],
  ['a\tb', 'a\tc'],
  ['   leading', '   leading edge'],
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

head('unchanged whitespace stays outside the marks');
// The space between the replaced words and what follows exists in both
// strings. Marking it struck-and-reinserted misreports it.
t('a shared trailing space is hoisted out',
  show('alpha beta gamma', 'alpha delta gamma'), 'alpha [-beta-]{+delta+} gamma');
t('but an inserted word brings its own space',
  show('the quick fox', 'the quick brown fox'), 'the quick {+brown +}fox');
t('and a removed word takes its space with it',
  show('the quick brown fox', 'the quick fox'), 'the quick [-brown -]fox');

head('shared punctuation rides out too');
// Same artefact as the shared space, and worse with a matched pair: two
// closing parens read as broken markup rather than as repeated content.
t('a shared closing paren', show('(something parenthetical)', '(something in parentheses)'),
  '(something [-parenthetical-]{+in parentheses+})');
t('brackets on both sides', show('(A),', '(B),'), '([-A-]{+B+}),');
t('a shared trailing comma', show('C+I,', 'C&I,'), '[-C+I-]{+C&I+},');
t('letters are never hoisted — no split words',
  show('running', 'runner'), '[-running-]{+runner+}');
t('digits are never hoisted', show('v1', 'v2'), '[-v1-]{+v2+}');

head('edges of the hoist rule');
t('punctuation on both ends is hoisted at once', show('“alpha”', '“beta”'), '“[-alpha-]{+beta+}”');
t('an em dash', show('a — b', 'a — c'), 'a — [-b-]{+c+}');
t('accented letters are letters', show('café', 'cafés'), '[-café-]{+cafés+}');
t('CJK is not punctuation', show('日本語', '中国語'), '[-日本語-]{+中国語+}');
t('an emoji is not a letter, so it can ride out',
  show('done 🎉', 'ready 🎉'), '[-done-]{+ready+} 🎉');
t('punctuation-only strings', show('...', '!!!'), '[-...-]{+!!!+}');
t('a trailing mark with nothing to pair against', show('a,', 'a'), '[-a,-]{+a+}');
t('whitespace-only strings still reassemble',
  [beforeText(wordDiff('   ', ' ')), afterText(wordDiff('   ', ' '))], ['   ', ' ']);

head('one suggestion stays one replacement');
// A real diff anchors on the shared word and splits this into two edits,
// which reads as two things you could take separately. You cannot.
t('a shared word in the middle does not fragment it',
  show('alpha and beta', 'gamma and delta'),
  '[-alpha and beta-]{+gamma and delta+}');
t('nor does a shared word inside a sentence',
  show('Start the alpha and beta projects.', 'Start the gamma and delta projects.'),
  'Start the [-alpha and beta-]{+gamma and delta+} projects.');
t('repeated words do not create false anchors',
  show('the cat and the dog', 'the bird and the fish'),
  'the [-cat and the dog-]{+bird and the fish+}');

head('large replacements need no special case');
const long = Array.from({ length: 450 }, (_, i) => `w${i}`).join(' ');
const other = Array.from({ length: 450 }, (_, i) => `v${i}`).join(' ');
const big = wordDiff(long, other);
t('a wholesale rewrite is one del and one ins', big.map((p) => p.kind), ['del', 'ins']);
t('and still reassembles', [beforeText(big) === long, afterText(big) === other], [true, true]);

rmSync(dir, { recursive: true, force: true });
done('word-diff');
