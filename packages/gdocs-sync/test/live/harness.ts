/**
 * Live-tier harness per the doc-tools design: session-scoped auth
 * (skip the suite when unauthenticated), per-test scratch docs with
 * best-effort cleanup, quota-aware client. Never share docs between
 * tests; quota is the shared resource.
 */
import { afterAll } from 'vitest';
import { getAccessToken } from '../../src/auth.ts';
import { HttpDocsClient } from '../../src/gdoc.ts';
import { withQuotaRetry } from '../../src/util.ts';

export const token = await getAccessToken();
export const client = token ? new HttpDocsClient(async () => token) : null;

const scratchDocs: string[] = [];

export function trackDoc(docId: string): void {
  scratchDocs.push(docId);
}

export async function drive<T>(path: string, init?: RequestInit): Promise<T> {
  if (!token) throw new Error('no token');
  return withQuotaRetry(async () => {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const err = new Error(`${init?.method ?? 'GET'} drive/${path} → ${res.status}`);
      (err as unknown as { status: number }).status = res.status;
      throw err;
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  });
}

afterAll(async () => {
  for (const id of scratchDocs) {
    try {
      await drive(id, { method: 'DELETE' });
    } catch {
      console.warn(`cleanup: could not delete scratch doc ${id}`);
    }
  }
});
