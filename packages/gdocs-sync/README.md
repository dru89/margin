# gdocs-sync

Standalone markdown ↔ Google Docs sync engine. **No Margin imports,
ever** — Margin is one consumer; the other planned consumer is a CLI
that replaces the reference gpush/gfetch tools. Lives in this repo for
now; extracts to its own repo when stable.

The specification is external:

- Product spec: [`docs/specs/gdocs-sync.md`](../../docs/specs/gdocs-sync.md)
- Behavior + scenario catalog: [`dru89/doc-tools`](https://github.com/dru89/doc-tools)
  (`google-docs-api-lessons.md`, `test-scenarios.md`, `conventions.md`)

Tests are named by scenario ID from the catalog. Run with `npm test`
(offline tier only; the live tier comes later and skips without
credentials).

## Scenario coverage

- [x] UCANON-1..3 — canonicalization parity (`src/blocks.ts`)
- [x] UDIFF-1..7 — block diff planner (`src/differ.ts`)
- [x] UREGION-1..5 — rebuild regions (`src/regions.ts`)
- [x] UMD-1..4 — dialect pins (`src/markdown.ts`)
- [x] UMISC-1..5 — marker strip, width, tab titles, doc IDs, frontmatter
- [x] UQUOTA-1..3 — retry wrapper (`src/util.ts`)
- [x] UAUTH-1..3 — scope checks (pure part; UAUTH-4 needs the auth flow)
- [x] UIMG-2 — figure/inline/empty-alt trichotomy (parse side)
- [ ] UBUILD-1..5 — request builder (blocks → batchUpdate; phase
      ordering, bullet-tab index correction, explicit-styles invariant)
- [ ] UREAD-1..10 — Docs JSON → blocks/markdown (run merging, chips,
      checkboxes, heading −1 shift with SUBTITLE→frontmatter)
- [ ] UIMG-1,3..6 — image index math, figure emission, sizing
- [ ] UCHIP-1..4 — metadata chip block replacement (fake service)
- [ ] UTAB-1..9 — tab reconciliation planner
- [ ] USCOPE-1..3 — orchestrator vs. fake Docs service
- [ ] UAUTH-4 — auth flow end-to-end (fake flow)
- [ ] Live tier: RT-1 first (noop re-push, zero writes), then CP-*,
      SI-*, TAB-*, IMG-*, META-* per the harness design in the catalog.

## Architecture

Pure decision logic, tested offline: markdown → `CanonicalBlock[]`
(`markdown.ts`), block identity + canonical forms (`blocks.ts`), LCS
diff with modify-fusion (`differ.ts`), contiguous rebuild regions
(`regions.ts`). Everything API-facing arrives later behind the same
canonical model: request builder (UBUILD), doc read-back (UREAD),
orchestrator + fake Docs service (USCOPE), then the live tier.

Index math is UTF-16 code units throughout — in TS, `String.length` is
already correct; do not "fix" it to code points (lesson 1).
