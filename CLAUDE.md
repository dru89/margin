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
- **gdocs-sync is bundled into the main bundle from source** via the
  vite alias + tsconfig.node.json `paths` (no workspace/file: dep).
  Import it as `'gdocs-sync'`; the integration layer is
  `src/main/gdocs.ts`. The library itself must never import Margin.
- **Never return a fresh array/object from a zustand selector**
  (`useStore((s) => s.x.filter(...))`) — it re-renders forever and blanks the
  app with React #185. Select the stable reference, derive after.

## Conventions

- IPC channel names live in `src/shared/ipc.ts`; payload types in
  `src/shared/types.ts`. Preload exposes everything as `window.margin`
  (typed via `src/preload/index.d.ts`). Add new channels in all three places.
- **Discussion is project-scoped** (`<workspaceRoot>/.margin/discussion.json`,
  shared across documents); review threads/suggestions are per-document
  sidecars. Review turns run with cwd = workspace root and
  `settingSources: ['project']` (project skills + CLAUDE.md load; user-level
  config does not — DECISIONS.md §28-29).
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
- **The agent never writes the real file tree.** Its only write surfaces
  are Margin-internal: the notes file (`.margin/agent-notes.md`, via
  `update_notes`) and staged file proposals (`.margin/proposed/` +
  `proposals.json`, via `propose_file` — materialized only by the user's
  explicit Accept). All other agent tools (`src/main/agent.ts`) mutate the
  review sidecar only; text changes land exclusively through user-accepted
  suggestions. Keep `Write`/`Edit`/`Bash` in `disallowedTools`.
- **Colors:** Catppuccin only (Latte light / Mocha dark), via the CSS
  variables in `styles.css`. Never hardcode hex values in components.
- Fonts are bundled Fontsource packages (CSP has no network access):
  Newsreader = document prose, Spline Sans = UI, Spline Sans Mono = code.

## The gdocs-sync package (`packages/gdocs-sync/`)

A **standalone** markdown ↔ Google Docs sync engine — the future
replacement for Drew's internal gpush/gfetch CLIs; Margin will be one
consumer. **Zero imports from Margin, ever** (DECISIONS §42): if a
change would make it know about Margin types, review sidecars, or
Electron, it belongs in Margin's integration layer instead.

**Specs, in authority order:** `docs/specs/gdocs-sync.md` (product,
rev 3+), the `dru89/doc-tools` repo (API lessons, scenario catalog with
stable IDs like RT-1/CP-8/UBUILD-4, interop conventions), the package
README (scenario-coverage checklist = the resumption point), and
`packages/gdocs-sync/docs/splice-findings.md` (one-shot human-verified
anchor experiments — cannot be re-run; treat as ground truth). Open
work is tracked as GitHub issues under the three `gdocs-sync:`
milestones. Tests are named by catalog scenario ID.

```bash
cd packages/gdocs-sync
npm test              # offline tier (CI runs this; no credentials)
npm run test:live     # live tier — real API, scratch docs; skips w/o auth
npm run rt1           # THE canary: noop re-push must plan zero writes
npm run smoke         # client/scopes/APIs end-to-end
npm run auth          # one-time interactive OAuth (loopback+PKCE)
npm run gdocs -- …    # the CLI: auth | push | fetch
npm run build         # tsc → dist/ (publishable output; bin = dist/cli.js)
```

Auth lives in `~/.config/gdocs-sync/google-oauth.json` (Google's
downloaded Desktop-client shape) + a cached token; `~/.config/margin/`
is honored as a legacy fallback. Scope is `drive.file` only.
The live tier's durable fixture doc id is in `test/live/fixtures.ts` —
**read-only, never recreate**; its anchored comments/suggestions were
made by hand in the Docs UI and the API cannot recreate them.

### Gotchas specific to this package

- **Node runs the .ts directly** (type stripping): internal imports use
  `.ts` extensions, and only erasable syntax — no parameter properties,
  no enums. tsc/vitest are configured to match.
- **Run everything from the package dir.** The Bash tool's cwd resets
  between calls; a `python3`/`npm` invoked from the repo root has
  twice edited the WRONG package.json. `cd` in the same command.
- **RT-1 is the canary** for any conversion change: push every block
  type, re-push identical markdown, assert zero writes. If it fails,
  the script prints side-by-side identities. Keep it green forever.
- **Index math is UTF-16 code units** — in TS, `String.length` is
  already correct; do not "fix" it to code points.
- **Phase ordering is load-bearing** (lesson 2): inserts → bullets →
  paragraph styles → text styles; and `updateParagraphStyle` with
  `namedStyleType` RE-APPLIES the named style's text properties —
  paragraph styles must precede text styles or fonts silently vanish
  (this shipped broken once; SI-2 caught it).
- **Table cell requests interleave per cell** (fill → styles, reverse
  document order) — phased styles run against shifted indices.
- **Comment anchor state is API-invisible** — orphaned and healthy
  comments are indistinguishable via `comments.list`; automated tests
  max out at thread survival + quotes; anchor claims need one-shot
  UI-decorated experiments (protocol in splice-findings.md).
- **Sync reads use the default (inline) view for indices; the fetch
  path uses PREVIEW_WITHOUT_SUGGESTIONS; push refuses when suggestions
  are pending** — both other combinations corrupt or destroy content.
- A doc body's first element is a **sectionBreak** — scanners must skip
  it, not stop (broke the meta scanner once).
- Styling is excluded from block identity (UDIFF-7); styling-only
  changes travel via the `restyle` op, never rebuilds.

## Author preferences that shape this app

- In-app comments are the primary feedback channel; inline `(TK: ...)`
  markers are a supported fallback for edits made outside Margin — the agent
  is prompted to answer them and propose replacements (DECISIONS.md §8).
- No Sift/vault/work-log integration for this project — Drew tracks it
  himself.
- **GitHub comments post from Drew's own account.** Write issue/PR comments
  as neutral log entries — never name Drew, address him as "you", or use an
  assistant voice. Under his byline that reads as Drew talking to himself.
- Feature priority (2026-07-10): multi-document workspace → comments in
  preview mode → history browser → model picker → about/auto-update/
  packaging → user-authored suggestions.
- Window/OS behavior follows `reference/Netscope Requirements.md`.
