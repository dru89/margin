import { describe, expect, it } from 'vitest';
import { FakeDocsClient, type GDocDocument } from '../src/gdoc.ts';
import { docToBlocks } from '../src/reader.ts';
import { updateFromMarkdown } from '../src/sync.ts';

/** Hand-built three-paragraph doc: 'first.' [1,8), 'second.' [8,16), 'third.' [16,23). */
function threeParagraphDoc(): GDocDocument {
  const para = (start: number, text: string) => ({
    startIndex: start,
    endIndex: start + text.length + 1,
    paragraph: {
      elements: [{ textRun: { content: `${text}\n`, textStyle: {} } }],
      paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
    },
  });
  return {
    documentId: 'fake-doc',
    revisionId: 'rev-1',
    body: { content: [para(1, 'first.'), para(8, 'second.'), para(16, 'third.')] },
  };
}

describe('reader (UREAD-lite)', () => {
  it('reads paragraphs with ranges and strips trailing newlines', () => {
    const blocks = docToBlocks(threeParagraphDoc());
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => (b.block.kind === 'paragraph' ? b.block.spans[0]!.text : ''))).toEqual([
      'first.',
      'second.',
      'third.',
    ]);
    expect(blocks[1]).toMatchObject({ startIndex: 8, endIndex: 16 });
  });

  it('UREAD-5: adjacent runs with identical formatting merge', () => {
    const doc: GDocDocument = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 8,
            paragraph: {
              elements: [
                { textRun: { content: 'bo', textStyle: { bold: true } } },
                { textRun: { content: 'ld', textStyle: { bold: true } } },
                { textRun: { content: ' end\n', textStyle: {} } },
              ],
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            },
          },
        ],
      },
    };
    const [b] = docToBlocks(doc);
    if (b!.block.kind !== 'paragraph') throw new Error('expected paragraph');
    expect(b!.block.spans).toEqual([
      { text: 'bold', bold: true },
      { text: ' end' },
    ]);
  });

  it('reads TITLE as level-1 heading and HEADING_N as N+1 (conventions)', () => {
    const doc: GDocDocument = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 7,
            paragraph: {
              elements: [{ textRun: { content: 'Title\n' } }],
              paragraphStyle: { namedStyleType: 'TITLE' },
            },
          },
          {
            startIndex: 7,
            endIndex: 15,
            paragraph: {
              elements: [{ textRun: { content: 'Section\n' } }],
              paragraphStyle: { namedStyleType: 'HEADING_1' },
            },
          },
        ],
      },
    };
    const blocks = docToBlocks(doc).map((b) => b.block);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ kind: 'heading', level: 2 });
  });
});

describe('USCOPE — orchestrator against the fake Docs service', () => {
  it('USCOPE-2: no change → zero write calls (offline half of RT-1)', async () => {
    const client = new FakeDocsClient(threeParagraphDoc());
    const plan = await updateFromMarkdown(client, 'fake-doc', 'first.\n\nsecond.\n\nthird.\n');
    expect(plan.regions).toBe(0);
    expect(plan.requestsSent).toBe(0);
    expect(client.batches).toHaveLength(0);
  });

  it('USCOPE-1: editing one paragraph emits exactly one scoped delete plus its rebuild', async () => {
    const client = new FakeDocsClient(threeParagraphDoc());
    await updateFromMarkdown(client, 'fake-doc', 'first.\n\nsecond, CHANGED.\n\nthird.\n');
    const deletes = client.batches.flat().filter((r) => 'deleteContentRange' in r) as {
      deleteContentRange: { range: { startIndex: number; endIndex: number } };
    }[];
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.deleteContentRange.range).toEqual({ startIndex: 8, endIndex: 16 });
    const inserts = client.batches.flat().filter((r) => 'insertText' in r) as {
      insertText: { location: { index: number }; text: string };
    }[];
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.insertText.location.index).toBe(8);
    expect(inserts[0]!.insertText.text).toBe('second, CHANGED.\n');
  });

  it('USCOPE-3: two separated edits leave the paragraph between them untouched', async () => {
    const client = new FakeDocsClient(threeParagraphDoc());
    await updateFromMarkdown(client, 'fake-doc', 'first, CHANGED.\n\nsecond.\n\nthird, CHANGED.\n');
    // "Untouched" = never deleted or rebuilt. Style/insert ranges shift
    // coordinates as earlier regions apply, so the meaningful assertion
    // is on the destructive requests: 'second.' occupies [8,16) and no
    // delete may cover its interior; no insert may land inside it.
    const flat = client.batches.flat() as any[];
    for (const r of flat) {
      const del = r.deleteContentRange?.range;
      if (del) expect(del.startIndex < 15 && del.endIndex > 9).toBe(false);
      const ins = r.insertText?.location?.index;
      if (ins !== undefined) expect(ins > 8 && ins < 16).toBe(false);
    }
    // Regions processed in reverse: the third-paragraph delete lands
    // before the first-paragraph delete in emission order.
    const deletes = client.batches.flat().filter((r) => 'deleteContentRange' in r) as any[];
    expect(deletes).toHaveLength(2);
    expect(deletes[0]!.deleteContentRange.range.startIndex).toBe(16);
    expect(deletes[1]!.deleteContentRange.range.startIndex).toBe(1);
  });
});
