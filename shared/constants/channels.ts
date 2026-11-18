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

/** Scan & Pack: the local stand-in for TrackVid-BE's /packlog API. */
export const SCANPACK_IPC = {
  create: 'scanpack:create',
  list: 'scanpack:list',
  get: 'scanpack:get',
  remove: 'scanpack:delete',
  upload: 'scanpack:upload',
  download: 'scanpack:download',
  buildPdf: 'scanpack:build-pdf',
  savePartsPdf: 'scanpack:save-parts-pdf',
  saveBundlesZip: 'scanpack:save-bundles-zip',
  markPacked: 'scanpack:mark-packed',
  print: 'scanpack:print',
  chooseDir: 'scanpack:choose-dir',
  resetDir: 'scanpack:reset-dir',
  openDir: 'scanpack:open-dir',
  setWeeksKept: 'scanpack:set-weeks-kept',
  runCleanup: 'scanpack:run-cleanup',
  saveSource: 'scanpack:save-source',
  mapOrders: 'scanpack:map-orders',
  setDistributionCodes: 'scanpack:set-distribution-codes',
  setSortKey: 'scanpack:set-sort-key',
  printPart: 'scanpack:print-part',
  waitForFirst: 'scanpack:wait-for-first',
  listJobs: 'scanpack:list-jobs',
  getJob: 'scanpack:get-job',
  deleteJob: 'scanpack:delete-job',
  rerunJob: 'scanpack:rerun-job',
  /** Push: a job changed — { jobs: summaries, job: the changed job with records }. */
  jobChanged: 'scanpack:job-changed',
  setWorkers: 'scanpack:set-workers',
  saveDownload: 'scanpack:save-download',
  /** The `master-sku` table: summary, every record, replace from a sheet, clear. */
  masterSkuSummary: 'scanpack:master-sku-summary',
  masterSkuList: 'scanpack:master-sku-list',
  masterSkuImport: 'scanpack:master-sku-import',
  masterSkuClear: 'scanpack:master-sku-clear',
  /** One-way: timing lines from the window, printed in the app's terminal. */
  perf: 'scanpack:perf'
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
