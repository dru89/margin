/**
 * TAB — multi-tab reconciliation, live (TAB-1..3): rename preserves
 * position + updates content; add/delete; reorder lands the exact
 * input order (one batchUpdate per move — batched moves silently
 * produce the wrong order).
 */
import { describe, expect, it } from 'vitest';
import { HttpDocsClient } from '../../src/gdoc.ts';
import { pushTabs } from '../../src/tabsync.ts';
import { client, token, trackDoc } from './harness.ts';

async function tabTitles(docId: string): Promise<string[]> {
  const doc = await (client as HttpDocsClient).getDocumentWithTabs(docId);
  return ((doc as { tabs?: { tabProperties?: { title?: string } }[] }).tabs ?? []).map(
    (t) => t.tabProperties?.title ?? '',
  );
}

describe.skipIf(!token)('TAB — multi-tab reconciliation (live)', () => {
  it('TAB-1/2/3: create, rename-in-place, add/delete, reorder land exactly', async () => {
    const { documentId } = await client!.createDocument(`gdocs-sync TAB ${Date.now()}`);
    trackDoc(documentId);

    // Round 1: three tabs from scratch (the doc's initial tab gets
    // positionally renamed; two more created).
    const r1 = await pushTabs(client!, documentId, [
      { title: 'Alpha', markdown: '# Alpha\n\nAlpha body.\n' },
      { title: 'Beta', markdown: '# Beta\n\nBeta body.\n' },
      { title: 'Gamma', markdown: '# Gamma\n\nGamma body.\n' },
    ]);
    expect(await tabTitles(documentId)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(Object.values(r1.perTab).every((p) => p.requestsSent > 0)).toBe(true);

    // Round 2: positional rename Beta → Bravo (same slot — UTAB-2),
    // content update rides along; other tabs are per-tab noops.
    const r2 = await pushTabs(client!, documentId, [
      { title: 'Alpha', markdown: '# Alpha\n\nAlpha body.\n' },
      { title: 'Bravo', markdown: '# Bravo\n\nBravo body, renamed.\n' },
      { title: 'Gamma', markdown: '# Gamma\n\nGamma body.\n' },
    ]);
    expect(await tabTitles(documentId)).toEqual(['Alpha', 'Bravo', 'Gamma']);
    expect(r2.steps).toContain('rename:Beta→Bravo');
    expect(r2.perTab['Alpha']!.requestsSent).toBe(0);
    expect(r2.perTab['Gamma']!.requestsSent).toBe(0);
    expect(r2.perTab['Bravo']!.requestsSent).toBeGreaterThan(0);

    // Round 3: pure reorder — every tab a content noop (TAB-3).
    const r3 = await pushTabs(client!, documentId, [
      { title: 'Gamma', markdown: '# Gamma\n\nGamma body.\n' },
      { title: 'Alpha', markdown: '# Alpha\n\nAlpha body.\n' },
      { title: 'Bravo', markdown: '# Bravo\n\nBravo body, renamed.\n' },
    ]);
    expect(await tabTitles(documentId)).toEqual(['Gamma', 'Alpha', 'Bravo']);
    expect(Object.values(r3.perTab).every((p) => p.requestsSent === 0)).toBe(true);

    // Round 4: delete a tab.
    const r4 = await pushTabs(client!, documentId, [
      { title: 'Gamma', markdown: '# Gamma\n\nGamma body.\n' },
      { title: 'Bravo', markdown: '# Bravo\n\nBravo body, renamed.\n' },
    ]);
    expect(await tabTitles(documentId)).toEqual(['Gamma', 'Bravo']);
    expect(r4.steps).toContain('delete:Alpha');
  }, 300_000);
});
