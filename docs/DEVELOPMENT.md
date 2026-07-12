# Developing Margin

## Requirements

- Node.js 20+ and git on `PATH`
- A logged-in Claude Code (`claude -p "ok"` should work in a plain terminal) —
  review rounds run through your existing Claude subscription via the
  [Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)

## Run from source

```bash
npm install
npm run dev            # electron-vite dev server with HMR
```

Production build:

```bash
npm run build && npm start
# or open a file/folder directly:
npx electron . path/to/doc.md
```

No credentials handy? `MARGIN_FAKE_AGENT=1 npm run dev` runs review rounds
with a scripted turn — the full pipeline, no tokens.

## Package

```bash
make package-linux     # AppImage + pacman into dist/
make package-mac       # dmg + zip (run on macOS)
```

AppImages need libfuse2; on Arch-family systems run with
`--appimage-extract-and-run` or `pacman -S fuse2`.

## Release

```bash
make release           # bump version, tag, push — GitHub Actions does the rest
```

The tag push triggers `.github/workflows/release.yml`: typecheck, per-platform
builds, and one GitHub Release carrying the artifacts plus the
`latest*.yml` feeds that in-app auto-update reads.

macOS signing/notarization is optional until these repo secrets exist
(unsigned builds download fine but won't auto-update):
`MAC_CERTIFICATE_BASE64` (base64 .p12, Developer ID Application),
`MAC_CERTIFICATE_PASSWORD`, and for notarization `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

## Layout

```
src/main/       Electron main process — windows, menu, sessions, git, agent
  agent.ts      Agent SDK integration: review turns + MCP review tools
  session.ts    Per-window document session; review lifecycle + file watching
src/preload/    contextBridge API (window.margin)
src/renderer/   React UI — CodeMirror editor, review sidebar, discussion dock
src/shared/     Types + anchor resolution shared by both processes
site/           Static marketing site (published as-is by Netlify)
```

Architecture: [ARCHITECTURE.md](ARCHITECTURE.md). Why things are the way they
are: [../DECISIONS.md](../DECISIONS.md) — read it before changing behavior,
and add a numbered entry when you make a non-obvious call. Agent-facing
contributor notes live in [../CLAUDE.md](../CLAUDE.md), including the CDP
smoke-test recipe used in place of a test framework.
