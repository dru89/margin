#!/usr/bin/env node
/**
 * The composer's re-target rule (spec §8, #121).
 *
 * One decision is being asserted here: what counts as work a new selection
 * must not destroy. Everything downstream — whether the anchor moves,
 * whether focus jumps, whether the submit popover mentions an unfinished
 * comment — reads this one answer.
 *
 *   node scripts/test-composer.mjs
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const dir = mkdtempSync(path.join(tmpdir(), 'margin-composer-'));
const out = path.join(dir, 'composer.mjs');
execFileSync('npx', ['esbuild', 'src/shared/composer.ts', '--format=esm', `--outfile=${out}`, '--log-level=error'], { stdio: 'inherit' });
const { draftHasContent, emptyDraft } = await import(pathToFileURL(out).href);

let fails = 0;
const t = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(56)} ${got}${ok ? '' : `   (want ${want})`}`);
};
const head = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`);

const QUOTE = 'the quoted words';
const draft = (o = {}) => ({ ...emptyDraft, ...o });

head('an empty composer re-targets freely');
t('nothing typed', draftHasContent(draft(), QUOTE), false);
// Otherwise a stray keystroke wedges the composer onto text the author has
// already moved on from, with no way to release it but Cancel.
t('whitespace only', draftHasContent(draft({ text: '  \n ' }), QUOTE), false);
t('suggest mode, replacement untouched',
  draftHasContent(draft({ mode: 'suggest' }), QUOTE), false);
t('suggest mode, the quote typed back in by hand',
  draftHasContent(draft({ mode: 'suggest', replacement: QUOTE }), QUOTE), false);

head('a composer holding work keeps its anchor');
t('a comment typed', draftHasContent(draft({ text: 'this needs a source' }), QUOTE), true);
t('a rationale typed in suggest mode',
  draftHasContent(draft({ mode: 'suggest', text: 'clearer' }), QUOTE), true);
// In suggest mode the replacement *is* the work; requiring a rationale too
// would discard the edit itself on a misclick.
t('a replacement edited, no rationale',
  draftHasContent(draft({ mode: 'suggest', replacement: 'other words' }), QUOTE), true);
t('a replacement emptied — that is a deletion, not an empty composer',
  draftHasContent(draft({ mode: 'suggest', replacement: '' }), QUOTE), true);

head('mode decides whether a replacement counts');
// The same draft in comment mode is empty: the replacement is not part of
// a comment, so it cannot be what a re-target would destroy.
t('an edited replacement while composing a comment',
  draftHasContent(draft({ mode: 'comment', replacement: 'other words' }), QUOTE), false);

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? '\nAll composer cases pass.' : `\n${fails} FAILING`);
process.exit(fails === 0 ? 0 : 1);
