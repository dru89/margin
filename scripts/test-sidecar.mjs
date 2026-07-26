#!/usr/bin/env node
/**
 * Review sidecar load: backfill and rename recovery (#126, DECISIONS §64).
 *
 * The sidecar is where the author's accumulated review work lives. Losing
 * it is unrecoverable by update, and claiming the wrong one attaches
 * someone else's review to this document — both silent.
 *
 *   node scripts/test-sidecar.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { load, reporter } from './lib/compile.mjs';

const { mod, dir: build } = await load('src/main/reviewStore.ts');
const { loadReview, sidecarPath } = mod;
const { t, head, done } = reporter();

const base = mkdtempSync(path.join(tmpdir(), 'margin-sidecar-'));
const TEXT = 'The quick brown fox jumps over the lazy dog.\n';
let n = 0;
/** A workspace with a document and, optionally, a sidecar under some name. */
function fixture(sidecarFor, review) {
  const dir = path.join(base, `w${n++}`);
  mkdirSync(dir, { recursive: true });
  const doc = path.join(dir, 'doc.md');
  writeFileSync(doc, TEXT);
  if (sidecarFor) writeFileSync(path.join(dir, `${sidecarFor}.review.json`), JSON.stringify(review, null, 2));
  return { dir, doc };
}
const review = (o = {}) => ({
  version: 1, document: 'doc.md', round: 5,
  comments: [{
    id: 'c1', author: 'user', createdAt: '2026-07-01T00:00:00Z', text: 'a comment',
    anchor: { from: 35, to: 43, quote: 'lazy dog', prefix: TEXT.slice(3, 35), suffix: TEXT.slice(43, 44) },
    replies: [{ id: 'r1', author: 'agent', text: 'a reply', createdAt: '2026-07-01T01:00:00Z' }],
    status: 'open',
  }],
  suggestions: [], discussion: [], ...o,
});

head('loading a current sidecar');
{
  const f = fixture('doc.md', review());
  const r = await loadReview(f.doc, TEXT);
  t('the comment survives', r.comments.length, 1);
  t('its anchor resolves', r.comments[0].anchor.orphaned, false);
}

head('sidecars written before round stamps (spec §1)');
{
  const f = fixture('doc.md', review());
  const r = await loadReview(f.doc, TEXT);
  t('the thread backfills to round 0', r.comments[0].round, 0);
  t('its reply backfills to round 0', r.comments[0].replies[0].round, 0);
  t('seenRound backfills to the current round', r.comments[0].seenRound, 5);
  // seen >= the reply's round means it reads as history, not a wall of unread.
  t('so old work reads as already seen', r.comments[0].seenRound >= r.comments[0].replies[0].round, true);
}

head('a stamped sidecar is left alone');
{
  // Backfilling seenRound on every load would mark a genuinely unread
  // thread as read the moment the document is opened.
  const r0 = review();
  r0.comments[0].round = 3;
  r0.comments[0].replies[0].round = 4;      // Claude spoke in round 4
  const f = fixture('doc.md', r0);          // ...and seenRound is absent
  const r = await loadReview(f.doc, TEXT);
  t('a thread that carries a round keeps its own seenRound', r.comments[0].seenRound, undefined);
  t('its rounds are untouched', [r.comments[0].round, r.comments[0].replies[0].round], [3, 4]);
}

head('a rename outside Margin (#126)');
{
  // The sidecar still carries the OLD document's name.
  const f = fixture('draft.md', review());
  const r = await loadReview(f.doc, TEXT);
  t('the review is recovered', r.comments.length, 1);
  t('the sidecar is renamed, not copied', existsSync(path.join(f.dir, 'draft.md.review.json')), false);
  t('it now sits under the new name', existsSync(sidecarPath(f.doc)), true);
}

head('refusing to claim a review that is not ours');
{
  // A leftover whose document was genuinely deleted, beside an unrelated file.
  const f = fixture('deleted-doc.md', review());
  writeFileSync(f.doc, 'Nothing here resembles the other document at all.\n');
  const r = await loadReview(f.doc, 'Nothing here resembles the other document at all.\n');
  t('nothing is adopted', r.comments.length, 0);
  t('the leftover is left alone', existsSync(path.join(f.dir, 'deleted-doc.md.review.json')), true);
}
{
  // Two orphans: too ambiguous to guess between them.
  const f = fixture('one.md', review());
  writeFileSync(path.join(f.dir, 'two.md.review.json'), JSON.stringify(review()));
  const r = await loadReview(f.doc, TEXT);
  t('two candidates means adopt neither', r.comments.length, 0);
  t('both leftovers are untouched',
    [existsSync(path.join(f.dir, 'one.md.review.json')), existsSync(path.join(f.dir, 'two.md.review.json'))],
    [true, true]);
}
{
  // An orphan with nothing anchored can't be verified, so it isn't claimed.
  const f = fixture('empty.md', review({ comments: [] }));
  const r = await loadReview(f.doc, TEXT);
  t('an unverifiable orphan is not adopted', existsSync(path.join(f.dir, 'empty.md.review.json')), true);
  t('and the document starts clean', r.comments.length, 0);
}

head('damaged input degrades to an empty review, never a throw');
{
  const f = fixture('doc.md', review());
  writeFileSync(sidecarPath(f.doc), '{ not json');
  const r = await loadReview(f.doc, TEXT);
  t('unparseable sidecar', r.comments.length, 0);
}
{
  const f = fixture('doc.md', review({ version: 99 }));
  const r = await loadReview(f.doc, TEXT);
  t('a version we do not understand', r.comments.length, 0);
}

rmSync(base, { recursive: true, force: true });
rmSync(build, { recursive: true, force: true });
done('sidecar');
