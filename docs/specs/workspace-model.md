# Workspace model — design spec

**Status:** settled with Drew (2026-07-27). Build order steps 1-4 are in
(#167, #168, #169, #170); §1-§5 and §7 describe what the app does.
Steps 5-7 are not built.
**Covers:** #124, #6, #107, and the window half of #2. Retires DECISIONS §63.

## The problem

**A project is currently something Margin infers, and the inference is
invisible, permanent, and occasionally wrong.**

`findWorkspaceRoot(filePath)` walks up for a `.margin/`, falls back to the
git toplevel, then to the file's own directory. The root is a property of
the *file*, so nothing the author does declares a project — it is derived
on their behalf. And `.margin/` is created as a side effect of ordinary
actions: queueing one discussion message, changing the model preference,
the agent writing its notes. Nothing asks, and the only surface is a
folder name in the explorer header.

The failure this produces is reachable in about three clicks, and only in
folders without git — because inside a repo the marker lands at the git
toplevel, which is right. Take `book/` with no repo:

```
open book/chapters/one.md, queue a message  →  book/chapters/ is now a project
open book/notes/ideas.md                    →  book/notes/ is now a second project
```

One book, two discussions, two sets of agent notes, and an explorer that
never shows the whole thing. Permanently, because the markers are on
disk, and silently, because nothing announced either.

That lands hardest on exactly the case #6 describes: importing writing
that already exists, rather than creating a project through Margin.

## 1. Adoption, not derivation

**The unit of selection is a folder, and selecting it is the
declaration.** This is VSCode's model, and the reason to copy it is not
familiarity: VSCode does not walk up. Open `book/` and `book/` is the
workspace. Open `book/chapter1/` and *that* is the workspace, with its
own settings, and `book/`'s are not consulted. Open `book/` and
`chapter1/`'s settings are inert.

Which means the `book/` + `chapter1/` + `chapter2/` case works *because*
there is no ancestor walk. The unit of selection is the statement of
intent, and there is nothing left to infer.

**What this trades away, deliberately: one file no longer maps to one
root.** §124 protected that property; adoption gives it up. Under
derivation `chapter1/foo.md` resolved to exactly one project. Under
adoption it belongs to whichever project is open. §6 is where that gets
paid for.

**What it buys, beyond intent: `findWorkspaceRoot` largely disappears.**
The root stops being computed from a path and becomes a property of what
was opened, which deletes the entire class of bugs #123 came from.

## 2. `margin.json` declares; `.margin/` stores

A visible, committed, hand-editable file at the project root, beside the
generated state — `package.json` next to `node_modules/`. Every root
marker worth copying is a file rather than a dotdir, because a dotdir is
easy to overlook and easy to gitignore by accident.

```json
{ "version": 1, "name": "2026 Self-Evaluation", "model": "opus", "effort": "high" }
```

- `name` — the project's title, independent of its folder name. Today
  `rootName` is the basename and cannot be anything else.
- `model` / `effort` — moved out of `.margin/project.json`, where they
  are invisible. Committed, so a preference travels with the project.

Deliberately thin. Everything else stays in `.margin/`: the discussion,
agent notes, proposals, staged proposal content, the Google Docs link.
Those are state Margin writes, not statements the author makes.

**Name:** plain `margin.json`. A collision needs another tool called
Margin looking for the same filename at a project root, and
`package.json` sets the precedent for not defensively decorating it.

**Migration is a read-fallback.** A folder holding `.margin/` but no
`margin.json` is a project — that is every project that exists today —
and `margin.json` is written the next time anything about the project
changes. Nothing to convert, nothing to lose.

## 3. Derive to find, never to create

Opening a *file* — from recents, drag-drop, the CLI, Open… — still walks
up. But only to find a declaration that already exists:

**`margin.json`, else a legacy `.margin/`, else nothing.**

No git fallback and no `dirname` fallback, because both invent projects
nobody declared. That is the whole of the accident above, and removing
the fallbacks removes it at the root rather than papering over it.

**This retires DECISIONS §63 entirely.** The marker-versus-git
precedence, "the deeper of the two wins", and the guard that stops the
walk before the home directory all exist to make *derivation* safe. There
is no derivation left to make safe. Git goes back to being a feature —
checkpoints and history — and stops being a boundary.

The answer to "why isn't this folder my project?" becomes "because
nothing declared it", which is something a person can check.

## 4. The pre-adoption state

A window holding a file that belongs to no project. **Its only job is to
avoid writing to disk without being asked** — it is not a mode, and
nothing should be built for it.

What works, because it lives in the file or beside it: reading, editing,
preview, comments, suggestions, accept/reject, anchors, git history. The
sidecar is a sibling of the document, so the review surface needs no
project at all.

What does not: the discussion, agent notes, proposals, the model
preference, the Google Docs link, project skills and `CLAUDE.md`.

**A review round is the moment we ask**, because a round writes notes and
can stage proposals — it would create `.margin/` as a side effect, which
is the thing being removed. So: reviewing your own writing is free;
bringing Claude in makes it a project.

Comments made before adoption are **pending, not wasted** — they persist
in the sidecar and the first round picks them up. That falls out of the
sidecar living beside the document; it is not a feature to build.

**Honest about its value:** on its own this state is a markdown editor
with an annotation system nothing consumes. That is fine, because its
purpose is the absence of a side effect, not a feature set. If it ever
looks like it is earning its own keep, that is a sign something has been
built for it that should not have been.

### Not now

Registering as a `.md` handler (`fileAssociations` in electron-builder)
would make "Open With → Margin" work. Worth having; worth *not*
contending for default handler, since Margin is a review app rather than
a general editor. Filed separately when wanted.

## 5. Adopting a folder

One small confirmation, not an OS folder picker — a bare picker lets
someone choose `/` and makes them think about paths at the moment they
are thinking about writing.

- Default: the file's parent folder.
- Offered when different: the git toplevel above it, since that is the
  most likely intended boundary.
- Escape: browse for something else.

Never reached when an ancestor already holds a declaration (§3).

Adopting writes `margin.json` immediately. The act and the record are the
same thing.

## 6. Overlapping projects

`book/`, `book/chapter1/` and `book/chapter2/` adopted separately are
three projects. Supported, and the reason to support it is that §1 makes
it fall out rather than needing a mechanism.

**A document's review is shared between them, and that is correct.** The
sidecar is a sibling of the document, so a comment left on
`chapter1/foo.md` from the `chapter1` project is visible on
`chapter1/foo.md` from the `book` project. A review is a property of the
document, the same reasoning that makes it survive a rename (§64).

**Project-scoped state is not shared, and that is also correct.** The
discussion, agent notes, proposals, model preference and project skills
belong to whichever project is open. The same document reviewed from
`book/` and from `chapter1/` gets different context — which is the point
of having chosen a folder.

### The shared round counter, and what it actually costs

**`ReviewData.round` is per document, but the discussion is per
project.** Under derivation those were one-to-one. Under adoption they
are many-to-one: many projects, one document, one counter.

**Nothing breaks.** The counter describes the *document*, and the sidecar
is the truth about the document. A round submitted from `chapter1/`
genuinely does send `book/`'s pending comments, because the agent's
`list_review_state` returns the whole sidecar — so a thread that starts
reading *awaiting reply* after someone else's round is not lying. It was
sent, and an agent did answer it or decline to. Every state derivation
stays internally correct, and anchors, suggestions, decisions and rename
adoption are round-independent.

Three consequences, all real, none corrupting, in order of how much they
actually matter:

- **The other project can send, and then freeze, a draft.** The one with
  teeth. A comment written in `book/` is editable until `chapter1/`
  submits; afterwards its round is behind the counter and it goes
  read-only (review-surface §8). Correct — it really was sent — but it
  changes what the author *can do* with no action in the window they are
  looking at, and nothing on screen explains why.
- **The number is wrong per project, cosmetically.** The toolbar chip and
  the card stamps count the document's rounds, so `book/` can say
  "Round 7" having run one round itself.
- **The agent's memory is thinner than it could be.** In `book/` it sees
  review items stamped with rounds whose notes live in `chapter1/`.
  Mild, for three reasons: every round is already a fresh session with no
  resumption, so reading prior rounds it does not remember writing is the
  everyday condition rather than an anomaly; the decision record that
  matters — rejected suggestions and their `decisionComment` — lives in
  the *sidecar*, which is the shared part, so it cannot re-propose
  something already declined; and its write surfaces are notes and staged
  proposals only, so thin memory costs a redundant suggestion, not a
  change to the document.

  What genuinely degrades is a *preference* learned in one project not
  being applied in the other. Self-correcting the moment the author
  repeats it. **If it ever bites, the fix is one sentence in the prompt**
  — its notes cover this project while the review may span others — not
  machinery.

**Accepted.** Moving the counter into `.margin/` would make it
per-project, but it would also break the self-contained sidecar — the
property rename adoption (§64) depends on. Overlapping adoption is
deliberate and rare; a sidecar that travels intact is neither.

Worth revisiting only if overlapping projects turn out to be common, or
if the third consequence above proves to matter more than it reads.

## 7. The round lock keys on the document's real path

Today the guard is `if (this.activeTurn)` on the `DocumentSession` — per
window. Two agent turns mutating one sidecar would be the one failure
here that corrupts rather than confuses.

**It is mostly unreachable already, and the spec should say so rather
than justify work with a threat that is not real.** `openFile` dedupes on
the resolved path, so a document is only ever open in one window, and
`submitReview` runs against the *open* document of the window that called
it. Two projects cannot both submit on `foo.md`, because only one of them
can have it open.

The reachable case is narrower: **`path.resolve` does not resolve
symlinks.** A chapter symlinked into another folder — which overlapping
projects make more likely — gives two distinct paths for one file,
defeating the dedupe and allowing two windows and two concurrent rounds
against one sidecar.

So: hold the lock against the document's **real path**, in the main
process, for the life of a turn. Not the window (two windows on one
project is a feature, §8) and not the project (two projects can share a
document, §6). A second submit on a document already under review is
refused with a message naming where it is running, rather than queued.

Hardening rather than an emergency, and it does not need to gate the
multi-window work.

## 8. Windows

**Multiple windows per project. One window per document.**

The second half is already true and already non-clunky: `openFile`
dedupes on the resolved path and *focuses* the existing window. The
author asked for the file and got the file; it happened to be open
already. Every path routes through that — recents, drag-drop, "Open
With", the explorer.

**The explorer marks documents open in another window**, so focusing that
window is the expected outcome of the click rather than a jolt. One flag
on the workspace file entry, one bit of styling, and the dedupe that
exists. This is the whole of "how do we stop it feeling clunky".

### What syncs between windows

**Committed state syncs; uncommitted state does not.** That line is
already the app's central distinction — draft versus sent (§66), a round
that produced nothing did not happen (§71), the submit popover naming
what will not travel. Extending it to windows is consistent rather than
new.

Syncs: document content, saved comments and suggestions, the discussion,
agent notes and proposals, and the agent's status — a round submitted in
one window shows as running in every window on that project.

Does not sync: the composer's draft, an unqueued discussion message, an
open edit box, the filter and fold states, selection and scroll. Two
windows are two places the author is working. Syncing a half-typed
comment would mean keystrokes appearing elsewhere, and it contradicts
"nothing typed is ever discarded" — there is no answer to which window's
version wins.

### What this needs

Most of it exists: the session already watches the document's directory
and `.margin/discussion.json` and pushes updates to its renderer.

- **The review sidecar is not watched.** Only the document and
  `discussion.json` are. Adding it is the bulk of comment sync.
- **Agent status is per session.** It must broadcast to every window on
  the project.
- **The round lock** (§7).

### Deliberately not: the same document in two windows

Two live editors over one file breaks the ownership rule — one renderer
owns `content` and `review` while editing. Two owners means autosave
races where the last writer silently wins, undo histories that diverge,
every keystroke in one window arriving in the other as a
*changed-on-disk* event so the conflict bar fires continuously, and an
accepted suggestion applying in one window while the other reloads and
loses its cursor. Making that work means main becomes the authority and
renderers become views: an architecture change, not a feature.

The use case behind the request — compare a document with itself — is
better served two other ways. Two *places* in one document is a split
view over one buffer, with no sync problem because there is one state.
Two *versions* is a diff, which is the history browser (#129). Both are
cheaper and better at the actual job, and the split view is the same
feature family as #142.

## 9. Scenarios worth testing

Journeys, not coverage. Each is here because it protects a decision above.

**Adoption and the absence of accidents**

1. Opening a folder holding `margin.json` adopts it; the project's name
   comes from the file, not the folder.
2. Opening a folder with no declaration prompts, and on confirm writes
   `margin.json` at the chosen folder.
3. Opening a *file* whose ancestor holds a declaration adopts that
   project without prompting (§3).
4. **Opening a file with no ancestor declaration writes nothing to
   disk** — no `margin.json`, no `.margin/`. The headline assertion of
   this spec.
5. A comment made before adoption persists in the sidecar, and after
   adopting, the first round sees it.
6. A folder holding a legacy `.margin/` and no `margin.json` still opens
   as a project.

**Overlapping projects — Drew's scenario**

7. `book/`, `book/chapter1/` and `book/chapter2/` adopt as three
   projects, each with its own `margin.json`.
8. **A comment made on `chapter1/foo.md` in the `chapter1` project is
   present on `chapter1/foo.md` opened from the `book` project.** The
   review is a property of the document.
9. A discussion message queued in `chapter1` is not visible in `book`,
   and vice versa.
10. `book`'s explorer lists `chapter1/foo.md`; `chapter1`'s explorer does
    not list anything from `chapter2/`.
11. A round submitted from `chapter1` advances the round counter that
    `book` reads, *and* a comment left pending in `book` is answered by
    that round — the pair that shows the shared counter is describing the
    document truthfully rather than drifting (§6).

**The round lock**

12. Two paths reaching one document through a symlink — the case the
    resolved-path dedupe misses — cannot run two turns against one
    sidecar; the second submit is refused.
13. Two windows on one project, submitting on *different* documents, both
    run.

**Windows**

14. Opening a document already open in another window focuses that window
    and does not open a second.
15. The explorer marks a document that is open in another window.
16. A committed comment made in one window appears in the other.
17. A draft comment in one window does not appear in the other.
18. A round submitted in one window shows as running in the other.

## 10. Build order

1. `margin.json`: read, write, and the `.margin/project.json` fallback.
   Nothing visible changes. **Done** (#167).
2. Find-only resolution (§3), retiring §63. Scenarios 3, 4, 6.
   **Done** (#168, DECISIONS §74).
3. Adopt a folder — the open-folder path and the confirmation (§5).
   Scenarios 1, 2, 5. **Done** (#169, DECISIONS §75). Scenario 4 is
   covered here too, since the write gates are what make it true, and
   the window carrying its own root (§1) landed with it.
4. The document-scoped round lock (§7), keyed on real path. Scenarios
   12, 13. Cheap and independent — it does not gate the multi-window
   work, since the path dedupe already prevents the common case.
   **Done** (#170). Lives in `src/main/roundLock.ts`: single-writer is a
   guarantee this host offers, so it stays out of `src/shared/`
   (DECISIONS §77).
5. Overlapping projects (§6) — mostly assertions rather than code, since
   §1 makes it fall out. Scenarios 7-11.
6. Multiple windows per project: sidecar watching, project-scoped agent
   status, the explorer's open-elsewhere marker. Scenarios 14-18.
7. Recents become projects rather than files, which reshapes Welcome.

## Settled with Drew (2026-07-27)

1. **Folder adoption**, VSCode-style, trading away one-file-one-root.
2. **Drafts do not sync** between windows; committed state does.
3. **`margin.json` declares, `.margin/` stores**, and the locator becomes
   a declaration rather than a derivation.
4. **One window per document** accepted as a limitation for now, made
   liveable by marking documents open elsewhere.
5. The pre-adoption state stays, on the understanding that its value is
   the absence of a side effect rather than a feature set.

## Still open

- **Multi-root projects** — VSCode's `.code-workspace`, several folders
  adopted into one project. Interesting, not now.
- **Session reuse** (#2) — resuming an agent session for a project rather
  than a fresh turn each round. Independent of this model, but it becomes
  easier to state once a project is a declared thing.
- **Split view** for comparing a document with itself (§8), same family
  as #142.
