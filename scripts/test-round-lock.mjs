#!/usr/bin/env node
/**
 * One review round per document (spec §7, #170).
 *
 * The decision under test: **the lock is keyed on the document's real
 * path**, not on the window and not on the project. Two windows on one
 * project is a feature; two projects sharing a document is a feature;
 * two turns mutating one review sidecar is the one failure in this area
 * that corrupts rather than confuses.
 *
 * The case that makes the real path load-bearing is the symlink:
 * `path.resolve` does not follow one, so a chapter linked into another
 * folder presents two distinct paths for one file — defeating the
 * open-file dedupe that makes the common case unreachable.
 *
 *   node scripts/test-round-lock.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { load, reporter } from './lib/compile.mjs';

const { mod, dir: build } = await load('src/main/roundLock.ts');
const { acquireRoundLock, documentKey, refusalMessage, roundRunningOn, roundsInFlight } = mod;
const { t, head, done } = reporter();

const base = mkdtempSync(path.join(tmpdir(), 'margin-lock-'));
const doc = (rel) => {
  const abs = path.join(base, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, '# doc\n');
  return abs;
};
/** Take the lock and report the refusal instead of throwing. */
const tryLock = async (p) => {
  try {
    return { lease: await acquireRoundLock(p) };
  } catch (err) {
    return { refused: err.message };
  }
};

head('one round at a time, per document');
const a = doc('one.md');
const first = await tryLock(a);
t('the first submit takes it', !!first.lease, true);
t('a second on the same path is refused', (await tryLock(a)).refused, 'A review is already running on this document.');
// The lock is the document's, so an unrelated document is unaffected.
const b = doc('two.md');
const other = await tryLock(b);
t('a different document runs anyway', !!other.lease, true);
t('two rounds in flight', roundsInFlight(), 2);
other.lease.release();
first.lease.release();
t('released', roundsInFlight(), 0);
const again = await tryLock(a);
t('and can be taken again', !!again.lease, true);
again.lease.release(); // leave the registry empty for what follows

head('the symlink — the case the resolved-path dedupe misses');
// `openFile` dedupes on path.resolve, which does not follow links, so
// these two paths open two windows over one file (spec §7).
const real = doc('chapters/one.md');
const linkDir = path.join(base, 'linked');
mkdirSync(linkDir, { recursive: true });
const link = path.join(linkDir, 'one.md');
let symlinked = true;
try {
  symlinkSync(real, link);
} catch {
  symlinked = false;
  console.log('skip  symlink cases (not permitted here)');
}
if (symlinked) {
  t('two paths, one document', (await documentKey(link)) === (await documentKey(real)), true);
  // The thing the whole entry exists to prevent.
  const viaReal = await tryLock(real);
  const viaLink = await tryLock(link);
  t('the round is taken through the real path', !!viaReal.lease, true);
  t('and refused through the link', viaLink.refused !== undefined, true);
  // "Already running" is baffling when the window you are looking at is
  // idle; the other path is the fact that explains it.
  t('the refusal names where it is running', viaLink.refused.includes(real), true);
  t('roundRunningOn sees it by either path', await roundRunningOn(link), true);
  viaReal.lease.release();
  t('releasing frees both paths', await roundRunningOn(link), false);
}

head('the refusal message');
t('same path — no point naming it', refusalMessage('/p/a.md', '/p/a.md'),
  'A review is already running on this document.');
t('another path — that is the explanation',
  refusalMessage('/link/a.md', '/real/a.md').includes('/real/a.md'), true);

head('releasing is safe to get wrong');
const c = doc('three.md');
const held = await tryLock(c);
held.lease.release();
held.lease.release(); // idempotent
t('a double release is harmless', roundsInFlight(), 0);
// The dangerous version: a late release evicting the round that
// legitimately took the key afterwards.
const next = await tryLock(c);
held.lease.release();
t('a stale release does not free the current round', await roundRunningOn(c), true);
next.lease.release();

head('a document that cannot be resolved');
// Mid-rename or gone. Refusing the lock here would block a round that
// is about to fail on its own terms with a better message.
const ghost = path.join(base, 'ghost.md');
t('falls back to the resolved path', await documentKey(ghost), path.resolve(ghost));
const ghostLock = await tryLock(ghost);
t('and still locks', !!ghostLock.lease, true);
ghostLock.lease.release();

rmSync(base, { recursive: true, force: true });
rmSync(build, { recursive: true, force: true });
done('round-lock');
