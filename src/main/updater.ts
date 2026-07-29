import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import type { UpdateState } from '@shared/types';
import { IPC } from '@shared/ipc';
import {
  REMIND_INTERVAL_MS,
  shouldPrompt,
  shouldShowChip,
  type UpdaterPrefs,
} from '@shared/updatePolicy';

/**
 * Auto-update, following the Netscope UX: ask before downloading
 * (Install / Remind Me Later / Skip This Version), show download progress
 * on the taskbar, prompt to restart when ready. Updates are served from
 * GitHub Releases via electron-updater (`build.publish` in package.json).
 *
 * **Checking is periodic; interrupting is not** (#180). The original
 * design checked once at launch, so an app left running for a week never
 * learned a release had happened — and the obvious fix, a timer that
 * raises the same dialog, is worse: `update-available` re-fires on every
 * check, and a modal taking focus mid-sentence in a writing app is a
 * bigger failure than a stale version.
 *
 * So the timer only ever updates *state*, and the state is a quiet chip
 * in the toolbar. The dialog appears when the author clicks it, or from
 * Help → Check for Updates…. Nothing pops on its own.
 */

/** How often to re-check while the app is running. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let state: UpdateState = { status: 'idle' };
let updater: import('electron-updater').AppUpdater | null = null;
/** Set while an explicit "Check for Updates…" is in flight. */
let manualCheck = false;
let timer: ReturnType<typeof setInterval> | null = null;

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

/** Every window shows the same chip: the update is the app's, not a document's. */
function setState(next: UpdateState): void {
  state = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.updateStateChanged, state);
  }
}

function activeWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined;
}

function ask(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const win = activeWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

/**
 * The Install / Remind Me Later / Skip dialog. Reached from the chip and
 * from the menu — never from the timer.
 */
async function promptAvailable(version: string): Promise<void> {
  const prefs = await readPrefs();
  const { response } = await ask({
    type: 'info',
    message: 'Update Available',
    detail: `A new version of Margin (${version}) is available. Would you like to download and install it?`,
    buttons: ['Install Update', 'Remind Me Later', 'Skip This Version'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    setState({ status: 'downloading', version, percent: 0 });
    if (updater) void updater.downloadUpdate();
    else void fakeDownload(version); // MARGIN_FAKE_UPDATE, dev only
  } else if (response === 1) {
    // A timestamp, not a calendar day: the old pref made "later" mean
    // "ten minutes" when clicked at 23:50.
    await writePrefs({ ...prefs, remindLaterAt: new Date().toISOString() });
  } else if (response === 2) {
    await writePrefs({ ...prefs, skippedVersion: version });
    // Skipping is a decision about the release, so the chip goes too.
    setState({ status: 'idle' });
  }
}

/** Walk the chip through downloading → ready without a release to fetch. */
async function fakeDownload(version: string): Promise<void> {
  for (const percent of [8, 27, 54, 81, 100]) {
    await new Promise((r) => setTimeout(r, 400));
    setState({ status: 'downloading', version, percent });
  }
  setState({ status: 'ready', version });
  await promptReady(version);
}

/**
 * The Restart Now / Later dialog, after the download finished.
 *
 * "Later" deliberately does nothing but leave the chip in place.
 * Installing on quit was considered and rejected: a deferral must not
 * silently become an install, since someone may be staying on a working
 * version on purpose (#180).
 */
async function promptReady(version: string): Promise<void> {
  const { response } = await ask({
    type: 'info',
    message: 'Update Ready',
    detail: `Version ${version} has been downloaded. Restart to install.`,
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) updater?.quitAndInstall();
}

/** The chip was clicked: continue whatever the current state is about. */
async function actOnState(): Promise<void> {
  if (state.status === 'available' && state.version) await promptAvailable(state.version);
  else if (state.status === 'ready' && state.version) await promptReady(state.version);
}

/**
 * Help → Check for Updates…. Always answers, including "you are up to
 * date" — a menu item that silently does nothing is the same failure as
 * the git button in #145 — and overrides an earlier "Remind Me Later",
 * because asking is not deferring.
 */
export async function checkForUpdatesManually(): Promise<void> {
  if (state.status === 'downloading') {
    await ask({
      type: 'info',
      message: 'Update in progress',
      detail: `Version ${state.version} is downloading.`,
      buttons: ['OK'],
    });
    return;
  }
  if (state.status === 'ready' || state.status === 'available') {
    await actOnState();
    return;
  }
  // No real updater wired: a dev build, or the fake. Say so rather than
  // leaving a menu item that does nothing (the #145 rule).
  if (!updater) {
    await ask({
      type: 'info',
      message: 'Updates are unavailable in this build',
      detail: 'Margin checks for updates when running a packaged release.',
      buttons: ['OK'],
    });
    return;
  }
  manualCheck = true;
  try {
    await updater.checkForUpdates();
  } catch {
    manualCheck = false;
    await ask({
      type: 'warning',
      message: 'Could not check for updates',
      detail: 'Margin could not reach the update server. Check your connection and try again.',
      buttons: ['OK'],
    });
  }
}

export function getUpdateState(): UpdateState {
  return state;
}

/** Send the current state to a window that has just loaded. */
export function pushUpdateState(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.webContents.send(IPC.updateStateChanged, state);
}

export function registerUpdaterIpc(): void {
  ipcMain.handle(IPC.getUpdateState, () => state);
  ipcMain.handle(IPC.updateAction, () => actOnState());
}

export async function initUpdater(): Promise<void> {
  try {
    await initUpdaterInner();
  } catch {
    // Updates are never worth breaking the app over.
  }
}

async function initUpdaterInner(): Promise<void> {
  // A stand-in for a release, so the chip and its dialogs can be driven
  // without a feed — the same bargain as MARGIN_FAKE_AGENT. Checked
  // before `isPackaged` rather than inside a dev-only branch, because
  // Playwright's Electron reports `isPackaged === true` and a fake
  // reachable only in dev would be a fake no journey could use.
  const fake = process.env.MARGIN_FAKE_UPDATE;
  if (fake) {
    setState({ status: 'available', version: fake });
    return;
  }
  // Without a feed electron-updater would only log errors.
  if (!app.isPackaged) return;

  // electron-updater is CJS with `autoUpdater` defined as a lazy getter, so
  // a dynamic import only exposes it on the `default` namespace.
  const mod = (await import('electron-updater')) as unknown as {
    autoUpdater?: import('electron-updater').AppUpdater;
    default?: { autoUpdater?: import('electron-updater').AppUpdater };
  };
  const autoUpdater = mod.default?.autoUpdater ?? mod.autoUpdater;
  if (!autoUpdater) return;
  updater = autoUpdater;

  autoUpdater.autoDownload = false;
  // A deferral must never become an install (#180).
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', async (info) => {
    const prefs = await readPrefs();
    const wasManual = manualCheck;
    manualCheck = false;
    // The chip outlives a "Remind Me Later" — deferring silences the
    // interruption, not the fact that an update exists.
    if (shouldShowChip(prefs, info.version)) {
      setState({ status: 'available', version: info.version });
    }
    if (wasManual || shouldPrompt(prefs, info.version)) await promptAvailable(info.version);
  });

  autoUpdater.on('update-not-available', async () => {
    if (!manualCheck) return; // a quiet timer tick, and nothing to say
    manualCheck = false;
    await ask({
      type: 'info',
      message: 'Margin is up to date',
      detail: `Version ${app.getVersion()} is the latest release.`,
      buttons: ['OK'],
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    const fraction = progress.percent / 100;
    for (const win of BrowserWindow.getAllWindows()) win.setProgressBar(fraction);
    setState({ ...state, status: 'downloading', percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    for (const win of BrowserWindow.getAllWindows()) win.setProgressBar(-1);
    setState({ status: 'ready', version: info.version });
    await promptReady(info.version);
  });

  autoUpdater.on('error', async () => {
    // Update failures are never fatal — clear any progress bar and move on.
    for (const win of BrowserWindow.getAllWindows()) win.setProgressBar(-1);
    if (state.status === 'downloading') setState({ status: 'available', version: state.version });
    if (!manualCheck) return;
    manualCheck = false;
    await ask({
      type: 'warning',
      message: 'Could not check for updates',
      detail: 'Margin could not reach the update server. Check your connection and try again.',
      buttons: ['OK'],
    });
  });

  void autoUpdater.checkForUpdates();
  // Re-check while the app runs. This only ever moves `state`; the chip
  // is the whole notification (#180).
  timer = setInterval(() => {
    if (state.status === 'idle') void autoUpdater.checkForUpdates().catch(() => undefined);
  }, CHECK_INTERVAL_MS);
  app.on('before-quit', () => {
    if (timer) clearInterval(timer);
  });
}

export { REMIND_INTERVAL_MS };
