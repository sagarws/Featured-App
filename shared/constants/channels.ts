/** IPC channel names between the window and the main process. */
export const IPC = {
  getState: 'agent:get-state',
  state: 'agent:state',
  refreshPrinters: 'agent:refresh-printers',
  testPrint: 'agent:test-print',
  setOpenAtLogin: 'agent:set-open-at-login',
  setThemeMode: 'agent:set-theme-mode',
  setBlockOfflinePrinters: 'agent:set-block-offline-printers',
  setNotifications: 'agent:set-notifications',
  resumePrinter: 'agent:resume-printer',
  clearQueue: 'agent:clear-queue',
  cancelQueueJob: 'agent:cancel-queue-job',
  releaseQueueJob: 'agent:release-queue-job',
  cancelJob: 'agent:cancel-job',
  releaseJob: 'agent:release-job',
  reprintJob: 'agent:reprint-job',
  openPrinterSettings: 'agent:open-printer-settings',
  checkForUpdates: 'agent:check-for-updates',
  installUpdate: 'agent:install-update',
  openUpdateLink: 'agent:open-update-link',
  setAutoUpdate: 'agent:set-auto-update',
  /** One-way: a log line from the window (API calls, crashes) for the terminal and agent.log. */
  log: 'agent:log'
} as const

/** Screen / webcam / audio recorder — see electron/main/recorder. */
export const RECORDER_IPC = {
  getStatus: 'recorder:get-status',
  start: 'recorder:start',
  pause: 'recorder:pause',
  resume: 'recorder:resume',
  stop: 'recorder:stop',
  selectRegion: 'recorder:select-region',
  listDisplays: 'recorder:list-displays',
  storageInfo: 'recorder:storage-info',
  getSettings: 'recorder:get-settings',
  updateSettings: 'recorder:update-settings',
  chooseOutputDir: 'recorder:choose-output-dir',
  resetOutputDir: 'recorder:reset-output-dir',
  list: 'recorder:list',
  rename: 'recorder:rename',
  remove: 'recorder:remove',
  exportFile: 'recorder:export',
  openLocation: 'recorder:open-location',
  merge: 'recorder:merge',
  listInterrupted: 'recorder:list-interrupted',
  recover: 'recorder:recover',
  openPrivacy: 'recorder:open-privacy',
  systemAudioPermission: 'recorder:system-audio-permission',
  requestSystemAudioPermission: 'recorder:request-system-audio-permission',
  /** Push: RecorderStatus, every second while recording and on every change. */
  status: 'recorder:status',
  /** Push: the library changed on disk. */
  libraryChanged: 'recorder:library-changed',

  // The hidden capture window (#engine).
  engineConfig: 'recorder:engine-config',
  engineReady: 'recorder:engine-ready',
  engineFailed: 'recorder:engine-failed',
  engineChunk: 'recorder:engine-chunk',
  engineStopped: 'recorder:engine-stopped',
  engineEvent: 'recorder:engine-event',
  /** Push to the engine: 'pause' | 'resume' | 'stop'. */
  engineCommand: 'recorder:engine-command',

  // Region overlays (#region).
  regionStarted: 'recorder:region-started',
  regionDone: 'recorder:region-done',
  /** Push to the other overlays: clear your selection. */
  regionReset: 'recorder:region-reset',
  /** Camera bubble (#camera): which camera to show. */
  cameraDevice: 'recorder:camera-device'
} as const

/** Video / audio → text — see electron/main/transcriber. */
export const TRANSCRIBER_IPC = {
  chooseFiles: 'transcriber:choose-files',
  start: 'transcriber:start',
  list: 'transcriber:list',
  cancel: 'transcriber:cancel',
  remove: 'transcriber:remove',
  exportFile: 'transcriber:export',
  models: 'transcriber:models',
  /** Push: one job changed (progress, status, result). */
  job: 'transcriber:job',
  /** Push: a job was added or removed. */
  listChanged: 'transcriber:list-changed'
} as const

/** Screenshots — see electron/main/screenshot. */
export const SCREENSHOT_IPC = {
  // The Screenshots page.
  capture: 'screenshot:capture',
  getSettings: 'screenshot:get-settings',
  updateSettings: 'screenshot:update-settings',
  environment: 'screenshot:environment',
  chooseFolder: 'screenshot:choose-folder',
  resetFolder: 'screenshot:reset-folder',
  openFolder: 'screenshot:open-folder',
  openKeyboardSettings: 'screenshot:open-keyboard-settings',
  openScreenPrivacy: 'screenshot:open-screen-privacy',
  /** Pause global shortcuts while a shortcut field is recording keys. */
  suspendHotkeys: 'screenshot:suspend-hotkeys',
  listRecent: 'screenshot:list-recent',
  openFile: 'screenshot:open-file',
  revealFile: 'screenshot:reveal-file',
  deleteFile: 'screenshot:delete-file',
  copyFile: 'screenshot:copy-file',
  testUpload: 'screenshot:test-upload',
  /** Push: settings or hotkeys changed (from the tray, another window, a Google sign-in). */
  changed: 'screenshot:changed',
  /** Push: a file was saved or deleted in the screenshots folder. */
  libraryChanged: 'screenshot:library-changed',

  // Editor / thumbnail / pin windows.
  getCapture: 'screenshot:get-capture',
  exportImage: 'screenshot:export-image',
  editorSettings: 'screenshot:editor-settings',
  openEditor: 'screenshot:open-editor',
  closeSelf: 'screenshot:close-self',
  startDrag: 'screenshot:start-drag',
  /** Push to the windows showing a capture: it was saved / uploaded. */
  captureUpdated: 'screenshot:capture-updated',

  // Area overlays.
  overlayImage: 'screenshot:overlay-image',
  overlayReady: 'screenshot:overlay-ready',
  overlayStarted: 'screenshot:overlay-started',
  overlayDone: 'screenshot:overlay-done',
  /** Push to the other overlays: clear your selection. */
  overlayReset: 'screenshot:overlay-reset',

  // Window picker (Windows / Linux).
  listWindows: 'screenshot:list-windows',
  pickWindow: 'screenshot:pick-window'
} as const

/** Remote Desktop — see electron/main/remote. */
export const REMOTE_IPC = {
  // The Remote Desktop page.
  getStatus: 'remote:get-status',
  history: 'remote:history',
  clearHistory: 'remote:clear-history',
  updateSettings: 'remote:update-settings',
  setPassword: 'remote:set-password',
  clearPassword: 'remote:clear-password',
  setTurnCredential: 'remote:set-turn-credential',
  connect: 'remote:connect',
  cancelConnect: 'remote:cancel-connect',
  disconnect: 'remote:disconnect',
  focusViewer: 'remote:focus-viewer',
  endIncoming: 'remote:end-incoming',
  endAllIncoming: 'remote:end-all-incoming',
  setSessionPermission: 'remote:set-session-permission',
  extendSession: 'remote:extend-session',
  refreshDiscovery: 'remote:refresh-discovery',
  updateDevice: 'remote:update-device',
  forgetDevice: 'remote:forget-device',
  forgetSavedPassword: 'remote:forget-saved-password',
  forgetAllSavedPasswords: 'remote:forget-all-saved-passwords',
  revokeDevice: 'remote:revoke-device',
  revokeAll: 'remote:revoke-all',
  unblockDevice: 'remote:unblock-device',
  probe: 'remote:probe',
  diagnostics: 'remote:diagnostics',
  openPrivacy: 'remote:open-privacy',
  requestAccessibility: 'remote:request-accessibility',
  /** macOS one-time setup: ask for Screen Recording and keyboard/mouse control together. */
  setupPermissions: 'remote:setup-permissions',
  /** Restart the app (macOS applies Screen Recording only to a fresh start). */
  relaunch: 'remote:relaunch',
  chooseTrustedFolder: 'remote:choose-trusted-folder',
  sendFiles: 'remote:send-files',
  installSecureAgent: 'remote:install-secure-agent',
  removeSecureAgent: 'remote:remove-secure-agent',
  cancelTransfer: 'remote:cancel-transfer',
  /** Push: RemoteStatus, on every change. */
  status: 'remote:status',
  /** Push: progress of an outgoing connection attempt. */
  connectProgress: 'remote:connect-progress',

  // Incoming request window (#rd-request).
  requestInfo: 'remote:request-info',
  answerRequest: 'remote:answer-request',

  // Viewer window (#rd-viewer).
  viewerConfig: 'remote:viewer-config',
  viewerReady: 'remote:viewer-ready',
  viewerSignal: 'remote:viewer-signal',
  viewerQuality: 'remote:viewer-quality',
  viewerDisplay: 'remote:viewer-display',
  viewerCapture: 'remote:viewer-capture',
  viewerClipboard: 'remote:viewer-clipboard',
  viewerRestart: 'remote:viewer-restart',
  viewerCtrlAltDel: 'remote:viewer-ctrl-alt-del',
  /** Push to the viewer: a picture of the host's lock screen (JPEG). */
  viewerSecureFrame: 'remote:viewer-secure-frame',
  /** Push to the viewer: SignalMessage from the host. */
  viewerSignalIn: 'remote:viewer-signal-in',
  /** Push to the viewer: session events (timer, permission, displays, warning, end, clipboard). */
  viewerEvent: 'remote:viewer-event',
  /** Push to the viewer: a key the main process intercepted (shortcuts that would otherwise act locally). */
  viewerKey: 'remote:viewer-key',

  // Host capture window (#rd-host).
  engineConfig: 'remote:engine-config',
  engineArm: 'remote:engine-arm',
  engineSignal: 'remote:engine-signal',
  engineState: 'remote:engine-state',
  /** One-way: input events from the viewer's data channel. */
  engineInput: 'remote:engine-input',
  /** Push to the engine: SignalMessage from the viewer. */
  engineSignalIn: 'remote:engine-signal-in',
  /** Push to the engine: start | quality | display | stop. */
  engineCommand: 'remote:engine-command'
} as const

/** The connected Google account and its Drive folders — see electron/main/google. */
export const GOOGLE_IPC = {
  status: 'google:status',
  connect: 'google:connect',
  cancelConnect: 'google:cancel-connect',
  disconnect: 'google:disconnect',
  folders: 'google:folders',
  createFolder: 'google:create-folder',
  /** Push: GoogleStatus. */
  changed: 'google:changed'
} as const

/** File Share: the user's own Drive files — see electron/main/fileshare. */
export const FILESHARE_IPC = {
  getFolder: 'fileshare:get-folder',
  setFolder: 'fileshare:set-folder',
  list: 'fileshare:list',
  chooseAndUpload: 'fileshare:choose-and-upload',
  uploadPaths: 'fileshare:upload-paths',
  uploadBytes: 'fileshare:upload-bytes',
  cancelUpload: 'fileshare:cancel-upload',
  jobs: 'fileshare:jobs',
  thumbnail: 'fileshare:thumbnail',
  share: 'fileshare:share',
  describe: 'fileshare:describe',
  remove: 'fileshare:remove',
  download: 'fileshare:download',
  openLink: 'fileshare:open-link',
  /** Push: one UploadJob changed. */
  job: 'fileshare:job',
  /** Push: the files of a folder changed (folder id). */
  filesChanged: 'fileshare:files-changed'
} as const
