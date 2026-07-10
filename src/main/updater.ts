import { app, BrowserWindow, dialog } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Auto-update, following the Netscope UX: check on launch, ask before
 * downloading (Install / Remind Me Later / Skip This Version), show download
 * progress on the taskbar, prompt to restart when ready. Updates are served
 * from GitHub Releases via electron-updater (`build.publish` in package.json).
 */

interface UpdaterPrefs {
  skippedVersion?: string;
  /** ISO date (YYYY-MM-DD) of the last "Remind Me Later". */
  remindLaterDate?: string;
}

function prefsPath(): string {
  return path.join(app.getPath('userData'), 'updater.json');
}

async function readPrefs(): Promise<UpdaterPrefs> {
  try {
    return JSON.parse(await fs.readFile(prefsPath(), 'utf8')) as UpdaterPrefs;
  } catch {
    return {};
  }
}

async function writePrefs(prefs: UpdaterPrefs): Promise<void> {
  try {
    await fs.writeFile(prefsPath(), JSON.stringify(prefs, null, 2), 'utf8');
  } catch {
    /* non-fatal */
  }
}

export async function initUpdater(): Promise<void> {
  // electron-updater has no feed in dev and would just log errors.
  if (!app.isPackaged) return;

  // ESM-only sibling of the Agent SDK situation — load dynamically.
  const { autoUpdater } = await import('electron-updater');

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', async (info) => {
    const prefs = await readPrefs();
    if (prefs.skippedVersion === info.version) return;
    const today = new Date().toISOString().slice(0, 10);
    if (prefs.remindLaterDate === today) return;

    const focused = BrowserWindow.getFocusedWindow();
    const options = {
      type: 'info' as const,
      message: 'Update Available',
      detail: `A new version of Margin (${info.version}) is available. Would you like to download and install it?`,
      buttons: ['Install Update', 'Remind Me Later', 'Skip This Version'],
      defaultId: 0,
    };
    const result = focused
      ? await dialog.showMessageBox(focused, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) {
      void autoUpdater.downloadUpdate();
    } else if (result.response === 1) {
      await writePrefs({ ...prefs, remindLaterDate: today });
    } else if (result.response === 2) {
      await writePrefs({ ...prefs, skippedVersion: info.version });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    const fraction = progress.percent / 100;
    for (const win of BrowserWindow.getAllWindows()) win.setProgressBar(fraction);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    for (const win of BrowserWindow.getAllWindows()) win.setProgressBar(-1);
    const focused = BrowserWindow.getFocusedWindow();
    const options = {
      type: 'info' as const,
      message: 'Update Ready',
      detail: `Version ${info.version} has been downloaded. Restart to install.`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    };
    const result = focused
      ? await dialog.showMessageBox(focused, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', () => {
    // Update failures are never fatal — clear any progress bar and move on.
    for (const win of BrowserWindow.getAllWindows()) win.setProgressBar(-1);
  });

  void autoUpdater.checkForUpdates();
}
