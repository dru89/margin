/**
 * `margin.json` — the project's own record of itself (spec §2, #167).
 *
 * The split it creates is the point: **`margin.json` declares, `.margin/`
 * stores.** A visible, committed, hand-editable file beside the generated
 * state, the way `package.json` sits beside `node_modules/`. Every root
 * marker worth copying is a file rather than a dotdir, because a dotdir
 * is easy to overlook and easy to gitignore by accident.
 *
 * Deliberately thin. Only what the author states about the project lives
 * here; everything Margin writes on their behalf — the discussion, agent
 * notes, proposals, the Google Docs link — stays in `.margin/`.
 *
 * Reading falls back to the old `.margin/project.json`, which is every
 * project that exists today. Nothing is converted on read: the fallback
 * is transparent and `margin.json` appears the next time anything about
 * the project changes. That is the whole migration.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { ProjectFile } from '@shared/types';

export const PROJECT_FILE = 'margin.json';

/** Where the project states what it is. */
export function projectFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, PROJECT_FILE);
}

/** The pre-`margin.json` location, still read so existing projects work. */
function legacyPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.margin', 'project.json');
}

async function readJson(file: string): Promise<Partial<ProjectFile> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    // A hand-editable file can hold anything; a non-object is not a
    // project record, and treating it as one would spread `undefined`
    // fields over good defaults.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Partial<ProjectFile>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the project's record, preferring `margin.json` and falling back to
 * the legacy location. Absent or unreadable yields defaults rather than
 * throwing — a project with no record is a project, just an unopinionated
 * one.
 */
export async function loadProjectFile(workspaceRoot: string): Promise<ProjectFile> {
  const raw =
    (await readJson(projectFilePath(workspaceRoot))) ?? (await readJson(legacyPath(workspaceRoot)));
  return { ...raw, version: 1 };
}

/**
 * Merge a patch into the record and write it to `margin.json`.
 *
 * Always writes the new location, even when the values came from the
 * legacy one — which is what quietly migrates a project the first time
 * its model preference or name changes. The old file is left alone
 * rather than deleted: a stale `.margin/project.json` is inert once
 * `margin.json` exists, and removing files the author did not ask us to
 * remove is not ours to do.
 */
export async function saveProjectFile(
  workspaceRoot: string,
  patch: Partial<ProjectFile>,
): Promise<ProjectFile> {
  const next: ProjectFile = { ...(await loadProjectFile(workspaceRoot)), ...patch, version: 1 };
  // Undefined keys would serialize away anyway, but dropping them keeps a
  // hand-edited file free of noise the author did not write.
  const clean = Object.fromEntries(
    Object.entries(next).filter(([, v]) => v !== undefined),
  ) as ProjectFile;
  await fs.writeFile(
    projectFilePath(workspaceRoot),
    `${JSON.stringify(clean, null, 2)}\n`,
    'utf8',
  );
  return clean;
}

/**
 * What to call this project: its stated name, else the folder's own.
 *
 * The reason `name` exists at all — until now a project could only be
 * called whatever its directory was called.
 */
export function projectName(workspaceRoot: string, file: ProjectFile): string {
  const stated = file.name?.trim();
  return stated && stated.length > 0 ? stated : path.basename(workspaceRoot);
}
