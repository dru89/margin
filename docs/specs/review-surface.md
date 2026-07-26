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
| **Draft** | latest activity is *yours*, `round >= r` | You wrote this; it hasn't been sent |
| **Awaiting** | latest activity is yours, `round < r` | Sent, no answer yet |
| **Unread** | latest *external* round `> (t.seenRound ?? -1)` | Someone else spoke and you haven't looked |
| **Read** | latest activity is external, already seen | Answered, you've seen it |
| **Settled** | `t.status === 'resolved'` | Done |

Two things implementation settled that the rules above had glossed:

**Draft needs authorship, not just the round number.** `ReviewData.round`
increments at the *top* of `submitReview`, so submitting moves the
counter past everything the author has written — which is what makes
"unsent" computable at all. But the agent's output for round N also
carries N and stays there until the next submit, so the number alone
cannot separate the two. It is *your* writing at the current round that
is a draft.

**"The agent" is really "not you".** A thread imported from a linked
Google Doc is attributed to `user` (it isn't the agent's) but was
written by a collaborator, so it must not read as your draft. The test
is external authorship: `author === 'agent'`, or an imported thread, or
a reply carrying `collaborator`. Note that a reply *you* send to the Doc
carries `driveReplyId` but no `collaborator`, which is what keeps it
yours.

Unread therefore tracks the latest **external** round rather than the
latest activity, so a thread where someone else spoke and you then
replied still counts as seen.

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

### Deliberately not modeled

There is no "needs a reply from you" state. Whether Claude's answer
asks a question or merely reports is not knowable from the data, and
guessing produces a badge that is wrong often enough to be ignored.
**Unread** is the honest version: it says you haven't looked, which we
do know. If a stronger signal is wanted later, the agent should mark it
explicitly through a tool argument rather than have the UI infer it.

## 3. Visual language

One rule: **state is carried by the card's leading edge, authorship by
color, operation by the diff.** These are three independent axes today
fighting over the same pixels.

- **Unread** — a filled dot on the leading edge, and the card's rule in
  the agent color. Clears on view (see §4).
- **Draft** — dashed leading edge, matching the dashed anchor
  decoration already used in the document for an unsubmitted composer
  (§64/#87). Same meaning in both places: written, not committed.
- **Awaiting** — leading edge in the user color, muted. Quiet: this is
  the normal state of a submitted round and shouldn't compete.
- **Read** — a quiet neutral spine (`--rule`), not nothing. Dropping the
  edge entirely on click made the card look like it had broken rather
  than settled; the spine stays, it just stops meaning anything.
- **Settled** — collapsed to one line, below the fold (§5).

Nothing blinks, and nothing uses color alone: the dot is a shape
difference, the dash is a texture difference.

**Hover and selected sit on different properties**, so hover, selected,
and selected-while-hovered are three visibly different things. Hover is
transient and gets the light touch — the surface lifts. Selected is
persistent and gets the structural one — the spine widens and a hairline
ring appears. Neither recolors the card: color is state, and selecting
a card must not appear to change what it is. They previously differed
only by a 40% versus 55% border tint, which is invisible.

**A card head is facts on the left, one action in the corner.** The facts
wrap among themselves and the action never moves: a thread carrying a
state label, an orphan badge, and a round stamp used to push Resolve onto
a line of its own, so the card reported its own width rather than its
state. When the row runs out of room the round stamp drops to a second
line, which is the right thing to lose.

**The spine stays inside the card.** It sits within the border rather
than straddling it — an edge hanging past the rounded corners draws the
eye to the overhang instead of to the state it is reporting.

**The operation is named in words and colored in the diff, not in the
label.** "Deletion" set in `--danger` shouted over every other card's
quiet uppercase; the word alone carries it, and the struck red text
says the rest. A deletion in a card reads the way one reads in the
document: ordinary text, struck through, on a red wash — not the
insertion color sitting on a red background.

**Within a card, messages run oldest first** — the order the
conversation happened in. A thread read backwards is incoherent, since
every reply refers to what came before it, and putting the newest at
the top costs the reader that thread of reference to save a scroll the
state edge has already made unnecessary.

That means **the card head never carries an author** — only the state
label, the anchored quote, and the round of the latest activity. The
author chip always introduces the content it wrote: a message in a
thread, or the diff in a suggestion. One position, whether or not a
thread happens to have replies.

The alternative — author in the head for single-message cards, inside
for threads — puts the same fact in two places depending on a detail
the reader shouldn't have to notice. It also reintroduces the reversed
reading: a head showing the *latest* author sits above an older first
message.

**Long threads collapse in the middle, never at the ends.** Past four
messages, the first and the last two stay open and everything between
folds into one line ("3 earlier replies"). The first message is the
question and the last is where things stand; those are the two a reader
needs.

Deliberately *not* collapsed by age. Folding anything from an earlier
round would hide the question in a two-message thread — the very thing
the reply is answering. Position, not age, is what makes a message
skippable.

Individual messages are not truncated. The agent's replies are short by
prompt design, and hiding prose the reader needs is worse than a
scroll.

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

**Order by document position. Always — and in one list.** Threads and
suggestions interleave; separate sections for each put a comment on the
first paragraph below a suggestion on the ninth, which is not what a
margin does. The sidebar's job is to correspond to the text beside it. Sorting by recency or
grouping by state breaks the spatial memory that makes a margin
readable, and means a card moves when its state changes — the exact
complaint in #88 about a comment sliding away after submission.

**The filter is "needs you", not "unread".** Unread changes the moment
the author looks at something, so a list filtered on it rearranges
itself as it is read — cards vanish mid-click. Outstanding work is the
stable question: a thread needs the author whenever the last word came
from someone else, and only replying, resolving or deciding removes it.
Reading is not responding.

Unread remains as a *state* on the card — it says what is new, which is
a different and still useful thing. It is simply not what a filter
should be built on.

**Whatever is selected stays visible**, even once it stops qualifying.
Acting on a card should not make it disappear from under the cursor; it
leaves the list when the author moves on.

**Answer "what's new" with a summary bar, not with order.**

```
7 need you · 2 not sent · 2 awaiting reply · 3 resolved
[ All ] [ Need you ]
```

**Facts on one line, the filter beneath them.** Counts and buttons on the
same row read as one control strip, so the counts looked clickable;
stacking separates what is stated from what is offered without having to
strip the buttons of their affordance. A single toggle chip carrying the
count was tried and reads worse — the paired toggle is the app's existing
vocabulary (it is what Write/Preview uses), and it makes the inactive
option visible rather than implied.

**The words say who holds the ball**, and the bar and the cards use the
same ones. "Queued" and "awaiting" were indistinguishable, and
"awaiting" read as though it might be waiting on the author:

| | means | card label |
| --- | --- | --- |
| **need you** | someone else spoke last, or an edit is undecided | *Unread*, or nothing once seen |
| **not sent** | your writing, still to go | *Not sent* |
| **awaiting reply** | sent, no answer yet | *Awaiting reply* |
| **resolved** | done — matching "Resolved & decided" below | *Resolved* |

**Settled threads stay in the list**, collapsed below a fold pinned to
the floor of the pane — not merely last. With little to review it
otherwise rendered straight after the empty state and floated mid-pane.
`margin-top: auto` takes the slack when the list is short and does
nothing once it scrolls, where the fold is already last.

**Opening the fold scrolls its heading to the top**, as far as the
scroll allows. Expanding something sitting on the floor would otherwise
reveal the items below the fold, off-screen. Instant rather than
animated: it is a disclosure, and a glide reads as more ceremony than
the action deserves. Keeping them is a decision to revisit
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

**At most three entries, in document order, then a hand-off.** A turn
can answer a dozen threads, and nothing in the data says which of them
matters most — so no ranking is attempted. The first three by document
position get an entry; the rest become "+N more — review all", which
**shares state with the All / Need you pair** — it presses in, and
pressing it again returns to All. A control that silently changes
something elsewhere and then looks unchanged leaves no visible way
back.

Each entry **centers** the card, **marks the passage in the document**
and gives the card a brief pulse. Landing a card barely inside the
viewport asks the reader to find it again, and moving only the sidebar
leaves them to locate the text themselves.

The jump is driven imperatively rather than by an effect watching the
active id — otherwise clicking the same entry twice does nothing,
because the state never changed. The pulse is a Web Animations call
rather than a class, because focusing a card changes its state and
rewrites its `className`, which would strip one. Both respect
`prefers-reduced-motion`. The pulse waits for the scroll to land
(`scrollend`, with a timeout fallback): fired together, it peaks while
the card is still traveling — usually off-screen — and is over before
it arrives. It also **dissolves at full width rather than shrinking
back** — a ring collapsing to nothing reads as a cut — over about 1.5s
with a soft, low-alpha color.

The header is dismissible and disappears once every item in it has been
seen or decided.

The prose stays in the discussion dock — it is about the document as a
whole and does not belong to any one thread. What changes is that it is
no longer the *only* record that a turn produced anything.

**Not proposed:** moving thread replies into the discussion dock. The
dock is project-scoped and shared across documents; per-thread replies
are document- and anchor-scoped. Merging them would lose the anchor.

## 6. Suggestions: diff granularity and removals (#98, #102)

**Trim the suggestion; do not diff it.** The whole anchored range used
to render struck with the whole replacement after it, so
`C+I → Commerce & Identity (C&I)` displayed as two full clauses when
three words changed. Strip the words the quote and the replacement share
at each end and show everything between as **one** deletion and **one**
insertion. No schema change — both strings are already stored.

A real diff is wrong here rather than merely different. Replacing
"alpha and beta" with "gamma and delta" shares the word *and*, and a
diff anchors on it: `[alpha|gamma] and [beta|delta]`. That reads as two
edits you could take separately, when a suggestion is one replacement
you accept or reject whole — and a suggestion that fragments into five
small swaps is harder to judge than the sentence it came from.

**Characters the two sides share at the edges stay outside the marks** —
whitespace *and* punctuation. They exist in both strings, so marking
them misreports something untouched and the highlight stops matching
the words that differ:

```
[-C+I,-]{+Commerce & Identity (C&I),+} where     two commas
(something [-parenthetical)-]{+in parentheses)+} two closing parens
```

The second reads worse, because a closing paren is half a matched pair
and two of them look like broken markup rather than repeated content —
but it is the same artifact, so one rule covers both.

**Never letters or digits.** Hoisting those cuts words in half
(`runn[-ing-]{+er+}`), trading one oddity for a worse one.

**And only when both sides have it.** Inserting a word into a sentence
adds a space as well as a word, so that space really is new and stays
inside the insertion; deleting a word takes its space with it.

Trimming also has no pathological case, so it needs no size cap.

The same trim drives the inline decoration and the sidebar card, so
the document strikes only the words that change rather than the whole
anchored range.

**A deletion-only suggestion still gets an accept/reject pill.** The
pill lives on the inserted half's widget, which used to be placed only
when there was a replacement — so a deletion had nothing to act on
inline (#102). The widget is now always placed and renders no inserted
text when there is none.

**The pill sits below the change and centered on the seam** between the
struck and inserted text. Above put it over the previous line, where it
read as annotating the wrong text; pinned to the left of the insertion
it hung off the end of the edit. A deletion has no seam, so its widget
is anchored mid-run instead and the pill centers on the words it removes
rather than trailing past them.

**Large changes are left to degrade.** A rewrite spanning several lines
renders as the old passage struck and the new one after it, which reads
as an old-then-new paragraph and is legible, but it doubles the text and
pushes the document down. If the change runs past the viewport its pill
can be off-screen. That is acceptable because **the sidebar card carries
the same Accept/Reject and is always reachable** — the inline pill is a
convenience for local edits, not the primary control. If it becomes a
problem the answer is to collapse very large inline suggestions to a
marker, not to make the floating pill cleverer.

**Color by operation, not by author.** Insertions in the agent color,
deletions in `--danger`. #102 asks whether a deletion-only suggestion
should read red rather than green — yes, and the rule that produces
that answer is that the color describes what will happen to the text.

Two places carry it, and one deliberately does not:

- **The kind label** — "Deletion" is set in `--danger`, "Edit" in the
  agent color. This is what makes the operation legible before the
  reader parses the diff.
- **The diff** — but at card strength, not document strength. The
  inline decoration in the document uses `--danger` at 9%, tuned for
  17px prose that has to stay readable underneath it. The same value in
  a 13px sidebar card reads as a gray smudge rather than as red. Cards
  run around 20%.
- **Not the leading edge.** That is state, and only state. A deletion
  sitting unread keeps a teal edge; coloring it red would mean an
  unread deletion and a read one look identical, which is the exact
  collapse §3 exists to prevent.

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

"With text" ignores whitespace, and in suggest mode an edited
replacement counts on its own — the replacement *is* the work there.

The composer's anchor is remapped through document changes like a review
anchor. It could previously be skipped, because a new selection
re-targeted the composer and it rarely outlived an edit; keeping it put
is precisely what makes the remap necessary. Text deleted from under an
open draft leaves it anchored to nothing, and it commits as orphaned
rather than onto whatever moved into its place.

**A draft belongs to its document, not to the window.** Documents in one
project share a window, so switching files parks the draft and coming
back restores it, re-resolved against whatever the file says by then.
Neither blocking the switch nor discarding the draft is right, and
bouncing back the way a refused re-target does is worst of all: switching
is often *because* of what is being drafted, since a `@path` chip is a
link to another file (§9). An empty composer is not parked — leaving with
nothing typed is what closing it means.

**Anything in Draft state is editable and deletable** (#89). It hasn't
left the building, so the asymmetry where a queued discussion message
can be deleted but not edited, and an inline comment neither, has no
justification. Once a round is submitted, its contents are history and
become read-only.

**An open edit box is not a second composer.** Both can be open at once,
and that is fine, because they are different in what they risk. A
composer holds text that exists nowhere else, so losing it loses work —
which is why a new selection cannot take it. An edit box holds a
*revision* to something already staged; abandoning it loses the revision
and the original survives intact. Closing one edit to open another would
destroy typing to prevent nothing, so any number may be open.

**Submission is never blocked, by an open draft or an open edit.** A
disabled primary action would have to explain itself, and the submit
popover already exists to say what travels with the round. It gets one
line per kind of uncommitted work:

- The composer's draft *survives* the round — it stays open, its anchor
  keeps being remapped — so its line is a fact: it isn't included.
- An open edit box *cannot* survive: the item it is changing becomes
  history the moment the round goes, so the box closes and the typing
  goes with it. Its line is therefore a warning, said before the click
  rather than discovered after it.

Submitting deliberately does not save an open edit. The author typed it
but never confirmed it, and committing half a rewrite into a round sends
it to Claude and makes it part of the record — worse than losing it,
because it cannot be taken back.

## 9. @-references as chips (#90)

Store as plain `@path` text; render as a chip. Storage stays plain so
the reference survives a round trip through the agent unchanged, and so
a sidecar remains readable.

- **A chip resolves against the workspace file list, not the
  filesystem.** That is what confines references to the project without
  a containment check of its own: the scan is rooted at the project
  root, so anything outside names no file. Matching is exact on the
  relative path — fuzzy matching reads as helpful right up until two
  files share a basename.
- **Clicking follows the explorer's rule.** Markdown opens in Margin;
  anything else opens in its default app. Chips exist to point at
  anything in the project — the CSV behind a number, the diagram — and
  most of that is not markdown.
- A chip that names no file in the project is not a control, and
  renders in the orphaned style: same vocabulary as a lost anchor, and
  the same for a deleted file as for a path that was never here.
- The agent can emit them, and they render identically. This is why
  the plain-text storage matters — and why the main process validates
  independently of what the renderer chose to make clickable.

## 10. TK markers (#84)

Answering the question in the issue: TK handling **is** shipped, but
only in the agent prompt — it treats `(TK: …)` as an author note and
answers it. No UI has ever highlighted TK, deliberately (DECISIONS §8).
So the observed behavior was correct.

Proposed, low priority: a quiet inline decoration on TK markers so the
author can see what the agent will treat as a note before submitting.
Same texture as the draft anchor, different hue. If it makes the
document noisy in practice, drop it — the prompt behavior is the
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
6. Draft editing (§8) — closes #89, #121.
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
