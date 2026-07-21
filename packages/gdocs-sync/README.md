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
- [x] UBUILD-1..5 — request builder (phase ordering, bullet-tab index
      correction, explicit-styles invariant) (`src/builder.ts`)
- [x] USCOPE-1..3 — orchestrator vs. fake Docs service (`src/sync.ts`)
- [x] UREAD (partial) — run merging (UREAD-5), heading −1 shift, ranges;
      remaining: chips, checkboxes, adjacent-list separation, subtitle
- [x] **RT-1 (live) — PASSING.** Corpus: 3 heading levels, styled
      paragraphs, nested + ordered lists, table, fenced code,
      blockquote. Create ≈47 writes; identical re-push plans zero.
      `npm run rt1` (needs `npm run auth` once).
- [x] Serializer (fetch path): blocks → markdown, contract = re-parse
      is identity-equal; UREAD-5 hygiene, checkbox round-trip
      (`src/serialize.ts`)
- [x] UTAB-1..9 — tab reconciliation planner (`src/tabs.ts`)
- [x] UWIDTH-1..5 — **reference** column-sizing algorithm (percentile,
      wrap tier, word floor, prefix pooling, water-fill, SI-4
      centering) (`src/widths.ts`)
- [x] Reference styles from reference.docx (`src/styles.ts`): Roboto
      body, Lato headings, Roboto Mono code, extracted spacing
- [x] Checkboxes end-to-end: BULLET_CHECKBOX + strikethrough encodes
      checked (conventions option c); read detection probed live
- [x] Live tier v1 (`npm run test:live`): comments persist across
      region rebuilds, CP-5 edit-lands, edit→noop stability. Skips
      without credentials; scratch docs self-clean.
- [ ] CP anchored-survival (CP-1..4/8 proper) — **blocked**:
      programmatic comments are unanchored (probed); needs the
      reference harness technique (asked in margin#10)
- [ ] UREAD-8..10 remainder — chips read, subtitle policy
- [ ] UIMG-1,3..6 — image index math, staging, sizing (v0 gap: images
      still placeholder in builder)
- [ ] UCHIP-1..4 — metadata block (title/subtitle/chips) replacement
- [ ] UAUTH-4 — auth flow end-to-end (fake flow)
- [ ] Live tier: SI-*, TAB-*, IMG-*, META-* per the catalog.

Known warts (deliberate, revisit): update regions at doc end can leave
a trailing empty paragraph (the final segment newline is undeletable —
lesson 13; the reader skips empties so parity holds); code blocks with
blank lines split on read-back; checkbox list items round-trip as plain
items; UI-checked boxes whose text is not struck read back as
unchecked (probed: the API exposes no checked state at all).

## Architecture

Pure decision logic, tested offline: markdown → `CanonicalBlock[]`
(`markdown.ts`), block identity + canonical forms (`blocks.ts`), LCS
diff with modify-fusion (`differ.ts`), contiguous rebuild regions
(`regions.ts`). Everything API-facing arrives later behind the same
canonical model: request builder (UBUILD), doc read-back (UREAD),
orchestrator + fake Docs service (USCOPE), then the live tier.

Index math is UTF-16 code units throughout — in TS, `String.length` is
already correct; do not "fix" it to code points (lesson 1).
