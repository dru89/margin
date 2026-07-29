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
over CDP (see below) plus targeted node scripts for pure logic — compile a
module with esbuild and assert against it. Existing suites:

```bash
npm test                 # all suites
npm run test:state       # review-state derivation + transitions
npm run test:anchors     # anchor resolution, orphaning, position stability
npm run test:worddiff    # trimming a suggestion to what actually changed (§6)
npm run test:composer    # what counts as a draft the composer must protect (§66)
npm run test:mentions    # finding @path references in comment text (§67)
npm run test:paths       # agent-supplied path validation (the untrusted boundary)
npm run test:workspace   # project-root derivation + its two guards (§63)
npm run test:sidecar     # load, backfill, rename recovery, refusing a stranger's
npm run test:tables      # GFM table formatting
npm run test:git         # git is optional — runs with git off PATH (#145)
npm run test:errors      # what a failed round says and whether it rolls back (§71)
npm run test:project     # margin.json: the legacy fallback and the name
npm run test:policy      # when an update may interrupt (§76)
npm run test:contract    # the REAL agent, unauthenticated — free, fast, CI-safe (§73)
```

`scripts/lib/compile.mjs` does the esbuild-and-import; a new suite is
~10 lines of setup plus assertions.

**Two tiers exercise the real Claude agent**, because every journey runs
the scripted one and nothing else executes `agents/claude.ts`:

```bash
npm run test:contract    # in `npm test`: no credentials, $0, ~0.4s
npm run test:live        # by hand, before a release: one real round
```

`test:contract` runs a turn with **every credential removed** and asserts
it reaches an auth refusal — which proves the SDK loaded, our options were
accepted and the MCP tools were built, since anything malformed fails
somewhere else. It also pins the rule that *not signed in is a failure,
not a round*: the CLI reports that as a **successful** result carrying
`is_error`, so a turn reading only `subtype` would post "Please run
/login" into the discussion as review feedback and spend a round on it.

`test:live` skips (exit 0, printing why) when unauthenticated. **Running
it from inside a Claude Code session skips too** — `cleanEnv()` strips
that session's token refresh on purpose, so the spawned CLI falls back to
whatever is on disk. Run it from a plain terminal.

Both use `scripts/lib/agentHarness.mjs`, which compiles `claude.ts` with
the SDK left **external** and the output inside the repo — bundling the
SDK inlines its binary loader, which then looks beside the bundle and
fails with "Native CLI binary not found".

**Journey tests** drive the built app through Playwright's Electron
support — they have replaced the ad-hoc CDP scripts for anything worth
keeping:

```bash
npm run test:e2e         # builds, then runs test/e2e/
npm run test:e2e:quiet   # the same, on a virtual display (Linux)
```

**`test:e2e:quiet` is the one to use while working.** Electron has no
headless mode, so a normal run maps real windows and takes focus —
stopping whatever else you were typing into for the ~90s the suite
lasts. `xvfb-run` gives it an X server with its own root window, focus
model and cursor, unconnected to the session compositor, so the journeys
still exercise a real mapped window on a screen nobody is attached to.
Needs `xorg-server-xvfb` (Arch) or `xvfb` (Debian); CI has always run
this way. The screen size is pinned because Xvfb defaults to 640x480,
which is smaller than the app window.

`test/e2e/margin.ts` launches with an isolated `--user-data-dir` and a
seeded `projectsDir`, so a test never touches real settings, recents, or
`~/Documents/Margin`. `MARGIN_FAKE_AGENT=1` is always set. Assert on what
the user ends up with — which window holds what, sidecar contents, file
contents — never on markup, or a restyle breaks the suite. All four
critical journeys are in place (#134, #135 and the two before them).

**Use `projectDoc()`, not `doc()`, for anything that submits a round.** A
project is declared and never derived (DECISIONS §75), so a document
written into a bare folder belongs to nothing and a round stops to ask
for one. `doc()` is for when the *absence* of a project is the point —
`adoption.spec.ts` is the only current caller.

**Journey 1 is the one to read first** — `journey-1-review-round.spec.ts`
walks a whole round and crosses the four seams that have produced the
most bugs: review-state ownership handing off to main and back, the
agent tool surface, anchor remapping through an accepted edit, and
sidecar persistence holding all of it.

Traps this suite has already hit:

- `electron.launch()` resolves before any window exists — await
  `firstWindow()`.
- Clicking a link that `will-navigate` blocks needs
  `click({ noWaitAfter: true })`, since the navigation Playwright waits
  for is precisely the one that must never happen. Stub
  `shell.openExternal` via `app.evaluate` or the run opens a real browser.
- **Read the sidecar through a try/catch that returns null.**
  `expect.poll` retries a failed assertion but *propagates a thrown
  error*, so a read landing before the first autosave ends the run with
  ENOENT instead of waiting.
- **Select text by counting from the start of the document**, not by
  clicking a line and pressing Home. A `.cm-line` click lands at the
  centre of its box — the end of a visual row on a wrapped line — and
  `Home` with line wrapping goes to that row's start, not the logical
  line's. The arrows then walk off the end and leave no selection, which
  surfaces as a disabled `+ Comment` and nothing else.
- **Wait for the round to *finish*, not for its first results.** The
  agent keeps working after the visible output lands, and the editor
  stays read-only for all of it — correctly. Typing into that window
  silently does nothing.
- **"No orphan badge" is not "the anchor is right."** An anchor that
  migrated onto different text shows no badge either — the #126 failure
  exactly. Assert the marked range's own text
  (`.anchor[data-anchor-id=…]`), not the absence of a warning. Journey 3
  passed a never-orphan mutant until it did.
- **Native dialogs are stubbed on the app object**, not the page:
  `app.evaluate(({ dialog }) => { dialog.showOpenDialog = … })`. Both
  `showOpenDialog` and `showMessageBox` need answering to drive the
  Open Folder path.
- **`app.isPackaged` is `true` under Playwright's Electron.** Anything
  behind a `!app.isPackaged` branch is unreachable from a journey, so a
  test affordance has to be gated on its own env var *before* that check
  — `MARGIN_FAKE_UPDATE` shipped broken once for exactly this reason.
- **"Open Folder" seeds the window with the *first* markdown file under
  it, sorted.** A fixture whose intended starting document does not sort
  first opens somewhere else, and any later "switch to another document"
  step becomes a no-op that passes for the wrong reason — which is
  exactly how the adoption suite's window-scoping case first passed
  against a build with the behaviour removed.

**When a change needs a test:**

- A **bug fix** in `src/shared/` or `src/main/` logic ships with a case
  that *fails without the fix*. You already wrote the reproduction while
  debugging — commit it instead of deleting it. (#125 and #126 both
  shipped without one; the suite added afterwards fails 7 cases against
  the pre-fix code, so the net was always available and simply thrown
  away.)
- A **new logic module** gets a suite.
- A **changed rule** updates the case that asserted the old one, so the
  diff shows the decision changing.

Not required for presentation (CSS, layout, copy), for wiring with no
branching, or for anything only judgeable by eye — that is what the CDP
screenshots are for.

**What to assert: the decision, not the code path.** Every case should be
traceable to a DECISIONS entry, a spec rule, or a filed bug. If you can't
name what a case protects, it is probably asserting an implementation
detail and will break the next time someone touches the file. Never
assert DOM structure or internal call order.

**Cover transitions, not just states.** The review-state cases all passed
while replying to an unread thread still left it reading as unread — the
bug lived on an edge between two states that were each individually
correct.

## A project to look at

```bash
npm run fixture      # builds .fixtures/review-surface (gitignored), then prints the open command
```

A self-evaluation document with a review already in it: threads in every
state from the spec (draft, awaiting, unread, read, settled, orphaned, a
six-message thread, one imported from a Doc), pending/accepted/rejected
suggestions including a deletion, a queued discussion message, a second
document so the explorer has something to show, and a git repo. Anchors
are computed against the real text, so the generator fails loudly rather
than producing a document full of accidental orphans. Re-running resets
it.

Use it when working on the review surface — an empty document hides
every problem worth seeing.

## Verifying changes (screenshots and smoke tests)

**Default to a virtual display.** Electron has no headless mode, so
anything that launches the app takes over the screen and the keyboard
focus of whoever is sitting at it. `xvfb-run` removes that cost
entirely, and nothing is given up: fonts resolve identically, layout is
identical, and forcing the backing scale makes screenshots *sharper*
than a real fractional-scaled display.

```bash
npm run test:e2e:quiet    # the journey suite, on a virtual display
```

For a screenshot, drive the built app from Playwright under the same
wrapper — it passes `env` explicitly, which a backgrounded `npx electron`
may not (see below):

```bash
xvfb-run -a -s "-screen 0 1920x1080x24" node scripts/shot.mjs --file .fixtures/review-surface/self-evaluation.md --name surface
```

`scripts/shot.mjs` takes both themes, uses an isolated `--user-data-dir`,
and forces a 2x backing scale — without that the capture is 1x and
noticeably soft. Pass `--selector .toolbar` to crop to one region when
the change is local, and `--name` to control the output basename
(`<name>-light.png` / `<name>-dark.png` under `.fixtures/shots/`).

**The CDP route still exists** for poking at an app that is already
running, and it is the only way to inspect a session started by hand:

```bash
npx electron . --remote-debugging-port=9224 "path/to/doc.md" &
# puppeteer.connect({ browserURL: 'http://127.0.0.1:9224' }) — puppeteer-core
# is a devDependency, so this connects without downloading a browser.
```

- Scripts using puppeteer-core must run **from the repo root** (ESM resolution).
- Kill the app with `pkill -x electron`. **Never `pkill -f electron`** — the
  pattern matches your own wrapper shell's command line and kills your shell
  (exit 144).
- A real agent round needs a logged-in `claude` CLI (`claude -p "ok"` must
  work in a plain terminal). Otherwise use `MARGIN_FAKE_AGENT=1`, which
  exercises the entire round pipeline with a scripted turn.
- **Env vars may not survive backgrounding.** Some agent harnesses scrub
  the environment of detached processes, so `VAR=x npx electron . &`
  silently starts the app *without* `VAR`, and the feature under test
  looks broken. This is the main reason to prefer Playwright, which
  passes `env` explicitly. Verify the harness with a plain `sleep`,
  **not** with Electron: Chromium scrubs its helper processes' `environ`,
  so `/proc/<pid>/environ` reads back as NULs and every variable looks
  absent whether it is or not.

## Gotchas that will bite you

- **ESM-only deps in the main process.** The main bundle is CJS.
  `@anthropic-ai/claude-agent-sdk` is loaded via dynamic `import()` (see
  `src/main/agents/claude.ts` — Rollup preserves it). `nanoid` is inlined via
  `externalizeDepsPlugin({ exclude: ['nanoid'] })` in
  `electron.vite.config.ts`. Any new ESM-only dependency used from main must
  go on that exclude list (inline) or be dynamically imported.
- **The Agent SDK vendors its own `claude` binary** (compressed inside
  the package; `manifest.json` names the CLI version, no `cli.js` on
  disk). The system `claude` is never used. That binary pins the model
  catalog `supportedModels()` returns, so **new Claude models need an
  `@anthropic-ai/claude-agent-sdk` bump** — it's on the release
  checklist. Deliberately not using `pathToClaudeCodeExecutable`
  (DECISIONS §59): reproducibility over freshness. Check the vendored
  version with `manifest.json`; print the live catalog with
  `node scripts/model-catalog.mjs`.
- **Nested-session auth.** The spawned agent CLI inherits Margin's env; if
  Margin was launched from inside a Claude Code session, `CLAUDECODE`/
  `CLAUDE_CODE_*` vars make it refuse credentials. `cleanEnv()` in
  `agents/claude.ts` strips them — keep it.
- **`process.execPath` is Electron, not Node**, so agent turns set
  `executable: 'node'` (system Node must be on PATH).
- **Window background color** in `src/main/windows.ts` must match the
  Catppuccin base values in `styles.css` (`#1e1e2e` Mocha / `#eff1f5` Latte).
- **CodeMirror theme injection wins over the stylesheet** for same-specificity
  rules (CM injects later). If a CM default style won't die, remove the
  extension (as done for `highlightActiveLine`) or raise specificity.
- **`styles.css` is long enough that source order is not a defense.** A new
  single-class rule loses to an existing single-class rule defined further
  down, silently. This has bitten three times: `.cm-selectionMatch` (dead
  for months, matches painted CodeMirror's green), the review-state spine
  (`.card::before` is defined late, so the whole state vocabulary rendered
  as the old pair-accent), and `.card-context-del` (the insertion color
  won, so deleted text stayed green). Win on **specificity** — two classes,
  or a custom property the base rule reads — not on where the rule sits.
  And verify the computed value, not that the class is present.
- **`focus()` scrolls, and it wins against a smooth scroll.** Focusing an
  off-screen element yanks its scroller into place in one frame, so a
  `scrollIntoView({ behavior: 'smooth' })` running on the same container
  ends as a snap — the animation is there, it just gets overwritten on
  its first frame. Any `focus()` issued alongside a scroll needs
  `focus({ preventScroll: true })`. React's `autoFocus` prop takes no
  options, so a mount that also animates has to focus in an effect.
- **Unregistered CSS custom properties do not interpolate.** `background:
  var(--x)` with a `transition` declared will still snap when `--x` changes
  — the declaration is there but has nothing to animate. Put the animated
  value on the element directly (qualify the selector to win on
  specificity), or register the property with `@property`. A conditionally
  *rendered* element can't fade either: keep it mounted and collapse it.
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
- **A project is declared, never derived** (`margin.json`; DECISIONS
  §74-75). The window's root is a property of what was *opened* and is
  carried through `attachDocument(win, file, root)` — don't re-derive it
  per document. `DocumentSession.hasProject` is false when nothing
  declared one, and **every write of project state is gated on it**:
  agent notes, the discussion, the project file, staged proposals, the
  Google Docs link. New project-scoped state goes on that list, and its
  UI affordance has to be *unavailable* rather than inert.
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
  explicit Accept). All other agent tools (`src/main/agents/claude.ts`) mutate the
  review sidecar only; text changes land exclusively through user-accepted
  suggestions. Keep `Write`/`Edit`/`Bash` in `disallowedTools`.
- **Anything reachable from agent-authored text is an untrusted request.**
  Comment text renders `@path` chips, so `openExternal` checks containment
  in the project (`resolveInsideWorkspace`) instead of trusting its caller
  — the renderer declining to make a chip clickable is presentation, not a
  boundary. Apply the same rule to anything new that turns agent output
  into a file or URL the user can activate.
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
