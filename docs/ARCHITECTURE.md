# Margin — Architecture

## Processes

```
┌─ Electron main ─────────────────────────────────────────────┐
│ index.ts     app lifecycle, single-instance, open-file      │
│ windows.ts   window creation, cascade, open-file dedupe     │
│ menu.ts      native menu + Open Recent (recents.ts)         │
│ ipc.ts       ipcMain handlers (all channels in shared/ipc)  │
│ session.ts   DocumentSession — one per window/document      │
│ reviewStore  sidecar load/save (+ re-anchoring on load)     │
│ git.ts       execFile('git') — checkpoints, status, log     │
│ agent.ts     Agent SDK review turns + MCP review tools      │
└──────────────┬──────────────────────────────────────────────┘
               │ contextBridge: window.margin (preload/index.ts)
┌─ Renderer (React) ──────────────────────────────────────────┐
│ store.ts     zustand — doc content, review state, agent UI  │
│ EditorPane   CodeMirror 6 (editor/extensions.ts)            │
│ Sidebar      threads, suggestions, composer, archive        │
│ Toolbar      mode toggle, comment, submit popover           │
│ Preview      react-markdown (GFM)                           │
│ AgentBar     round status stream + cancel + log             │
└─────────────────────────────────────────────────────────────┘
```

One document per window (a `DocumentSession` keyed by `webContents.id`).
Multiple windows share the single app process.

## Data model (src/shared/types.ts)

- The **document** is a plain `.md` file — never contains app metadata.
- **ReviewData** lives in `<doc>.md.review.json` beside it: comment threads
  (with replies, open/resolved), suggestions (pending/accepted/rejected,
  rejection carries an optional `decisionComment`), and the **discussion** —
  a document-level conversation whose user messages queue (`pending`) and
  send with the next round; the agent's closing message each round is its
  reply. Threads and suggestions are keyed to text via **Anchors**.
- **Anchor** = `{from, to, quote, prefix, suffix, orphaned?}`. Offsets are a
  cache; the quote+context is the durable identity. Resolution logic is in
  `src/shared/anchors.ts` (shared by main and renderer):
  - live edits → offsets remapped through CodeMirror `ChangeDesc`
  - persist → quote/context refreshed from offsets
  - load → `reanchor()` re-finds the quote (context match, then proximity);
    misses become `orphaned: true` (thread survives in sidebar, no highlight)
  - agent tools address text by exact quote via `resolveQuote()`

## Review round lifecycle

```
user edits/comments  (renderer owns state; autosave via IPC)
        │ Submit for review (optional note)
        ▼
save doc + sidecar → round += 1 → git commit "Review round N: submitted"
        ▼
agent.ts runReviewTurn(): Agent SDK query()
  cwd = document folder    settingSources: []    executable: 'node'
  MCP server "review": read_document, list_review_state,
                       reply_to_comment, add_comment, suggest_edit
  allowed: Read/Grep/Glob + review tools; Write/Edit/Bash/… disallowed
  tool handlers mutate session.review → save sidecar → push reviewUpdated
        │ (renderer is locked read-only; AgentBar streams activity)
        ▼
git commit "Review round N: agent review" → agentStatus done/error → unlock
        ▼
user accepts/rejects suggestions, replies, resolves threads … repeat
```

Each round is a **fresh agent session** — continuity comes from the artifact
(document + full review state incl. rejected suggestions and their
decisionComments), not conversation history. Errors (including auth failures
from the spawned CLI) surface in the AgentBar; a failed round leaves the
document untouched.

Accepting a suggestion dispatches the replacement **through the CodeMirror
view** (`editorBridge.applyReplacement`) so every other anchor remaps.

## Agent boundary

The Claude Agent SDK runs Claude Code headlessly from the main process
(dynamic `import()` — ESM-only dep in a CJS bundle). It spawns the SDK's
bundled CLI with system Node and the user's existing `claude` login; Margin
never handles API keys. `cleanEnv()` strips `CLAUDE_CODE_*` markers so
Margin works when launched from inside a Claude Code session.
`MARGIN_FAKE_AGENT=1` substitutes a scripted turn (no network) that exercises
the same mutation/streaming paths — for dev and demos.

## Window management (per reference/Netscope Requirements.md)

Single instance (second launch routes files into the first process);
new windows cascade +28px from the focused window, centered fallback
(Wayland-safe); opening an already-open file focuses its window; a welcome
window offers Open; recents in File ▸ Open Recent (userData store +
`app.addRecentDocument`). Shortcuts: Cmd/Ctrl+N/O/S/W, Cmd/Ctrl+E preview,
Cmd/Ctrl+M comment, Cmd/Ctrl+Shift+Enter submit.

## Build

electron-vite: main + preload bundle to CJS with deps external (except
ESM-only `nanoid`, inlined); renderer is a normal Vite React app, fonts
bundled via Fontsource, CSP `default-src 'self'`. `npm run typecheck` runs
both tsconfigs (`tsconfig.node.json`, `tsconfig.web.json`).
