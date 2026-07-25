# Review surface — design spec

**Status:** draft for review. Nothing here is built.
**Covers:** #84, #88, #89, #90, #98, #100, #102, #103, #104, #121.

## The problem

Eleven issues describe one failure from different angles: **the review
sidebar cannot say what happened in the last turn.** It lists open
threads and pending suggestions, and that is all it knows. So:

- new replies from Claude are indistinguishable from ones read three
  rounds ago (#104)
- Claude's prose response lives in the discussion dock while the reply
  it refers to lives in the sidebar, so "see my thread reply" means go
  hunting (#100, #103)
- there is no way to tell what is queued for the next round from what
  is already settled (#104)

Fixing these one at a time produces a sidebar with a decoration per
issue and no coherent story. This spec proposes the state model first,
then the visual language that expresses it.

## 1. The missing fact: round provenance

`CommentThread` and `Reply` carry `createdAt` and `author`. Neither
carries the round it belongs to, and no record exists of when a round
ran. **The sidebar cannot compute "new since my last turn" from the
data it has.** Every symptom above follows from that.

Add one field, in three places:

```ts
interface CommentThread { round: number; seenRound?: number; /* … */ }
interface Reply         { round: number; /* … */ }
interface Suggestion    { round: number; /* … */ }
```

- `round` — the review round during which this was authored. Stamped on
  creation from `ReviewData.round`, by both the user and the agent
  tools. Immutable.
- `seenRound` — the highest round whose activity on this thread the
  author has actually looked at. Written by the UI, never by the agent.

`ReviewData.round` already exists and already increments per turn. This
is the only schema change the spec needs.

**Migration.** Existing sidecars have no stamps. On load, backfill
missing `round` with `0` and `seenRound` with `ReviewData.round`, so
prior work reads as settled history rather than a flood of unread. No
sidecar is rewritten until its document is next saved.

## 2. Thread state

States are **derived, never stored** — storing them means two sources of
truth and a migration every time the rules change. Given a thread `t`
and the review's current round `r`:

| state | rule | means |
| --- | --- | --- |
| **Draft** | `t.round === r` and the round hasn't been submitted | You wrote this; it hasn't been sent |
| **Awaiting** | last activity is yours, `round < r` | Sent, Claude hasn't answered |
| **Unread** | last activity is the agent's, `round > (t.seenRound ?? -1)` | Claude answered and you haven't looked |
| **Read** | last activity is the agent's, already seen | Answered, you've seen it |
| **Settled** | `t.status === 'resolved'` | Done |

**Orphaned is a flag, not a state.** An anchor can be lost in any of
the above, and the thread still needs its state shown. It renders as a
badge on the card plus loss of the document highlight.

Suggestions collapse to three: **Draft** (yours, unsent), **Pending**
(awaiting your accept/reject), **Decided** (accepted or rejected).

### Deliberately not modelled

There is no "needs a reply from you" state. Whether Claude's answer
asks a question or merely reports is not knowable from the data, and
guessing produces a badge that is wrong often enough to be ignored.
**Unread** is the honest version: it says you haven't looked, which we
do know. If a stronger signal is wanted later, the agent should mark it
explicitly through a tool argument rather than have the UI infer it.

## 3. Visual language

One rule: **state is carried by the card's leading edge, authorship by
colour, operation by the diff.** These are three independent axes today
fighting over the same pixels.

- **Unread** — a filled dot on the leading edge, and the card's rule in
  the agent colour. Clears on view (see §4).
- **Draft** — dashed leading edge, matching the dashed anchor
  decoration already used in the document for an unsubmitted composer
  (§64/#87). Same meaning in both places: written, not committed.
- **Awaiting** — leading edge in the user colour, muted. Quiet: this is
  the normal state of a submitted round and shouldn't compete.
- **Read** — no leading edge.
- **Settled** — collapsed to one line, below the fold (§5).

Nothing blinks, and nothing uses colour alone: the dot is a shape
difference, the dash is a texture difference.

## 4. Ordering, grouping, and what clears "unread"

**Order by document position. Always.** The sidebar is a margin; its
job is to correspond to the text beside it. Sorting by recency or
grouping by state breaks the spatial memory that makes a margin
readable, and means a card moves when its state changes — the exact
complaint in #88 about a comment sliding away after submission.

**Answer "what's new" with a summary bar, not with order.** A single
row above the list:

```
3 unread · 2 queued · 5 settled            [ Unread ]  [ All ]
```

Counts are always visible; the filter narrows the list without
reordering it. This gives #104 its answer — what's new, what's queued,
what's done — while a card stays where the document put it.

**Settled threads collapse below a fold** at the end of the list, one
line each, expandable. They are history, not work.

**`seenRound` advances when the thread is expanded**, not when it
scrolls past. Scroll-based read tracking marks things read that the
user never looked at, and the cost of a false "read" here is a lost
reply from Claude.

## 5. Where a turn's response lives (#100, #103)

Root cause: a turn produces two kinds of output that go to two
surfaces. The prose summary goes to the project discussion dock; the
per-thread replies and suggestions go to the sidebar. Claude writes
"see my thread reply" in one place and the reply is in the other.

**Keep both surfaces, connect them with a round header.** When a round
completes, the sidebar gains a header at the top:

```
Round 4 · Claude replied to 2 threads, proposed 3 edits
  ↳ [ thread: "moved from C+I…" ]  [ thread: "TIM program" ]  [ 3 suggestions ]
```

Each entry jumps to the card and expands it. The header is dismissible
and disappears once every item in it has been seen.

The prose stays in the discussion dock — it is about the document as a
whole and does not belong to any one thread. What changes is that it is
no longer the *only* record that a turn produced anything.

**Not proposed:** moving thread replies into the discussion dock. The
dock is project-scoped and shared across documents; per-thread replies
are document- and anchor-scoped. Merging them would lose the anchor.

## 6. Suggestions: diff granularity and removals (#98, #102)

**Diff within the suggestion, not across the anchor.** Today the whole
anchored range renders struck and the whole replacement renders
inserted, so `C+I → Commerce & Identity (C&I)` displays as two full
clauses when three words changed. Compute a word-level diff between
`anchor.quote` and `replacement` at render time and mark only the
changed spans. **No schema change** — both strings are already stored;
this is presentation.

This is the same code path in the inline decoration and the sidebar
card, and it is what #102 is really about: a pure deletion currently
renders as "everything struck, nothing inserted", which reads as a
glitch rather than as a deletion.

**Colour by operation, not by author.** Insertions in the agent colour,
deletions in `--danger`. #102 asks whether a deletion-only suggestion
should read red rather than green — yes, and the rule that produces
that answer is that the colour describes what will happen to the text.

**A deletion-only suggestion still gets an accept/reject pill.** It has
no inserted half to hang the pill on today, which is why the control
goes missing. The pill attaches to the struck range instead.

## 7. Composer and editability (#121, #89)

Carried from #121, unchanged: **one composer.** Committing a comment
already stages it without sending, so several drafts before a round
already work; a second composer would be a second draft buffer, not a
second comment.

- Empty composer → re-targets freely on a new selection.
- Composer with text → keeps its anchor, does not re-target, takes
  focus. Nothing typed is ever discarded by a misclick.

**Anything in Draft state is editable and deletable** (#89). It hasn't
left the building, so the asymmetry where a queued discussion message
can be deleted but not edited, and an inline comment neither, has no
justification. Once a round is submitted, its contents are history and
become read-only.

**Submission is never blocked by an open draft.** The submit popover
already enumerates what travels with the round; an unfinished comment
gets a line there saying it isn't included. A disabled primary action
would have to explain itself, and this surface already exists to
answer the question.

## 8. @-references as chips (#90)

Store as plain `@path` text; render as a chip. Storage stays plain so
the reference survives a round trip through the agent unchanged, and so
a sidecar remains readable.

- Clicking a chip opens that file in the window.
- A chip whose file no longer exists renders in the orphaned style —
  same vocabulary as a lost anchor.
- The agent can emit them, and they render identically. This is why
  the plain-text storage matters.

## 9. TK markers (#84)

Answering the question in the issue: TK handling **is** shipped, but
only in the agent prompt — it treats `(TK: …)` as an author note and
answers it. No UI has ever highlighted TK, deliberately (DECISIONS §8).
So the observed behaviour was correct.

Proposed, low priority: a quiet inline decoration on TK markers so the
author can see what the agent will treat as a note before submitting.
Same texture as the draft anchor, different hue. If it makes the
document noisy in practice, drop it — the prompt behaviour is the
feature and it works.

## 10. Build order

The state model is the dependency; everything else reads from it.

1. `round` / `seenRound` on the three types, stamped at creation,
   backfilled on load. Nothing visible changes.
2. Derived state + the leading-edge vocabulary (§2, §3).
3. Summary bar, filter, settled fold (§4) — closes #104, #88.
4. Round header (§5) — closes #100, #103.
5. Intra-suggestion word diff + removal rendering (§6) — closes #98,
   #102.
6. Draft editing (§7) — closes #89, #121.
7. Chips (§8) — closes #90. Independent of 1–6; can move earlier.

## Open questions

1. **Ordering.** This spec commits to document order plus a filter.
   The alternative is grouping by state, which surfaces work faster but
   makes cards move as their state changes. Worth confirming — it is
   the decision the rest of §4 hangs from.
2. **Does an agent reply always deserve "unread"?** As specified, yes.
   If a reply that merely acknowledges shouldn't demand attention, the
   agent needs to say which kind it is, which means a tool-argument
   change and a prompt change.
3. **Settled threads: keep or archive?** Collapsed below a fold here.
   If a document accumulates hundreds over its life, they may want to
   leave the sidecar entirely.
4. **Chips for anything besides files?** #90 mentions dates and links.
   Only files are specified here, because only files have a defined
   click target.
