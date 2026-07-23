import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type {
  AgentStatus,
  AppSettingsState,
  DiscussionMessage,
  DocState,
  FileProposal,
  GdocsAuthStatus,
  GdocsSyncState,
  ProjectProposal,
  RecentFile,
  ReviewData,
  SetupMessage,
  SetupReply,
  WorkspaceState,
} from '@shared/types';
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
  updateDiscussion: (messages: DiscussionMessage[]): Promise<void> =>
    ipcRenderer.invoke(IPC.updateDiscussion, messages),
  submitReview: (content: string, review: ReviewData, model?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.submitReview, content, review, model),
  cancelReview: (): Promise<void> => ipcRenderer.invoke(IPC.cancelReview),
  openFileDialog: (): Promise<void> => ipcRenderer.invoke(IPC.openFileDialog),
  openPath: (filePath: string): Promise<void> => ipcRenderer.invoke(IPC.openPath, filePath),
  newWindow: (): Promise<void> => ipcRenderer.invoke(IPC.newWindow),
  gitInit: (): Promise<boolean> => ipcRenderer.invoke(IPC.gitInit),
  gitLog: (): Promise<{ hash: string; date: string; message: string }[]> =>
    ipcRenderer.invoke(IPC.gitLog),
  gitRestore: (hash: string): Promise<void> => ipcRenderer.invoke(IPC.gitRestore, hash),
  reloadDoc: (): Promise<void> => ipcRenderer.invoke(IPC.reloadDoc),
  getWorkspace: (): Promise<WorkspaceState | null> => ipcRenderer.invoke(IPC.getWorkspace),
  getRecents: (): Promise<RecentFile[]> => ipcRenderer.invoke(IPC.getRecents),
  openExternal: (filePath: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, filePath),
  openFolderDialog: (): Promise<void> => ipcRenderer.invoke(IPC.openFolderDialog),
  /** Resolve a dropped File to its filesystem path (sandbox-safe). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  openInWindow: (filePath: string): Promise<void> => ipcRenderer.invoke(IPC.openInWindow, filePath),
  /** Fire-and-forget caret context so the native right-click menu stays relevant. */
  setCaretContext: (ctx: { inTable: boolean }): void => ipcRenderer.send(IPC.caretContext, ctx),
  readProposal: (id: string): Promise<{ proposal: FileProposal; content: string } | null> =>
    ipcRenderer.invoke(IPC.readProposal, id),
  acceptProposal: (id: string): Promise<string> => ipcRenderer.invoke(IPC.acceptProposal, id),
  rejectProposal: (id: string, comment?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.rejectProposal, id, comment),
  getProjectsDir: (): Promise<string> => ipcRenderer.invoke(IPC.getProjectsDir),
  setupMessage: (transcript: SetupMessage[]): Promise<SetupReply> =>
    ipcRenderer.invoke(IPC.setupMessage, transcript),
  createProject: (proposal: ProjectProposal, transcript: SetupMessage[]): Promise<string> =>
    ipcRenderer.invoke(IPC.createProject, proposal, transcript),
  getAppSettings: (): Promise<AppSettingsState> => ipcRenderer.invoke(IPC.getAppSettings),
  chooseProjectsDir: (): Promise<AppSettingsState> => ipcRenderer.invoke(IPC.chooseProjectsDir),
  gdocsStatus: (): Promise<GdocsAuthStatus> => ipcRenderer.invoke(IPC.gdocsStatus),
  gdocsConnect: (): Promise<void> => ipcRenderer.invoke(IPC.gdocsConnect),
  gdocsCancelConnect: (): Promise<void> => ipcRenderer.invoke(IPC.gdocsCancelConnect),
  gdocsDisconnect: (): Promise<void> => ipcRenderer.invoke(IPC.gdocsDisconnect),
  gdocsImportClient: (json?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.gdocsImportClient, json),
  gdocsSyncState: (): Promise<GdocsSyncState> => ipcRenderer.invoke(IPC.gdocsSyncState),
  gdocsShareCreate: (): Promise<{ error?: string }> => ipcRenderer.invoke(IPC.gdocsShareCreate),
  gdocsPushDoc: (force: boolean): Promise<{ error?: string; conflict?: boolean; regions?: number }> =>
    ipcRenderer.invoke(IPC.gdocsPushDoc, force),
  gdocsUnlink: (): Promise<void> => ipcRenderer.invoke(IPC.gdocsUnlink),
  openUrl: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openUrl, url),

  onDocLoaded: (cb: (doc: DocState) => void) => on(IPC.docLoaded, cb),
  onReviewUpdated: (cb: (review: ReviewData) => void) => on(IPC.reviewUpdated, cb),
  onDiscussionUpdated: (cb: (messages: DiscussionMessage[]) => void) =>
    on(IPC.discussionUpdated, cb),
  onDocChangedOnDisk: (cb: () => void) => on(IPC.docChangedOnDisk, cb),
  onAgentStatus: (cb: (status: AgentStatus) => void) => on(IPC.agentStatus, cb),
  onAgentActivity: (cb: (detail: string) => void) => on(IPC.agentActivity, cb),
  onMenuSave: (cb: () => void) => on(IPC.menuSave, cb),
  onMenuSubmit: (cb: () => void) => on(IPC.menuSubmit, cb),
  onMenuTogglePreview: (cb: () => void) => on(IPC.menuTogglePreview, cb),
  onMenuAddComment: (cb: () => void) => on(IPC.menuAddComment, cb),
  onMenuFormatTable: (cb: () => void) => on(IPC.menuFormatTable, cb),
  onMenuOpenSettings: (cb: () => void) => on(IPC.menuOpenSettings, cb),
  onGdocsAuthChanged: (cb: (status: GdocsAuthStatus) => void) => on(IPC.gdocsAuthChanged, cb),
  onGdocsSyncChanged: (cb: (state: GdocsSyncState) => void) => on(IPC.gdocsSyncChanged, cb),
};

export type MarginApi = typeof api;

contextBridge.exposeInMainWorld('margin', api);
