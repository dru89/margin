import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

export async function isInRepo(filePath: string): Promise<boolean> {
  try {
    const out = await git(path.dirname(filePath), ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

export async function initRepo(filePath: string): Promise<void> {
  await git(path.dirname(filePath), ['init']);
}

/** git init + first commit of everything in a freshly created project dir. */
export async function initProjectRepo(dir: string, message: string): Promise<void> {
  await git(dir, ['init']);
  try {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', message]);
  } catch {
    // e.g. no git identity configured — the repo exists, project creation
    // still succeeds; round checkpoints surface git problems non-fatally.
  }
}

/**
 * Commit the document, its review sidecar, and any extra paths (e.g. the
 * workspace's .margin directory — discussion + agent notes) if changed.
 * Returns true when a commit was created.
 */
export async function commitCheckpoint(
  filePath: string,
  message: string,
  extraPaths: string[] = [],
): Promise<boolean> {
  const dir = path.dirname(filePath);
  const files = [
    path.basename(filePath),
    `${path.basename(filePath)}.review.json`,
    ...extraPaths.filter((p) => existsSync(p)),
  ];
  await git(dir, ['add', '--', ...files]);
  const status = await git(dir, ['status', '--porcelain', '--', ...files]);
  if (!status.trim()) return false;
  await git(dir, ['commit', '-m', message, '--', ...files]);
  return true;
}

/**
 * Restore the document (and its review sidecar, when present in that commit)
 * to the given commit. Callers checkpoint first so this is always reversible.
 */
export async function restoreFromCommit(filePath: string, hash: string): Promise<void> {
  const dir = path.dirname(filePath);
  const files = [path.basename(filePath), `${path.basename(filePath)}.review.json`];
  for (const f of files) {
    try {
      await git(dir, ['checkout', hash, '--', f]);
    } catch {
      // The sidecar may not exist at that commit — the doc restore stands.
    }
  }
}

export interface LogEntry {
  hash: string;
  date: string;
  message: string;
}

export async function fileLog(filePath: string, limit = 50): Promise<LogEntry[]> {
  const dir = path.dirname(filePath);
  // The review sidecar is part of the document's history — round commits
  // often touch only it (comments/suggestions without text edits).
  const out = await git(dir, [
    'log',
    `--max-count=${limit}`,
    '--pretty=format:%h%x1f%aI%x1f%s',
    '--',
    path.basename(filePath),
    `${path.basename(filePath)}.review.json`,
  ]);
  if (!out.trim()) return [];
  return out
    .trim()
    .split('\n')
    .map((line) => {
      const [hash, date, message] = line.split('\x1f');
      return { hash, date, message };
    });
}
