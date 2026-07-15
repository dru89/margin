# Spec: Google Docs sync

Status: **proposed** · Owner: Margin · Depends on: extraction of the
md↔gdocs conversion core from an existing internal tool (Python), to be
ported to TypeScript as a standalone library.

## Summary

Margin documents gain an optional link to a Google Doc. Writers work
locally in Margin (with Claude, in review rounds); collaborators work in
Google Docs (comments, suggested edits). Sync is **explicit and
user-initiated** in both directions. Collaborator comments appear in
Margin's sidebar and in the agent's review context; the local
conversation *about* those comments never leaves the machine, and
**nothing is ever published to the Doc except text the author typed and
explicitly sent.**

## Goals

- Write locally in markdown, share as a Google Doc, iterate across both.
- See collaborator comments (and later, suggested edits) inside Margin,
  attributed, anchored to the right text.
- Discuss collaborator feedback with Claude locally — plan responses,
  propose document edits — without any of that discussion reaching the Doc.
- Preserve collaborator comments across pushes, including edits to
  commented text and (eventually) tables.
- Work as a normal external app under Google's least-privilege scope
  (`drive.file`), while allowing orgs to substitute their own OAuth client.

## Non-goals

- Live/background bidirectional sync. Sync is a deliberate act, like a
  review round.
- Automatic text merging when both sides changed. v1 detects and asks.
- The agent writing anything to the Doc. There is deliberately **no code
  path** for agent-authored content to reach Google — not a setting, an
  invariant.
- Office / Confluence. Out of scope here; the conversion library should
  not preclude them, but this spec is Docs-only.

## Product model

### Linking

- **Push-created (v0, primary):** "Share to Google Docs" on a Margin
  document creates the Doc. Files created by the app are automatically
  within `drive.file` scope.
- **Import-existing (v2):** linking a Doc someone else created requires
  the Google Picker flow (that's how `drive.file` grants per-file access).
- Link state is a project-scoped record (see *Data* below). One markdown
  file ↔ one Doc (or one tab of a Doc; the conversion core already
  supports tabs).

### Sync actions

- **Pull:** fetch Doc → convert to markdown → write the local file
  through Margin's existing external-change path (clean editor reloads
  silently; dirty editor gets the conflict banner). Fetch comments and
  merge (append-only by ID). Git checkpoint before and after.
- **Push:** diff last-synced base → current local markdown → minimal
  Docs API `batchUpdate`. Git checkpoint before and after.
- **Conflict rule:** the link record stores the Doc `revisionId` and a
  base snapshot from the last sync. If both sides changed since base,
  neither direction proceeds silently — the user chooses pull-first or
  push-anyway. No three-way text merge in v1.

### Comments

Every thread carries a **provenance**: `local` (author or Claude, native
Margin) or `imported` (from the Doc, with collaborator attribution).

- **Imported threads are read-down.** They render in the sidebar with the
  collaborator's name, anchored via the same quote+context re-anchoring
  Margin uses everywhere (`quotedFileContent` from the Drive API maps
  directly onto Margin's anchor model).
- **Shadow discussion:** each imported thread supports local replies
  (author and Claude) that are stored in the review sidecar and are
  structurally unable to sync. This is the primary workflow: hash out a
  collaborator's comment with Claude, decide what to do, respond with
  document edits.
- **Reply on Doc** is a separate, explicit composer on an imported
  thread. It sends exactly the text typed into it, as a reply to the
  existing Drive comment thread, under the user's account. Nothing else
  syncs up: local threads never do, shadow replies never do, agent text
  never does. (Replying to *existing* threads is fully supported by the
  Drive API; creating *new* anchored comments programmatically is not —
  the Docs anchor format is undocumented — so restricting upstream writes
  to replies is also the technically safe boundary.)
- **Resolution:** resolving an imported thread in Margin optionally syncs
  (Drive supports resolve-via-reply); default is to ask.
- Native Margin comments never appear in the Doc.

### Collaborator suggestions (v2)

Google suggested edits can be *read* through the Docs API and rendered as
Margin suggestion cards (author-attributed, accept/reject). Constraints:

- The API cannot accept or reject a suggestion in the Doc. Accepting in
  Margin applies the change locally; the Doc-side suggestion becomes
  stale and is superseded by the next push. The UI must say so honestly.
- A push onto a Doc with pending suggestions is the messiest known case;
  behavior must be pinned by integration tests before this ships.

### Agent integration

Imported comments are part of review state, so Claude sees them in the
next round automatically and can discuss them in shadow threads or
propose `suggest_edit`s in response. Claude's writing reaches the Doc
only as document content, only after the author accepts a suggestion,
and only when the author pushes.

## Sync engine

### Data

`.margin/gdocs.json` (project-scoped, checkpointed like the rest of
`.margin/`):

```jsonc
{
  "version": 1,
  "links": [
    {
      "file": "Proposal.md",            // relative to workspace root
      "docId": "…",
      "tabId": "…",                      // optional
      "revisionId": "…",                 // Doc revision at last sync
      "baseRef": "…",                    // git blob of last-synced markdown
      "threads": { "<localThreadId>": "<driveCommentId>", … },
      "lastSyncAt": "…"
    }
  ]
}
```

The base snapshot is a git blob reference (the checkpoint commits already
exist), not a copied file.

### Push granularity (hybrid)

- **Prose:** word/run-level diffs within changed paragraphs. Smallest
  edits maximize server-side comment-anchor survival.
- **Structure:** paragraph/block operations for insert/delete/reorder.
- **Tables:** *atomic* (delete + reinsert) when the table carries no
  comments; **in-place morph** when it does — row/column ops for shape,
  then per-cell splices for content.
- All operations are emitted in **reverse document order** so earlier
  indices are never invalidated by already-emitted edits. Indices are
  UTF-16 code units (Docs API convention).

### The anchor-preserving splice

The standard write primitive whenever a diff hunk overlaps a comment
anchor. Invariant: **a comment survives as long as its anchored range
never reaches zero width at any point in the operation sequence.**

1. Insert the replacement text *strictly inside* the anchored range
   (the range absorbs the insertion and grows).
2. Delete the old text on each flank as separate operations (the range
   shrinks but never vanishes).

Delete-then-insert orphans the comment; insert-then-delete preserves it.

Known edges, all of which must be pinned by live integration tests
because Google documents none of this behavior:

- **Boundary semantics:** insertion strictly inside extends the range;
  insertion at the range's start/end boundary generally does not.
- **Single-character anchors** have no strictly-inside insertion point —
  the degenerate case. Fallback: accept the orphan, or recreate the
  thread as best-effort (loses Doc-side anchor).
- **Style inheritance:** inserted text takes the style at the insertion
  point; the engine applies text-style corrections after the splice
  rather than assuming the insert landed clean.
- **Suggesting mode:** interactions between the splice and pending
  suggestion spans are unknown; test, don't reason.
- **Concurrent edits:** a collaborator typing in the same region during
  a push is decided by the API's revision handling, not the splice.
  Sync being explicit makes this rare, not impossible; needs a live test
  and a defined retry/abort behavior.

## Conversion library

A new standalone TypeScript library (own public repo), ported from the
internal Python tool. The internal tool is the reference implementation
and keeps running unmodified.

- **AST:** remark/mdast with GFM replaces pandoc. Margin already ships
  remark; dropping the pandoc binary removes a large bundled dependency
  and version-skew risk. The markdown dialect is GFM, which mdast covers.
- **Styling:** the reference.docx concept survives as a style-mapping
  config (fonts/spacing per block type). A reference.docx *importer* can
  come later; the mapping format is the contract.
- **API surface:** token in, fidelity out. No auth opinions, no Margin
  types — the library speaks markdown, Docs API requests, and comment
  records. Margin owns sync, provenance, and UI. The internal tool can
  eventually wrap the same library with internal auth and the
  Office/Confluence extras.
- **Tests are the spec.** Port the existing integration round-trip corpus
  *first*, then implement until green. Add: table-torture cases (the
  known weak spot), splice boundary-semantics pinning tests, and a
  live-API mode that runs against a scratch Doc under a test account.

## OAuth

- **Scope:** `drive.file` only. Avoids the restricted-scope security
  assessment that makes full-`drive` external apps effectively
  unshippable, and matches the product: push-created docs are in scope
  automatically; import-existing goes through the Picker.
- **Client config, three tiers** (same binary for everyone — no fork):
  1. Default: embedded public Margin client. Zero setup.
  2. Custom: paste a client-config file or URL in settings — orgs
     distribute one internal link, setup is a runbook sentence. (Same
     pattern as rclone/gcloud custom clients.)
  3. Org admins can pre-approve their internal client, so colleagues
     never see an unverified-app consent screen — useful while the
     public client works through Google's verification queue.
- **Flow:** installed-app loopback + PKCE. Client IDs for native apps are
  not secrets (the repo is public). Tokens stored via Electron
  `safeStorage` (OS keychain).

## Phasing

- **v0 — content round-trip:** link (push-created), push, pull, conflict
  banner, checkpoints. Tables atomic. No comments yet. Independently
  useful: write locally, share as a Doc.
- **v1 — comments:** import + attribution + re-anchoring, shadow
  discussions, Reply-on-Doc, optional resolve sync, agent sees imported
  threads in review state. Splice primitive for prose; commented tables
  still atomic (documented as lossy).
- **v2 — the hard fidelity:** collaborator suggestions (read-only
  import), commented-table morphing, Picker import of pre-existing docs.

## Open questions

1. Incremental-push quality on tables in the reference implementation is
   still being worked; the morph strategy above needs validation against
   its test corpus.
2. Splice behavior under suggesting mode and concurrent edits —
   empirical, needs the live test rig.
3. Whether resolve-sync should default on or off.
4. Style-mapping format: minimal JSON now vs. reference.docx parity.

## Dependencies / what unblocks implementation

From the internal tool (sanitized for sharing): the md↔gdocs conversion
core, the integration-test fixture corpus (round-trip cases), and any
notes/commits documenting Docs API bugs already solved. Internal OAuth
handling and the Office/Confluence paths stay behind.
