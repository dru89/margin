import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions, shell } from 'electron';
import path from 'path';
import { IPC } from '@shared/ipc';
import { clearRecentFiles, getRecentFiles, setRecentsChangedListener } from './recents';
import { createWindow, openFile } from './windows';
import { declaresProject, firstMarkdownIn } from './workspace';
import { saveProjectFile } from './projectFile';

const isMac = process.platform === 'darwin';

/** Open Settings in the focused window, any window, or a fresh one. */
function openSettings(win?: BrowserWindow): void {
  const target =
    (win instanceof BrowserWindow ? win : undefined) ??
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows()[0] ??
    createWindow();
  if (target.webContents.isLoading()) {
    target.webContents.once('did-finish-load', () =>
      target.webContents.send(IPC.menuOpenSettings),
    );
  } else {
    target.webContents.send(IPC.menuOpenSettings);
  }
}

export async function showOpenDialog(win?: BrowserWindow): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: 'Open Markdown File',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  await openFile(result.filePaths[0], win);
}

/**
 * Open a folder — which is how a project is declared (spec §1, §5).
 *
 * **The unit of selection is the folder, and selecting it is the
 * statement of intent.** There is no walk up from here: opening
 * `book/chapter1/` scopes the window to `chapter1`, whatever `book/` says
 * about itself, which is what makes overlapping projects fall out of the
 * model instead of needing a mechanism.
 *
 * A folder that already declares itself is simply opened. One that does
 * not is asked about first, because confirming is what writes
 * `margin.json` into somebody's folder — the one moment Margin adds a
 * file the author did not create.
 *
 * The explorer shows the whole tree, so the window is seeded with the
 * folder's first markdown file.
 */
export async function showOpenFolderDialog(win?: BrowserWindow): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: 'Open Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const dir = result.filePaths[0];
  const first = await firstMarkdownIn(dir);
  if (!first) {
    dialog.showMessageBox({
      type: 'info',
      message: 'No markdown files',
      detail: 'That folder has no markdown documents to open.',
    });
    return;
  }
  if (!(await declaresProject(dir))) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Open as Project', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Open “${path.basename(dir)}” as a Margin project?`,
      detail:
        'Margin will create a margin.json file here to remember it. Your discussion with Claude, its notes and its memory of this work live with the project.',
    });
    if (response !== 0) return;
    await saveProjectFile(dir, {});
  }
  await openFile(first, win, dir);
}

export async function rebuildMenu(): Promise<void> {
  const recents = await getRecentFiles();

  const recentItems: MenuItemConstructorOptions[] = recents.map((r) => ({
    label: r.name,
    sublabel: r.path,
    click: (_item, win) => void openFile(r.path, win instanceof BrowserWindow ? win : undefined),
  }));
  if (recentItems.length > 0) recentItems.push({ type: 'separator' });
  recentItems.push({
    label: 'Clear Menu',
    enabled: recents.length > 0,
    click: () => void clearRecentFiles(),
  });

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: (_item, win) =>
                  openSettings(win instanceof BrowserWindow ? win : undefined),
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => void createWindow(),
        },
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: (_item, win) => void showOpenDialog(win instanceof BrowserWindow ? win : undefined),
        },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: (_item, win) =>
            void showOpenFolderDialog(win instanceof BrowserWindow ? win : undefined),
        },
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: (_item, win) => win instanceof BrowserWindow && win.webContents.send(IPC.menuSave),
        },
        {
          label: 'Submit for Review',
          accelerator: 'CmdOrCtrl+Shift+Enter',
          click: (_item, win) => win instanceof BrowserWindow && win.webContents.send(IPC.menuSubmit),
        },
        { type: 'separator' },
        ...(isMac
          ? ([{ role: 'close' }] as MenuItemConstructorOptions[])
          : ([
              {
                label: 'Settings',
                accelerator: 'CmdOrCtrl+,',
                click: (_item, win) =>
                  openSettings(win instanceof BrowserWindow ? win : undefined),
              },
              { type: 'separator' },
              { role: 'quit' },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Preview',
          accelerator: 'CmdOrCtrl+E',
          click: (_item, win) =>
            win instanceof BrowserWindow && win.webContents.send(IPC.menuTogglePreview),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Report an Issue',
          click: () => void shell.openExternal('https://github.com/Dru89/margin/issues'),
        },
        ...(isMac ? [] : ([{ type: 'separator' }, { role: 'about' }] as MenuItemConstructorOptions[])),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function initMenu(): void {
  setRecentsChangedListener(() => void rebuildMenu());
  void rebuildMenu();
}
