---
name: gdocs
description: Sync markdown with Google Docs using the gdocs CLI — push creates or updates a doc in place (preserving collaborator comments and suggestions), fetch pulls it back as markdown with comments, plus multi-tab docs, sharing, and pageless mode. Use when the user wants to push, publish, update, or fetch a Google Doc from markdown.
---

# gdocs — markdown ↔ Google Docs sync

Use the `gdocs` CLI to push markdown to Google Docs and pull docs back down as markdown. Unlike upload tools that pave the document, `gdocs push` computes a diff and edits the doc in place — collaborators' comments and suggestions survive updates.

For Google **Slides**, **Sheets**, or native docx/pptx/xlsx uploads, use `gpush`/`gfetch` instead; for SharePoint or Confluence, use `docfetch`.

## Commands

### Push (create or update)

```bash
gdocs push notes.md                      # create; title from # heading → frontmatter title: → filename
gdocs push notes.md --write-url          # also record the new doc's URL in frontmatter (url:)
gdocs push notes.md --doc <url|docId>    # explicit target
gdocs push notes.md --share              # share with the configured domain (commenter by default)
gdocs push notes.md --no-pageless        # create in paged mode (default is pageless)
```

Target resolution: `--doc`, else a bare url/docId argument, else the file's frontmatter `url:`. The recommended loop is `--write-url` on the first push, then plain `gdocs push file.md` for every update after — the frontmatter URL makes it update in place.

Sharing options: `--share-domain <d>` (implies `--share`), `--share-role viewer|commenter|editor` (default commenter), `--no-searchable`.

### Multi-tab docs

```bash
gdocs push "Overview=overview.md" "Details=details.md" --doc <url|docId>
```

One markdown file per tab, `Title=path` specs, argument order = tab order. Tabs are created, renamed, reordered, and deleted to match the spec. `--doc` is required for multi-tab push. Tab names must be 50 characters or fewer (Docs API limit) — shorten long names intentionally rather than letting them truncate.

### Fetch

```bash
gdocs fetch <url|docId> out.md           # doc → markdown file
gdocs fetch <url|docId>                  # → stdout (when you need the content in memory)
gdocs fetch <url|docId> out/ --tabs      # multi-tab doc: one file per tab + a push-back spec
gdocs fetch <url|docId> out.md --no-comments
```

Fetching over an existing file preserves its unknown frontmatter keys. Collaborator comments append as a `## Comments` section wrapped in `<!-- gpush:comments-start -->` / `<!-- gpush:comments-end -->` markers; push strips that section again, so the round trip is safe.

### Comments only

```bash
gdocs comments <url|docId>                    # all comment threads → stdout
gdocs comments <url|docId> --unresolved-only  # only open threads
gdocs comments <url|docId> out.md             # write to a file
```

Works on any Drive file (Docs, Slides, Sheets).

### Auth

```bash
gdocs auth                    # OAuth flow; scope from the client JSON's "scopes", else drive.file
gdocs auth --scope drive      # full Drive access (needed to fetch docs this tool didn't create)
```

Credentials live in `~/.config/gdocs-sync/google-oauth.json` (Google's downloaded Desktop-client JSON; it may also carry a `"scopes"` array and a `"share-domain"`), with the cached token alongside it.

## Expected refusals (not errors)

`gdocs push` refuses to run while the doc has pending suggested edits:

> Document has pending suggested edits — resolve them in Google Docs (or pull first) before pushing.

This is a guardrail, not a failure: pushing would either write against wrong indices or silently destroy collaborators' suggestions, so the tool declines. Do not retry, work around it, or report it as a tool error. Instead:

1. Tell the user the doc has open suggestions that must be accepted or rejected in the Google Docs UI first (the Docs API cannot resolve suggestions programmatically).
2. Offer `gdocs fetch` to review the doc's current state and `gdocs comments --unresolved-only` for the open discussion.
3. Re-run the push once the user confirms the suggestions are resolved.

## Markdown conventions

- A leading `# H1` becomes the document **Title** (same as frontmatter `title:`; the heading wins when both exist). Frontmatter `subtitle:`, `author:`, and `date:` render as a subtitle and byline; fetch writes them back as frontmatter.
- Use `##` for Heading 1, `###` for Heading 2, and so on.

## Guidelines

- Prefer `gdocs` for anything markdown ↔ Google Docs — it is a true sync, not an upload. Re-pushing unchanged markdown plans zero writes, so pushing repeatedly is safe.
- If fetch fails for a doc that opens fine in the browser, the token's scope is probably `drive.file` (which only sees docs this tool created or opened) — re-auth with `gdocs auth --scope drive`.
- If auth fails or the token is stale, run `gdocs auth`.
