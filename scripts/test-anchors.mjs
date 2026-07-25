#!/usr/bin/env node
/**
 * Anchor tests. Anchors decide which text a comment belongs to, so a
 * defect here silently attaches a reader's comment to words they never
 * wrote it about — the least visible and least recoverable class of bug
 * in the app.
 *
 * Every case below asserts a *decision* (DECISIONS §64, docs/specs/
 * review-surface.md), not an implementation path. If one fails, either a
 * decision changed on purpose or something is broken; neither should
 * happen because a function was refactored.
 *
 *   node scripts/test-anchors.mjs
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const dir = mkdtempSync(path.join(tmpdir(), 'margin-anchors-'));
const out = path.join(dir, 'anchors.mjs');
execFileSync('npx', ['esbuild', 'src/shared/anchors.ts', '--format=esm', `--outfile=${out}`, '--log-level=error'], { stdio: 'inherit' });
const { makeAnchor, reanchor, resolveQuote } = await import(pathToFileURL(out).href);

let fails = 0;
const t = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(60)} ${JSON.stringify(got)}${ok ? '' : `   (want ${JSON.stringify(want)})`}`);
};
const head = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`);

// The quote appears twice, which is the whole problem in miniature.
const doc = 'The quick brown fox jumps over the lazy dog.\nI am a lazy dog. You are a brown fox.\n';
const first = doc.indexOf('lazy dog');           // 35
const second = doc.indexOf('lazy dog', first + 1); // 52
const a = makeAnchor(doc, first, first + 8);
// Where did it land? 'orphaned', or the offset.
const at = (content, anchor = a) => {
  const r = reanchor(content, anchor);
  return r.orphaned ? 'orphaned' : r.from;
};

head('an anchor records enough to find itself again');
t('the quote is the exact slice', a.quote, 'lazy dog');
t('prefix is the run before it', a.prefix, doc.slice(first - 32, first));
t('suffix is the run after it', a.suffix, doc.slice(first + 8, first + 40));
t('the two occurrences are distinct', [first, second], [35, 52]);

head('it follows the text through ordinary editing');
t('nothing changed', at(doc), first);
t('unrelated text inserted at the start', at('PREFACE. ' + doc), first + 9);
t('a paragraph inserted above', at('An entirely new opening.\n\n' + doc), first + 26);
t('a word changed earlier in the same sentence',
  at(doc.replace('The quick brown fox jumps', 'The very quick brown fox leaps')), 40);
t('the following sentence rewritten',
  at('The quick brown fox jumps over the lazy dog.\nA different second line.\n'), first);
t('list markers added around it', at(doc.replace('The quick', '- The quick')), first + 2);

head('it is not fooled by a copy of its own words (#125)');
t('the exact words inserted at the start', at('lazy dog ' + doc), first + 9);
t('the exact words inserted immediately before it',
  at(doc.slice(0, first) + 'lazy dog ' + doc.slice(first)), first + 9);
t('the two sentences swapped',
  at('I am a lazy dog. You are a brown fox.\nThe quick brown fox jumps over the lazy dog.\n'), 73);

head('it orphans rather than guessing (#125)');
t('the anchored text deleted, a decoy elsewhere survives',
  at(doc.slice(0, first) + doc.slice(first + 8)), 'orphaned');
t('a word inside the anchor changed', at(doc.replace('lazy dog', 'lazy cat')), 'orphaned');
t('the whole surrounding sentence rewritten',
  at('Totally different opening about a lazy dog here.\nI am a lazy dog. You are a brown fox.\n'), 'orphaned');
t('the document emptied', at(''), 'orphaned');

head('an orphan keeps its last known position (spec §2)');
// The sidebar sorts orphans where their text used to be, so these must not drift.
const lost = reanchor(doc.slice(0, first) + doc.slice(first + 8), a);
t('orphaned', lost.orphaned, true);
t('from is preserved', lost.from, first);
t('to is preserved', lost.to, first + 8);
t('the quote is kept as the only remaining evidence', lost.quote, 'lazy dog');

head('sidecars written before context existed still resolve');
const bare = { from: 35, to: 43, quote: 'lazy dog' };  // no prefix/suffix
t('a bare anchor is not orphaned for lack of context', reanchor(doc, bare).orphaned, false);
t('a bare anchor still finds its quote', reanchor('xx' + doc, bare).from, first + 2);
t('resolveQuote with no context takes the best position',
  resolveQuote(doc, 'brown fox'), { from: 10, to: 19 });
t('resolveQuote on a missing quote returns null', resolveQuote(doc, 'not present'), null);
t('resolveQuote on an empty quote returns null', resolveQuote(doc, ''), null);

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? '\nAll anchor cases pass.' : `\n${fails} FAILING`);
process.exit(fails === 0 ? 0 : 1);
