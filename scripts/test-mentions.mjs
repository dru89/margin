#!/usr/bin/env node
/**
 * `@path` references in comment text (spec §9, #90).
 *
 * Two decisions are asserted here. **The text is the truth**: putting
 * every part back together has to reproduce the input, because the chip
 * is a rendering and the sidecar keeps the plain `@path`. And **what
 * counts as a reference**, which is mostly a list of things that must
 * not become one — an email address being the obvious one.
 *
 *   node scripts/test-mentions.mjs
 */
import { load, reporter } from './lib/compile.mjs';

const { mod } = await load('src/shared/mentions.ts');
const { splitMentions, normalizeMentionPath } = mod;
const { t, head, done } = reporter();

/** The file paths found, in order. */
const files = (text) => splitMentions(text).filter((p) => p.kind === 'file').map((p) => p.value).join(' | ');
/** Reassembled source — must always equal the input. */
const roundTrip = (text) => splitMentions(text).map((p) => p.raw ?? p.value).join('');

head('finding references');
t('on its own', files('@docs/plan.md'), 'docs/plan.md');
t('mid-sentence', files('see @docs/plan.md for the rest'), 'docs/plan.md');
t('several', files('@a.md and @b/c.md'), 'a.md | b/c.md');
t('at the start of a line', files('intro\n@notes.md'), 'notes.md');
t('none', files('nothing to see'), '');

head('what is not a reference');
// The @ follows a word character, so it never opens a reference.
t('an email address', files('mail drew@hays.fm today'), '');
t('an email at the start', files('drew@hays.fm'), '');
t('a bare @', files('@ alone'), '');
t('@ then punctuation only', files('@, really'), '');
// Two @ in a row would make the path ambiguous; the class excludes @.
t('doubled', files('@@handle'), '');

head('sentence punctuation is not part of the path');
t('a period', files('see @docs/plan.md.'), 'docs/plan.md');
t('a comma', files('@a.md, @b.md'), 'a.md | b.md');
t('inside parentheses', files('(@docs/plan.md)'), 'docs/plan.md');
t('quoted', files('“@docs/plan.md”'), 'docs/plan.md');
t('a question mark', files('did you read @plan.md?'), 'plan.md');

head('the text is the truth');
t('plain', roundTrip('see @docs/plan.md for the rest'), 'see @docs/plan.md for the rest');
t('trailing punctuation stays in the text', roundTrip('see @docs/plan.md.'), 'see @docs/plan.md.');
t('several', roundTrip('@a.md and @b/c.md, yes'), '@a.md and @b/c.md, yes');
t('an email survives untouched', roundTrip('mail drew@hays.fm'), 'mail drew@hays.fm');
t('newlines survive', roundTrip('one\n\n@two.md\n'), 'one\n\n@two.md\n');

head('normalizing to a workspace key');
t('already relative', normalizeMentionPath('docs/plan.md'), 'docs/plan.md');
t('leading slash', normalizeMentionPath('/docs/plan.md'), 'docs/plan.md');
t('dot slash', normalizeMentionPath('./docs/plan.md'), 'docs/plan.md');
t('backslashes', normalizeMentionPath('docs\\plan.md'), 'docs/plan.md');
// Left alone on purpose: nothing outside the project is in the file list,
// so it fails to resolve and renders as a lost reference. Normalizing it
// away would turn an escape attempt into a valid-looking path.
t('traversal is left to fail the lookup', normalizeMentionPath('../secrets.md'), '../secrets.md');
t('an absolute path outside', normalizeMentionPath('/etc/passwd'), 'etc/passwd');

done('mention');
