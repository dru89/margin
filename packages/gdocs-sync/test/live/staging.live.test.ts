/**
 * IMG — local-file image staging, live (issue #18): the temp-docx
 * contentUri trick end to end. A generated PNG on disk, referenced
 * relatively in markdown, must land as a sized inline object, and the
 * doc must be RT-1-stable afterward.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeDocxStager, minimalPng } from '../../src/images.ts';
import { getAccessToken } from '../../src/auth.ts';
import { createFromMarkdown, updateFromMarkdown } from '../../src/sync.ts';
import { client, token, trackDoc } from './harness.ts';

describe.skipIf(!token)('IMG — local-file staging (temp-docx contentUri trick)', () => {
  it('a relative local PNG stages, inserts sized, and the doc stays noop-stable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gdocs-stage-'));
    await writeFile(join(dir, 'diagram.png'), minimalPng(320, 200));
    const md = '# Staging Corpus\n\nBefore the figure.\n\n![A staged local figure](./diagram.png)\n\nAfter the figure.\n';
    const imageStager = makeDocxStager(async () => (await getAccessToken())!);

    const { documentId } = await createFromMarkdown(client!, `gdocs-sync staging ${Date.now()}`, md, {
      baseDir: dir,
      imageStager,
    });
    trackDoc(documentId);

    const doc = await client!.getDocument(documentId);
    const objectIds = Object.keys(doc.inlineObjects ?? {});
    expect(objectIds).toHaveLength(1);
    // Sized via objectSize from the PNG's real dimensions (320×200 @96dpi → 240×150pt).
    const embedded = doc.inlineObjects![objectIds[0]!]!.inlineObjectProperties?.embeddedObject as {
      size?: { width?: { magnitude?: number }; height?: { magnitude?: number } };
    };
    expect(Math.round(embedded?.size?.width?.magnitude ?? 0)).toBe(240);
    expect(Math.round(embedded?.size?.height?.magnitude ?? 0)).toBe(150);

    // Identity is alt+figure, so the re-push (image src unchanged in md,
    // contentUri on the doc side) plans zero writes.
    const plan = await updateFromMarkdown(client!, documentId, md, { baseDir: dir, imageStager });
    expect(plan.requestsSent).toBe(0);
  }, 180_000);
});
