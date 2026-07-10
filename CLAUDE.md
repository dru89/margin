# CLAUDE.md — Margin (agent-editor)

Margin is an Electron app for co-editing markdown with Claude in PR-style
review rounds. Read `docs/ARCHITECTURE.md` for how it fits together and
`DECISIONS.md` for why — **check DECISIONS.md before changing behavior, and
add a numbered entry there whenever you make a non-obvious choice.** The
author (Drew) reviews that file; it is the contract between sessions.

## Commands

```bash
npm run dev          # electron-vite dev server + HMR
npm run build        # bundle main/preload/renderer to out/
npm start            # run the built app (electron-vite preview)
npm run typecheck    # tsc for both node (main/preload) and web (renderer)
npx electron . path/to/doc.md          # open a specific file (after build)
MARGIN_FAKE_AGENT=1 npx electron . …   # scripted review round, no credentials/tokens
```

There is no test framework. Verification is done by driving the built app
over CDP (see below) plus targeted node scripts for pure logic (compile a
single module with `npx esbuild src/shared/anchors.ts --format=esm --outfile=…`
and assert against it).

## Verifying changes (CDP smoke pattern)

```bash
npm run build
npx electron . --remote-debugging-port=9224 "path/to/doc.md" &   # background
# drive it with puppeteer-core (devDependency; connects, no browser download):
#   puppeteer.connect({ browserURL: 'http://127.0.0.1:9224' })
#   page.evaluate(...), page.screenshot(...)
```

- Scripts using puppeteer-core must run **from the repo root** (ESM resolution).
- Kill the app with `pkill -x electron`. **Never `pkill -f electron`** — the
  pattern matches your own wrapper shell's command line and kills your shell
  (exit 144).
- Take screenshots in both themes: `page.emulateMediaFeatures([{ name:
  'prefers-color-scheme', value: 'light' | 'dark' }])`.
- A real agent round needs a logged-in `claude` CLI (`claude -p "ok"` must
  work in a plain terminal). Otherwise use `MARGIN_FAKE_AGENT=1`, which
  exercises the entire round pipeline with a scripted turn.

## Gotchas that will bite you

- **ESM-only deps in the main process.** The main bundle is CJS.
  `@anthropic-ai/claude-agent-sdk` is loaded via dynamic `import()` (see
  `src/main/agent.ts` — Rollup preserves it). `nanoid` is inlined via
  `externalizeDepsPlugin({ exclude: ['nanoid'] })` in
  `electron.vite.config.ts`. Any new ESM-only dependency used from main must
  go on that exclude list (inline) or be dynamically imported.
- **Nested-session auth.** The spawned agent CLI inherits Margin's env; if
  Margin was launched from inside a Claude Code session, `CLAUDECODE`/
  `CLAUDE_CODE_*` vars make it refuse credentials. `cleanEnv()` in
  `agent.ts` strips them — keep it.
- **`process.execPath` is Electron, not Node**, so agent turns set
  `executable: 'node'` (system Node must be on PATH).
- **Window background color** in `src/main/windows.ts` must match the
  Catppuccin base values in `styles.css` (`#1e1e2e` Mocha / `#eff1f5` Latte).
- **CodeMirror theme injection wins over the stylesheet** for same-specificity
  rules (CM injects later). If a CM default style won't die, remove the
  extension (as done for `highlightActiveLine`) or raise specificity.

## Conventions

- IPC channel names live in `src/shared/ipc.ts`; payload types in
  `src/shared/types.ts`. Preload exposes everything as `window.margin`
  (typed via `src/preload/index.d.ts`). Add new channels in all three places.
- **Review-state ownership:** the renderer owns `content` + `review` while
  the user edits (autosave persists through IPC); the main process owns them
  during an agent round (renderer locks itself via `agent.phase ===
  'running'` and receives `reviewUpdated` pushes). Don't create a second
  writer.
- **Anchors** are offsets + exact quote + 32-char context. While the editor
  is open they're remapped through every ChangeDesc (`store.handleDocChange`);
  quotes are refreshed from offsets on every persist (`refreshAnchors`); on
  load they're re-resolved against file content (`@shared/anchors.reanchor`).
  Programmatic doc edits must go through the CM view
  (`editorBridge.applyReplacement`) so anchors remap — never rewrite
  `content` directly.
- **The agent never writes files.** All agent tools (`src/main/agent.ts`)
  mutate the review sidecar only; text changes land exclusively through
  user-accepted suggestions. Keep `Write`/`Edit`/`Bash` in `disallowedTools`.
- **Colors:** Catppuccin only (Latte light / Mocha dark), via the CSS
  variables in `styles.css`. Never hardcode hex values in components.
- Fonts are bundled Fontsource packages (CSP has no network access):
  Newsreader = document prose, Spline Sans = UI, Spline Sans Mono = code.

## Author preferences that shape this app

- Comments belong in the app, never as `(TK: ...)` markers in the document —
  no TK special-casing anywhere (DECISIONS.md §8).
- Feature priority (2026-07-10): multi-document workspace → comments in
  preview mode → history browser → model picker → about/auto-update/
  packaging → user-authored suggestions.
- Window/OS behavior follows `reference/Netscope Requirements.md`.
