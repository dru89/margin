import { describe, expect, it } from 'vitest';
import { fetchComments, replyToComment, resolveComment } from '../src/comments.ts';

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const tok = async () => 'tok';

const RAW = {
  id: 'c1',
  content: 'Fix this sentence.',
  author: { displayName: 'Colleague', me: false },
  quotedFileContent: { value: 'the anchored words' },
  resolved: false,
  anchor: 'kix.opaque123',
  createdTime: '2026-07-01T00:00:00Z',
  modifiedTime: '2026-07-02T00:00:00Z',
  replies: [
    { id: 'r1', content: 'Agreed.', author: { displayName: 'Drew Hays', me: true }, createdTime: '2026-07-02T00:00:00Z' },
    { id: 'r2', content: 'gone', deleted: true, createdTime: '2026-07-02T01:00:00Z' },
  ],
};

describe('fetchComments (issue #25)', () => {
  it('maps records: quotedText, anchored, replies without deleted ones', async () => {
    const { impl, calls } = fakeFetch([{ body: { comments: [RAW] } }]);
    const records = await fetchComments(tok, 'doc-1', { fetchImpl: impl });
    expect(records).toEqual([
      {
        id: 'c1',
        content: 'Fix this sentence.',
        author: { displayName: 'Colleague', me: false },
        quotedText: 'the anchored words',
        anchored: true,
        resolved: false,
        createdTime: '2026-07-01T00:00:00Z',
        modifiedTime: '2026-07-02T00:00:00Z',
        replies: [
          {
            id: 'r1',
            content: 'Agreed.',
            author: { displayName: 'Drew Hays', me: true },
            createdTime: '2026-07-02T00:00:00Z',
          },
        ],
      },
    ]);
    expect(calls[0]!.url).toContain('/files/doc-1/comments?');
    expect(calls[0]!.url).toContain('quotedFileContent');
  });

  it('paginates until nextPageToken runs out', async () => {
    const { impl, calls } = fakeFetch([
      { body: { comments: [RAW], nextPageToken: 'p2' } },
      { body: { comments: [{ ...RAW, id: 'c2', anchor: undefined, quotedFileContent: undefined }] } },
    ]);
    const records = await fetchComments(tok, 'doc-1', { fetchImpl: impl });
    expect(records!.map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(records![1]).toMatchObject({ anchored: false, quotedText: null });
    expect(calls[1]!.url).toContain('pageToken=p2');
  });

  it('unresolvedOnly filters resolved threads; deleted comments drop', async () => {
    const { impl } = fakeFetch([
      { body: { comments: [RAW, { ...RAW, id: 'c2', resolved: true }, { ...RAW, id: 'c3', deleted: true }] } },
    ]);
    const records = await fetchComments(tok, 'doc-1', { unresolvedOnly: true, fetchImpl: impl });
    expect(records!.map((r) => r.id)).toEqual(['c1']);
  });

  it('403/404 on the comments endpoint degrades to null, not empty (lesson 6)', async () => {
    for (const status of [403, 404]) {
      const { impl } = fakeFetch([{ status, body: { error: 'nope' } }]);
      expect(await fetchComments(tok, 'doc-1', { fetchImpl: impl })).toBeNull();
    }
    const { impl } = fakeFetch([{ status: 500, body: {} }]);
    await expect(fetchComments(tok, 'doc-1', { fetchImpl: impl })).rejects.toThrow(/500/);
  });
});

describe('replyToComment / resolveComment', () => {
  it('reply posts verbatim content to the thread', async () => {
    const { impl, calls } = fakeFetch([
      { body: { id: 'r9', content: 'A reply.', author: { displayName: 'Drew Hays', me: true }, createdTime: 't' } },
    ]);
    const reply = await replyToComment(tok, 'doc-1', 'c1', 'A reply.', { fetchImpl: impl });
    expect(reply).toMatchObject({ id: 'r9', content: 'A reply.' });
    expect(calls[0]!.url).toContain('/files/doc-1/comments/c1/replies');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ content: 'A reply.' });
  });

  it('resolve is an action reply', async () => {
    const { impl, calls } = fakeFetch([{ body: { id: 'r9', action: 'resolve' } }]);
    await resolveComment(tok, 'doc-1', 'c1', undefined, { fetchImpl: impl });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ action: 'resolve', content: '' });
  });
});

describe('comments section emission (issue #52)', () => {
  const record = {
    id: 'c1',
    content: 'Fix this sentence.',
    author: { displayName: 'Colleague', me: false },
    quotedText: 'the anchored words',
    anchored: true,
    resolved: false,
    createdTime: 't1',
    modifiedTime: 't2',
    replies: [
      { id: 'r1', content: 'Agreed.', author: { displayName: 'Drew Hays', me: true }, createdTime: 't3' },
      { id: 'r2', content: '', author: { displayName: 'Drew Hays', me: true }, createdTime: 't4', action: 'resolve' },
    ],
  };

  it('emits author, quote, status, and replies; skips bare action replies', async () => {
    const { commentsAsMarkdown } = await import('../src/comments.ts');
    const md = commentsAsMarkdown([record]);
    expect(md).toContain('**Colleague** on “the anchored words” — open');
    expect(md).toContain('> Fix this sentence.');
    expect(md).toContain('**Drew Hays** replied: Agreed.');
    expect(md).not.toContain('replied: \n');
  });

  it('the wrapped section round-trips: push strips exactly what fetch appends', async () => {
    const { commentsSection } = await import('../src/comments.ts');
    const { stripCommentsSection } = await import('../src/markdown.ts');
    const body = '# Doc\n\nContent.\n';
    const withSection = body + commentsSection([record]);
    expect(withSection).toContain('<!-- gpush:comments-start -->');
    expect(withSection).toContain('<!-- gpush:comments-end -->');
    expect(stripCommentsSection(withSection)).toBe(body);
    expect(commentsSection([])).toBe('');
  });
});
