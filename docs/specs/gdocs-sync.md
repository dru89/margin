# Spec: Google Docs sync

Status: **accepted, rev 3** · Owner: Margin · Reference:
[`dru89/doc-tools`](https://github.com/dru89/doc-tools) — the knowledge
base distilled from an internal md↔gdocs tool with months of production
use (`docs/google-docs-api-lessons.md`, `docs/test-scenarios.md`).
Scenario IDs below (RT-1, CP-8, UTAB-*, …) refer to that catalog.

Rev 2 incorporates review against the reference behavior: the conversion
core arrives as a **specification, not code to port**; push diffs
against live doc read-back; comment preservation ships at block-level
parity first with the anchor-preserving splice re-phased behind a live
test rig; images move into v0; `writeControl` is mandatory.

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
- Preserve collaborator comments across pushes to the extent the API
  allows, stated honestly at each phase.
- Work as a normal external app under Google's least-privilege scope
  (`drive.file`), while allowing orgs to substitute their own OAuth client.

## Non-goals

- Live/background bidirectional sync. Sync is a deliberate act, like a
  review round.
- Automatic text merging when both sides changed. v1 detects and asks.
- The agent writing anything to the Doc. There is deliberately **no code
  path** for agent-authored content to reach Google — not a setting, an
  invariant.
- Office / Confluence. Out of scope; the conversion library should not
  preclude them, but this spec is Docs-only.

## Product model

### Linking

- **Push-created (v0, primary):** "Share to Google Docs" on a Margin
  document creates the Doc. Files created by the app are automatically
  within `drive.file` scope.
- **Import-existing (v2):** linking a Doc someone else created requires
  the Google Picker flow (that's how `drive.file` grants per-file access).
- Link state is a project-scoped record (see *Data*). One markdown file
  ↔ one Doc or one tab (the reference supports nested tabs; Margin v0 is
  single-tab, with the tab-reconciliation planner (UTAB-*) reserved for
  a later multi-file↔multi-tab mapping).

### Sync actions

- **Pull:** fetch Doc (`documents.get` with `includeTabsContent=true` —
  never the export path) → convert to markdown → write the local file
  through Margin's existing external-change path (clean editor reloads
  silently; dirty editor gets the conflict banner). Fetch comments and
  merge (append-only by ID). Git checkpoint before and after.
- **Push:** read the live Doc back, canonicalize both sides, and diff
  **doc-readback vs. current markdown** (reference behavior: you need
  the read for current indices regardless, and doc-vs-markdown diffing
  self-heals renderer drift — this is also why canonicalization parity
  is a hard requirement, lesson 5). Emit the minimal `batchUpdate`s.
  Git checkpoint before and after.
- **Every push batchUpdate sets `writeControl.requiredRevisionId`**,
  chained through the returned revision across sequential batches. A
  racing collaborator makes the push fail cleanly instead of editing
  against moved indices; the user re-pulls and retries.
- **Conflict rule:** the link record stores the Doc `revisionId` and a
  base snapshot (git blob) from the last sync — used for *detection
  only*, not as the diff base. If both sides changed since base, neither
  direction proceeds silently: the user chooses pull-first or
  push-anyway.

### Comments

Every thread carries a **provenance**: `local` (author or Claude, native
Margin) or `imported` (from the Doc, with collaborator attribution).

- **Imported threads are read-down.** They render in the sidebar with the
  collaborator's name, anchored via the same quote+context re-anchoring
  Margin uses everywhere (`quotedFileContent` from the Drive comments API
  maps directly onto Margin's anchor model). Comment fetch failures
  (403/404 independent of file access) degrade gracefully.
- **Shadow discussion:** each imported thread supports local replies
  (author and Claude) stored in the review sidecar, structurally unable
  to sync. This is the primary workflow: hash out a collaborator's
  comment with Claude, decide what to do, respond with document edits.
- **Reply on Doc** is a separate, explicit composer on an imported
  thread. It sends exactly the text typed into it, as a reply to the
  existing Drive thread, under the user's account. Nothing else syncs
  up. (This is also the only technically safe upstream write: creating
  *positioned* comments programmatically is unsupported — the Docs
  anchor format is undocumented and unstable, lesson 6.)
- **Resolution:** resolving an imported thread in Margin optionally
  syncs (resolve-via-reply); default is to ask.
- Native Margin comments never appear in the Doc.

**Preservation phasing (revised):** the reference behavior is
block-level diff-and-rebuild, which preserves comments on *unchanged*
blocks and **orphans comments on any block that is edited** — pinned as
CP-8, a known limitation, not a solved problem. Margin ships that parity
first (v1), stated in the UI ("editing commented text will disconnect
the comment in Google Docs"). The **anchor-preserving splice** (insert
strictly inside the anchored range, then delete flanks; the range never
hits zero width) is the intended upgrade, but it is **new engineering,
not extraction** — a prior inline-diff prototype was abandoned with
exactly the bugs the splice must avoid (delete-then-insert ordering,
code-point index math). It lands only behind live boundary tests
(insertion at range start/end, single-character anchors, suggesting
mode, concurrent edits — the CP-8 extension group), following the
reference's difficulty ladder: **list items → code blocks → tables.**

### Collaborator suggestions (v2)

Google suggested edits can be *read* (suggestion spans in document
content) and rendered as Margin suggestion cards. The API **cannot
accept or reject** a suggestion; accepting in Margin applies the change
locally and the Doc-side suggestion goes stale, superseded by the next
push. The UI must say so honestly. Push onto a Doc with pending
suggestions is unpinned behavior — live tests before shipping.

### Images (v0 — real documents have images)

- `insertInlineImage` needs a URI Google's fetchers can reach. Workspace
  accounts that block public link-sharing require the temp-doc staging
  trick (upload a .docx containing all images with convert-to-Doc, read
  back the ~30-minute `contentUri`s, delete the temp doc) — it works
  under `drive.file`. Batch all images into one temp doc.
- Always set `objectSize` (Docs renders raw pixel size otherwise);
  compute from pixel dimensions at render DPI, clamp to page width and
  max height preserving aspect ratio.
- An inline image is **one index unit**.
- Dialect: image alone in a paragraph with alt text = figure (centered,
  italic caption); mixed with text = inline; empty alt = plain paragraph.
- Scenarios: UIMG-1..6 offline, IMG-1..3 live.

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
      "baseRef": "…",                    // git blob of last-synced markdown (conflict detection only)
      "threads": { "<localThreadId>": "<driveCommentId>", … },
      "lastSyncAt": "…"
    }
  ]
}
```

### Push pipeline (per the reference architecture)

1. **Read back** the live Doc; convert to canonical block list.
2. **Canonicalize** the markdown AST side to the same form. Parity rules
   from lesson 5: coalesce Docs' per-line code paragraphs into one
   block; one canonical string per table (per-cell text, stripped,
   newline-joined, row-major); render smart chips as text or they're
   invisible to the diff and duplicate forever. Block identity = type +
   heading level + plain text — **content, not styling** (UDIFF-6/7).
3. **Diff** block lists (UDIFF-*), group changes into contiguous rebuild
   regions (UREGION-*).
4. **Build requests** with the phase ordering that doesn't lose styles
   (lesson 2): all inserts → all bullet applications → all base
   paragraph/text styles → all inline styles. Correct post-bullet
   indices for the tabs `createParagraphBullets` removes (lesson 3 —
   the empty-document bug). **Explicitly set every inheritable property
   on everything inserted** (named style, font, alignment, bullet
   state) — insertion inherits neighbor formatting and the bug class
   only manifests on incremental update, never on fresh create
   (lesson 4; SI-1..3 were all production bugs).
5. **Send** with `writeControl.requiredRevisionId`; retry 429s with
   exponential backoff at the single choke point (60 write
   requests/min/user — lesson 10).

Granularity: word-level prose diffs and in-place table morphing are
*not* v0/v1. The reference validates block-level rebuild with atomic
tables; finer granularity follows the splice work (see Comments).

Index math is **UTF-16 code units** everywhere. TS `String.length`
already is — do not "fix" it to code points (lesson 1). Visible width
(table column sizing) is a third, separate measurement (UMISC-2).

### Read pipeline

Structured `documents.get` walk (never export-to-docx: silent table
loss, size limits). Merge adjacent same-format runs (`**bo****ld**`),
push whitespace out of emphasis markers, render smart chips explicitly,
reconstruct nested/checkbox lists, blank line between adjacent lists of
different types. UREAD-1..10.

## Conversion library

A standalone TypeScript library (own repo), **written fresh against the
scenario catalog** — the internal implementation stays internal; what
crossed the boundary is what it learned. "Tests are the spec" is now
literal:

- **Build order:** port the scenario catalog into a test suite first.
  The first implementation target is **RT-1** (push a doc with every
  block type; re-push identical markdown; assert zero write requests) —
  it catches canonicalization drift for every block type at once and
  stays green forever.
- **Test architecture** (from the catalog's design principle): pure
  decision logic (differ, region planner, tab planner, request builder)
  tested offline in milliseconds; a **fake Docs service** middle tier
  proving the orchestrator emits surgical requests (USCOPE-*); an
  opt-in live tier with session-scoped auth (skip, don't fail, when
  unauthenticated), retry-on-429, per-test scratch docs with cleanup,
  and generated image fixtures.
- **AST:** remark/mdast with GFM (Margin already ships remark; no
  pandoc binary). **Dialect is pinned, not inherited** (UMD-1..4):
  smart punctuation off — straight quotes stay straight, `--` stays two
  hyphens, `...` stays three dots — lists parse without a preceding
  blank line, the image trichotomy above, HR as a `borderBottom`
  paragraph (no HR element exists in Docs).
- **Styling:** style-mapping config (fonts/spacing per block type); a
  reference.docx importer can come later.
- **API surface:** token in, fidelity out. No auth opinions, no Margin
  types. The internal tool can eventually wrap the same library.

## OAuth

- **Scope:** `drive.file` only. Avoids restricted-scope review;
  push-created docs are in scope automatically; import-existing goes
  through the Picker. Sufficient for the image staging trick.
- **Client config, three tiers** (same binary — no fork): embedded
  public Margin client by default; custom client via a config file/URL
  pasted in settings (orgs distribute one internal link — the
  rclone/gcloud pattern); org admins can pre-approve their internal
  client so colleagues skip the unverified-app screen.
- **Flow:** installed-app loopback + PKCE; tokens in Electron
  `safeStorage`. Client IDs for native apps are not secrets.
- **Token handling carries the reference's failure-mode fixes**
  (UAUTH-1..4): persist *granted* scopes and compare against required
  (an unexpired read-only token must not pass as valid for writes);
  refresh failure falls through to interactive auth; `invalid_client`
  gets its own user-facing message (re-auth won't fix a dead client).

## Phasing

- **v0 — content round-trip:** link (push-created), push, pull, images,
  conflict banner, checkpoints, `writeControl`, RT-1 green. Tables
  atomic. No comments yet.
- **v1 — comments at reference parity:** import + attribution +
  re-anchoring, shadow discussions, Reply-on-Doc, optional resolve
  sync, agent sees imported threads. Block-level preservation with the
  CP-8 limitation stated in the UI.
- **v2 — fidelity upgrades, each behind live tests:** the
  anchor-preserving splice (list items → code blocks → tables),
  commented-table morphing, collaborator suggestions (read-only
  import), Picker import of pre-existing docs, multi-tab mapping
  (UTAB planner).

## Interop conventions (resolved — doc-tools `docs/conventions.md`)

1. **Frontmatter.** Reference push reads `title`, `subtitle`, `author`,
   `author-email`, `date`, `url`; fetch writes `title`, `author`, `url`,
   published date, `google-doc` tag; after a push `url:` is always
   overwritten, other keys added only if missing. **Margin's contract:**
   honor `url:` on import as a link-*offer* signal (files that touched
   the reference tool carry it); `.margin/gdocs.json` is the sole link
   store; Margin never writes `url:` into the user's markdown.
2. **Headings.** Push shifts −1 (`#` → TITLE, `##` → Heading 1, …);
   read maps TITLE → `#`, Heading N → N+1 hashes. Round-trip stable.
   Do **not** copy the reference's SUBTITLE asymmetry (written from
   frontmatter, read back as `##`) — Margin round-trips SUBTITLE to the
   `subtitle` frontmatter key.
3. **Comment-section markers.** Fetched docs in the wild carry
   `<!-- gpush:comments-start -->` … `<!-- gpush:comments-end -->`
   wrapping a `---` + `## Comments` section at EOF. The push path strips
   from the start marker to end of file before parsing (UMISC-1). No
   unmarked legacy format exists.
4. **Multi-tab.** Reference declares tabs as ordered CLI args
   (`"Title=path.md"` or bare path; title falls back `#` heading →
   frontmatter → filename stem; 50-char truncation at word boundaries).
   Margin's file+`tabId` link record is compatible — writes are scoped
   to Margin's own tab, so single-tab Margin coexists with multi-tab
   docs.
5. **Chips on push.** `insertPerson` (`personProperties.email`) and
   `insertDate` (ISO 8601 UTC timestamp). Each chip is exactly **one
   index unit**. On update, the title/subtitle/chip block is found and
   **replaced, never appended** (chips invisible to a text diff
   duplicate on every push otherwise — UCHIP-1..4).
6. **Diagram support (DIA-*) is out of scope** for v0–v2. The scenarios
   stay in the catalog if it's ever wanted.

Remaining open question: resolve-sync default (ask vs. on vs. off) —
product taste, low risk, decide at v1.

## Dependencies

Resolved: `dru89/doc-tools` (lessons + scenario catalog + interop
conventions) is the specification for the conversion core. No code
crosses the boundary; the internal tool remains the reference
implementation and keeps running. Implementation proceeds on the
`gdocs-sync` feature branch: the conversion library starts life at
`packages/gdocs-sync/` (self-contained, own test suite, no coupling to
the app build) and extracts to its own repo when it stabilizes.
