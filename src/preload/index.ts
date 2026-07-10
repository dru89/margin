import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AgentStatus, DocState, ReviewData, WorkspaceState } from '@shared/types';
import { IPC } from '@shared/ipc';

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  getDoc: (): Promise<DocState | null> => ipcRenderer.invoke(IPC.getDoc),
  saveDoc: (content: string): Promise<void> => ipcRenderer.invoke(IPC.saveDoc, content),
  updateReview: (review: ReviewData): Promise<void> => ipcRenderer.invoke(IPC.updateReview, review),
  submitReview: (content: string, review: ReviewData, note?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.submitReview, content, review, note),
  cancelReview: (): Promise<void> => ipcRenderer.invoke(IPC.cancelReview),
  openFileDialog: (): Promise<void> => ipcRenderer.invoke(IPC.openFileDialog),
  openPath: (filePath: string): Promise<void> => ipcRenderer.invoke(IPC.openPath, filePath),
  newWindow: (): Promise<void> => ipcRenderer.invoke(IPC.newWindow),
  gitInit: (): Promise<boolean> => ipcRenderer.invoke(IPC.gitInit),
  gitLog: (): Promise<{ hash: string; date: string; message: string }[]> =>
    ipcRenderer.invoke(IPC.gitLog),
  getWorkspace: (): Promise<WorkspaceState | null> => ipcRenderer.invoke(IPC.getWorkspace),
  openInWindow: (filePath: string): Promise<void> => ipcRenderer.invoke(IPC.openInWindow, filePath),

  onDocLoaded: (cb: (doc: DocState) => void) => on(IPC.docLoaded, cb),
  onReviewUpdated: (cb: (review: ReviewData) => void) => on(IPC.reviewUpdated, cb),
  onAgentStatus: (cb: (status: AgentStatus) => void) => on(IPC.agentStatus, cb),
  onAgentActivity: (cb: (detail: string) => void) => on(IPC.agentActivity, cb),
  onMenuSave: (cb: () => void) => on(IPC.menuSave, cb),
  onMenuSubmit: (cb: () => void) => on(IPC.menuSubmit, cb),
  onMenuTogglePreview: (cb: () => void) => on(IPC.menuTogglePreview, cb),
};

export type MarginApi = typeof api;

contextBridge.exposeInMainWorld('margin', api);
