/** IPC channel names shared between main, preload, and renderer. */
export const IPC = {
  // renderer -> main (invoke)
  getDoc: 'doc:get',
  saveDoc: 'doc:save',
  updateReview: 'doc:update-review',
  submitReview: 'doc:submit-review',
  cancelReview: 'doc:cancel-review',
  openFileDialog: 'app:open-file-dialog',
  openPath: 'app:open-path',
  newWindow: 'app:new-window',
  gitInit: 'doc:git-init',
  gitLog: 'doc:git-log',
  getWorkspace: 'workspace:get',
  openInWindow: 'workspace:open-in-window',

  // main -> renderer (send)
  docLoaded: 'doc:loaded',
  reviewUpdated: 'doc:review-updated',
  agentStatus: 'agent:status',
  agentActivity: 'agent:activity',
  menuSave: 'menu:save',
  menuSubmit: 'menu:submit',
  menuTogglePreview: 'menu:toggle-preview',
} as const;
