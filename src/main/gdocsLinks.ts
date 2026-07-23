/**
 * The .margin/gdocs.json link store (spec §Data): which markdown files
 * are linked to which Google Docs, plus the conflict-detection state
 * from the last sync. Project-scoped, checkpointed with the rest of
 * .margin/. v0 is one file ↔ one whole Doc (no tabs).
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

export interface GdocsLink {
  /** Relative to the workspace root. */
  file: string;
  docId: string;
  /** Doc revision at last sync — conflict detection only, never a diff base. */
  revisionId: string;
  /**
   * Hash of the markdown at last sync (spec calls for a git blob;
   * a content hash detects identically and works in non-repo
   * workspaces — DECISIONS §51). Format: "sha256:<hex>".
   */
  baseRef: string;
  lastSyncAt: string;
}

interface GdocsFile {
  version: 1;
  links: GdocsLink[];
}

function storePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.margin', 'gdocs.json');
}

export function contentRef(markdown: string): string {
  return `sha256:${createHash('sha256').update(markdown, 'utf8').digest('hex')}`;
}

export async function loadLinks(workspaceRoot: string): Promise<GdocsLink[]> {
  try {
    const raw = JSON.parse(await fs.readFile(storePath(workspaceRoot), 'utf8')) as GdocsFile;
    return Array.isArray(raw.links) ? raw.links : [];
  } catch {
    return [];
  }
}

async function saveLinks(workspaceRoot: string, links: GdocsLink[]): Promise<void> {
  const file = storePath(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const data: GdocsFile = { version: 1, links };
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function linkFor(workspaceRoot: string, relFile: string): Promise<GdocsLink | null> {
  const links = await loadLinks(workspaceRoot);
  return links.find((l) => l.file === relFile) ?? null;
}

export async function upsertLink(workspaceRoot: string, link: GdocsLink): Promise<void> {
  const links = await loadLinks(workspaceRoot);
  const i = links.findIndex((l) => l.file === link.file);
  if (i === -1) links.push(link);
  else links[i] = link;
  await saveLinks(workspaceRoot, links);
}

export async function removeLink(workspaceRoot: string, relFile: string): Promise<void> {
  const links = await loadLinks(workspaceRoot);
  await saveLinks(
    workspaceRoot,
    links.filter((l) => l.file !== relFile),
  );
}
