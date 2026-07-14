import { app } from 'electron';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export interface AppSettings {
  /** Where "Start a new project" creates project folders. */
  projectsDir: string;
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * App settings, stored as an editable JSON file in userData. Written with
 * defaults on first read so the file (and the knob) is discoverable.
 */
export async function getSettings(): Promise<AppSettings> {
  const defaults: AppSettings = {
    projectsDir: path.join(os.homedir(), 'Documents', 'Margin'),
  };
  try {
    const raw = JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as Partial<AppSettings>;
    return { ...defaults, ...raw };
  } catch {
    try {
      await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
      await fs.writeFile(settingsPath(), JSON.stringify(defaults, null, 2) + '\n', 'utf8');
    } catch {
      /* settings stay in-memory defaults */
    }
    return defaults;
  }
}
