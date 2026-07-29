import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

export interface Margin {
  app: ElectronApplication;
  /** The window that existed at launch. */
  first: Page;
  /** Scratch directory the test owns; everything it writes lives here. */
  dir: string;
  /** Where "Start a new project" will create folders. */
  projectsDir: string;
  close: () => Promise<void>;
}

/**
 * Launch the built app in isolation: its own userData (so settings and
 * recents never leak between tests or into the developer's real install)
 * and the fake agent (so rounds are deterministic and no credentials or
 * network are involved).
 */
export async function launch(
  opts: { open?: string; env?: Record<string, string> } = {},
): Promise<Margin> {
  const dir = mkdtempSync(path.join(tmpdir(), 'margin-e2e-'));
  const userData = path.join(dir, 'userData');
  const projectsDir = path.join(dir, 'projects');
  mkdirSync(userData, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  // Seed settings so project creation never touches ~/Documents/Margin.
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ projectsDir }, null, 2));

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, ...(opts.open ? [opts.open] : [])],
    env: { ...process.env, MARGIN_FAKE_AGENT: '1', ...opts.env },
  });
  // launch() resolves before the renderer exists; every caller needs a window.
  const first = await app.firstWindow();
  await first.waitForLoadState('domcontentloaded');
  return {
    app,
    first,
    dir,
    projectsDir,
    async close() {
      await app.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Write a markdown file into the test's scratch directory. */
export function doc(dir: string, rel: string, body: string): string {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

/**
 * The same, in a folder that declares itself a project.
 *
 * A project is declared and never derived (workspace spec §1), so a
 * document dropped in a bare folder belongs to nothing — it can be read,
 * edited and commented on, but a review round asks for a folder first.
 * Every journey about *rounds* wants a project already in place, and says
 * so here rather than clicking through the prompt each time.
 *
 * Use plain `doc()` when the absence of a project is the point.
 */
export function projectDoc(dir: string, rel: string, body: string): string {
  const abs = doc(dir, rel, body);
  writeFileSync(
    path.join(path.dirname(abs), 'margin.json'),
    `${JSON.stringify({ version: 1 }, null, 2)}\n`,
  );
  return abs;
}

/**
 * What a window is showing, named the way a user would name it — the
 * assertions read against this rather than against markup, so a restyle
 * doesn't break them.
 */
export async function showing(page: Page): Promise<string> {
  return page.evaluate(() => {
    if (document.querySelector('.setup-compose')) return 'new project';
    const title = document.querySelector('.doc-title');
    if (title) return title.textContent?.trim() ?? 'document';
    return 'welcome';
  });
}

/** Every window, described. Order follows creation. */
export async function windows(app: ElectronApplication): Promise<string[]> {
  const pages = app.windows().filter((p) => p.url().includes('index.html'));
  return Promise.all(pages.map(showing));
}

/** Wait until the windows settle on an expected description. */
export async function waitForWindows(app: ElectronApplication, want: number): Promise<string[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const w = await windows(app);
    if (w.length === want || Date.now() > deadline) return w;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The window showing exactly this path, waiting for it to appear.
 *
 * Matches on `filePath` rather than on the title, because overlapping
 * projects routinely put two *different* documents on screen with the
 * same basename (`chapter1/one.md` and a symlink to it, or `one.md` in
 * two chapters). Matching by name silently returns the same window twice
 * and makes a multi-window test pass against a build that never opened
 * the second one.
 */
export async function windowFor(app: ElectronApplication, filePath: string): Promise<Page> {
  for (let i = 0; i < 60; i++) {
    for (const page of app.windows()) {
      if (!page.url().includes('index.html')) continue;
      const open = await page
        .evaluate(() => window.margin.getDoc().then((d) => d?.filePath ?? null))
        .catch(() => null);
      if (open === filePath) {
        await page.waitForSelector('.cm-content');
        return page;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no window is showing ${filePath}`);
}

/** What project a window believes it is in. */
export function projectOf(page: Page): Promise<{ root: string; hasProject: boolean } | null> {
  return page.evaluate(async () => {
    const d = await window.margin.getDoc();
    return d ? { root: d.workspaceRoot, hasProject: d.hasProject } : null;
  });
}

/** The window currently showing a given document, if any. */
export function pageShowing(app: ElectronApplication, name: string): Promise<Page | undefined> {
  const pages = app.windows().filter((p) => p.url().includes('index.html'));
  return (async () => {
    for (const p of pages) if ((await showing(p)) === name) return p;
    return undefined;
  })();
}
