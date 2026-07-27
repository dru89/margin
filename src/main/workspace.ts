import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { WorkspaceFile, WorkspaceState } from '@shared/types';
import { loadProposals } from './proposalsStore';
import { loadProjectFile, projectName } from './projectFile';

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
/**
 * The project a document belongs to, in precedence order:
 *
 *   1. the nearest ancestor holding a `.margin/` — the marker we own, and
 *      the only one the user can place deliberately. Nested markers mean
 *      deliberately nested projects; the nearest wins.
 *   2. the git toplevel — a decent guess when no marker exists yet, and
 *      what every project created before `.margin/` keying resolved to.
 *   3. the file's own directory.
 *
 *  Where both (1) and (2) apply, the *deeper* one wins. `.margin/` is
 *  created automatically at whatever root was in use, so a stray marker
 *  high up — open a loose `~/Writing/notes.md` once and `~/Writing/`
 *  has one — must not swallow every git repo beneath it.
 *
 *  `.margin/` is written *at* whatever root (2) or (3) produced, so
 *  existing projects already carry the marker at their current root and
 *  keep it under this rule.
 *
 *  The walk stops before the home directory: opening a loose `~/notes.md`
 *  creates `~/.margin/`, and without this every file anywhere under home
 *  would then inherit home as its project. `~/notes.md` itself still
 *  resolves to home through (3).
 */
export async function findWorkspaceRoot(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const home = os.homedir();
  let marker: string | null = null;
  let cur = dir;
  for (;;) {
    if (cur !== home) {
      try {
        if ((await fs.stat(path.join(cur, '.margin'))).isDirectory()) {
          marker = cur;
          break;
        }
      } catch {
        /* no marker here — keep walking up */
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  let toplevel: string | null = null;
  try {
    toplevel = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    /* not a repo */
  }
  if (marker && toplevel) return toplevel.length > marker.length ? toplevel : marker;
  return marker ?? toplevel ?? dir;
}

export function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

/**
 * Resolve a path the renderer asked to open, refusing anything outside
 * the project (#90).
 *
 * "Open in its default app" stopped being a request only the explorer can
 * make the moment `@path` chips shipped: a chip's path comes from comment
 * text, and the agent writes comment text. The renderer already refuses
 * to make a chip clickable unless it names a file the workspace scan
 * found, so this is the second lock on the same door — worth having,
 * because the first one is a rendering decision and this one is the
 * boundary that actually reaches the disk.
 *
 * Symlinks are resolved before the containment test, so a link inside
 * the project pointing out of it does not smuggle a target past the
 * check.
 */
export async function resolveInsideWorkspace(
  workspaceRoot: string,
  rawPath: string,
): Promise<string | null> {
  const root = await fs.realpath(workspaceRoot).catch(() => path.resolve(workspaceRoot));
  const abs = path.resolve(root, rawPath);
  const real = await fs.realpath(abs).catch(() => null);
  if (!real) return null; // nothing there to open
  if (real !== root && !real.startsWith(root + path.sep)) return null;
  // A directory would hand the request to a file manager, which is not
  // what naming a file in a comment asks for.
  const stat = await fs.stat(real).catch(() => null);
  return stat?.isFile() ? real : null;
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

/** Names of project skills (<root>/.claude/skills/<name>/SKILL.md). */
async function listProjectSkills(root: string): Promise<string[]> {
  try {
    const dir = path.join(root, '.claude', 'skills');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const names: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        await fs.access(path.join(dir, e.name, 'SKILL.md'));
        names.push(e.name);
      } catch {
        /* not a skill */
      }
    }
    return names.sort();
  } catch {
    return [];
  }
}

export async function getWorkspace(filePath: string): Promise<WorkspaceState> {
  const root = await findWorkspaceRoot(filePath);
  const [allFiles, modified, skills, proposalsData, project] = await Promise.all([
    walkFiles(root),
    modifiedSet(root),
    listProjectSkills(root),
    loadProposals(root),
    loadProjectFile(root),
  ]);
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
  const notesPath = path.join(root, '.margin', 'agent-notes.md');
  let agentNotesPath: string | undefined;
  try {
    await fs.access(notesPath);
    agentNotesPath = notesPath;
  } catch {
    /* no notes yet */
  }
  return {
    root,
    // A project's stated name, else its folder's — the reason `name`
    // exists in `margin.json` at all (spec §2).
    rootName: projectName(root, project),
    files,
    skills,
    agentNotesPath,
    proposals: proposalsData.proposals,
  };
}
