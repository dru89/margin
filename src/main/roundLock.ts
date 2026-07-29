/**
 * One review round per document at a time (spec §7, #170).
 *
 * **The lock is held against the document, in the main process, for the
 * life of a turn.** Not the window — two windows on one project is a
 * feature (§8) — and not the project, since two projects can share a
 * document (§6). What must never happen is two turns mutating one review
 * sidecar, which is the single failure in this area that corrupts rather
 * than confuses.
 *
 * **Hardening, not an emergency.** The common case is already
 * unreachable: `openFile` dedupes on the resolved path, so a document is
 * open in exactly one window, and `submitReview` runs against the
 * calling window's own document. The reachable case is narrower —
 * `path.resolve` does not resolve symlinks, so a chapter symlinked into
 * another folder presents two distinct paths for one file, defeating the
 * dedupe and allowing two windows and two concurrent rounds against one
 * sidecar. Overlapping projects make exactly that arrangement more
 * likely.
 *
 * Hence the real path as the key. It lives here rather than in
 * `src/shared/` on purpose: single-writer is a guarantee *this host*
 * offers, and shared logic must not come to assume it (DECISIONS §77).
 */
import { promises as fs } from 'fs';
import path from 'path';

interface Held {
  /** The path the running round was submitted under, for the message. */
  openedAs: string;
  startedAt: number;
}

const held = new Map<string, Held>();

/**
 * A document's identity for locking: its real path.
 *
 * Falls back to `path.resolve` when the file cannot be resolved — a
 * document that is mid-rename or gone is not a reason to refuse a lock,
 * and the round will fail on its own terms a moment later with a better
 * message than this one could give.
 */
export async function documentKey(filePath: string): Promise<string> {
  return fs.realpath(filePath).catch(() => path.resolve(filePath));
}

/**
 * Why a second submit was refused.
 *
 * Naming *where* the round is running is the whole point of the message
 * when two paths reach one file: "already running" is baffling when the
 * window you are looking at is idle, and the other path is the fact that
 * explains it.
 */
export function refusalMessage(ownPath: string, openedAs: string): string {
  return openedAs === ownPath
    ? 'A review is already running on this document.'
    : `A review is already running on this document — it is open as ${openedAs}.`;
}

export interface RoundLease {
  /** Idempotent, and never frees a lock someone else has since taken. */
  release(): void;
}

/** Take the lock, or throw with a message naming where the round is. */
export async function acquireRoundLock(filePath: string): Promise<RoundLease> {
  const key = await documentKey(filePath);
  const existing = held.get(key);
  if (existing) throw new Error(refusalMessage(filePath, existing.openedAs));
  const entry: Held = { openedAs: filePath, startedAt: Date.now() };
  held.set(key, entry);
  return {
    release() {
      // Identity, not just presence: a late release must not evict the
      // round that legitimately took the key afterwards.
      if (held.get(key) === entry) held.delete(key);
    },
  };
}

/** Is a round running on this document, by any of its paths? */
export async function roundRunningOn(filePath: string): Promise<boolean> {
  return held.has(await documentKey(filePath));
}

/** How many rounds are in flight (diagnostics and tests). */
export function roundsInFlight(): number {
  return held.size;
}
