import { app, BrowserWindow } from 'electron';
import path from 'path';
import { createWindow, openFile } from './windows';
import { initMenu } from './menu';
import { registerIpcHandlers } from './ipc';

// One app process for all windows.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setName('Margin');

  const fileFromArgv = (argv: string[]): string | undefined =>
    argv
      .slice(1)
      .filter((a) => !a.startsWith('-'))
      .find((a) => /\.(md|markdown|mdx|txt)$/i.test(a));

  // macOS: file opened from Finder before/after launch.
  let pendingFile: string | undefined;
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) void openFile(filePath);
    else pendingFile = filePath;
  });

  // Second instance (double-clicked file on Linux/Windows): route into this process.
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const file = fileFromArgv(argv);
    if (file) {
      void openFile(path.resolve(workingDirectory, file));
    } else {
      createWindow();
    }
  });

  app.whenReady().then(() => {
    initMenu();
    registerIpcHandlers();

    const file = pendingFile ?? fileFromArgv(process.argv);
    if (file) void openFile(path.resolve(file));
    else createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
