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
