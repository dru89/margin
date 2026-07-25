# Review surface — design spec

**Status:** model settled with Drew (2026-07-25). Nothing here is built.
**Covers:** #84, #88, #89, #90, #98, #100, #102, #103, #104, #121, #128.

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

**An orphaned thread keeps its place in the list**, at the last
position where its text was actually found. The data supports this:
`reanchor()` preserves `from`/`to` when it orphans, and
`refreshAnchors()` skips orphaned anchors on save, so the offsets
freeze rather than drift. Its stored quote is the only remaining
evidence of what it was about, so the card keeps showing it — which is
most useful sitting where the text used to be. (Offsets are clamped
for sorting: heavy editing can leave a frozen offset past the end of a
now-shorter document.)

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

**Within a card, messages run oldest first** — the order the
conversation happened in. A thread read backwards is incoherent, since
every reply refers to what came before it, and putting the newest at
the top costs the reader that thread of reference to save a scroll the
state edge has already made unnecessary.

That means **the card head carries state, not an author**: the state
label, the anchored quote, and the round of the latest activity.
Authorship belongs to each message. A head showing the latest author
above an older first message is what makes a thread look like it ran
backwards.

**Round stamps appear only on items older than the current round**, and
are spelled out (`Round 3`). A stamp on every card is noise — while
working in round 5, "round 5" tells the reader nothing the state has
not already said. Restricting it to older items means the number always
carries information: this has been sitting unanswered for two rounds.
Because it is then rare, the full word fits where a code like `r3`
would have been needed.

`#3` is avoided deliberately. Margin borrows pull-request vocabulary
throughout, so `#3` reads as an issue or PR number. The absolute date
lives in the tooltip (`Round 3 · 24 Jul`) rather than on screen.

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

**Settled threads stay in the list**, collapsed below a fold at the
end, one line each, expandable. Keeping them is a decision to revisit
only if documents accumulate enough to make the fold useless.

**The sidebar and the document scroll independently**, as today. The
alternative — floating each card beside its anchor, the Google Docs
model — reads better until several comments cluster on one paragraph,
and then it needs a collision solver. In a dense review that is the
common case, not the edge case. Independent scrolling has a known
weakness (a lone comment in a long document sits nowhere near its text
until clicked) and no open-ended design work behind it.

**What clears unread.** Cards render fully expanded today and there is
no collapse gesture, so "seen" has to hang on something that already
exists:

| gesture | effect | why |
| --- | --- | --- |
| clicking the card | `seenRound` = latest agent round | Already focuses the thread and highlights its anchor — a deliberate "I'm looking at this" that needs no new control |
| Mark all read | clears every unread | In the summary bar, for the round you skim and accept wholesale |
| scrolling past | nothing | Scroll tracking marks things read that were never looked at, and the cost of a false read here is a lost reply |

`seenRound` is the cheapest thing in this spec to remove. It earns its
place on one case: taking another turn before finishing the previous
one's replies. Round-only highlighting would drop the unread ones out
of "new" the moment the next round lands, silently — #104 again, in a
form that is harder to notice.

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

## 7. Linking a suggestion to the comment it answers

Claude often replies to a comment *and* proposes an edit. Today those
are two unrelated objects that reference each other only in prose —
which is why it writes "see my thread reply", and why that reads as a
layout problem (#100) when it is a data one. The tools cannot express
the relationship, so it gets expressed in English, and English does not
render.

One optional field:

```ts
interface Suggestion { inReplyTo?: string; /* thread id */ }
```

Plus an optional `in_reply_to` on the `suggest_edit` tool, and a prompt
line telling the agent to link an edit that answers a comment instead
of describing the link.

**The field lives on the suggestion, which gives both directions from
one place.** A thread's linked edits are found by scanning suggestions
for its id — no second field, nothing to keep in sync, no way for the
two ends to disagree.

### Link, don't merge

The two stay separate cards. They have different lifecycles (open /
resolved versus pending / accepted / rejected), different verbs (reply
and resolve versus accept and reject), and often different anchors —
you comment on a sentence and Claude edits three words inside it, or
edits the introduction because that is what contradicts you. A merged
card carries two status models and has to pick one anchor and lie about
the other.

### Pointers, not nesting

**Every card keeps its own position in document order.** Nesting a
suggestion inside its thread would have made a card sort somewhere
other than its own anchor — the first exception to §4, and every later
feature would have cited it.

Instead each card carries a pointer to its counterpart:

- On the **suggestion**: a row identifying the thread it answers.
- On the **thread**: a row per linked edit, showing enough of the
  quoted text to say *where* the change is. Several edits group under
  one expandable row rather than becoming several chips.

Clicking a pointer jumps to the counterpart. **Focusing a card also
highlights its counterpart** — the sidebar already pairs a card with
its anchor (`usePair`); extending that pairing to the linked card means
you see the relationship without leaving where you are. Glance for
free, jump when you want the detail.

The cost: you cannot read both in full at once. Accepted — the
alternative is duplicating a card in two places or breaking document
order, and both are worse.

### One comment, many edits

The multiplicity that occurs is **one comment producing several edits**
— "change all C+I to C&I", "give everyone a first and last name". The
field on the suggestion handles this: N suggestions carry the same
thread id. A single suggestion answering several unrelated comments is
rare enough not to model, and a single id keeps the render unambiguous.

**Deciding every linked edit does not resolve the thread, and does not
prompt to.** The edits being handled is not evidence the comment is
answered — the author may have meant something broader than the edits
Claude found. Resolving stays a deliberate act. What changes is that
the pointer rows stop being work: once an edit is decided its row is no
longer a call to action. Rows for decided edits collapse into a single
muted line recording what happened, rather than vanishing, because that
line is the evidence you would resolve the thread *on*.

**"Accept all" is deliberately not specified here.** It is the obvious
affordance once N edits hang off one instruction, and it is also a
bulk, irreversible action over changes that may be spread across more
document than fits on screen. It should not be designed in the same
pass as the model it depends on, and it should not ship before #128 —
accepting a suggestion is currently unreversible in the review even
though its text edit lands on CodeMirror's undo stack, so undo desyncs
the document from the sidecar. A single accept has to be recoverable
before a bulk one is offered.

## 8. Composer and editability (#121, #89)

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

## 9. @-references as chips (#90)

Store as plain `@path` text; render as a chip. Storage stays plain so
the reference survives a round trip through the agent unchanged, and so
a sidecar remains readable.

- Clicking a chip opens that file in the window.
- A chip whose file no longer exists renders in the orphaned style —
  same vocabulary as a lost anchor.
- The agent can emit them, and they render identically. This is why
  the plain-text storage matters.

## 10. TK markers (#84)

Answering the question in the issue: TK handling **is** shipped, but
only in the agent prompt — it treats `(TK: …)` as an author note and
answers it. No UI has ever highlighted TK, deliberately (DECISIONS §8).
So the observed behaviour was correct.

Proposed, low priority: a quiet inline decoration on TK markers so the
author can see what the agent will treat as a note before submitting.
Same texture as the draft anchor, different hue. If it makes the
document noisy in practice, drop it — the prompt behaviour is the
feature and it works.

## 11. Build order

The state model is the dependency; everything else reads from it.

1. `round` / `seenRound` on the three types, stamped at creation,
   backfilled on load. Nothing visible changes.
2. Derived state + the leading-edge vocabulary (§2, §3).
3. Summary bar, filter, settled fold (§4) — closes #104, #88.
4. Round header (§5) — closes #100, #103.
5. Intra-suggestion word diff + removal rendering (§6) — closes #98,
   #102.
6. Draft editing (§7) — closes #89, #121.
7. Chips (§9) — closes #90. Independent of 1–6; can move earlier.
8. `inReplyTo` + pointer rows (§7) — needs 1–2 for state, and #128
   settled before any bulk accept.

## Settled with Drew (2026-07-25)

1. **Ordering** — document order plus a filter, confirmed. Not grouped
   by state.
2. **Unread** — kept. The mechanism is `seenRound` advanced by clicking
   the card; the case it earns its place on is taking another turn
   before finishing the previous one's replies.
3. **Settled threads** — keep in the sidecar, collapsed below a fold.
   Revisit only if volume makes that useless.
4. **Chips** — files only. Nothing else in the comment system needs
   one. The nearest future candidate is skills as slash-commands, not
   dates or links.
5. **Linked suggestions** — pointers both ways, no nesting, no
   auto-resolve, no prompt to resolve.

## Still open

- **Undo (#128)** is a prerequisite for "accept all" and a bug in its
  own right. Not solved by this spec.
