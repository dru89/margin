# Comment-anchor experiments — pinned findings (2026-07-21)

One-shot experiments on live Google Docs with UI-created anchored
comments (the API cannot create them). Operations were performed via
`batchUpdate`; anchor outcomes were verified **by a human in the Docs
UI**, because — finding zero — anchor state is entirely unobservable
through public APIs. These results cannot be re-run automatically;
each experiment consumes its hand-decorated fixture. Treat this file
as the record.

## Finding 0 — anchor state is API-invisible (both directions)

- `comments.list` returns an opaque `anchor` id that is **unchanged
  after the anchored text is deleted outright**. Orphaned and healthy
  comments are indistinguishable programmatically.
- Comment ranges do not appear in `documents.get` in any view.
- Consequence: automated comment tests max out at **thread survival +
  quotedFileContent + replies/resolved** (the existing live tier).
  Anchor-behavior claims can only be validated by human inspection —
  which is what the experiments below did, once, deliberately.

## Finding 1 — the anchor-preserving splice WORKS (Experiment A)

Full replacement of an anchored sentence via: insert the new text
strictly inside the range (at `start + 1`) → delete the original's
first character → delete the original's remainder. **Verdict (UI): the
comment survived and highlights the entire new sentence.** The v2
splice design is validated end-to-end for whole-range replacement.

## Finding 2 — block rebuild orphans, edits elsewhere don't (Experiment B)

- Inserting text in a *different* paragraph: both comments stayed
  anchored (UI).
- Delete-then-reinsert of the paragraph containing an anchored word:
  that comment became **“Original content deleted”** and hidden; the
  other comment was untouched. This is CP-8 observed directly, and the
  exact failure mode the splice exists to avoid.

## Finding 3 — boundary insertions do NOT extend the range (Experiment C)

- **End boundary:** inserting immediately after a single-character
  anchor `[x, x+1)` (at index `x+1`), then deleting the character →
  **orphaned.**
- **Start boundary:** inserting at the range's start index, then
  deleting the original word → **orphaned.**

Consequences for the splice implementation:

- The insertion point must be **strictly inside**: `start + 1` is
  correct; `start` and `end` are both fatal.
- **Single-character anchors cannot be preserved** — there is no
  strictly-inside insertion point. The degenerate-case fallback
  (accept the orphan) is now known-necessary, not hypothetical.
- The delete-flanks order (left flank shrinks the range from `start`,
  remainder deleted after the inserted text) held the range open
  throughout; combined with Finding 1 the full invariant is confirmed:
  *the range must never hit zero width, and growth happens only via
  strictly-interior insertion.*

## Not yet probed (needs fresh UI-decorated fixtures)

Suggesting-mode interaction with the splice; concurrent edits during a
splice; anchors spanning multiple blocks; anchors inside table cells
under cell-level splices (the fixture's cell comment remains intact
and unprobed — it is part of the durable read fixture, do not consume
it).
