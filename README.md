# Margin

Co-edit markdown documents with Claude, in review rounds.

You write and comment; the agent reviews, replies, and proposes suggestions
you accept or reject one by one — like a pull-request review for prose.
Documents stay plain markdown files on disk; review state lives in a
`.review.json` sidecar next to each document; git checkpoints every round.

## Requirements

- Node.js 20+ and git on `PATH`
- A logged-in Claude Code (`claude login`) — review rounds run through your
  existing Claude subscription via the Agent SDK; no API key config

## Run it

```bash
npm install
npm run dev            # dev mode with HMR
```

Production build:

```bash
npm run build && npm start
# or open a file directly:
npx electron . path/to/doc.md
```

## The loop

1. Open a markdown file (ideally inside a git repo — `newdoc` projects work
   as-is). Write and edit normally; the app autosaves.
2. Select text and hit **Cmd/Ctrl+M** (or `+ Comment`) to leave an inline
   comment. Use the sidebar's **Discussion** tab for framing and general
   feedback — those messages queue and are sent with your next round.
   Inline `(TK: ...)` markers also work as a fallback for edits made
   outside Margin.
3. **Submit for review** (Cmd/Ctrl+Shift+Enter) with an optional note. The
   round is checkpointed to git, then the agent reads the document (and
   anything else in its folder, e.g. `reference/`), replies to your comments,
   and files suggestions.
4. Accept or reject each suggestion (rejections take an optional comment the
   agent reads next round), reply to threads, resolve what's settled, edit,
   and submit again.
5. Done when neither of you has anything meaningful left to say.

## Layout

```
src/main/       Electron main process — windows, menu, sessions, git, agent
  agent.ts      Agent SDK integration: review turns + MCP review tools
  session.ts    Per-window document session; owns the review lifecycle
src/preload/    contextBridge API (window.margin)
src/renderer/   React UI — CodeMirror editor, sidebar, preview
src/shared/     Types + anchor resolution shared by both processes
```

See [DECISIONS.md](DECISIONS.md) for the why behind the architecture.
