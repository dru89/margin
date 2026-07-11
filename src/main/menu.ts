import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions, shell } from 'electron';
import { IPC } from '@shared/ipc';
import { clearRecentFiles, getRecentFiles, setRecentsChangedListener } from './recents';
import { createWindow, openFile } from './windows';
import { firstMarkdownIn } from './workspace';

const isMac = process.platform === 'darwin';

export async function showOpenDialog(win?: BrowserWindow): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: 'Open Markdown File',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  await openFile(result.filePaths[0], win);
}

/** Open a folder: the workspace explorer shows the whole tree, so we open
 * the folder's first markdown file to seed the window. */
export async function showOpenFolderDialog(win?: BrowserWindow): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: 'Open Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const first = await firstMarkdownIn(result.filePaths[0]);
  if (!first) {
    dialog.showMessageBox({
      type: 'info',
      message: 'No markdown files',
      detail: 'That folder has no markdown documents to open.',
    });
    return;
  }
  await openFile(first, win);
}

export async function rebuildMenu(): Promise<void> {
  const recents = await getRecentFiles();

  const recentItems: MenuItemConstructorOptions[] = recents.map((r) => ({
    label: r.name,
    sublabel: r.path,
    click: () => void openFile(r.path),
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
        ...(isMac ? [] : ([{ role: 'quit' }] as MenuItemConstructorOptions[])),
        ...(isMac ? ([{ role: 'close' }] as MenuItemConstructorOptions[]) : []),
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
          click: () => void shell.openExternal('https://github.com/dru89/agent-editor/issues'),
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
