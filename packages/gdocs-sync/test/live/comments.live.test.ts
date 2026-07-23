/**
 * Live tier for the typed comments module (issue #25): the full
 * fetch → reply → resolve loop on a scratch doc, and a read of the
 * durable fixture's human-made anchored threads (the API cannot
 * recreate those — the fixture is read-only, never recreate it).
 */
import { describe, expect, it } from 'vitest';
import { fetchComments, replyToComment, resolveComment } from '../../src/comments.ts';
import { createFromMarkdown } from '../../src/sync.ts';
import { getAccessToken } from '../../src/auth.ts';
import { client, drive, token, trackDoc } from './harness.ts';
import { CP_ANCHORS_FIXTURE_DOC_ID } from './fixtures.ts';

const tok = async () => (await getAccessToken())!;

describe.skipIf(!token)('comments module (live)', () => {
  it('fetch → reply → resolve loop on a scratch doc', async () => {
    const { documentId } = await createFromMarkdown(
      client!,
      `gdocs-sync comments ${Date.now()}`,
      '# Comments\n\nA paragraph to discuss.\n',
    );
    trackDoc(documentId);

    const created = await drive<{ id: string }>(`${documentId}/comments?fields=id`, {
      method: 'POST',
      body: JSON.stringify({
        content: 'module test thread',
        quotedFileContent: { mimeType: 'text/plain', value: 'A paragraph to discuss.' },
      }),
    });

    let records = await fetchComments(tok, documentId);
    expect(records).not.toBeNull();
    const thread = records!.find((r) => r.id === created.id);
    expect(thread).toMatchObject({
      content: 'module test thread',
      quotedText: 'A paragraph to discuss.',
      resolved: false,
      anchored: false, // programmatic comments are unanchored (probed)
    });
    expect(thread!.author.me).toBe(true);

    const reply = await replyToComment(tok, documentId, created.id, 'a reply from the module');
    expect(reply.content).toBe('a reply from the module');
    expect(reply.author.me).toBe(true);

    await resolveComment(tok, documentId, created.id);

    records = await fetchComments(tok, documentId);
    const after = records!.find((r) => r.id === created.id)!;
    expect(after.resolved).toBe(true);
    expect(after.replies.map((r) => r.content)).toContain('a reply from the module');
    expect(after.replies.some((r) => r.action === 'resolve')).toBe(true);

    // unresolvedOnly hides it now.
    const open = await fetchComments(tok, documentId, { unresolvedOnly: true });
    expect(open!.find((r) => r.id === created.id)).toBeUndefined();
  });

  it('durable fixture: hand-made anchored threads parse with quotes and the human reply', async () => {
    const records = await fetchComments(tok, CP_ANCHORS_FIXTURE_DOC_ID);
    expect(records).not.toBeNull();
    const anchored = records!.filter((r) => r.anchored);
    expect(anchored.length).toBeGreaterThanOrEqual(4);
    for (const r of anchored) {
      expect(r.quotedText).toBeTruthy();
      expect(r.author.displayName).toBeTruthy();
    }
    // The BULLSEYE thread carries Drew's UI-made reply.
    const bullseye = records!.find((r) => r.quotedText?.includes('BULLSEYE'));
    expect(bullseye).toBeDefined();
    expect(bullseye!.replies.length).toBeGreaterThanOrEqual(1);
  });
});
