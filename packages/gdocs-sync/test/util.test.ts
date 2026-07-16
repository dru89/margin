import { describe, expect, it } from 'vitest';
import { displayWidth, docIdFromUrl, scopesSatisfy, truncateTabTitle, withQuotaRetry } from '../src/util.js';
import { splitFrontmatter, stripCommentsSection } from '../src/markdown.js';

describe('UMISC — small but load-bearing', () => {
  it('UMISC-1: strips the gpush comments section from start marker to EOF', () => {
    const md = '# Doc\n\nBody text.\n\n<!-- gpush:comments-start -->\n---\n## Comments\n- thread\n<!-- gpush:comments-end -->\n';
    expect(stripCommentsSection(md)).toBe('# Doc\n\nBody text.\n');
    expect(stripCommentsSection('# Doc\n\nNo section.\n')).toBe('# Doc\n\nNo section.\n');
  });

  it('UMISC-2: display width equals len for ASCII; counts composed emoji as one', () => {
    expect(displayWidth('hello')).toBe(5);
    expect(displayWidth('⚠️')).toBe(1); // variation selector
    expect(displayWidth('👍🏽')).toBe(1); // skin tone
    expect(displayWidth('1️⃣')).toBe(1); // keycap
  });

  it('UMISC-3: tab titles truncate at 50 chars preferring word boundaries', () => {
    expect(truncateTabTitle('short')).toBe('short');
    const long = 'A very long tab title that keeps going well past the fifty character limit';
    const cut = truncateTabTitle(long);
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(long.startsWith(cut)).toBe(true);
    expect(cut.endsWith(' ')).toBe(false);
    expect(long[cut.length]).toBe(' '); // cut lands on a word boundary
  });

  it('UMISC-4: doc ID extraction from pasted URL shapes', () => {
    const id = '1AbC_dEf-2345678901234567890123456789012345';
    expect(docIdFromUrl(`https://docs.google.com/document/d/${id}/edit`)).toBe(id);
    expect(docIdFromUrl(`https://docs.google.com/document/d/${id}/edit?tab=t.0#heading=h.x`)).toBe(id);
    expect(docIdFromUrl(id)).toBe(id); // bare ID
    expect(docIdFromUrl('https://example.com/not-a-doc')).toBeNull();
  });

  it('UMISC-5: frontmatter values parse quoted, single-quoted, and bare', () => {
    for (const q of ['"https://docs.google.com/document/d/x/edit"', "'https://docs.google.com/document/d/x/edit'", 'https://docs.google.com/document/d/x/edit']) {
      const { meta } = splitFrontmatter(`---\ntitle: My Doc\nurl: ${q}\n---\nbody\n`);
      expect(meta.url).toBe('https://docs.google.com/document/d/x/edit');
      expect(meta.title).toBe('My Doc');
    }
    expect(splitFrontmatter('no frontmatter\n').meta).toEqual({});
  });
});

describe('UQUOTA — retry wrapper', () => {
  const err429 = { status: 429 };

  it('UQUOTA-1: success on first try → no sleeps', async () => {
    const sleeps: number[] = [];
    const result = await withQuotaRetry(async () => 'ok', { sleep: async (ms) => void sleeps.push(ms) });
    expect(result).toBe('ok');
    expect(sleeps).toEqual([]);
  });

  it('UQUOTA-2: 429s retry with exponentially increasing waits, then succeed', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withQuotaRetry(
      async () => {
        calls++;
        if (calls < 3) throw err429;
        return 'ok';
      },
      { baseDelayMs: 100, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toBe('ok');
    expect(sleeps).toEqual([100, 200]);
  });

  it('UQUOTA-3: non-429 raises immediately; persistent 429 raises after max retries', async () => {
    await expect(withQuotaRetry(async () => { throw new Error('boom'); }, { sleep: async () => {} })).rejects.toThrow('boom');
    let calls = 0;
    await expect(
      withQuotaRetry(async () => { calls++; throw err429; }, { retries: 2, sleep: async () => {} }),
    ).rejects.toEqual(err429);
    expect(calls).toBe(3); // initial + 2 retries
  });
});

describe('UAUTH — token scope handling (pure part)', () => {
  const W = 'https://www.googleapis.com/auth/drive.file';

  it('UAUTH-1: granted ⊇ required accepted; exact match accepted', () => {
    expect(scopesSatisfy([W, 'extra'], [W])).toBe(true);
    expect(scopesSatisfy([W], [W])).toBe(true);
  });
  it('UAUTH-2: read-only token vs write requirement rejected', () => {
    expect(scopesSatisfy(['https://www.googleapis.com/auth/drive.readonly'], [W])).toBe(false);
  });
  it('UAUTH-3: missing/malformed scopes reject, never crash', () => {
    expect(scopesSatisfy(undefined, [W])).toBe(false);
    expect(scopesSatisfy('not-an-array', [W])).toBe(false);
    expect(scopesSatisfy([42, null], [W])).toBe(false);
  });
});
