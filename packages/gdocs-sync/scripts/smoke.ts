/**
 * Live smoke test: proves the OAuth client, scopes, and both APIs work
 * end-to-end under drive.file. Creates a scratch doc, writes to it
 * (second batch chained through writeControl.requiredRevisionId),
 * reads it back, exercises the comments surface, and deletes the doc.
 *
 * Run: npm run smoke  (requires a cached token from `npm run auth`)
 */
import { getAccessToken } from '../src/auth.ts';

const DOCS = 'https://docs.googleapis.com/v1/documents';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

async function api<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const token = await getAccessToken();
if (!token) {
  console.error('No usable token — run `npm run auth` first.');
  process.exit(2);
}

let docId: string | null = null;
try {
  // 1. Create a scratch doc (drive.file: app-created files are in scope).
  const created = await api<{ documentId: string; revisionId: string }>(token, DOCS, {
    method: 'POST',
    body: JSON.stringify({ title: `gdocs-sync smoke ${new Date().toISOString()}` }),
  });
  docId = created.documentId;
  console.log(`1. created scratch doc ${docId}`);

  // 2. First write batch.
  await api(token, `${DOCS}/${docId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: 1 }, text: 'Hello from gdocs-sync.\n' } }],
    }),
  });
  console.log('2. batchUpdate #1 (insertText) ok');

  // 3. Second batch chained through writeControl.requiredRevisionId.
  const afterFirst = await api<{ revisionId: string }>(token, `${DOCS}/${docId}?fields=revisionId`);
  await api(token, `${DOCS}/${docId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: 1 }, text: 'Line zero.\n' } }],
      writeControl: { requiredRevisionId: afterFirst.revisionId },
    }),
  });
  console.log(`3. batchUpdate #2 with writeControl.requiredRevisionId ok (rev ${afterFirst.revisionId.slice(0, 12)}…)`);

  // 4. Read back and verify.
  const doc = await api<{ body: { content: { paragraph?: { elements?: { textRun?: { content?: string } }[] } }[] } }>(
    token,
    `${DOCS}/${docId}`,
  );
  const text = doc.body.content
    .flatMap((c) => c.paragraph?.elements ?? [])
    .map((e) => e.textRun?.content ?? '')
    .join('');
  if (!text.includes('Line zero.') || !text.includes('Hello from gdocs-sync.')) {
    throw new Error(`read-back missing expected text; got: ${JSON.stringify(text)}`);
  }
  console.log('4. documents.get read-back verified');

  // 5. Comments surface: create (unanchored), reply, resolve-via-reply, list.
  const comment = await api<{ id: string }>(
    token,
    `${DRIVE}/${docId}/comments?fields=id`,
    { method: 'POST', body: JSON.stringify({ content: 'smoke: comment thread' }) },
  );
  await api(token, `${DRIVE}/${docId}/comments/${comment.id}/replies?fields=id`, {
    method: 'POST',
    body: JSON.stringify({ content: 'smoke: resolving', action: 'resolve' }),
  });
  const list = await api<{ comments: { id: string; resolved?: boolean; replies?: unknown[] }[] }>(
    token,
    `${DRIVE}/${docId}/comments?fields=comments(id,resolved,replies(id,action))`,
  );
  const mine = list.comments.find((c) => c.id === comment.id);
  if (!mine?.resolved || (mine.replies?.length ?? 0) !== 1) {
    throw new Error(`comment round-trip unexpected: ${JSON.stringify(list.comments)}`);
  }
  console.log('5. comments create → resolve-via-reply → list verified');

  console.log('\nSMOKE PASS — client, scopes, Docs + Drive APIs, writeControl, comments all working.');
} finally {
  // 6. Cleanup, best-effort.
  if (docId) {
    await api(token, `${DRIVE}/${docId}`, { method: 'DELETE' }).then(
      () => console.log('6. scratch doc deleted'),
      (err) => console.warn(`6. cleanup failed (delete ${docId} manually): ${err}`),
    );
  }
}
