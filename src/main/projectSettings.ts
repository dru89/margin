/**
 * Per-project preferences in `<workspaceRoot>/.margin/project.json`.
 *
 * The model cascade (Drew, 2026-07-25): app settings hold the default,
 * a new project inherits it and may override, and the project's choice
 * lives here so it travels with the folder instead of sitting in one
 * machine's localStorage.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { ProjectSettings } from '@shared/types';

function settingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.margin', 'project.json');
}

export async function loadProjectSettings(workspaceRoot: string): Promise<ProjectSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsPath(workspaceRoot), 'utf8')) as ProjectSettings;
    return { ...raw, version: 1 };
  } catch {
    return { version: 1 };
  }
}

export async function saveProjectSettings(
  workspaceRoot: string,
  patch: Partial<ProjectSettings>,
): Promise<ProjectSettings> {
  const next: ProjectSettings = { ...(await loadProjectSettings(workspaceRoot)), ...patch, version: 1 };
  const file = settingsPath(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}
