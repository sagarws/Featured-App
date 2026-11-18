import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, RECORDER_IPC, SCANPACK_IPC } from '@shared/constants/channels'
import type { AgentState, Result, ThemeMode } from '@shared/types/agent'
import type {
  CleanupSummary,
  CreatePacklogInput,
  ExtractionJob,
  ExtractionJobSummary,
  MasterSkuImportResult,
  MasterSkuRecord,
  MasterSkuSummary,
  PacklogSortKey,
  PartName
} from '@shared/types/scanpack'
import type {
  CaptureArea,
  DisplayInfo,
  EngineConfig,
  RecorderSettings,
  RecorderStatus,
  RecordingSummary,
  RecoveryResult,
  StartRecordingRequest,
  StorageInfo,
  SystemAudioPermission
} from '@shared/types/recorder'

/** Subscribe to a push channel; returns the unsubscribe. */
const on = <T>(channel: string, listener: (value: T) => void): (() => void) => {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/**
 * The window's whole reach into the main process. Nothing else is exposed:
 * no ipcRenderer, no Node.
 */
const api = {
  getState: (): Promise<AgentState | null> => ipcRenderer.invoke(IPC.getState),
  onState: (listener: (state: AgentState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: AgentState) => listener(state)
    ipcRenderer.on(IPC.state, handler)
    return () => ipcRenderer.removeListener(IPC.state, handler)
  },
  refreshPrinters: (): Promise<Result> => ipcRenderer.invoke(IPC.refreshPrinters),
  testPrint: (printer: string): Promise<Result> => ipcRenderer.invoke(IPC.testPrint, printer),
  setOpenAtLogin: (enabled: boolean): Promise<Result> => ipcRenderer.invoke(IPC.setOpenAtLogin, enabled),
  setThemeMode: (mode: ThemeMode): Promise<Result> => ipcRenderer.invoke(IPC.setThemeMode, mode),
  setBlockOfflinePrinters: (enabled: boolean): Promise<Result> => ipcRenderer.invoke(IPC.setBlockOfflinePrinters, enabled),
  setNotifications: (enabled: boolean): Promise<Result> => ipcRenderer.invoke(IPC.setNotifications, enabled),
  resumePrinter: (printer: string): Promise<Result> => ipcRenderer.invoke(IPC.resumePrinter, printer),
  clearQueue: (printer: string): Promise<Result> => ipcRenderer.invoke(IPC.clearQueue, printer),
  cancelQueueJob: (printer: string, osJobId: string): Promise<Result> =>
    ipcRenderer.invoke(IPC.cancelQueueJob, printer, osJobId),
  releaseQueueJob: (printer: string, osJobId: string): Promise<Result> =>
    ipcRenderer.invoke(IPC.releaseQueueJob, printer, osJobId),
  cancelJob: (id: string): Promise<Result> => ipcRenderer.invoke(IPC.cancelJob, id),
  releaseJob: (id: string): Promise<Result> => ipcRenderer.invoke(IPC.releaseJob, id),
  reprintJob: (id: string): Promise<Result> => ipcRenderer.invoke(IPC.reprintJob, id),
  openPrinterSettings: (): Promise<Result> => ipcRenderer.invoke(IPC.openPrinterSettings),
  /** Write a line to the terminal and agent.log. One-way, never waits. */
  log: (level: 'info' | 'warn' | 'error', scope: string, message: string): void =>
    ipcRenderer.send(IPC.log, level, scope, message),

  /** Scan & Pack's local backend — see electron/main/scanpack. */
  scanPack: {
    create: (input: CreatePacklogInput): Promise<Result<unknown>> => ipcRenderer.invoke(SCANPACK_IPC.create, input),
    list: (opts: { page?: number; limit?: number; platform?: string; sorted?: boolean }): Promise<Result<unknown>> =>
      ipcRenderer.invoke(SCANPACK_IPC.list, opts),
    get: (id: string): Promise<Result<unknown>> => ipcRenderer.invoke(SCANPACK_IPC.get, id),
    remove: (id: string): Promise<Result<unknown>> => ipcRenderer.invoke(SCANPACK_IPC.remove, id),
    upload: (id: string, orderId: string, part: PartName, bytes: Uint8Array, pageCount: number): Promise<Result<unknown>> =>
      ipcRenderer.invoke(SCANPACK_IPC.upload, id, orderId, part, bytes, pageCount),
    download: (id: string, orderId: string, part: PartName): Promise<Result<Uint8Array>> =>
      ipcRenderer.invoke(SCANPACK_IPC.download, id, orderId, part),
    buildPdf: (id: string, orderIds: string[], parts: PartName[]): Promise<Result<Uint8Array>> =>
      ipcRenderer.invoke(SCANPACK_IPC.buildPdf, id, orderIds, parts),
    savePartsPdf: (
      id: string,
      orderIds: string[],
      parts: PartName[],
      fileName: string
    ): Promise<Result<{ file: string; bytes: number }>> =>
      ipcRenderer.invoke(SCANPACK_IPC.savePartsPdf, id, orderIds, parts, fileName),
    saveBundlesZip: (
      id: string,
      groups: { name: string; orderIds: string[] }[],
      parts: PartName[],
      fileName: string
    ): Promise<Result<{ file: string; bytes: number; pdfs: number }>> =>
      ipcRenderer.invoke(SCANPACK_IPC.saveBundlesZip, id, groups, parts, fileName),
    markPacked: (id: string, orderId: string): Promise<Result<unknown>> =>
      ipcRenderer.invoke(SCANPACK_IPC.markPacked, id, orderId),
    saveSource: (id: string, docId: string, name: string, bytes: Uint8Array, pageCount: number): Promise<Result<unknown>> =>
      ipcRenderer.invoke(SCANPACK_IPC.saveSource, id, docId, name, bytes, pageCount),
    mapOrders: (
      id: string,
      maps: { orderId: string; docId: string; labelPages: number[]; invoicePages: number[] }[]
    ): Promise<Result<{ mapped: number; mappedCount: number; jobId: string | null; workers: number }>> =>
      ipcRenderer.invoke(SCANPACK_IPC.mapOrders, id, maps),
    setSortKey: (id: string, sortKey: PacklogSortKey | null): Promise<Result<{ sortKey: PacklogSortKey | null }>> =>
      ipcRenderer.invoke(SCANPACK_IPC.setSortKey, id, sortKey),
    setDistributionCodes: (id: string, codes: { orderId: string; code: string }[]): Promise<Result<{ updated: number }>> =>
      ipcRenderer.invoke(SCANPACK_IPC.setDistributionCodes, id, codes),
    waitForFirst: (jobId: string, count: number): Promise<Result<ExtractionJob | null>> =>
      ipcRenderer.invoke(SCANPACK_IPC.waitForFirst, jobId, count),
    listJobs: (): Promise<Result<ExtractionJobSummary[]>> => ipcRenderer.invoke(SCANPACK_IPC.listJobs),
    getJob: (jobId: string): Promise<Result<ExtractionJob | null>> => ipcRenderer.invoke(SCANPACK_IPC.getJob, jobId),
    deleteJob: (jobId: string): Promise<Result<ExtractionJobSummary[]>> => ipcRenderer.invoke(SCANPACK_IPC.deleteJob, jobId),
    rerunJob: (jobId: string): Promise<Result<ExtractionJobSummary[]>> => ipcRenderer.invoke(SCANPACK_IPC.rerunJob, jobId),
    setWorkers: (workers: number): Promise<Result<number>> => ipcRenderer.invoke(SCANPACK_IPC.setWorkers, workers),
    saveDownload: (bytes: Uint8Array, fileName: string): Promise<Result<string>> =>
      ipcRenderer.invoke(SCANPACK_IPC.saveDownload, bytes, fileName),
    masterSkuSummary: (): Promise<Result<MasterSkuSummary>> => ipcRenderer.invoke(SCANPACK_IPC.masterSkuSummary),
    masterSkuList: (): Promise<Result<MasterSkuRecord[]>> => ipcRenderer.invoke(SCANPACK_IPC.masterSkuList),
    masterSkuImport: (fileName: string, pairs: { listingSku: string; masterSku: string }[]): Promise<Result<MasterSkuImportResult>> =>
      ipcRenderer.invoke(SCANPACK_IPC.masterSkuImport, fileName, pairs),
    masterSkuClear: (): Promise<Result<MasterSkuImportResult>> => ipcRenderer.invoke(SCANPACK_IPC.masterSkuClear),
    onJobChanged: (listener: (update: { jobs: ExtractionJobSummary[]; job: ExtractionJob | null }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, update: { jobs: ExtractionJobSummary[]; job: ExtractionJob | null }) =>
        listener(update)
      ipcRenderer.on(SCANPACK_IPC.jobChanged, handler)
      return () => ipcRenderer.removeListener(SCANPACK_IPC.jobChanged, handler)
    },
    printPart: (id: string, orderId: string, parts: PartName[], printer: string, jobName: string): Promise<Result<unknown>> =>
      ipcRenderer.invoke(SCANPACK_IPC.printPart, id, orderId, parts, printer, jobName),
    print: (printer: string, bytes: Uint8Array, jobName: string): Promise<Result<{ jobId: string; status: string }>> =>
      ipcRenderer.invoke(SCANPACK_IPC.print, printer, bytes, jobName),
    chooseDir: (): Promise<Result<string | null>> => ipcRenderer.invoke(SCANPACK_IPC.chooseDir),
    resetDir: (): Promise<Result<string>> => ipcRenderer.invoke(SCANPACK_IPC.resetDir),
    openDir: (): Promise<Result> => ipcRenderer.invoke(SCANPACK_IPC.openDir),
    setWeeksKept: (weeks: number): Promise<Result<CleanupSummary>> => ipcRenderer.invoke(SCANPACK_IPC.setWeeksKept, weeks),
    runCleanup: (): Promise<Result<CleanupSummary>> => ipcRenderer.invoke(SCANPACK_IPC.runCleanup),
    /** Timing lines for the terminal. Fire-and-forget: never slows what it measures. */
    perf: (lines: string[]): void => ipcRenderer.send(SCANPACK_IPC.perf, lines)
  },

  /** Screen / webcam / audio recorder — see electron/main/recorder. */
  recorder: {
    getStatus: (): Promise<Result<RecorderStatus>> => ipcRenderer.invoke(RECORDER_IPC.getStatus),
    onStatus: (listener: (status: RecorderStatus) => void): (() => void) => on(RECORDER_IPC.status, listener),
    onLibraryChanged: (listener: () => void): (() => void) => on(RECORDER_IPC.libraryChanged, listener),
    start: (request: StartRecordingRequest): Promise<Result<{ sessionId: string }>> => ipcRenderer.invoke(RECORDER_IPC.start, request),
    pause: (): Promise<Result> => ipcRenderer.invoke(RECORDER_IPC.pause),
    resume: (): Promise<Result> => ipcRenderer.invoke(RECORDER_IPC.resume),
    stop: (): Promise<Result> => ipcRenderer.invoke(RECORDER_IPC.stop),
    selectRegion: (): Promise<Result<CaptureArea | null>> => ipcRenderer.invoke(RECORDER_IPC.selectRegion),
    listDisplays: (): Promise<Result<DisplayInfo[]>> => ipcRenderer.invoke(RECORDER_IPC.listDisplays),
    storageInfo: (): Promise<Result<StorageInfo>> => ipcRenderer.invoke(RECORDER_IPC.storageInfo),
    getSettings: (): Promise<Result<RecorderSettings>> => ipcRenderer.invoke(RECORDER_IPC.getSettings),
    updateSettings: (patch: Partial<RecorderSettings>): Promise<Result<RecorderSettings>> =>
      ipcRenderer.invoke(RECORDER_IPC.updateSettings, patch),
    chooseOutputDir: (): Promise<Result<string | null>> => ipcRenderer.invoke(RECORDER_IPC.chooseOutputDir),
    resetOutputDir: (): Promise<Result<string>> => ipcRenderer.invoke(RECORDER_IPC.resetOutputDir),
    list: (): Promise<Result<RecordingSummary[]>> => ipcRenderer.invoke(RECORDER_IPC.list),
    rename: (id: string, name: string): Promise<Result> => ipcRenderer.invoke(RECORDER_IPC.rename, id, name),
    remove: (id: string): Promise<Result> => ipcRenderer.invoke(RECORDER_IPC.remove, id),
    exportFile: (id: string): Promise<Result<string | null>> => ipcRenderer.invoke(RECORDER_IPC.exportFile, id),
    openLocation: (id: string): Promise<Result> => ipcRenderer.invoke(RECORDER_IPC.openLocation, id),
    merge: (id: string): Promise<Result<string>> => ipcRenderer.invoke(RECORDER_IPC.merge, id),
    listInterrupted: (): Promise<Result<RecordingSummary[]>> => ipcRenderer.invoke(RECORDER_IPC.listInterrupted),
    recover: (id: string): Promise<Result<RecoveryResult>> => ipcRenderer.invoke(RECORDER_IPC.recover, id),
    openPrivacy: (pane: 'screen' | 'microphone' | 'camera' | 'audio'): Promise<Result> => ipcRenderer.invoke(RECORDER_IPC.openPrivacy, pane),
    /** macOS "System Audio Recording": check, or ask (shows the system prompt once). */
    systemAudioPermission: (): Promise<Result<SystemAudioPermission>> => ipcRenderer.invoke(RECORDER_IPC.systemAudioPermission),
    requestSystemAudioPermission: (): Promise<Result<SystemAudioPermission>> => ipcRenderer.invoke(RECORDER_IPC.requestSystemAudioPermission),
    cameraDevice: (): Promise<Result<string | null>> => ipcRenderer.invoke(RECORDER_IPC.cameraDevice),

    /** The hidden capture window only. */
    engine: {
      config: (): Promise<Result<EngineConfig | null>> => ipcRenderer.invoke(RECORDER_IPC.engineConfig),
      ready: (info: { mimeType: string; systemAudio: boolean; microphone: boolean }): Promise<Result> =>
        ipcRenderer.invoke(RECORDER_IPC.engineReady, info),
      failed: (message: string): Promise<Result> => ipcRenderer.invoke(RECORDER_IPC.engineFailed, message),
      chunk: (bytes: Uint8Array): Promise<Result> => ipcRenderer.invoke(RECORDER_IPC.engineChunk, bytes),
      stopped: (): Promise<Result> => ipcRenderer.invoke(RECORDER_IPC.engineStopped),
      event: (name: 'mic-lost' | 'mic-restored' | 'video-ended' | 'system-silent' | 'system-audible'): Promise<Result> => ipcRenderer.invoke(RECORDER_IPC.engineEvent, name),
      onCommand: (listener: (command: 'pause' | 'resume' | 'stop') => void): (() => void) => on(RECORDER_IPC.engineCommand, listener)
    },

    /** Region overlays only. */
    region: {
      started: (): void => ipcRenderer.send(RECORDER_IPC.regionStarted),
      done: (area: CaptureArea | null): void => ipcRenderer.send(RECORDER_IPC.regionDone, area),
      onReset: (listener: () => void): (() => void) => on(RECORDER_IPC.regionReset, () => listener())
    }
  }
}

export type PrintAgentApi = typeof api

contextBridge.exposeInMainWorld('printAgent', api)
