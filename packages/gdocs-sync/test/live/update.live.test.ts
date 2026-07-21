/**
 * Live update-path tests: the CP-group assertions that are honestly
 * pinnable with API-created comments. Programmatic comments are
 * UNANCHORED (probed: comments.create with quotedFileContent returns
 * no anchor), so anchored-survival/orphaning assertions (CP-1..4/8
 * proper) are blocked on the reference harness technique — asked in
 * margin#10. What this file pins instead:
 *  - comments persist (content, replies, resolved state) across real
 *    region rebuilds — a batchUpdate content churn never touches them
 *  - CP-5: the edit actually lands (content tests, not tautologies)
 *  - RT-1 stability after an incremental edit (edit → noop re-push)
 */
import { describe, expect, it } from 'vitest';
import { createFromMarkdown, updateFromMarkdown } from '../../src/sync.ts';
import { docToBlocks } from '../../src/reader.ts';
import { serializeBlocks } from '../../src/serialize.ts';
import { client, drive, token, trackDoc } from './harness.ts';

const BASE_MD = `# CP Corpus
First paragraph, stays untouched.

Second paragraph, the edit target.

Third paragraph, also untouched.
`;

const EDITED_MD = BASE_MD.replace('Second paragraph, the edit target.', 'Second paragraph, EDITED in place.');

describe.skipIf(!token)('live update path (CP-pinnable subset)', () => {
  it('comments persist across a region rebuild; the edit lands (CP-5)', async () => {
    const { documentId } = await createFromMarkdown(client!, `gdocs-sync CP ${Date.now()}`, BASE_MD);
    trackDoc(documentId);

    // Attach a comment (unanchored — see header) and a resolved thread.
    const comment = await drive<{ id: string }>(`${documentId}/comments?fields=id`, {
      method: 'POST',
      body: JSON.stringify({
        content: 'thread about the second paragraph',
        quotedFileContent: { mimeType: 'text/plain', value: 'Second paragraph, the edit target.' },
      }),
    });
    await drive(`${documentId}/comments/${comment.id}/replies?fields=id`, {
      method: 'POST',
      body: JSON.stringify({ content: 'a reply that must survive' }),
    });

    const plan = await updateFromMarkdown(client!, documentId, EDITED_MD);
    expect(plan.regions).toBe(1);
    expect(plan.requestsSent).toBeGreaterThan(0);

    // CP-5: the changed text is present, the old text gone.
    const blocks = docToBlocks(await client!.getDocument(documentId)).map((r) => r.block);
    const roundTripped = serializeBlocks(blocks);
    expect(roundTripped).toContain('EDITED in place');
    expect(roundTripped).not.toContain('the edit target');
    expect(roundTripped).toContain('First paragraph, stays untouched.');
    expect(roundTripped).toContain('Third paragraph, also untouched.');

    // The comment thread survived the rebuild with its reply.
    const listed = await drive<{ comments: { id: string; content: string; replies: { content: string }[] }[] }>(
      `${documentId}/comments?fields=comments(id,content,replies(content))`,
    );
    const mine = listed.comments.find((c) => c.id === comment.id);
    expect(mine).toBeDefined();
    expect(mine!.content).toBe('thread about the second paragraph');
    expect(mine!.replies.map((r) => r.content)).toEqual(['a reply that must survive']);
    expect(listed.comments).toHaveLength(1); // no duplication
  });

  it('restyle: a styling-only edit patches in place and comments survive by construction', async () => {
    const PLAIN = '# Restyle Corpus\n\nThis is bold and italics and inline code together.\n';
    const MIXED = '# Restyle Corpus\n\nThis is **bold** and *italics* and `inline code` together.\n';
    const { documentId } = await createFromMarkdown(client!, `gdocs-sync restyle ${Date.now()}`, PLAIN);
    trackDoc(documentId);
    const comment = await drive<{ id: string }>(`${documentId}/comments?fields=id`, {
      method: 'POST',
      body: JSON.stringify({
        content: 'comment on the block being restyled',
        quotedFileContent: { mimeType: 'text/plain', value: 'bold and italics' },
      }),
    });

    const plan = await updateFromMarkdown(client!, documentId, MIXED);
    expect(plan.regions).toBe(0); // no rebuild anywhere
    expect(plan.restyles).toBe(1);
    expect(plan.requestsSent).toBeGreaterThan(2);

    // Styling landed: the word 'bold' is bold in the doc.
    const doc = await client!.getDocument(documentId);
    let boldSeen = false;
    for (const el of doc.body?.content ?? []) {
      for (const pe of el.paragraph?.elements ?? []) {
        if (pe.textRun?.content?.startsWith('bold') && pe.textRun.textStyle?.bold) boldSeen = true;
      }
    }
    expect(boldSeen).toBe(true);

    // The comment thread survives (and with zero deletes sent, its
    // anchor is safe by construction — nothing could orphan it).
    const listed = await drive<{ comments: { id: string }[] }>(`${documentId}/comments?fields=comments(id)`);
    expect(listed.comments.map((c) => c.id)).toContain(comment.id);

    // And the restyled doc is stable: identical re-push is a noop.
    const again = await updateFromMarkdown(client!, documentId, MIXED);
    expect(again.requestsSent).toBe(0);
  });

  it('edit → identical re-push is a noop (RT-1 stability under incremental updates)', async () => {
    const { documentId } = await createFromMarkdown(client!, `gdocs-sync CP-noop ${Date.now()}`, BASE_MD);
    trackDoc(documentId);
    const first = await updateFromMarkdown(client!, documentId, EDITED_MD);
    expect(first.regions).toBe(1);
    const second = await updateFromMarkdown(client!, documentId, EDITED_MD);
    expect(second.regions).toBe(0);
    expect(second.requestsSent).toBe(0);
  });
});
