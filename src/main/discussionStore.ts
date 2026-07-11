import { promises as fs } from 'fs';
import path from 'path';
import type { DiscussionData, DiscussionMessage } from '@shared/types';

/**
 * The discussion is project-scoped, not per-document: it lives at
 * `<workspaceRoot>/.margin/discussion.json` and is shared by every document
 * in the workspace, so framing survives file switches.
 */
export function discussionPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.margin', 'discussion.json');
}

export async function loadDiscussion(
  workspaceRoot: string,
  /** Legacy per-doc messages (pre project-scope sidecars) to migrate. */
  legacyMessages: DiscussionMessage[] = [],
): Promise<DiscussionData> {
  try {
    const raw = await fs.readFile(discussionPath(workspaceRoot), 'utf8');
    const data = JSON.parse(raw) as DiscussionData;
    if (data.version === 1) return data;
  } catch {
    /* fall through */
  }
  const seeded: DiscussionData = { version: 1, messages: legacyMessages };
  if (legacyMessages.length > 0) await saveDiscussion(workspaceRoot, seeded);
  return seeded;
}

export async function saveDiscussion(workspaceRoot: string, data: DiscussionData): Promise<void> {
  const p = discussionPath(workspaceRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
