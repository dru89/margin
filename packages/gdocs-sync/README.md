# gdocs-sync

Sync markdown files to Google Docs and back, without losing your
colleagues' comments.

`gdocs push` turns a markdown file into a styled Google Doc — headings,
lists, tables, code blocks, images, callouts, a title block with author
and date chips. Pushing again after an edit diffs the live document
against your markdown and rewrites **only the blocks that changed**, so
comments anchored to untouched paragraphs survive. Styling-only edits
(say, bolding a word) are patched in place without deleting anything, so
even comments inside the edited block survive those. `gdocs fetch` pulls
a doc back down as clean markdown.

It uses only the `drive.file` OAuth scope: the tool can touch documents
it created (or that you explicitly open with it) and nothing else in
your Drive.

## Install

```bash
npm install -g @dru89/gdocs-sync   # CLI: `gdocs` on your PATH
npm install @dru89/gdocs-sync      # library
```

Or from a checkout:

```bash
cd packages/gdocs-sync
npm install
npm run build       # compiles to dist/
npm link            # puts `gdocs` on your PATH
```

Requires Node 22+.

## One-time setup: OAuth client + auth

The CLI deliberately ships without an OAuth client (the Margin app
bundles one; the npm artifact does not). Either save a client JSON a
colleague or org shared with you as
`~/.config/gdocs-sync/google-oauth.json`, or create your own — five
minutes, free, no verification needed because `drive.file` is not a
sensitive scope:

1. In [Google Cloud Console](https://console.cloud.google.com/), create
   a project (any name) and enable the **Google Docs API** and
   **Google Drive API** (APIs & Services → Library).
2. Configure the OAuth consent screen (External, just app name + your
   email; you can leave it in Testing and add yourself as a test user).
3. Create credentials → **OAuth client ID** → application type
   **Desktop app**, and download the JSON.
4. Save it as `~/.config/gdocs-sync/google-oauth.json` (the downloaded
   `{"installed": {...}}` shape works as-is).
5. Run `gdocs auth`, open the printed URL, approve. The token is cached
   at `~/.config/gdocs-sync/google-token.json` (mode 0600) and refreshes
   itself.

By default only `drive.file` is requested. If your OAuth client is
approved for broader access (e.g. an org-internal client), add a
top-level `"scopes"` array to the client JSON — it becomes the default
for `gdocs auth` — or pass `--scope drive` explicitly. With full drive,
`gdocs fetch` works on any doc you can read, not just tool-created ones.

## CLI usage

```bash
# Create a new doc from a markdown file and record its URL in the
# file's frontmatter (url: ...):
gdocs push notes.md --write-url

# Subsequent pushes read the URL from frontmatter and update in place:
gdocs push notes.md

# Or target a doc explicitly:
gdocs push notes.md --doc https://docs.google.com/document/d/<id>/edit

# Multi-tab documents: one markdown file per tab, Title=path specs.
# Tabs are created/renamed/reordered/deleted to match the spec order.
gdocs push "Overview=overview.md" "Design=design.md" --doc <url>

# Pull a doc back down as markdown (frontmatter is preserved/updated
# if the output file already exists):
gdocs fetch <url> notes.md

# Pull a multi-tab doc: writes one file per tab plus a push-back spec:
gdocs fetch <url> --tabs out-dir/

# Share the pushed doc with your whole domain in the same step
# (default role commenter; default domain from "share-domain" in the
# client JSON):
gdocs push notes.md --share
gdocs push notes.md --share-domain example.com --share-role viewer --no-searchable
```

Created docs are **pageless** by default (`--no-pageless` opts out);
existing docs are never flipped.

Frontmatter drives the title block: `title`, `subtitle`, `author` (or
`authors`), `author-email`, and `date` become the doc's TITLE/SUBTITLE
paragraphs and smart chips. A leading `# Heading` also lifts to the doc
title. `> [!note] Callouts` (GFM/Obsidian alert syntax) render as tinted
boxes.

Safety rails: every write batch is revision-guarded (a concurrent edit
aborts the push, which you can simply re-run), and a push is **refused**
while the doc has pending suggestions — resolve them first, because a
block rebuild would silently discard them.

## Library usage

```ts
import {
  createFromMarkdown,
  updateFromMarkdown,
  fetchAsMarkdown,
  HttpDocsClient,
  getAccessToken,
  makeDocxStager,
} from '@dru89/gdocs-sync';

const token = await getAccessToken(); // null → run authorize() first
const client = new HttpDocsClient(() => getAccessToken());

const { documentId } = await createFromMarkdown(client, markdown, {
  baseDir: '/path/for/relative/images',
  imageStager: makeDocxStager(() => getAccessToken()),
});

await updateFromMarkdown(client, documentId, editedMarkdown, opts);
const md = await fetchAsMarkdown(client, documentId);
```

`updateFromMarkdown` returns a plan summary (`regions`, `requestsSent`)
— zero for a no-op push, which the test suite holds as an invariant.
For multi-tab documents use `pushTabs`/`fetchTabs` from the same entry
point. All markdown↔block-model logic (`parseMarkdown`,
`blocksToMarkdown`, the differ) is exported and runs offline.

## What survives a round trip

Headings (`#` = title, `##`–`####` = H1–H3 styles), paragraphs with
bold/italic/strikethrough/code/links, tight and loose lists (bulleted,
numbered, checkboxes), fenced code blocks, tables (with header chrome,
zebra striping, and reference-derived column widths), blockquotes,
callouts, horizontal rules, figure and inline images, and person/date/
rich-link smart chips (chips read back as their display text or link).
Known limits live in [docs/COVERAGE.md](docs/COVERAGE.md) and the
repo's `api-blocked` issues — the biggest: comments can be *preserved*
but not yet created/imported (v2), and a checkbox checked by hand in
the UI is invisible to the API unless its text is struck through.

## Development

```bash
npm test            # offline tier: 108 tests, no credentials needed
npm run test:live   # live tier against real Docs API (skips w/o auth)
npm run rt1         # round-trip canary: full-corpus doc, re-push = 0 writes
npm run typecheck
```

Tests are named by scenario IDs from
[dru89/doc-tools](https://github.com/dru89/doc-tools). Coverage ledger:
[docs/COVERAGE.md](docs/COVERAGE.md). Splice/anchor API findings:
[docs/splice-findings.md](docs/splice-findings.md).
