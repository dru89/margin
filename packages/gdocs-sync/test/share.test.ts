import { describe, expect, it } from 'vitest';
import { shareDocument } from '../src/share.ts';
import { FakeDocsClient } from '../src/gdoc.ts';
import { createFromMarkdown } from '../src/sync.ts';

function fakeFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(status === 200 ? '{}' : 'denied', { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe('shareDocument (issue #53)', () => {
  it('posts a domain permission with the mapped role', async () => {
    const { impl, calls } = fakeFetch();
    await shareDocument(async () => 'tok', 'doc-1', { domain: 'hays.fm', role: 'viewer' }, impl);
    expect(calls[0]!.url).toContain('/files/doc-1/permissions');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({
      type: 'domain',
      domain: 'hays.fm',
      role: 'reader',
      allowFileDiscovery: true,
    });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('defaults to commenter and honors searchable: false', async () => {
    const { impl, calls } = fakeFetch();
    await shareDocument(async () => 'tok', 'doc-1', { domain: 'x.com', searchable: false }, impl);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.role).toBe('commenter');
    expect(body.allowFileDiscovery).toBe(false);
  });

  it('throws with status and body on failure', async () => {
    const { impl } = fakeFetch(403);
    await expect(
      shareDocument(async () => 'tok', 'doc-1', { domain: 'x.com' }, impl),
    ).rejects.toThrow(/share failed \(403\): denied/);
  });
});

describe('pageless on create (issue #54)', () => {
  const doc = { documentId: 'fake-doc', revisionId: 'r1', body: { content: [] } };

  it('create emits updateDocumentStyle PAGELESS before content', async () => {
    const client = new FakeDocsClient(doc);
    await createFromMarkdown(client, 'T', 'hello\n');
    const first = client.batches[0]!;
    expect(first).toEqual([
      {
        updateDocumentStyle: {
          documentStyle: { documentFormat: { documentMode: 'PAGELESS' } },
          fields: 'documentFormat',
        },
      },
    ]);
  });

  it('pageless: false suppresses it', async () => {
    const client = new FakeDocsClient(doc);
    await createFromMarkdown(client, 'T', 'hello\n', { pageless: false });
    const flat = client.batches.flat();
    expect(flat.some((r) => 'updateDocumentStyle' in r)).toBe(false);
  });
});
