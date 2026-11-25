import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { FILESHARE_IPC, GOOGLE_IPC, IPC, RECORDER_IPC, REMOTE_IPC, SCREENSHOT_IPC, TRANSCRIBER_IPC } from '@shared/constants/channels'
import type { AgentState, Result, ThemeMode, UpdateStatus } from '@shared/types/agent'
import type {
  ConnectRequest,
  HistoryEntry,
  HostEngineConfig,
  IncomingRequest,
  InputEvent,
  QualityPreset,
  QualityPriority,
  RemotePermission,
  RemoteSettings,
  RemoteStatus,
  SessionMinutes,
  SignalMessage,
  ViewerConfig
} from '@shared/types/remote'
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
import type { DriveFile, DriveFolder, GoogleAccount, GoogleStatus, UploadJob } from '@shared/types/google'
import type {
  AreaPick,
  CaptureImage,
  CaptureInfo,
  ExportAction,
  ExportResult,
  ScreenshotAction,
  ScreenshotEnvironment,
  ScreenshotFile,
  ScreenshotSettings,
  ThumbnailTimeout,
  WindowChoice
} from '@shared/types/screenshot'
import type { TranscriptExportFormat, TranscriptJob, TranscriptLanguage, TranscriptModel, TranscriptModelInfo } from '@shared/types/transcriber'

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
  /** Ask the update server now (the result also arrives in the next state push). */
  checkForUpdates: (): Promise<Result<UpdateStatus>> => ipcRenderer.invoke(IPC.checkForUpdates),
  /** Download (if needed) and install the newer version now; the app restarts. */
  installUpdate: (): Promise<Result> => ipcRenderer.invoke(IPC.installUpdate),
  /** Open the newer version's installer link in the browser (manual fallback). */
  openUpdateLink: (): Promise<Result> => ipcRenderer.invoke(IPC.openUpdateLink),
  /** Settings → Auto update. */
  setAutoUpdate: (enabled: boolean): Promise<Result> => ipcRenderer.invoke(IPC.setAutoUpdate, enabled),
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
  },

  /** Video / audio → text — see electron/main/transcriber. */
  transcriber: {
    chooseFiles: (): Promise<Result<string[]>> => ipcRenderer.invoke(TRANSCRIBER_IPC.chooseFiles),
    /** The disk path of a file dropped on the page ('' if it has none). */
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    start: (files: string[], language: TranscriptLanguage, model: TranscriptModel): Promise<Result<TranscriptJob[]>> =>
      ipcRenderer.invoke(TRANSCRIBER_IPC.start, files, language, model),
    list: (): Promise<Result<TranscriptJob[]>> => ipcRenderer.invoke(TRANSCRIBER_IPC.list),
    models: (): Promise<Result<TranscriptModelInfo[]>> => ipcRenderer.invoke(TRANSCRIBER_IPC.models),
    cancel: (id: string): Promise<Result> => ipcRenderer.invoke(TRANSCRIBER_IPC.cancel, id),
    remove: (id: string): Promise<Result> => ipcRenderer.invoke(TRANSCRIBER_IPC.remove, id),
    exportFile: (id: string, format: TranscriptExportFormat): Promise<Result<string | null>> => ipcRenderer.invoke(TRANSCRIBER_IPC.exportFile, id, format),
    onJob: (listener: (job: TranscriptJob) => void): (() => void) => on(TRANSCRIBER_IPC.job, listener),
    onListChanged: (listener: () => void): (() => void) => on(TRANSCRIBER_IPC.listChanged, () => listener())
  },

  /** Screenshots — see electron/main/screenshot. */
  screenshot: {
    capture: (action: ScreenshotAction): Promise<Result> => ipcRenderer.invoke(SCREENSHOT_IPC.capture, action),
    getSettings: (): Promise<Result<ScreenshotSettings>> => ipcRenderer.invoke(SCREENSHOT_IPC.getSettings),
    updateSettings: (patch: Partial<ScreenshotSettings>): Promise<Result<ScreenshotSettings>> => ipcRenderer.invoke(SCREENSHOT_IPC.updateSettings, patch),
    environment: (): Promise<Result<ScreenshotEnvironment>> => ipcRenderer.invoke(SCREENSHOT_IPC.environment),
    chooseFolder: (): Promise<Result<string | null>> => ipcRenderer.invoke(SCREENSHOT_IPC.chooseFolder),
    resetFolder: (): Promise<Result<string>> => ipcRenderer.invoke(SCREENSHOT_IPC.resetFolder),
    openFolder: (): Promise<Result> => ipcRenderer.invoke(SCREENSHOT_IPC.openFolder),
    openKeyboardSettings: (): Promise<Result> => ipcRenderer.invoke(SCREENSHOT_IPC.openKeyboardSettings),
    openScreenPrivacy: (): Promise<Result> => ipcRenderer.invoke(SCREENSHOT_IPC.openScreenPrivacy),
    suspendHotkeys: (pause: boolean): Promise<Result> => ipcRenderer.invoke(SCREENSHOT_IPC.suspendHotkeys, pause),
    listRecent: (): Promise<Result<ScreenshotFile[]>> => ipcRenderer.invoke(SCREENSHOT_IPC.listRecent),
    openFile: (path: string): Promise<Result> => ipcRenderer.invoke(SCREENSHOT_IPC.openFile, path),
    revealFile: (path: string): Promise<Result> => ipcRenderer.invoke(SCREENSHOT_IPC.revealFile, path),
    copyFile: (path: string): Promise<Result> => ipcRenderer.invoke(SCREENSHOT_IPC.copyFile, path),
    deleteFile: (path: string): Promise<Result> => ipcRenderer.invoke(SCREENSHOT_IPC.deleteFile, path),
    testUpload: (): Promise<Result<string>> => ipcRenderer.invoke(SCREENSHOT_IPC.testUpload),
    onChanged: (listener: () => void): (() => void) => on(SCREENSHOT_IPC.changed, () => listener()),
    onLibraryChanged: (listener: () => void): (() => void) => on(SCREENSHOT_IPC.libraryChanged, () => listener()),

    /** Editor, thumbnail and pin windows. */
    getCapture: (id: string): Promise<Result<CaptureImage | null>> => ipcRenderer.invoke(SCREENSHOT_IPC.getCapture, id),
    editorSettings: (): Promise<
      Result<{ preferActualSize: boolean; escCopy: boolean; escSave: boolean; thumbnailTimeout: ThumbnailTimeout; uploadReady: boolean; uploadProblem: string | null; platform: 'darwin' | 'win32' | 'linux' }>
    > => ipcRenderer.invoke(SCREENSHOT_IPC.editorSettings),
    /** `png` = the edited picture; omit to use the picture as captured. */
    exportImage: (id: string, action: ExportAction, png?: Uint8Array): Promise<Result<ExportResult>> =>
      ipcRenderer.invoke(SCREENSHOT_IPC.exportImage, id, action, png ?? null),
    openEditor: (id: string): Promise<Result> => ipcRenderer.invoke(SCREENSHOT_IPC.openEditor, id),
    closeSelf: (): Promise<Result> => ipcRenderer.invoke(SCREENSHOT_IPC.closeSelf),
    startDrag: (id: string): void => ipcRenderer.send(SCREENSHOT_IPC.startDrag, id),
    onCaptureUpdated: (listener: (info: CaptureInfo) => void): (() => void) => on(SCREENSHOT_IPC.captureUpdated, listener),

    /** Area overlays. */
    overlay: {
      image: (displayId: string): Promise<Result<Uint8Array | null>> => ipcRenderer.invoke(SCREENSHOT_IPC.overlayImage, displayId),
      ready: (): void => ipcRenderer.send(SCREENSHOT_IPC.overlayReady),
      started: (): void => ipcRenderer.send(SCREENSHOT_IPC.overlayStarted),
      done: (pick: AreaPick | null): void => ipcRenderer.send(SCREENSHOT_IPC.overlayDone, pick),
      onReset: (listener: () => void): (() => void) => on(SCREENSHOT_IPC.overlayReset, () => listener())
    },

    /** Window picker (Windows / Linux). */
    listWindows: (): Promise<Result<WindowChoice[]>> => ipcRenderer.invoke(SCREENSHOT_IPC.listWindows),
    pickWindow: (id: string | null): Promise<Result> => ipcRenderer.invoke(SCREENSHOT_IPC.pickWindow, id)
  },

  /** The user's own Google account (Drive) — see electron/main/google. */
  google: {
    status: (): Promise<Result<GoogleStatus>> => ipcRenderer.invoke(GOOGLE_IPC.status),
    /** Opens Google's consent screen in the browser; resolves once access is allowed. */
    connect: (): Promise<Result<GoogleAccount>> => ipcRenderer.invoke(GOOGLE_IPC.connect),
    cancelConnect: (): Promise<Result> => ipcRenderer.invoke(GOOGLE_IPC.cancelConnect),
    disconnect: (): Promise<Result> => ipcRenderer.invoke(GOOGLE_IPC.disconnect),
    folders: (): Promise<Result<DriveFolder[]>> => ipcRenderer.invoke(GOOGLE_IPC.folders),
    createFolder: (name: string, parentId: string): Promise<Result<{ id: string; name: string }>> => ipcRenderer.invoke(GOOGLE_IPC.createFolder, name, parentId),
    onChanged: (listener: (status: GoogleStatus) => void): (() => void) => on(GOOGLE_IPC.changed, listener)
  },

  /** File Share — see electron/main/fileshare. */
  fileShare: {
    getFolder: (): Promise<Result<string>> => ipcRenderer.invoke(FILESHARE_IPC.getFolder),
    setFolder: (id: string): Promise<Result> => ipcRenderer.invoke(FILESHARE_IPC.setFolder, id),
    list: (folderId: string): Promise<Result<DriveFile[]>> => ipcRenderer.invoke(FILESHARE_IPC.list, folderId),
    chooseAndUpload: (folderId: string, description: string): Promise<Result<UploadJob[]>> => ipcRenderer.invoke(FILESHARE_IPC.chooseAndUpload, folderId, description),
    /** Disk path of a dropped file ('' when it has none, e.g. a pasted image). */
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    uploadPaths: (paths: string[], folderId: string, description: string): Promise<Result<UploadJob[]>> => ipcRenderer.invoke(FILESHARE_IPC.uploadPaths, paths, folderId, description),
    uploadBytes: (name: string, mime: string, bytes: Uint8Array, folderId: string, description: string): Promise<Result<UploadJob>> =>
      ipcRenderer.invoke(FILESHARE_IPC.uploadBytes, name, mime, bytes, folderId, description),
    cancelUpload: (id: string): Promise<Result> => ipcRenderer.invoke(FILESHARE_IPC.cancelUpload, id),
    jobs: (): Promise<Result<UploadJob[]>> => ipcRenderer.invoke(FILESHARE_IPC.jobs),
    thumbnail: (id: string, size: number): Promise<Result<string | null>> => ipcRenderer.invoke(FILESHARE_IPC.thumbnail, id, size),
    /** Makes the file public ("anyone with the link") and returns the link. */
    share: (id: string): Promise<Result<string>> => ipcRenderer.invoke(FILESHARE_IPC.share, id),
    describe: (id: string, description: string): Promise<Result<string>> => ipcRenderer.invoke(FILESHARE_IPC.describe, id, description),
    remove: (id: string): Promise<Result> => ipcRenderer.invoke(FILESHARE_IPC.remove, id),
    download: (id: string, name: string): Promise<Result<string | null>> => ipcRenderer.invoke(FILESHARE_IPC.download, id, name),
    openLink: (url: string): Promise<Result> => ipcRenderer.invoke(FILESHARE_IPC.openLink, url),
    onJob: (listener: (job: UploadJob) => void): (() => void) => on(FILESHARE_IPC.job, listener),
    onFilesChanged: (listener: (folderId: string) => void): (() => void) => on(FILESHARE_IPC.filesChanged, listener)
  },

  /** Remote Desktop — see electron/main/remote. Each window may only use its own group (checked in the main process). */
  remote: {
    getStatus: (): Promise<Result<RemoteStatus>> => ipcRenderer.invoke(REMOTE_IPC.getStatus),
    onStatus: (listener: (status: RemoteStatus) => void): (() => void) => on(REMOTE_IPC.status, listener),
    history: (): Promise<Result<HistoryEntry[]>> => ipcRenderer.invoke(REMOTE_IPC.history),
    clearHistory: (): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.clearHistory),
    updateSettings: (patch: Partial<RemoteSettings>): Promise<Result<RemoteSettings>> => ipcRenderer.invoke(REMOTE_IPC.updateSettings, patch),
    setPassword: (password: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.setPassword, password),
    clearPassword: (): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.clearPassword),
    setTurnCredential: (value: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.setTurnCredential, value),
    connect: (request: ConnectRequest, attemptId: string): Promise<Result<string>> => ipcRenderer.invoke(REMOTE_IPC.connect, request, attemptId),
    cancelConnect: (attemptId: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.cancelConnect, attemptId),
    onConnectProgress: (listener: (p: { attemptId: string; stage: string; message: string; verificationCode?: string; expiresAt?: number }) => void): (() => void) =>
      on(REMOTE_IPC.connectProgress, listener),
    disconnect: (sessionId: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.disconnect, sessionId),
    focusViewer: (sessionId: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.focusViewer, sessionId),
    endIncoming: (sessionId: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.endIncoming, sessionId),
    endAllIncoming: (): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.endAllIncoming),
    setSessionPermission: (sessionId: string, permission: RemotePermission): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.setSessionPermission, sessionId, permission),
    extendSession: (sessionId: string, minutes: SessionMinutes): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.extendSession, sessionId, minutes),
    refreshDiscovery: (): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.refreshDiscovery),
    updateDevice: (id: string, patch: { name?: string; favorite?: boolean }): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.updateDevice, id, patch),
    forgetDevice: (id: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.forgetDevice, id),
    /** Saved passwords for other computers: the renderer only ever sees which IDs have one (RemoteStatus.savedPasswords). */
    forgetSavedPassword: (id: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.forgetSavedPassword, id),
    forgetAllSavedPasswords: (): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.forgetAllSavedPasswords),
    revokeDevice: (id: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.revokeDevice, id),
    revokeAll: (): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.revokeAll),
    unblockDevice: (id: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.unblockDevice, id),
    probe: (target: string): Promise<Result<{ id: string; name: string; os: string; fingerprint: string; attended: boolean; unattended: boolean; busy: boolean; route: string; ms: number }>> =>
      ipcRenderer.invoke(REMOTE_IPC.probe, target),
    diagnostics: (): Promise<Result<Record<string, unknown>>> => ipcRenderer.invoke(REMOTE_IPC.diagnostics),
    openPrivacy: (pane: 'screen' | 'accessibility' | 'firewall'): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.openPrivacy, pane),
    requestAccessibility: (): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.requestAccessibility),
    /** Windows: install / remove the lock-screen agent (administrator prompt). */
    installSecureAgent: (): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.installSecureAgent),
    removeSecureAgent: (): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.removeSecureAgent),
    chooseTrustedFolder: (): Promise<Result<string | null>> => ipcRenderer.invoke(REMOTE_IPC.chooseTrustedFolder),
    sendFiles: (sessionId: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.sendFiles, sessionId),
    cancelTransfer: (transferId: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.cancelTransfer, transferId),

    /** The incoming-request window. */
    requestInfo: (requestId: string): Promise<Result<(IncomingRequest & { defaultMinutes: SessionMinutes; controlDisabled: boolean }) | null>> =>
      ipcRenderer.invoke(REMOTE_IPC.requestInfo, requestId),
    answerRequest: (requestId: string, answer: { allow: boolean; permission: RemotePermission; minutes: SessionMinutes }): Promise<Result> =>
      ipcRenderer.invoke(REMOTE_IPC.answerRequest, requestId, answer),

    /** The viewer window (its own session only). */
    viewer: {
      config: (): Promise<Result<ViewerConfig>> => ipcRenderer.invoke(REMOTE_IPC.viewerConfig),
      ready: (): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.viewerReady),
      restart: (): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.viewerRestart),
      sendCtrlAltDel: (): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.viewerCtrlAltDel),
      /** The host's lock screen (JPEG), while it is locked. */
      onSecureFrame: (listener: (frame: { width: number; height: number; jpeg: Uint8Array }) => void): (() => void) => on(REMOTE_IPC.viewerSecureFrame, listener),
      signal: (signal: SignalMessage): void => ipcRenderer.send(REMOTE_IPC.viewerSignal, signal),
      quality: (preset: QualityPreset, priority: QualityPriority): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.viewerQuality, preset, priority),
      display: (id: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.viewerDisplay, id),
      sendClipboard: (): Promise<Result<boolean>> => ipcRenderer.invoke(REMOTE_IPC.viewerClipboard),
      /** The remote screen has keyboard focus: route shortcuts to it. */
      setCapture: (on: boolean): void => ipcRenderer.send(REMOTE_IPC.viewerCapture, on),
      onSignal: (listener: (signal: SignalMessage) => void): (() => void) => on(REMOTE_IPC.viewerSignalIn, listener),
      onEvent: (listener: (event: Record<string, unknown> & { type: string }) => void): (() => void) => on(REMOTE_IPC.viewerEvent, listener),
      onKey: (
        listener: (key: { type: 'down' | 'up'; code: string; key: string; shift: boolean; control: boolean; alt: boolean; meta: boolean; repeat: boolean }) => void
      ): (() => void) => on(REMOTE_IPC.viewerKey, listener)
    },

    /** The host's hidden capture window (its own session only). */
    engine: {
      config: (): Promise<Result<HostEngineConfig>> => ipcRenderer.invoke(REMOTE_IPC.engineConfig),
      /** Call right before getDisplayMedia(): the main process answers it with this display. */
      arm: (displayId: string): Promise<Result> => ipcRenderer.invoke(REMOTE_IPC.engineArm, displayId),
      signal: (signal: SignalMessage): void => ipcRenderer.send(REMOTE_IPC.engineSignal, signal),
      state: (state: { kind: 'ready' | 'display' | 'error' | 'connected' | 'recaptured'; id?: string; message?: string }): void => ipcRenderer.send(REMOTE_IPC.engineState, state),
      input: (events: InputEvent[]): void => ipcRenderer.send(REMOTE_IPC.engineInput, events),
      onSignal: (listener: (signal: SignalMessage) => void): (() => void) => on(REMOTE_IPC.engineSignalIn, listener),
      onCommand: (
        listener: (command: { type: 'start' } | { type: 'stop' } | { type: 'recapture' } | { type: 'quality'; preset: QualityPreset; priority: QualityPriority } | { type: 'display'; id: string }) => void
      ): (() => void) => on(REMOTE_IPC.engineCommand, listener)
    }
  }
}

export type PrintAgentApi = typeof api

contextBridge.exposeInMainWorld('printAgent', api)
