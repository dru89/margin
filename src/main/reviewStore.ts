import { promises as fs } from 'fs';
import path from 'path';
import { emptyReview, type ReviewData } from '@shared/types';
import { reanchor } from '@shared/anchors';

export function sidecarPath(docPath: string): string {
  return `${docPath}.review.json`;
}

const SUFFIX = '.review.json';

/** Every anchor a review carries, whatever its state. */
function anchorsOf(data: ReviewData) {
  return [
    ...data.comments.map((c) => c.anchor),
    ...data.suggestions.filter((s) => s.status === 'pending').map((s) => s.anchor),
  ];
}

/**
 * Recover the review of a document renamed outside Margin (#126).
 *
 * The sidecar is keyed by path, so `draft.md` -> `final.md` leaves
 * `draft.md.review.json` behind with nothing to load it, and the explorer
 * hides `.review.json`, so the work looks deleted rather than stranded.
 *
 * A sidecar whose document is gone is a candidate. It is only adopted when
 * there is exactly one and its anchors actually resolve against this file:
 * a rename keeps the text, so its quotes still land. That check is what
 * separates a rename from an unrelated deleted document — a new file that
 * happens to sit beside someone else's leftovers resolves nothing.
 *
 * Adoption renames the sidecar rather than copying it, so nothing is
 * duplicated and nothing is destroyed.
 */
async function adoptRenamedSidecar(docPath: string, content: string): Promise<string | null> {
  const dir = path.dirname(docPath);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const orphans: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(SUFFIX)) continue;
    try {
      await fs.stat(path.join(dir, name.slice(0, -SUFFIX.length)));
    } catch {
      orphans.push(path.join(dir, name)); // its document is gone
    }
  }
  if (orphans.length !== 1) return null; // nothing to adopt, or too ambiguous to guess
  let raw: string;
  let data: ReviewData;
  try {
    raw = await fs.readFile(orphans[0], 'utf8');
    data = JSON.parse(raw) as ReviewData;
  } catch {
    return null;
  }
  if (data.version !== 1) return null;
  const anchors = anchorsOf(data);
  // Nothing anchored means nothing to verify against, so don't guess.
  if (anchors.length === 0) return null;
  const resolved = anchors.filter((a) => !reanchor(content, a).orphaned).length;
  if (resolved * 2 < anchors.length) return null;
  try {
    await fs.rename(orphans[0], sidecarPath(docPath));
  } catch {
    return null;
  }
  return raw;
}

export async function loadReview(docPath: string, content: string): Promise<ReviewData> {
  const name = path.basename(docPath);
  let raw: string | null = null;
  try {
    raw = await fs.readFile(sidecarPath(docPath), 'utf8');
  } catch {
    raw = await adoptRenamedSidecar(docPath, content);
  }
  if (raw === null) return emptyReview(name);
  try {
    const data = JSON.parse(raw) as ReviewData;
    if (data.version !== 1) return emptyReview(name);
    data.discussion ??= []; // sidecars written before the discussion feature
    backfillRounds(data);
    // The file may have been edited outside the app since the sidecar was
    // written — re-anchor everything against the current content.
    for (const c of data.comments) c.anchor = reanchor(content, c.anchor);
    for (const s of data.suggestions) {
      if (s.status === 'pending') s.anchor = reanchor(content, s.anchor);
    }
    return data;
  } catch {
    return emptyReview(name);
  }
}

/**
 * Sidecars written before round stamps existed carry none. Backfill them
 * as round 0 — history — and mark every thread seen, so opening an old
 * review reads as settled work rather than a wall of unread. Nothing is
 * rewritten until the document is next saved.
 */
function backfillRounds(data: ReviewData): void {
  for (const c of data.comments) {
    c.round ??= 0;
    for (const r of c.replies) r.round ??= 0;
    c.seenRound ??= data.round;
  }
  for (const s of data.suggestions) s.round ??= 0;
}

export async function saveReview(docPath: string, review: ReviewData): Promise<void> {
  await fs.writeFile(sidecarPath(docPath), JSON.stringify(review, null, 2) + '\n', 'utf8');
}
