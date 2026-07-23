/**
 * Domain sharing for created docs (issue #53): one Drive
 * permissions.create call so a freshly pushed doc's link works for the
 * whole org without a Docs-UI trip. Matches the reference tool's
 * defaults (commenter role, discoverable).
 */
export type ShareRole = 'viewer' | 'commenter' | 'editor';

const DRIVE_ROLES: Record<ShareRole, string> = {
  viewer: 'reader',
  commenter: 'commenter',
  editor: 'writer',
};

export interface ShareOptions {
  domain: string;
  role?: ShareRole;
  /** false → the doc does not appear in domain-wide search (Drive allowFileDiscovery). */
  searchable?: boolean;
}

export async function shareDocument(
  getToken: () => Promise<string>,
  docId: string,
  options: ShareOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const role = options.role ?? 'commenter';
  const res = await fetchImpl(
    `https://www.googleapis.com/drive/v3/files/${docId}/permissions?supportsAllDrives=true`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await getToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'domain',
        domain: options.domain,
        role: DRIVE_ROLES[role],
        allowFileDiscovery: options.searchable !== false,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`share failed (${res.status}): ${await res.text()}`);
  }
}
