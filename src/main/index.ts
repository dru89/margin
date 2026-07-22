import { app, BrowserWindow } from 'electron';
import { statSync } from 'fs';
import path from 'path';
import { createWindow, openFile } from './windows';
import { initMenu } from './menu';
import { registerIpcHandlers } from './ipc';
import { registerGdocsIpc } from './gdocs';
import { initUpdater } from './updater';
import { firstMarkdownIn } from './workspace';

// One app process for all windows.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setName('Margin');
  app.setAboutPanelOptions({
    applicationName: 'Margin',
    applicationVersion: app.getVersion(),
    copyright: '© 2026 Drew Hays',
    website: 'https://github.com/Dru89/margin',
    iconPath: path.join(__dirname, '../../build/icon.png'),
  });

  // `margin <file.md>` or `margin <folder>` (issue #3): a folder opens its
  // first markdown document; the explorer shows the rest.
  const targetFromArgv = (argv: string[], cwd = process.cwd()): string | undefined =>
    argv
      // Dev runs are `electron <app-path> <target>` — skip the app path slot
      // or the directory test matches `.` and opens the repo itself.
      // (process.defaultApp is the canonical dev-run signal; app.isPackaged
      // has proven unreliable under `npx electron .` on this setup.)
      .slice(process.defaultApp ? 2 : 1)
      .filter((a) => !a.startsWith('-'))
      .find((a) => {
        if (/\.(md|markdown|mdx|txt)$/i.test(a)) return true;
        try {
          return statSync(path.resolve(cwd, a)).isDirectory();
        } catch {
          return false;
        }
      });

  const openTarget = async (target: string): Promise<void> => {
    try {
      if (statSync(target).isDirectory()) {
        const first = await firstMarkdownIn(target);
        if (first) return openFile(first);
        createWindow();
        return;
      }
    } catch {
      /* fall through to file handling */
    }
    await openFile(target);
  };

  // macOS: file or folder opened from Finder / `open -a Margin` before/after launch.
  let pendingFile: string | undefined;
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) void openTarget(filePath);
    else pendingFile = filePath;
  });

  // Second instance (file/folder opened from a shell or explorer): route
  // into this process.
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const target = targetFromArgv(argv, workingDirectory);
    if (target) {
      void openTarget(path.resolve(workingDirectory, target));
    } else {
      createWindow();
    }
  });

  app.whenReady().then(() => {
    initMenu();
    registerIpcHandlers();
    registerGdocsIpc();

    const target = pendingFile ?? targetFromArgv(process.argv);
    if (target) void openTarget(path.resolve(target));
    else createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    void initUpdater();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
