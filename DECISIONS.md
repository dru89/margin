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

## 8. TK markers are first-class

The agent's system prompt tells it to treat inline `(TK: ...)` as author
notes: respond to them and propose a `suggest_edit` replacing the marker with
real text. Your existing habit keeps working with zero UI.

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

## Verification status (honest accounting)

- Verified end-to-end: open/edit/save, autosave, comment compose → highlight →
  sidecar persistence, anchor mapping + re-anchoring (unit-tested), preview
  toggle, git checkpointing, submit → SDK spawn → live status streaming →
  error surfacing → editor unlock, light + dark themes.
- **Not yet verified: a full successful agent round.** The build environment
  had no CLI-usable Claude credentials (host-managed session), so the turn
  failed at auth — correctly surfaced in the UI. First submit on a machine
  with a normal `claude` login exercises the last untested step: the agent
  actually calling `reply_to_comment`/`suggest_edit`. The tool handlers are
  the same quote-resolution code that is unit-tested, so risk is contained,
  but expect to tune the system prompt after the first real rounds.
