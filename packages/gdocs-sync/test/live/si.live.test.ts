/**
 * SI — style-inheritance regressions, live. Each of these was a
 * production bug in the reference tool (lesson 4): the bug class only
 * manifests on INCREMENTAL update, when new content is inserted at
 * the boundary of kept, styled content — a green create path proves
 * nothing.
 */
import { describe, expect, it } from 'vitest';
import { createFromMarkdown, updateFromMarkdown } from '../../src/sync.ts';
import { parseDocMeta } from '../../src/meta.ts';
import { client, token, trackDoc } from './harness.ts';

describe.skipIf(!token)('SI — style-inheritance regressions', () => {
  it('SI-1: title/subtitle/chips do not duplicate across repeated updates', async () => {
    const md = (body: string) => `---
title: SI-1 Doc
subtitle: Chip stability
author: Drew Hays
author-email: drew@hays.fm
date: 2026-07-21
---
${body}`;
    const { documentId } = await createFromMarkdown(client!, `gdocs-sync SI-1 ${Date.now()}`, md('First body.\n'));
    trackDoc(documentId);
    await updateFromMarkdown(client!, documentId, md('Second body.\n'));
    await updateFromMarkdown(client!, documentId, md('Third body.\n'));
    const doc = await client!.getDocument(documentId);
    const named = (doc.body?.content ?? [])
      .map((el) => el.paragraph?.paragraphStyle?.namedStyleType)
      .filter((n) => n === 'TITLE' || n === 'SUBTITLE');
    expect(named).toEqual(['TITLE', 'SUBTITLE']); // exactly one of each
    const meta = parseDocMeta(doc);
    expect(meta.meta.title).toBe('SI-1 Doc');
    expect(meta.meta.hasAuthorChip).toBe(true);
    expect(meta.meta.hasDateChip).toBe(true);
  });

  it('SI-2: table cells rebuilt next to a heading keep the body font', async () => {
    const md = (qty: string) => `## Inventory
| Name | Qty |
| --- | --- |
| apple | ${qty} |
`;
    const { documentId } = await createFromMarkdown(client!, `gdocs-sync SI-2 ${Date.now()}`, md('3'));
    trackDoc(documentId);
    await updateFromMarkdown(client!, documentId, md('9'));
    const doc = await client!.getDocument(documentId);
    const table = (doc.body?.content ?? []).find((el) => el.table);
    const fonts: string[] = [];
    for (const row of table!.table!.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) {
        for (const inner of cell.content ?? []) {
          for (const pe of inner.paragraph?.elements ?? []) {
            const f = pe.textRun?.textStyle?.weightedFontFamily?.fontFamily;
            if (f && pe.textRun?.content?.trim()) fonts.push(f);
          }
        }
      }
    }
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) expect(f).toBe('Roboto'); // not the heading's Lato
  });

  it('SI-3: a code block rebuilt next to a bulleted list does not catch bullets', async () => {
    const md = (line: string) => `\`\`\`js
${line}
\`\`\`

- list item one
- list item two
`;
    const { documentId } = await createFromMarkdown(client!, `gdocs-sync SI-3 ${Date.now()}`, md('const a = 1;'));
    trackDoc(documentId);
    await updateFromMarkdown(client!, documentId, md('const b = 2;'));
    const doc = await client!.getDocument(documentId);
    let codeParas = 0;
    for (const el of doc.body?.content ?? []) {
      const para = el.paragraph;
      if (!para) continue;
      const text = (para.elements ?? []).map((e) => e.textRun?.content ?? '').join('');
      if (text.includes('const b = 2;')) {
        codeParas++;
        expect(para.bullet, 'rebuilt code line must not be bulleted').toBeUndefined();
      }
    }
    expect(codeParas).toBeGreaterThan(0);
  });
});
