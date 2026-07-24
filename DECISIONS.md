# Decision Log

Decisions made while building v0, in roughly the order they came up. Flagging
these for review — none are load-bearing enough that they can't be reversed,
but some (data model, agent boundary) get more expensive to change later.

## 1. Name: "Margin"

The app needed a product name for menus, window titles, and the userData
directory. Comments live in the margin; the agent writes in the margin; you
keep the page. Rename is a find-and-replace across `package.json`,
`src/main/index.ts` (`app.setName`), and the welcome screen.

## 2. Electron over Tauri

The deciding factor is the agent integration: the Claude Agent SDK is a Node
library, so Electron's main process can host it directly — same process, no
sidecar. Tauri would need a bundled Node sidecar process just to run the SDK,
which erases most of Tauri's footprint advantage. Stack: Electron 33 +
electron-vite + React + TypeScript, CodeMirror 6 for the editor.

## 3. Agent attachment: headless Claude Code via the Agent SDK

This was your open question. The answer: `@anthropic-ai/claude-agent-sdk`
runs Claude Code headlessly from the main process. Each "Submit for review"
spawns one fresh agent turn (`query()`) with:

- **cwd = the document's directory**, so the agent can `Read`/`Grep`/`Glob`
  reference material (e.g. your `reference/` folders) for context.
- **An in-process MCP server** (`createSdkMcpServer`) exposing five tools:
  `read_document`, `list_review_state`, `reply_to_comment`, `add_comment`,
  `suggest_edit`. Tool handlers mutate the review sidecar directly and push
  updates to the window live, so comments appear as the agent works.
- **No write access.** `Write`/`Edit`/`Bash`/`WebFetch`/`WebSearch`/`Task` are
  disallowed; every change the agent wants goes through `suggest_edit` so you
  accept or reject each one. `permissionMode: 'dontAsk'` with an explicit
  allowlist means no permission prompts and anything unlisted is denied.
- **`settingSources: []`** — your global CLAUDE.md and project settings do NOT
  load into review turns. The review persona is fully defined by Margin's own
  system prompt. Debatable; flip it if you want your CLAUDE.md voice rules in
  scope (the system prompt already tells it to match your register).

**Auth:** the SDK uses your existing Claude Code login (`claude login` /
subscription); the app never touches API keys. Model is whatever your Claude
Code default is — a per-document or per-app model picker is future work.

**Turn boundaries:** each round is a fresh session (no conversation carryover).
Continuity lives in the artifact instead: the agent re-reads the document,
open threads, and — importantly — rejected suggestions with your rejection
comments, and is instructed not to re-propose things you've declined. This
matches the PR-review mental model and avoids unbounded context growth.

## 4. Documents stay plain markdown; review state in a sidecar

The `.md` file is never polluted with app metadata. Comments and suggestions
live in `<name>.md.review.json` next to the document. Rationale: the sidecar
commits to git alongside the doc (review history is versioned), survives
external editing, and is human-readable JSON. Trade-off: two files per doc.

## 5. Anchoring: offsets + quote + context, re-anchored on load

Anchors store character offsets plus the exact quoted text and 32 chars of
prefix/suffix context. While the app is open, anchors are remapped through
every CodeMirror change (Google-Docs-style position mapping). When a document
was edited outside the app, anchors re-locate by exact quote search,
disambiguated by context match then proximity. If the text is gone, the
thread survives as "orphaned" in the sidebar rather than being deleted.

The agent addresses text by **exact quote**, not offsets — much more reliable
for an LLM, and the same resolution machinery anchors it.

## 6. Review rounds are turn-based and lock the editor

Submitting a round: save → git checkpoint → agent turn → git checkpoint. The
editor is read-only while the agent works (single-writer model; avoids merge
conflicts between your edits and the agent's anchors). Cancel is available.
This is the "GitHub PR review" cadence you described, not real-time co-editing.

## 7. Git checkpoints, but no auto-init

Each round produces up to two commits scoped to the doc + sidecar:
`Review round N: submitted` and `Review round N: agent review`. If the doc
isn't in a repo, checkpoints are skipped and the toolbar shows a "no repo"
button that runs `git init` — the app never creates repos unasked (your
`newdoc` flow already makes one anyway). Manual saves don't commit; rounds do.

## 8. TK markers: fallback channel (revised twice — final)

History: v0 special-cased `(TK: ...)` as author notes → removed on 2026-07-10
morning feedback ("comments should live in the app") → **reinstated later the
same day**: TKs are a deliberate fallback for edits made outside Margin
(another editor, quick terminal edit) that later get pulled up here. Current
behavior: the agent treats TK markers as author notes — replies via an
anchored comment and proposes a `suggest_edit` replacing the marker — while
in-app comments remain the primary channel. No UI treats TK specially; it's
prompt-level only.

## 9. Editor: markdown source + preview toggle, not WYSIWYG

Write mode is CodeMirror 6 with styled markdown source (headings sized, bold
bolded — Newsreader serif, so it reads like a manuscript, but syntax stays
visible). Preview mode (Cmd/Ctrl+E) renders GFM via react-markdown. A full
Obsidian-style live-preview hybrid is a big lift and deferred; comment
highlights currently show in Write mode only.

## 10. User-authored suggestions deferred

The data model supports `author: 'user'` suggestions (you called this less
important), but there's no UI to create them yet. Comments + direct edits
cover the flow for now.

## 11. Window & OS integration follows the Netscope rules

Single app process (single-instance lock; second launches route into the
first), cascade positioning with center fallback (Wayland-safe), open-file
dedupe (focus the window that already has the file), welcome window, native
menu bar with Open Recent (own store + `app.addRecentDocument`), standard
shortcuts (Cmd/Ctrl+N/O/S/W, Cmd/Ctrl+Shift+Enter to submit). Not done yet:
icons, About window, auto-update, file-type association.

## 12. Visual design: "paper & ink" editorial theme

Newsreader (variable serif) for document text, Spline Sans for UI chrome,
Spline Sans Mono for code — all bundled locally via Fontsource (no network
fonts; CSP is `default-src 'self'`). Warm paper light theme and ink dark
theme, following the system setting. Your comments are ink blue, the agent's
are verdigris, comment anchors are amber — color = author, everywhere.

## 13. ESM/CJS bridge for the Agent SDK

The SDK (and nanoid) are ESM-only while Electron's main bundle is CJS. The
SDK is loaded via dynamic `import()` (preserved by Rollup); nanoid is inlined
into the bundle. If this gets annoying, the durable fix is migrating the main
process to ESM output.

## 14. Nested-session env scrubbing

The spawned CLI inherits Margin's environment. If Margin is launched from
inside a Claude Code session (`npm run dev` in an agent terminal), the
`CLAUDECODE`/`CLAUDE_CODE_*` markers make the CLI think it's a nested session
and refuse stored credentials. Margin strips those vars for the child process.

## 15. Testing: puppeteer-core over CDP

`puppeteer-core` is a devDependency used to drive the built app over
`--remote-debugging-port` for smoke tests (no browser download). The comment
flow and review-round plumbing were verified this way.

## 16. Catppuccin theme (author request, 2026-07-10)

Latte for light, Mocha for dark (the flagship dark flavor), replacing the
original paper/ink palette. Mapping: base = ground, mantle = insets/sidebar,
surface0/1 = raised cards + rules, text/subtext0/overlay1 = ink scale,
blue = author, teal = agent, yellow = comment anchors, red = danger.
Accent-filled buttons use `--on-accent` (white on Latte, crust on Mocha)
since Mocha accents are light. Typography unchanged (Newsreader/Spline Sans).
Window `backgroundColor` follows `nativeTheme` so pre-paint matches.

## 17. Fake agent mode (`MARGIN_FAKE_AGENT=1`)

A scripted review turn that runs the exact same code path as a real round —
status streaming, sidecar mutations via the same helpers, git checkpoints —
without spawning the CLI. Exists because (a) dev/demo shouldn't burn tokens
or require credentials, and (b) the round pipeline needs to be testable in CI
or sandboxed sessions. It replies to every open thread, adds one comment,
and files suggestions against the first paragraphs it finds.

## 18. Multi-document workspace (author request, 2026-07-10)

You often work multiple documents per repo with the same agent. Design:

- **Workspace root** = the document's git repo root when there is one,
  otherwise the file's own directory. Nested folders included; nothing
  outside the root is listed. (Matches the `newdoc` project shape.)
- **Explorer rail** on the left lists `.md` files (`.git`, `node_modules`
  excluded), with per-file badges: open-comment count (read from sidecars)
  and a modified-since-HEAD dot (git status).
- **Clicking switches the document in the same window** (the window's
  DocumentSession is replaced) rather than tabs or split panes — cheapest
  model that matches "one doc in focus, quick switching". Cmd/Ctrl+N still
  opens more windows for side-by-side.
- Review rounds remain **per-document** for now. A workspace-wide round
  ("review everything open") is a plausible follow-up but needs UX for
  cross-file suggestions first.

## 19. Roadmap order (author, 2026-07-10)

Multi-doc workspace, then: comments in preview mode → history browser →
model picker → about screen/auto-update/packaging → user-authored
suggestions. TK special-casing removed (see §8).

## 20. Preview-mode comment highlighting = quote search in rendered DOM

Rendered markdown loses source offsets, so preview anchors are re-located by
searching for the quote text in the rendered text nodes and wrapping it.
Limitation (documented in `Preview.tsx`): a quote that crosses inline
formatting boundaries (spans **bold**, a link, etc.) isn't highlighted in
preview — it stays fully functional in the sidebar. Accepted trade-off over
a source-map-preserving markdown pipeline, which is a much bigger build.

## 21. History browser is read-only v1; sidecar commits count

Toolbar ▸ History lists `git log` for the document **and its review
sidecar** (round commits often touch only the sidecar). No diff view or
restore yet — for those, the repo is right there and `git` does it better;
revisit if it earns UI.

## 22. Model picker = alias pass-through, per window

The submit popover offers Claude Code default / Opus / Sonnet / Haiku and
passes the alias to the agent turn's `model` option. No pinned model IDs to
go stale; anything the CLI accepts works. Choice is per-window session state,
not persisted — deliberate until real usage says otherwise.

## 23. Document discussion: batched with the round, not live chat

You asked for a place to have the sideband conversation — framing, audience,
"why this doc exists" — and left the shape to me. I chose the **GitHub-PR
model over a live chat**: a persistent discussion thread stored in the
sidecar; user messages queue ("pending") and are sent with the next review
round alongside inline comments; the agent's closing message each round is
posted back as its reply.

Why not immediate-turn chat: each round is already a fresh agent session
with the artifact as its memory — a live chat would need either a parallel
long-lived session (two sources of agent truth, context drift between chat
and rounds) or a hidden mini-round per message (surprising token spend,
and the agent would reply without doing the reading). Batching keeps one
writer model, one prompt assembly path, and full framing context visible in
every round. The whole discussion (last 30 messages) goes into each turn
prompt with this round's messages marked "new".

This replaced the per-round note field in the submit popover — two channels
for the same job was confusing. The popover now shows how many queued
messages ride along. Trade-off accepted: no instant answers; if a real
"ask the agent something right now" need shows up, a lightweight
question-only turn could be added later without touching the round model.

## 24. Icon, About, packaging (choices made solo, 2026-07-10 afternoon)

- **Icon**: hand-drawn SVG (`build/icon.svg`) — a manuscript page with a
  margin rule, comment dot, highlighted line, and dashed suggestion box, in
  Catppuccin colors. Rendered to PNGs with rsvg-convert; regenerate with the
  same tool if the SVG changes.
- **About**: `app.setAboutPanelOptions` + the `about` menu role (works on
  macOS and Linux). No custom About window yet — the native panel carries
  name/version/icon, which covers the Netscope requirement's intent.
- **Packaging**: electron-builder AppImage for Linux; mac config present but
  untested (no mac here). **`asar: false`** — the Agent SDK spawns its
  bundled `cli.js` with *system Node*, which cannot read inside an asar
  archive; disabling asar is the simple correct fix (~194MB AppImage).
  Revisit with `asarUnpack` + path rewriting if size matters later.
- AppImages need libfuse2, which Arch-family systems don't ship — on this
  machine run with `--appimage-extract-and-run`, or `pacman -S fuse2`.
  Verified the AppImage boots and renders. A pacman/tar.gz target may suit
  this box better; deferred.
- **Auto-update: deferred.** electron-updater wants a release channel
  (GitHub Releases) and the repo has no remote yet; wire it up when the
  repo is published.

## 25. User-authored suggestions ride the same rails

The selection composer gained a Comment | Suggest toggle: Suggest pre-fills
the selected text for editing, takes an optional "why", and files a pending
suggestion authored by "You" — same card, same accept/reject flow (you can
accept your own; the agent is prompted to weigh in via an anchored comment
when it has a substantive opinion). No new data model: `author: 'user'`
suggestions were designed in from v0.

## 26. Publish + auto-update mirror Netscope's pipeline

Same shape as Dru89/netscope: `make release` bumps the version, commits,
tags `vX.Y.Z`, and pushes; `.github/workflows/release.yml` runs checks,
builds per-platform (`--publish never`), and a single publish job attaches
everything (including the `latest*.yml` update feeds) to one GitHub Release;
`electron-updater` in the app checks that feed on launch with Netscope's
exact UX — ask before downloading, Install / Remind Me Later (per-day) /
Skip This Version (persisted in `updater.json`), taskbar progress, restart
prompt. Deliberate differences: no Windows target yet, no nightly channel,
and macOS signing is optional until the CSC secrets exist (unsigned mac
builds download fine but won't auto-update — same constraint Netscope
solves with its Developer ID cert).

Verified locally: the Linux build emits `latest-linux.yml` + AppImage +
pacman (pacman needed `homepage` in package.json — added). **Not verified:
the Actions run and an in-app update**, because github.com/Dru89/margin
doesn't exist yet — I didn't create a public repo and push the source
without you. Once you `gh rc` + push, the first `make release` exercises
the rest; the workflow is a line-for-line adaptation of Netscope's proven
one.

## 27. Marketing site: static, no build step

`site/` is plain HTML/CSS (Catppuccin Latte/Mocha via prefers-color-scheme,
Newsreader/Spline Sans from Google Fonts) — no framework, no build, and
`netlify.toml` just publishes the directory (Netscope's site is a Vite app;
a landing page doesn't need one). Screenshots are real app captures at 2×
against a staged demo document ("Deprecating the Legacy Auth Flow") with a
hand-crafted review state — hero swaps light/dark with the visitor's theme.
Regenerate by re-staging a demo folder and driving the app over CDP.
`make site-dev` serves it locally.

## 28. Skills come from the writing project, not the user account

Empirically (tested via `claude -p --setting-sources`): with `settingSources:
[]` only built-in skills load; user skills (`~/.claude/skills`, e.g. a
`deslop` install) need `'user'`. Margin now runs review turns with
`settingSources: ['project']` — a writing project can carry its own
`.claude/skills/` and a project `CLAUDE.md` with per-project review
instructions, without dragging in the global config. The agent triggers a
skill from its description like any Claude Code session, or when you name it
in the discussion ("run deslop before this round"). To use user-level skills
without copying them into the project, flip this to `['user', 'project']` in
`agent.ts` — the trade-off is your global CLAUDE.md entering review turns.

## 29. Discussion is project-scoped

Per your feedback: the discussion now lives at
`<workspaceRoot>/.margin/discussion.json`, shared by every document in the
workspace, surviving file switches. Legacy per-doc sidecar discussions are
migrated in on first open. Messages lose their round number (rounds are
per-document; the discussion isn't) — pending/queued semantics are unchanged
and the agent's per-round closing message still posts here. Review turns now
run with **cwd = workspace root**, the prompt names the document by relative
path, and `@path/to/file.md` in discussion messages is documented to the
agent as "read this file". Rounds themselves remain per-document ("Start
round 1" on a fresh file is honest: that file's first round) — a
project-wide round is a future step that needs cross-file suggestion UX.

## 30. Suggestions render inline (Google Docs style); track-changes mode deferred

Pending suggestions now display in the document itself: original struck
through (red wash), replacement inserted after it (teal, underlined),
clickable through to the sidebar card where Accept/Reject lives. This is
display-only decoration — the file content is untouched until accept.

The other half of your ask — a **suggesting-mode toggle where your own edits
are captured as suggestions** (replacing the composer's Suggest tab, which
you rightly don't love) — is deferred as the next significant editor work.
Design sketch: a CM6 transaction filter that, when the toggle is on, lets
insertions through but marks them as suggestion-insert ranges, cancels
deletions and marks the range struck instead, then packages contiguous
marked regions into `author: 'user'` suggestions on submit. The tricky parts
are undo, edits inside your own pending insertions, and re-anchoring — it
deserves a fresh session, not the tail of this one. The composer Suggest tab
stays as a stopgap until then.

## 31. Claude Design refresh implemented as specced (2026-07-12)

The "One desk, one queue, one identity per thread" spec is implemented
nearly verbatim: discussion dock (collapsed preview line, expand-in-place,
composer always visible, queued-count chip, dashed queued cards with ✕),
pair model for linked selection (shared hue, 3px card spine, rest/hot/active
wash steps on both members, Esc/click-away unpins, 96px scroll landing),
slim suggestion cards (¶-locator from the nearest heading, ellipsized
context line, no diff block — the document is the diff), in-situ accept
pill on the inline suggestion, the status-chip grammar (neutral round chip,
warn "No repo · Initialize", agent/danger chips in a 32px status strip),
48px identity/actions toolbar, submit-popover manifest ("Goes with this
round" + "Send round N →" + the nothing-sends-live hint), glyph empty
states, welcome tweaks. Not implemented from the spec: accept/collapse
animations (160/240ms transitions — polish later) and per-project dock
persistence is localStorage keyed by workspace root.

## 32. @file and /skill completions in composers

All prose-to-Claude textareas (dock composer, comment composer, replies,
reject notes) are a shared MentionTextarea: `@` completes workspace file
paths, `/` at start of message/line completes project skill names
(`<root>/.claude/skills/`). These are prompt conventions, not protocol —
the turn prompt tells the agent @path means "read this file" and /name
means "invoke this skill".

## 33. Rounds stay — as metadata, not identity

Questioned 2026-07-12: is the round number worth tracking? Kept, three
reasons: it names the submit contract ("Send round 3 →" is a clearer promise
than "Submit"), it labels the checkpoint pairs in git history, and it powers
"new this round" marking in the agent prompt. But it's demoted visually to a
neutral chip per the design spec — blue was wrong, it's metadata, not
authorship. Not added: per-file "last reviewed" timestamps (derivable from
git and the discussion dates; add UI only if the need shows up in use).

## 34. Git usage, stated plainly + restore

How Margin uses git today: **automatic commits happen only around review
rounds** — one before the agent runs ("Review round N (file.md): submitted",
now with the filename since discussion went project-wide) and one after
("… agent review"), both scoped to the document + its sidecar. Manual saves
never commit; edits between rounds ride along in the next round's
"submitted" checkpoint. Everything else (other files, pushes) is the
author's own git.

New: **Restore** in the History popover — checkpoints the current state
("Checkpoint before restoring <hash>"), then checks out the doc + sidecar
from the chosen commit and reloads the session, so every restore is
reversible from the same menu.

## 35. File watching + conflict handling (closes §34's known gap)

Sessions watch the document's directory (directory, not file — editors save
via atomic rename, which kills single-file watchers) and the workspace's
`.margin/discussion.json`. External change with a clean editor → silent
reload, anchors re-resolve. With unsaved edits → a warn banner: "Reload
theirs" (discard local) or "Keep mine" (save immediately, asserting our
version). Our own saves are distinguished by content comparison, not
timing. Discussion changes from another window are adopted last-writer-wins
so multi-window use converges. Found and fixed along the way: reloading the
same path didn't remount the editor (it was keyed on file path only — now a
`loadedAt` nonce).

## 36. Agent notes over session resume (issue #2)

The restart problem is real — the agent's working context (conclusions,
conventions, reasoning that never landed in a document) evaporated between
rounds. Chosen fix: a persistent notes file, `.margin/agent-notes.md`,
written via a dedicated `update_notes` tool — **the single deliberate
exception to "the agent never writes files," scoped to exactly that path.**
Notes are fed into every round's prompt, committed with round checkpoints
(checkpoints now include `.margin/`), readable and editable by the author
(quiet "§ Agent notes" row at the bottom of the explorer), and they travel
through git — which SDK session-resume cannot do, being machine-local. That
last property decided it: Drew works across machines. If notes prove
insufficient for genuine conversational texture, per-project session resume
can layer on later as an opt-in; revisit after the dogfooding week.

## 37. Table formatter: no soft wrap + explicit pad-cells command (issue #5)

Tables never soft-wrap (`white-space: pre` on `.cm-table-line`; wide tables
scroll the editor horizontally) — a wrapped table row is unreadable and
uneditable, which Drew knows painfully from Obsidian Live Preview. Alignment
is the user's explicit act, not an on-save side effect: a ghost pill
("⌁ Format table") appears on the table's first line when the caret is
inside a table **and formatting would change something** — so it disappears
after formatting, doubling as done-feedback — plus a Format Table item in
the native context menu (renderer reports caret-in-table over a
fire-and-forget IPC channel). The transform (`src/shared/tables.ts`, pure
and script-testable) pads cells to column width, honors delimiter alignment
colons (center/right justify content), preserves `\|` escapes and indent,
and is idempotent. It dispatches per-line **minimal-span** changes through
the CM view so anchors inside the table survive the reflow. Cell width is
code points; CJK double-width rendering is accepted slop. No format-on-save,
ever — reformatting the user's text without being asked is how editors lose
trust. A modal grid editor remains a possible later layer (would warrant a
Claude Design round); this closes the day-to-day gap.

## 38. File proposals: staged content + one explicit accept (issue #1, part A)

The agent can now propose new files (`propose_file`: path + complete
content + note), but a proposal is a question, not an act — content is
staged at `.margin/proposed/<path>` with an index in
`.margin/proposals.json`, and nothing exists at the real path until the
author clicks **Accept file** (Margin creates intermediate folders; the
agent never touches the real tree). This is Drew's refined model from the
day-one discussion: atomic create-with-content, decided in ONE explicit
action — and deliberately *not* the implicit accept-by-commenting he first
floated, because a comment on a proposal should be conversation, not
consent. Pending proposals appear in the explorer under "proposed by
Claude" (teal italic, `+` prefix — visible but unmistakably not-yet-real);
clicking one opens a read-only preview with Accept/Reject and an optional
"why not" the agent reads next round. Reject keeps the record and drops
the staged content (round checkpoints already committed it, so git
retains what was proposed). Guards: workspace-relative paths only, no
`..`, no hidden segments, never an existing path — new files only.
Proposals ride the existing `.margin` checkpoint pathspec and feed the
next round's prompt (pending + rejected with comments).

## 39. New-project flow: conversation → card → one confirm (issue #1, part B)

The welcome screen gains "Start a new project with Claude": a centered
conversation (fresh agent session per message, transcript in the prompt —
same statelessness as review rounds) where the agent's only tool is
`propose_project`. Its output is a card — title, description, target path,
seed files — and, matching the proposal model in §38, the card is a
question: nothing exists until the author clicks Create project, at which
point the **app** makes the folder, writes the seed files, git-inits and
makes the first commit, and opens the main draft. The setup transcript
seeds `.margin/discussion.json`, so the first review round already has the
framing that produced the project. Projects land under a `projectsDir`
from `settings.json` in userData (default `~/Documents/Margin`; the file
is written with defaults on first read so the knob is discoverable — no
settings UI yet). The setup agent runs with no settingSources, no file
tools, and maxTurns 6: it's a scoped intake conversation, not a general
chat. A failed initial commit (e.g. no git identity) does not fail project
creation — parity with non-fatal round checkpoints. MARGIN_FAKE_AGENT
scripts a one-message propose so the whole surface tests without
credentials.

## 40. Google Docs sync: spec'd, not built (docs/specs/gdocs-sync.md)

Full spec in `docs/specs/gdocs-sync.md`; this entry records the
invariants so future sessions don't relitigate them. Sync is explicit,
never live. Imported collaborator threads are read-down with a local
"shadow discussion" (author + Claude) that is structurally unable to
sync; the only upstream write is an explicit Reply-on-Doc composer
sending exactly the author's typed text as a reply to an existing
thread — which is also the API-safe boundary, since creating new
anchored comments programmatically isn't supported. **The agent has no
code path to the Doc** (the GitHub-byline lesson as architecture, not
etiquette). Comment preservation on push uses the anchor-preserving
splice (insert strictly inside the anchored range, then delete flanks —
the range never hits zero width); tables morph in place when commented,
replace atomically when not. OAuth is drive.file only, embedded public
client with an org-overridable custom client (rclone/gcloud pattern, no
fork). Conversion core: TypeScript port of Drew's internal Python tool
(mdast replaces pandoc), its integration-test corpus ported first as
the spec.

## 41. Google Docs sync spec, rev 2 (reference-behavior review)

The internal tool's code stays internal; `dru89/doc-tools` publishes
what it learned (API lessons + a scenario catalog with stable IDs), and
the TS conversion library is a fresh implementation whose test suite is
that catalog — RT-1 (noop re-push emits zero writes) is the first thing
built and stays green forever. Spec changes from the review: push diffs
**live doc read-back vs. markdown** (self-healing; base snapshot is for
conflict detection only); every push batchUpdate sets
`writeControl.requiredRevisionId`; images move into v0 (temp-doc
staging under drive.file, explicit objectSize); markdown dialect is
pinned (smart punctuation off) rather than inherited from remark
defaults. Comment preservation ships at **block-level reference parity
first** (edits to a commented block orphan its comment — CP-8, stated
in the UI); the anchor-preserving splice from §40 is re-classified as
new engineering gated behind live boundary tests, upgrade ladder list
items → code blocks → tables. §40's invariants (shadow discussions
never sync, Reply-on-Doc only, no agent path to the Doc) are unchanged.

## 42. gdocs-sync is a standalone library; Margin is a consumer

Drew's bar for the sync engine: good enough to *replace* his internal
gpush/gfetch CLI tools, not just power Margin. So `packages/gdocs-sync`
is a standalone package — own package.json/tsconfig/vitest suite,
unscoped name, **zero imports from Margin, ever** — whose public API is
shaped so a CLI can wrap it one-to-one (push/fetch/comments/tabs/
images; token in, fidelity out). It lives in this repo for iteration
speed and extracts to its own repo when stable. Tests are named by
doc-tools scenario ID; the README's coverage checklist is the
resumption point for any session continuing the work. Rule for future
sessions: if a change would make the library know about Margin types,
review sidecars, or Electron, it belongs in Margin's integration layer
instead.

## 43. Conventions chosen for gdocs-sync (Drew to course-correct)

Drew delegated convention decisions for the night (2026-07-16), keeping
two explicitly: the −1 heading shift (`#` → TITLE — implemented,
RT-1-pinned) and subtitle rendering into the doc. Decisions made:

- **Frontmatter keys stay** (`title`/`subtitle`/`author`/`author-email`/
  `date`/`url` are read — the interop contract). Subtitle will render
  as SUBTITLE and round-trip back to frontmatter, not `##` (the
  reference asymmetry we were told not to copy). Meta-block rendering
  (UCHIP) is still unbuilt.
- **The library never writes frontmatter by default.** `url:`
  write-back is a CLI-layer option; Margin's link store is
  `.margin/gdocs.json` (per spec). Rationale: the library should not
  have opinions about the user's file beyond what it was asked to
  convert.
- **gpush comment markers**: stripped on push (implemented, UMISC-1);
  never generated by Margin (comments live in the sidecar); fetch-side
  comment-section rendering will be an opt-in CLI flag, not core.
- **Checkboxes** round-trip in markdown (serializer emits `[x]`/`[ ]`);
  the doc-side write representation is undecided (BULLET_CHECKBOX
  preset planned; asked whether the reference used it or the
  strikethrough convention).
- **Column widths**: provisional algorithm in `widths.ts` (displayWidth
  × 6.5pt + padding, min 36pt/max 300pt, single-glyph columns narrow
  per SI-4, proportional page-fit at 468pt), UWIDTH-* scenarios are
  Margin-added. Wholesale replacement expected when the reference
  algorithm arrives (asked in margin#10).

Architecture added the same night: `serialize.ts` (blocks → markdown;
contract = re-parse is identity-equal — the fetch path's half of RT-1),
`tabs.ts` (UTAB-1..9 planner), the split live test tier
(`vitest.live.config.ts`, harness with skip-without-creds + scratch-doc
cleanup). Live probe result worth remembering: **programmatic comments
are unanchored** (comments.create with quotedFileContent returns no
anchor), so CP anchored-survival tests are blocked on the reference
harness technique — the pinnable subset (comments persist across
region rebuilds, CP-5 edit-lands, edit→noop stability) is live and
green.

## 44. Reference answers integrated: widths, styles, checkboxes

The doc-tools answers (conventions.md @ ad145b3) landed and replaced
the provisional work. **Column widths** now implement the reference
algorithm exactly: 80th-percentile typical (never below header),
one-line fit at typical×6.2+14 up to 150pt then the 26·√typical−20
wrap tier, a word floor (longest token capped at 20 glyphs; hyphens
don't split; header unbroken), clamp [26,350], pooling keyed on
(position, full leading-header prefix), water-fill page fit that pins
26pt floors and never stretches fitting tables, centering when ≤48pt
and all body cells ≤1 glyph. Pooling context is the whole document
(widths planned once from all md tables, regions get theirs by block
reference). **Styles** come from reference.docx (parsed locally from
doc-tools): Roboto 11 body, Lato title/subtitle/headings with the
extracted sizes/spacing/colors, Roboto Mono 11 #188038 code, 1.8pt
compact list spacing — layered explicitly per lesson 4; the builder's
base reset now sets the reference body look rather than clearing to
Google defaults. **Checkboxes** use conventions option (c):
BULLET_CHECKBOX preset + explicit strikethrough on checked items —
real checkboxes, and [x] state round-trips through the read heuristic
(strike is stripped on read; it encodes state, not formatting). Chosen
over (a) because silently degrading the author's [x] to [ ] on every
pull is worse for a review tool than the struck-text look; matches how
UI-checked items read back anyway. Checkbox read detection was probed
live: glyphType GLYPH_TYPE_UNSPECIFIED with no glyphSymbol. The CP
catalog amendment (thread-survival vs anchor-state split) matches what
the live tier already pins; anchor-state tests still need a UI-created
durable fixture doc.

## 45. gdocs-sync packaging: real build, standalone config path, user docs

The package now compiles to `dist/` via `tsc -p tsconfig.build.json`
with `rewriteRelativeImportExtensions` (the `.ts`-extension internal
imports become `.js` in output — no bundler needed, source stays
node-type-strippable for dev). `bin.gdocs` points at `dist/cli.js`
(shebang on the source survives compilation); `main`/`types`/`exports`
point at dist; `files: ["dist"]`; `prepublishOnly` runs typecheck +
offline tests + build. **`private: true` stays until Drew decides to
publish** — likely under a scoped name, which is his call.

Config moved to `~/.config/gdocs-sync/` with `~/.config/margin/` as a
read fallback (first candidate directory containing `google-oauth.json`
wins; new tokens are written beside whichever client was found). Drew's
existing margin-path setup keeps working untouched; new users never see
a Margin-branded path for a standalone tool.

`auth.ts` is now re-exported from the package index — library consumers
(Margin included) need `getAccessToken`/`authorize` without deep
imports. Its `import.meta.url` CLI guard is inert on import.

README.md rewrote as user docs (install, bring-your-own Desktop OAuth
client walkthrough, CLI + library usage); the scenario-coverage ledger
moved to `docs/COVERAGE.md`. A package-level MIT LICENSE was added
because npm requires one — the repo itself has no LICENSE file, so the
choice needs Drew's confirmation before any publish.

## 46. Settings screen + Google auth: bundle the library, ship a default-client slot

First Margin↔gdocs-sync integration (Settings only; no push/pull yet).
Choices:

**The library is bundled into the main bundle from source** via a vite
alias (`'gdocs-sync'` → `packages/gdocs-sync/src/index.ts`) plus a
matching `paths` entry in tsconfig.node.json (with
`allowImportingTsExtensions` for its `.ts`-extension imports). No npm
workspace, no `file:` dependency, no electron-builder changes — the
package stays a normal externalized-world citizen while its code ships
inside `out/main/index.js` like nanoid does. The standalone rule (§42)
is untouched: the dependency direction is Margin → library only, and
`src/main/gdocs.ts` is the integration layer. Rollup tree-shakes to the
auth surface for now; sync entry points ride along free when needed.

**Default OAuth client is a paste-slot, not a committed secret.**
`src/main/defaultOAuthClient.ts` exports `DEFAULT_OAUTH_CLIENT` (null
today) which is fed to the library's new `setFallbackClient()`. Drew
decided the app default should be his client, but this repo is public —
committing the client id/secret is his paste, not the agent's
(installed-app secrets are non-confidential per Google's model and
rclone ships one, but shared quota + a public credential is an owner's
call). Until pasted: users with a config file work; others must import
a client in Settings before Connect enables.

**Library auth grew an app-facing surface** (still CLI-first, still
standalone): dynamic config-dir resolution (`GDOCS_SYNC_CONFIG_DIR` env
override → `~/.config/gdocs-sync/` → legacy `~/.config/margin/`, chosen
per call, token written beside the client that was found), `authStatus`,
`saveClientConfig` (validate-then-write 0600), `signOut`, and
`authorize(scopes, { onUrl, signal })` — Margin opens the consent URL
via `shell.openExternal` and Cancel aborts the loopback server. The env
override made UAUTH-4 testable offline: the full loopback+PKCE flow now
runs against a fake token endpoint in `test/auth.test.ts` (state
mismatch rejects before code exchange; abort rejects cleanly).

**Menu placement:** macOS gets Settings… in the app menu below About;
Windows/Linux get it in File above Quit; both on CmdOrCtrl+, . The
renderer also handles the chord directly as an open-only fallback
(idempotent, so a menu-consumed accelerator can't double-toggle), which
is also what makes the overlay drivable over CDP.

## 47. Default OAuth client: build-time env injection, not a committed paste

GitHub push protection rejected the commit carrying the pasted client
(§46's paste-slot plan), and Drew chose the clean-repo route over
allowlisting: the credential now enters at build time via
`MARGIN_GOOGLE_OAUTH_CLIENT_ID` / `MARGIN_GOOGLE_OAUTH_CLIENT_SECRET` —
read from an untracked `.env` locally and from same-named repo secrets
in the release workflow (both build steps), injected through vite
`define` into `defaultOAuthClient.ts`. Empty/missing values compile to
a null default, so forks and secretless CI build fine; Settings then
requires an imported client. The point is scraper resistance, not
secrecy — the credential still ships in every binary, extractable by
anyone who downloads the app. The prod client was verified live before
this rework: consent → PKCE exchange → drive.file-only grant → doc
created and deleted through the library.

## 48. Scopes ride the client JSON; the package is npm-ready as @dru89/gdocs-sync

Issue #48 implemented Drew's shape: a top-level `"scopes"` array in the
OAuth client JSON becomes the default for `gdocs auth` (and Margin's
Connect), so an org-internal client approved for `/auth/drive` grants
full-drive fetch by copy-paste alone — no flags to teach. `gdocs auth
--scope drive|drive.file|<url>` overrides per-run. Scope satisfaction
is now superset-aware (`drive` covers a `drive.file` requirement) —
previously literal string matching meant a drive-scoped token read as
signed-out everywhere. The public app default stays drive.file (drive
is a restricted scope; verification + admin blocks — see #46/#48).

npm prep (issue #44): renamed to **@dru89/gdocs-sync** at 0.1.0,
`private` removed, `publishConfig.access: public` (scoped packages
default restricted), `repository.directory` set. Margin's alias/import
specifier updated to match the published name. Dry-run tarball: 41
files, dist+README+LICENSE only, no config/env leakage. Actual publish
is Drew's (`npm login` + `npm publish` from the package dir;
prepublishOnly gates on typecheck + offline tests + build).

## 49. The npm artifact ships no OAuth client (app does, CLI does not)

Considered embedding the shared client into the published package at
prepublish time (mirroring the app's build-time injection) and decided
against it: npm tarballs are the most aggressively crawled artifact
channel, and an automated leak report to Google could get the secret
flagged or reset — which would brick Connect in every shipped copy of
the *app*, not just the CLI. The blast radius asymmetry decides it.
CLI users skew technical and get a client via the shared-JSON paste
path (documented in the internal runbook gist) or bring their own;
the README states the split explicitly. Revisit only if a
non-technical CLI audience materializes (rclone-style obfuscated
embedding is the known escape hatch).

## 50. Parity pick-off: --share and pageless (issues #53/#54)

Pageless is settable after all: `documentStyle.documentFormat.
documentMode: PAGELESS` exists in the current API discovery document
(checked directly rather than trusting memory — long-standing "the API
can't do pageless" lore is stale). Created docs and pushTabs-created
tabs default to pageless (reference behavior); updates never touch the
mode — a user's deliberate flip must survive pushes. RT-1's corpus doc
is now pageless, and the noop re-push still plans zero writes.

Sharing deviates from the reference's `--share [domain]` optional-value
flag: a value-taking `--share-domain` plus boolean `--share` avoids the
domain-vs-filename ambiguity in argument parsing (domains and files
both contain dots). The default domain rides a top-level
`"share-domain"` key in the client config JSON, same paste-once pattern
as `"scopes"` (§48). Role names are user-facing (viewer/commenter/
editor) and map to Drive's reader/commenter/writer. Live-verified:
permission lands with correct role + allowFileDiscovery; probe doc
deleted.

## 51. Margin link + push v0: file↔Doc links, conflict-ask, push-created only

First in-app sync surface (spec §Product model). Choices within it:

**`.margin/gdocs.json`** follows the spec's shape with one deviation:
`baseRef` is a sha256 content hash, not a git blob — identical
detection power, and it works in workspaces without a repo (the git
checkpoint calls remain conditional on `inRepo` for the same reason).

**Linking is push-created only.** "Share to Google Docs" creates the
Doc from the saved file (title = frontmatter/# lift, pageless, images
staged). No link-by-URL in the app: under drive.file it only works for
docs this client already touched, which in practice means docs the app
created — the honest v0 is create-only, with the Picker (#46) as the
future path to existing docs. (The CLI keeps --doc URL targeting; its
users hold full-drive tokens more often.)

**The conflict ask fires whenever the Doc's revision moved since last
sync**, not only when both sides changed: push forces the Doc to match
local markdown, so a collaborator's text edit would be reverted even if
the local file is untouched — that always deserves a confirm. The
banner says what will happen; "Push anyway" re-invokes with force.
Pending-suggestion refusals surface the library's message plus an
"open in Docs" pointer.

**Push reads the saved file, not renderer state**: the chip's actions
save first, then main reads from disk — one content authority, no new
writer (the review-state ownership rule extends unchanged). Actions
disable while an agent round runs.

Verified in-app against the real API: share created+linked+
checkpointed; incremental push reported "1 section updated"; a
simulated collaborator edit (direct batchUpdate) tripped the conflict
banner; force push succeeded; link state survives app restarts.

## 52. Pull v0: through the external-change path, symmetric conflict ask

Pull fetches the Doc as markdown (frontmatter preserved from the local
file) and writes the file on disk; the session's existing watcher does
the rest — a clean editor reloads silently, exactly the spec's "write
through Margin's existing external-change path". The chip's Pull
action saves first, so editor state becomes the file and any unsaved
edits correctly count as local movement.

The conflict rule mirrors §51's push side: pull reverts local edits,
so any local change since last sync (contentRef vs baseRef) asks
before proceeding — with the note that a git checkpoint precedes the
overwrite, so History can restore. The push-conflict banner gained a
"Pull first" action; in the both-changed case that lands on the pull
ask next, which is honest (their edits or yours — something gets
overwritten, and the checkpoints keep both recoverable).

"Already up to date" still refreshes revisionId/baseRef/lastSyncAt —
a noop pull re-bases conflict detection, so a doc-side styling change
that fetches identically stops re-triggering the push ask.

Comments import is deliberately absent (needs the typed comments
module, #25); v0 pull is content only.

Verified in-app against the real API: collaborator batchUpdate →
clean pull applied + editor reloaded silently; both-sides-changed →
pull ask → forced pull won with before/after checkpoints in git log;
scratch Doc deleted after.

## 53. Comments module: read + reply + resolve only, marker-exact emission

`src/comments.ts` (#25) deliberately offers **no comment creation**:
positioned comments are unsupported (anchor format opaque — lesson 6,
issue #37), and unanchored creations would float uselessly; the safe
upstream writes are reply and resolve-via-reply, exactly the spec's
Reply-on-Doc boundary. Records carry `quotedText` prominently (it is
what Margin's re-anchoring consumes) plus `anchored` as presence-only
(orphaned and healthy are indistinguishable, #38). A 403/404 from the
comments endpoint returns null — "unavailable" must not read as
"none".

The fetch surface (#52) emits the `## Comments` section wrapped in the
exact `gpush:comments-*` markers the push side already strips
(UMISC-1), pinned by an offline round-trip test: fetch-append → push
strips to byte-identical input. The section's *content* format is ours
(author — quote — status, replies as nested blockquote lines); only
the markers are interop contract. `gdocs fetch` appends by default
(`--no-comments` opts out; unavailable degrades to no section);
`gdocs comments <url>` works on any Drive file id and prints or writes
the bare list.

Verified live: full fetch→reply→resolve loop on a scratch doc, and the
durable fixture's hand-anchored threads parse (BULLSEYE's UI-made
reply included). 156 offline tests; RT-1 green.

## 54. Sidebar comments import: provenance on threads, renderer-owned writes

Imported Doc threads are ordinary `CommentThread`s with three optional
fields (`provenance: 'imported'`, `driveCommentId`, `collaborator`)
rather than a parallel type — they ride the existing anchor remapping,
archive, and agent-round plumbing for free, and Claude sees them in
review context automatically (spec §Agent integration) with the
collaborator's name attached.

**Merge happens inside pull only**, via `session.mutateReview` — the
same external-change moment that rewrites the file, so the single-
writer rule holds (the renderer saved just before, reloads just
after). Append-only by Drive id: new threads anchor by `quotedText`
against the fresh markdown (`resolveQuote` → `makeAnchor`; misses
import as orphaned); known threads only gain unseen Drive replies
(`driveReplyId` is the merge key); a Doc-side resolve closes a locally
open imported thread; local shadow replies are never touched and never
sync. `fetchComments` returning null (unavailable) changes nothing.

**Upstream writes stay renderer-owned:** Reply-on-Doc and
resolve-on-Doc IPC handlers only make the Drive call and return the
result — the renderer records the sent reply through its normal
`updateReview` path (`addDocReply`), so main never becomes a second
review writer outside pull. Reply on Doc is a separate button on the
same composer (spec: sends exactly the typed text, under the user's
account); the card notes that plain replies stay in Margin. Resolving
an imported thread offers "Margin only" or "here and on the Doc"
(resolve-via-reply), defaulting to an explicit choice rather than a
setting.

Verified in-app against the real API: a Doc comment with a reply
imported on pull, anchored to the right sentence (live editor
highlight), collaborator chip + Docs badge rendered; Reply on Doc
landed on the Drive thread; resolve-with-sync marked it resolved
there. Scratch Doc deleted.

## 55. Quote mapper (#28): mdast-position segment map, ground-truth-driven

`src/anchormap.ts` renders the document the way Docs sees it — block
texts joined by '\n' (one join rule for paragraphs, list items, and
callout body lines; probes A7/A10/A13 agree), syntax markers absent —
while recording per-segment source offsets from mdast positions.
Quote resolution searches the rendered stream and maps back; a
normalization variant (curly→straight quotes, EN dash→`--` — A6's
finding; the dash is EN, not em) is tried when the literal form
misses. Soft-wrapped text inside `> `-prefixed blocks maps per line
(value ≠ source slice there). Ranges may legitimately begin or end
inside styling markers when the selection did (A2/A10) — those are
valid source characters and Margin anchors them fine.

Deliberate non-goals, documented rather than half-built: first
occurrence wins (Drive supplies no context or position — the fixture
itself demonstrated the collision when A9's quote matched my own
instruction text); title/chips/image-captions/cross-cell selections
orphan gracefully.

Margin's import tries source-literal `resolveQuote` first (exact,
cheap, and correct for plain-text quotes), the mapper second. All 15
fixture probes resolve offline against the harvested ground truth;
e2e in the app, a comment quoting across a bold span — previously an
orphan — anchored to the source range including the `**` markers.

## 56. Callouts without emoji; the blank-line-before-tables saga (#63)

Emoji read as tacky on professional docs (beta feedback). New chrome:
tint background + 3pt accent left border + bold accent-colored title,
default title = capitalized type name. The type signal on read moves
from emoji-prefix to **exact tint-background match** — machine-
readable, and stricter than the emoji heuristic (a user's own 1×1
table starting with ⚠️ can no longer false-positive into a callout).
Considered and rejected: inline icon images (staging machinery on
every push, fixed-pixel icons against resizable text, asset hosting).
**No reader migration** for old emoji docs, per Drew: their tint still
detects the callout; the emoji just rides along as literal title text.

The #63 fixes surfaced a real API constraint: `insertTable` always
inserts a newline first, and the API **refuses to delete** that
newline afterward (Invalid deletion range — probed). So the blank
line above tables is avoided at insert time: when the preceding block
is a plain paragraph this call just wrote, the table is inserted AT
that paragraph's trailing newline — the auto-newline becomes the
terminator, the old newline becomes the mandatory post-table
paragraph. Plain paragraphs only: an absorbed quote/heading/list
newline carries its style into the separator and reads back as a
phantom empty block (caught by RT-1 — exactly what the canary is
for). Table-to-table separators are structurally required by Docs;
those shrink to 6pt/zero-spacing instead, which the reader ignores
(empty paragraphs drop). Callout boxes lose their trailing blank via
omitTrailingNewline into the cell's own final paragraph. Table cell
padding bumped 2/5.75 → 4/7.5pt (deliberate deviation from the
reference extraction; Docs renders the original cramped). The bump
exposed a width-algorithm calibration drift: PADDING_PT was a
hardcoded 14 tuned to the old padding, so tight columns lost text
room and bold headers wrapped mid-word ("Component"). PADDING_PT is
now derived from TABLE_STYLE (left+right+3 slack) and the header's
unbreakable floor gets a 1.08 bold-width allowance — headers render
bold and the flat CHAR_PT average under-measured them all along. Cell
paragraph spacing bookends (Drew's hand-tuned values): 4pt above the
first paragraph, 4pt below the last, middle paragraphs keep the body
default 10pt gaps — replaces the bottom-heavy look from the trailing
paragraph's default after-spacing.

## Verification status (honest accounting)

Updated 2026-07-10, all verified by driving the built app over CDP:

- Editing: open/edit/save, autosave, comment compose → highlight → sidecar
  persistence, anchor mapping + re-anchoring (unit-tested), preview toggle
  with anchor highlighting, both Catppuccin themes.
- **Full live agent round** (after `/login` + SDK upgrade to 0.3.x): submit →
  git checkpoint → agent reads doc + review state → replies to the open
  thread → files a suggestion → adds a comment → summary → checkpoint →
  unlock. Accepting the suggestion replaced the text, autosaved, and kept
  the other anchors intact. Note: SDK 0.1.x fails mid-round with
  `tool_use ids must be unique` API 400s — stay on ≥0.3.
- Workspace explorer: root detection, nested grouping, modified dots
  (`git status -uall`), open-item badges, in-window switching, dedupe to
  other windows.
- History popover, model picker plumbing (picker UI verified; a non-default
  model round hasn't been exercised — it's a one-string pass-through).
- Fake agent mode exists but hasn't been exercised end-to-end in the UI
  (same code path as the real round minus the SDK; low risk).
