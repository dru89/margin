import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import type { WorkspaceFile, WorkspaceState } from '@shared/types';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', '.obsidian']);
const MAX_FILES = 500;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    );
  });
}

/** Workspace root = git repo root when present, else the file's directory. */
export async function findWorkspaceRoot(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return dir;
  }
}

export function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

async function walkFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const stack = [root];
  while (stack.length > 0 && results.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      // Review sidecars are Margin internals, not documents.
      if (entry.name.endsWith('.review.json')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else results.push(full);
    }
  }
  return results.sort();
}

/** First markdown file under a directory (for "Open Folder…"). */
export async function firstMarkdownIn(dir: string): Promise<string | null> {
  const files = await walkFiles(dir);
  return files.find((f) => isMarkdown(f)) ?? null;
}

/** Paths (relative to root) that differ from HEAD, per git status. */
async function modifiedSet(root: string): Promise<Set<string>> {
  try {
    // -uall lists untracked files individually (not just their directory).
    const out = await git(root, ['status', '--porcelain', '-uall']);
    const set = new Set<string>();
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      // Format: "XY path" or "XY old -> new"
      const p = line.slice(3).split(' -> ').pop()!.trim().replace(/^"|"$/g, '');
      set.add(p);
    }
    return set;
  } catch {
    return new Set();
  }
}

async function openItemCounts(mdPath: string): Promise<{ comments: number; suggestions: number }> {
  try {
    const raw = await fs.readFile(`${mdPath}.review.json`, 'utf8');
    const review = JSON.parse(raw) as {
      comments?: { status: string }[];
      suggestions?: { status: string }[];
    };
    return {
      comments: review.comments?.filter((c) => c.status === 'open').length ?? 0,
      suggestions: review.suggestions?.filter((s) => s.status === 'pending').length ?? 0,
    };
  } catch {
    return { comments: 0, suggestions: 0 };
  }
}

export async function getWorkspace(filePath: string): Promise<WorkspaceState> {
  const root = await findWorkspaceRoot(filePath);
  const [allFiles, modified] = await Promise.all([walkFiles(root), modifiedSet(root)]);
  const files: WorkspaceFile[] = await Promise.all(
    allFiles.map(async (p) => {
      const rel = path.relative(root, p);
      const markdown = isMarkdown(p);
      const counts = markdown ? await openItemCounts(p) : { comments: 0, suggestions: 0 };
      return {
        path: p,
        rel,
        name: path.basename(p),
        dir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
        kind: markdown ? ('markdown' as const) : ('other' as const),
        openComments: counts.comments,
        pendingSuggestions: counts.suggestions,
        modified: modified.has(rel),
      };
    }),
  );
  return { root, rootName: path.basename(root), files };
}
