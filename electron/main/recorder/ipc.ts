import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { RECORDER_IPC } from '@shared/constants/channels'
import type { Result } from '@shared/types/agent'
import type { CaptureArea, RecorderSettings, StartRecordingRequest, StorageInfo } from '@shared/types/recorder'
import { isAudioSource, sanitiseRecorderSettings } from '@shared/utils/recorder'
import { logger } from '../logger'
import { getSettings, updateSettings } from '../settings'
import { getWindow, isRendererUrl, showWindow } from '../window'
import { listDisplays, openPrivacySettings, screenPermission, systemAudioSupport } from './capture'
import { ffmpegVersion } from './ffmpeg'
import { deleteRecording, exportRecording, listInterrupted, listRecordings, mergeRecording, openRecordingLocation, recoverRecording, renameRecording } from './library'
import {
  activeCameraDevice,
  broadcastLibraryChanged,
  broadcastStatus,
  engineChunk,
  engineConfigFor,
  engineEvent,
  engineFailed,
  engineReady,
  engineStopped,
  getFfmpeg,
  getStatus,
  pauseRecording,
  resumeRecording,
  startRecording,
  stopRecording
} from './session'
import { freeBytes, recordingsRoot } from './storage'
import { closeWindow, createRegionWindows } from './windows'

/** Every call must come from this app's own page (main window or a recorder window). */
const handle = <A extends unknown[], T>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: A) => T | Promise<T>): void => {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<Result<T>> => {
    if (!isRendererUrl(event.senderFrame?.url ?? '')) return { ok: false, error: 'Not allowed.' }
    try {
      return { ok: true, value: await fn(event, ...(args as A)) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`[recorder] ${channel} failed: ${message}`)
      return { ok: false, error: message }
    }
  })
}

const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)

const parseArea = (v: unknown): CaptureArea | undefined => {
  if (!v || typeof v !== 'object') return undefined
  const a = v as Record<string, unknown>
  if (typeof a['displayId'] !== 'string') return undefined
  if (a['type'] === 'display') return { type: 'display', displayId: a['displayId'] }
  const n = (k: string) => (typeof a[k] === 'number' && Number.isFinite(a[k]) ? (a[k]) : NaN)
  const [x, y, width, height] = [n('x'), n('y'), n('width'), n('height')]
  if (a['type'] === 'region' && [x, y, width, height].every(Number.isFinite)) {
    return { type: 'region', displayId: a['displayId'], x, y, width, height }
  }
  return undefined
}

const parseStart = (v: unknown): StartRecordingRequest => {
  const r = (v ?? {}) as Record<string, unknown>
  const kind = r['kind']
  if (kind !== 'screen' && kind !== 'webcam' && kind !== 'audio') throw new Error('Unknown recording type.')
  if (!isAudioSource(r['audio'])) throw new Error('Unknown audio source.')
  const device = (k: string): string | null | undefined =>
    r[k] === null ? null : typeof r[k] === 'string' && (r[k]).length < 512 ? (r[k]) : undefined
  const area = parseArea(r['area'])
  const mic = device('micDeviceId')
  const cam = device('cameraDeviceId')
  return {
    kind,
    audio: r['audio'],
    ...(area ? { area } : {}),
    ...(mic !== undefined ? { micDeviceId: mic } : {}),
    ...(cam !== undefined ? { cameraDeviceId: cam } : {}),
    ...(typeof r['webcamOverlay'] === 'boolean' ? { webcamOverlay: r['webcamOverlay'] } : {})
  }
}

// ── region selection ────────────────────────────────────────────────────────

let regionPick: { windows: BrowserWindow[]; resolve: (area: CaptureArea | null) => void } | null = null

const finishRegion = (area: CaptureArea | null): void => {
  const pick = regionPick
  if (!pick) return
  regionPick = null
  pick.windows.forEach(closeWindow)
  showWindow()
  pick.resolve(area)
}

const selectRegion = (): Promise<CaptureArea | null> => {
  if (regionPick) finishRegion(null)
  return new Promise(resolve => {
    // Out of the way, so the user sees what they are framing.
    getWindow()?.hide()
    regionPick = { windows: createRegionWindows(), resolve }
  })
}

export const registerRecorderIpc = (): void => {
  handle(RECORDER_IPC.getStatus, () => getStatus())
  handle(RECORDER_IPC.start, async (_e, request: unknown) => startRecording(parseStart(request)))
  handle(RECORDER_IPC.pause, () => pauseRecording())
  handle(RECORDER_IPC.resume, () => resumeRecording())
  handle(RECORDER_IPC.stop, () => {
    // Answer at once; the result arrives as a status push when saving ends.
    void stopRecording('user')
  })
  handle(RECORDER_IPC.selectRegion, () => selectRegion())
  handle(RECORDER_IPC.listDisplays, () => listDisplays())

  handle(RECORDER_IPC.storageInfo, async (): Promise<StorageInfo> => {
    const paths = getFfmpeg()
    const platform = process.platform
    return {
      dir: recordingsRoot(),
      freeBytes: await freeBytes(),
      ffmpeg: { found: !!paths, path: paths?.ffmpeg ?? null, version: paths ? ffmpegVersion(paths) : null },
      platform: platform === 'darwin' || platform === 'win32' ? platform : 'linux',
      screenPermission: screenPermission(),
      systemAudio: systemAudioSupport()
    }
  })

  handle(RECORDER_IPC.getSettings, () => getSettings().recorder)
  handle(RECORDER_IPC.updateSettings, (_e, patch: unknown): RecorderSettings => {
    if (!patch || typeof patch !== 'object') throw new Error('Expected settings.')
    const next = sanitiseRecorderSettings({ ...getSettings().recorder, ...(patch as Partial<RecorderSettings>), outputDir: getSettings().recorder.outputDir })
    updateSettings({ recorder: next })
    return next
  })
  handle(RECORDER_IPC.chooseOutputDir, async (event): Promise<string | null> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = { title: 'Folder for recordings', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const dir = result.canceled ? null : (result.filePaths[0] ?? null)
    if (dir) {
      updateSettings({ recorder: { ...getSettings().recorder, outputDir: dir } })
      broadcastLibraryChanged()
    }
    return dir
  })
  handle(RECORDER_IPC.resetOutputDir, () => {
    updateSettings({ recorder: { ...getSettings().recorder, outputDir: null } })
    broadcastLibraryChanged()
    return recordingsRoot()
  })

  handle(RECORDER_IPC.list, () => listRecordings())
  handle(RECORDER_IPC.rename, (_e, id: unknown, name: unknown) => {
    if (!isId(id) || typeof name !== 'string') throw new Error('Unknown recording.')
    renameRecording(id, name)
  })
  handle(RECORDER_IPC.remove, async (_e, id: unknown) => {
    if (!isId(id)) throw new Error('Unknown recording.')
    await deleteRecording(id)
  })
  handle(RECORDER_IPC.exportFile, (event, id: unknown) => {
    if (!isId(id)) throw new Error('Unknown recording.')
    return exportRecording(id, BrowserWindow.fromWebContents(event.sender))
  })
  handle(RECORDER_IPC.openLocation, (_e, id: unknown) => {
    if (!isId(id)) throw new Error('Unknown recording.')
    openRecordingLocation(id)
  })
  handle(RECORDER_IPC.merge, async (_e, id: unknown) => {
    if (!isId(id)) throw new Error('Unknown recording.')
    return mergeRecording(id)
  })
  handle(RECORDER_IPC.listInterrupted, () => listInterrupted())
  handle(RECORDER_IPC.recover, async (_e, id: unknown) => {
    if (!isId(id)) throw new Error('Unknown recording.')
    return recoverRecording(id)
  })
  handle(RECORDER_IPC.openPrivacy, async (_e, pane: unknown) => {
    if (typeof pane !== 'string') throw new Error('Unknown settings page.')
    await openPrivacySettings(pane)
  })

  // ── capture window ──
  handle(RECORDER_IPC.engineConfig, event => engineConfigFor(event.sender))
  handle(RECORDER_IPC.engineReady, (event, info: unknown) => {
    const i = (info ?? {}) as Record<string, unknown>
    engineReady(event.sender, { mimeType: typeof i['mimeType'] === 'string' ? i['mimeType'] : '', systemAudio: i['systemAudio'] === true, microphone: i['microphone'] === true })
  })
  handle(RECORDER_IPC.engineFailed, (event, message: unknown) => engineFailed(event.sender, String(message).slice(0, 500)))
  handle(RECORDER_IPC.engineChunk, async (event, bytes: unknown) => {
    if (!(bytes instanceof Uint8Array)) throw new Error('Expected media bytes.')
    await engineChunk(event.sender, bytes)
  })
  handle(RECORDER_IPC.engineStopped, event => engineStopped(event.sender))
  handle(RECORDER_IPC.engineEvent, (event, name: unknown) => engineEvent(event.sender, String(name)))

  handle(RECORDER_IPC.cameraDevice, () => activeCameraDevice())

  // ── region overlays ──
  ipcMain.on(RECORDER_IPC.regionStarted, event => {
    if (!regionPick) return
    for (const win of regionPick.windows) {
      if (!win.isDestroyed() && win.webContents.id !== event.sender.id) win.webContents.send(RECORDER_IPC.regionReset)
    }
  })
  ipcMain.on(RECORDER_IPC.regionDone, (event, area: unknown) => {
    if (!regionPick || !regionPick.windows.some(w => !w.isDestroyed() && w.webContents.id === event.sender.id)) return
    finishRegion(parseArea(area) ?? null)
  })

  broadcastStatus()
}
