import { BrowserWindow, Menu, nativeTheme, screen, shell } from 'electron';
import path from 'path';
import { IPC } from '@shared/ipc';
import { DocumentSession, dropSession, findSessionByPath, getSession, setSession } from './session';
// (Menu import above is used by the context-menu handler.)
import { addRecentFile } from './recents';

const CASCADE_OFFSET = 28;
const DEFAULT_SIZE = { width: 1280, height: 860 };

function nextWindowBounds(): { x?: number; y?: number; width: number; height: number } {
  const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!focused) return { ...DEFAULT_SIZE }; // first window: let the OS center it
  try {
    const [fx, fy] = focused.getPosition();
    const display = screen.getDisplayMatching(focused.getBounds());
    const area = display.workArea;
    let x = fx + CASCADE_OFFSET;
    let y = fy + CASCADE_OFFSET;
    // Wrap back toward the origin if the cascade would run off the screen.
    if (x + DEFAULT_SIZE.width > area.x + area.width || y + DEFAULT_SIZE.height > area.y + area.height) {
      x = area.x + 40;
      y = area.y + 40;
    }
    return { x, y, ...DEFAULT_SIZE };
  } catch {
    // Position unknown (Wayland after a move) — fall back to centered.
    return { ...DEFAULT_SIZE };
  }
}

export function createWindow(filePath?: string): BrowserWindow {
  const bounds = nextWindowBounds();
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    title: filePath ? path.basename(filePath) : 'Margin',
    icon: path.join(__dirname, '../../build/icon.png'),
    // Catppuccin base: Mocha dark / Latte light, matching styles.css.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e2e' : '#eff1f5',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Right-click: native edit actions plus "Add Comment" on a selection.
  win.webContents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.selectionText.trim() && getSession(win.webContents.id)) {
      template.push(
        {
          label: 'Add Comment',
          accelerator: 'CmdOrCtrl+M',
          click: () => win.webContents.send(IPC.menuAddComment),
        },
        { type: 'separator' },
      );
    }
    if (params.isEditable || params.selectionText) {
      template.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' },
      );
    }
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: win });
  });

  win.on('closed', () => dropSession(win.webContents.id));

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  if (filePath) {
    void attachDocument(win, filePath);
  }
  return win;
}

export async function attachDocument(win: BrowserWindow, filePath: string): Promise<void> {
  const session = await DocumentSession.open(filePath, win);
  setSession(win.webContents.id, session);
  win.setTitle(session.fileName);
  await addRecentFile(filePath);
  const send = () => win.webContents.send(IPC.docLoaded, session.toDocState());
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

/**
 * Open a file, following the Netscope window rules:
 * - already open somewhere -> focus that window
 * - `preferWindow` (e.g. a welcome window the user acted in) -> load it there
 * - otherwise -> new cascaded window
 */
export async function openFile(filePath: string, preferWindow?: BrowserWindow): Promise<void> {
  const resolved = path.resolve(filePath);
  const existing = findSessionByPath(resolved);
  if (existing) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (getSession(win.webContents.id)?.filePath === resolved) {
        if (win.isMinimized()) win.restore();
        win.focus();
        return;
      }
    }
  }
  if (preferWindow && !getSession(preferWindow.webContents.id)) {
    await attachDocument(preferWindow, resolved);
    preferWindow.focus();
    return;
  }
  createWindow(resolved);
}
