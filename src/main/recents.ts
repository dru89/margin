import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import type { RecentFile } from '@shared/types';

const MAX_RECENTS = 12;
let cache: RecentFile[] | null = null;
let onChange: (() => void) | null = null;

function storePath(): string {
  return path.join(app.getPath('userData'), 'recent-files.json');
}

export function setRecentsChangedListener(fn: () => void): void {
  onChange = fn;
}

export async function getRecentFiles(): Promise<RecentFile[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(storePath(), 'utf8')) as RecentFile[];
  } catch {
    cache = [];
  }
  return cache;
}

export async function addRecentFile(filePath: string, root?: string): Promise<void> {
  const recents = await getRecentFiles();
  const resolved = path.resolve(filePath);
  cache = [
    { path: resolved, name: path.basename(resolved), openedAt: new Date().toISOString(), root },
    // One entry per project: the newest file in a workspace replaces its siblings.
    ...recents.filter((r) => r.path !== resolved && !(root && r.root === root)),
  ].slice(0, MAX_RECENTS);
  app.addRecentDocument(resolved);
  await persist();
}

export async function clearRecentFiles(): Promise<void> {
  cache = [];
  app.clearRecentDocuments();
  await persist();
}

async function persist(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(storePath()), { recursive: true });
    await fs.writeFile(storePath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    /* non-fatal */
  }
  onChange?.();
}
