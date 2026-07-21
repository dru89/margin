/**
 * Durable-fixture read tests (CP read tier): assert against the
 * UI-decorated fixture doc — READ ONLY, never mutate. What the
 * automated tier can honestly pin (see docs/splice-findings.md:
 * anchor *state* is API-invisible; these pin presence, quotes,
 * threading, suggestion runs, and fetch-path behavior).
 */
import { describe, expect, it } from 'vitest';
import { hasPendingSuggestions } from '../../src/gdoc.ts';
import { fetchAsMarkdown, updateFromMarkdown } from '../../src/sync.ts';
import { client, drive, token } from './harness.ts';
import { CP_ANCHORS_FIXTURE_DOC_ID as FIXTURE } from './fixtures.ts';

interface CommentsList {
  comments: {
    id: string;
    anchor?: string;
    quotedFileContent?: { value?: string };
    replies?: { content: string }[];
  }[];
}

describe.skipIf(!token)('durable fixture — anchored comments & suggestions (read-only)', () => {
  it('CP-R1: four UI-anchored comments with expected quotes; BULLSEYE thread has a reply', async () => {
    const { comments } = await drive<CommentsList>(
      `${FIXTURE}/comments?fields=comments(id,anchor,quotedFileContent,replies(content))&pageSize=50`,
    );
    expect(comments).toHaveLength(4);
    for (const c of comments) expect(c.anchor, 'UI comments carry anchors').toBeTruthy();
    const quotes = comments.map((c) => c.quotedFileContent?.value ?? '');
    expect(quotes).toContain('BULLSEYE');
    expect(quotes).toContain('anchor a comment inside this cell');
    expect(quotes).toContain('anchor a comment to this list item');
    expect(quotes.some((q) => q.startsWith('Anchor a comment to this entire sentence'))).toBe(true);
    const bullseye = comments.find((c) => c.quotedFileContent?.value === 'BULLSEYE');
    expect(bullseye!.replies!.length).toBeGreaterThanOrEqual(1);
  });

  it('CP-R2: suggestion runs are readable in the stored-content view', async () => {
    const doc = await client!.getDocument(FIXTURE);
    expect(hasPendingSuggestions(doc)).toBe(true);
  });

  it('CP-R3: fetchAsMarkdown reads original text — suggestions excluded, deletions intact', async () => {
    const md = await fetchAsMarkdown(client!, FIXTURE);
    expect(md).not.toContain('hippopotamus'); // suggested insertion
    expect(md).toContain('REDUNDANT redundant'); // suggested deletion still present
    expect(md).toContain('OLDWORD'); // suggested replacement's original
    expect(md).toContain('BULLSEYE');
    // Known API loss: the UI-checked box (text not struck) reads unchecked.
    expect(md).toContain('- [ ] check this box');
  });

  it('CP-R4: push refuses while suggestions are pending (also protects this fixture)', async () => {
    await expect(updateFromMarkdown(client!, FIXTURE, '# anything\n')).rejects.toThrow(
      /pending suggested edits/,
    );
  });
});
