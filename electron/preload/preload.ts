import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, RECORDER_IPC } from '@shared/constants/channels'
import type { AgentState, Result, ThemeMode } from '@shared/types/agent'
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
