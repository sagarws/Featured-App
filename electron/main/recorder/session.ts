import { randomUUID } from 'node:crypto'
import { appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Notification, type WebContents } from 'electron'
import { RECORDER_IPC } from '@shared/constants/channels'
import { RECORDER_TUNING } from '@shared/constants/recorder'
import type { EngineConfig, RecorderStatus, SessionManifest, StartRecordingRequest } from '@shared/types/recorder'
import {
  bitrates,
  defaultRecordingName,
  formatBytes,
  safeRecordingFileName,
  segmentPosition,
  segmentSecondsFor,
  wantsMic,
  wantsSystemAudio
} from '@shared/utils/recorder'
import { logger } from '../logger'
import { getSettings } from '../settings'
import { getWindow, showWindow } from '../window'
import { armDisplayRequest, ensureMediaAccess, listDisplays, openPrivacySettings, screenPermission, systemAudioSupport } from './capture'
import { findFfmpeg, type FfmpegPaths } from './ffmpeg'
import { checkSegments, makeThumbnail, mergeSegments, removeSegments } from './finalize'
import { readSegments, Segmenter } from './segmenter'
import { createSessionDir, freeBytes, saveManifest } from './storage'
import { closeWindow, createBorderWindow, createCameraWindow, createEngineWindow, createToolbarWindow, displayFor } from './windows'

/*
 * The one recording that can run at a time, driven from the main process:
 *
 *   start → session folder + manifest → ffmpeg segmenter → hidden capture
 *   window (#engine) opens the streams and MediaRecorder → chunks arrive here
 *   every second and go straight to ffmpeg → Stop → last chunk → ffmpeg
 *   closes the last segment → segments checked, joined, validated → segments
 *   removed (unless kept).
 *
 * The manifest is rewritten (durably) on every state change and every 5 s,
 * so after any crash the next start knows exactly what was on disk.
 */

interface Active {
  manifest: SessionManifest
  dir: string
  segmenter: Segmenter
  config: EngineConfig
  engine: BrowserWindow
  toolbar: BrowserWindow | null
  border: BrowserWindow | null
  camera: BrowserWindow | null
  phase: RecorderStatus['phase']
  startedAt: number
  pausedAt: number | null
  pausedTotal: number
  systemAudio: boolean
  systemAudioSilent: boolean
  /** Real sound came through system audio at least once. */
  systemAudioHeard: boolean
  microphone: RecorderStatus['microphone']
  error: string | null
  timers: NodeJS.Timeout[]
  ready: { resolve: (v: { mimeType: string; systemAudio: boolean; microphone: boolean }) => void; reject: (e: Error) => void } | null
  stopped: (() => void) | null
  stopping: Promise<void> | null
  minimizedMain: boolean
}

let active: Active | null = null
let lastResult: RecorderStatus['lastResult'] = null
let merging: string | null = null
let ffmpegPaths: FfmpegPaths | null | undefined

const bundledFfmpegDir = (): string | null => (app.isPackaged ? join(process.resourcesPath, 'ffmpeg') : null)

export const getFfmpeg = (): FfmpegPaths | null => {
  if (ffmpegPaths === undefined) ffmpegPaths = findFfmpeg(bundledFfmpegDir())
  return ffmpegPaths
}

export const requireFfmpeg = (): FfmpegPaths => {
  const paths = getFfmpeg()
  if (!paths) {
    // Look again next time: it may have been installed meanwhile.
    ffmpegPaths = undefined
    throw new Error('ffmpeg was not found. Install ffmpeg (or set FFMPEG_PATH and FFPROBE_PATH) to record.')
  }
  return paths
}

// ── status ──────────────────────────────────────────────────────────────────

const elapsedSeconds = (a: Active): number => {
  if (a.phase === 'starting') return 0
  const now = a.pausedAt ?? Date.now()
  return Math.max(0, (now - a.startedAt - a.pausedTotal) / 1000)
}

export const getStatus = (): RecorderStatus => {
  if (!active) {
    return {
      active: false,
      sessionId: null,
      kind: null,
      phase: merging ? 'merging' : 'idle',
      elapsed: 0,
      segment: 0,
      segmentElapsed: 0,
      segmentSeconds: null,
      audio: 'none',
      systemAudio: false,
      systemAudioSilent: false,
      microphone: 'off',
      error: null,
      lastResult
    }
  }
  const elapsed = elapsedSeconds(active)
  const pos = segmentPosition(elapsed, active.manifest.segmentSeconds)
  return {
    active: true,
    sessionId: active.manifest.id,
    kind: active.manifest.kind,
    phase: active.phase,
    elapsed,
    segment: pos.segment,
    segmentElapsed: pos.into,
    segmentSeconds: active.manifest.segmentSeconds,
    audio: active.manifest.audio,
    systemAudio: active.systemAudio,
    systemAudioSilent: active.systemAudioSilent,
    microphone: active.microphone,
    error: active.error,
    lastResult
  }
}

/** Status to every window of the app (main window, toolbar, camera bubble). */
export const broadcastStatus = (): void => {
  const status = getStatus()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(RECORDER_IPC.status, status)
  }
}

export const broadcastLibraryChanged = (): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(RECORDER_IPC.libraryChanged)
  }
}

const persist = (a: Active): void => {
  a.manifest.recordedSeconds = elapsedSeconds(a)
  a.manifest.segments = readSegments(a.dir, a.phase === 'recording' || a.phase === 'paused')
  try {
    saveManifest(a.dir, a.manifest)
  } catch (error) {
    logger.error('[recorder] could not save manifest', error)
  }
}

// ── start ───────────────────────────────────────────────────────────────────

export const isEngine = (contents: WebContents): boolean => !!active && active.engine.webContents.id === contents.id

export const engineConfigFor = (contents: WebContents): EngineConfig | null => (active && isEngine(contents) ? active.config : null)

export const startRecording = async (request: StartRecordingRequest): Promise<{ sessionId: string }> => {
  if (active || merging) throw new Error(active ? 'A recording is already running.' : 'Please wait — the last recording is still being saved.')
  const paths = requireFfmpeg()
  const settings = getSettings().recorder
  const { kind, audio } = request

  // Screen: which display, which area.
  let area = request.area ?? null
  if (kind === 'screen') {
    if (!area) area = { type: 'display', displayId: String(displayFor(null).id) }
    if (!listDisplays().some(d => d.id === area?.displayId)) throw new Error('That display is no longer connected.')
    if (area.type === 'region' && (area.width < 32 || area.height < 32)) throw new Error('The selected region is too small.')
    if (screenPermission() === 'denied') {
      throw new Error('Screen Recording permission is off for this app. Turn it on in System Settings → Privacy & Security → Screen Recording, then restart the app.')
    }
  } else {
    area = null
  }

  if (kind === 'webcam' && wantsSystemAudio(audio)) throw new Error('Webcam recordings record the microphone (or no sound).')
  if (kind === 'audio' && audio === 'none') throw new Error('Choose an audio source to record.')
  if (wantsSystemAudio(audio)) {
    const support = systemAudioSupport()
    if (!support.supported) throw new Error(support.reason ?? 'System audio is not supported on this computer.')
  }
  if ((wantsMic(audio) || (kind === 'webcam' && audio !== 'none')) && !(await ensureMediaAccess('microphone'))) {
    throw new Error('Microphone access is off for this app. Turn it on in your privacy settings.')
  }
  const overlay = kind === 'screen' && (request.webcamOverlay ?? settings.webcamOverlay)
  if ((kind === 'webcam' || overlay) && !(await ensureMediaAccess('camera'))) {
    throw new Error('Camera access is off for this app. Turn it on in your privacy settings.')
  }

  const free = await freeBytes()
  if (free !== null && free < RECORDER_TUNING.minFreeBytesToStart) {
    throw new Error(`Only ${formatBytes(free)} free on the recordings drive. Free some space or choose another folder in Recorder settings.`)
  }

  const now = new Date()
  const dir = createSessionDir(kind, now)
  // Development only: RECORDER_TEST_SEGMENT_SECONDS=10 npm run dev cuts short segments to test splitting and recovery.
  const testSegment = Number(process.env['RECORDER_TEST_SEGMENT_SECONDS'])
  const segmentSeconds = !app.isPackaged && testSegment > 0 ? testSegment : segmentSecondsFor(settings)
  const id = randomUUID()
  const manifest: SessionManifest = {
    version: 1,
    id,
    kind,
    name: defaultRecordingName(kind, now),
    status: 'starting',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    stoppedAt: null,
    audio,
    area,
    segmentSeconds,
    mimeType: null,
    recordedSeconds: 0,
    segments: [],
    final: null,
    thumbnail: null,
    note: null
  }
  saveManifest(dir, manifest)

  const rates = bitrates(settings.resolution, settings.fps, settings.audioQuality)
  const display = area ? displayFor(area.displayId) : null
  const config: EngineConfig = {
    sessionId: id,
    kind,
    audio,
    area,
    displayBounds: display ? { width: display.bounds.width, height: display.bounds.height } : null,
    micDeviceId: request.micDeviceId !== undefined ? request.micDeviceId : settings.micDeviceId,
    cameraDeviceId: request.cameraDeviceId !== undefined ? request.cameraDeviceId : settings.cameraDeviceId,
    micVolume: settings.micVolume,
    resolution: settings.resolution,
    fps: settings.fps,
    audioBitsPerSecond: rates.audio,
    videoBitsPerSecond: rates.video,
    keyframeIntervalMs: RECORDER_TUNING.keyframeIntervalMs,
    timesliceMs: RECORDER_TUNING.timesliceMs
  }

  const segmenter = new Segmenter(paths, dir, segmentSeconds, message => {
    logger.error(`[recorder] ${message}`)
    if (active?.manifest.id === id) {
      active.error = 'The recording writer stopped. What was recorded so far is kept.'
      void stopRecording('writer-failed')
    }
  })

  // The camera bubble is shown first so it is in the very first frames.
  const camera = overlay ? createCameraWindow(area, settings.overlayCorner, settings.overlaySize) : null
  const engine = createEngineWindow()
  const a: Active = {
    manifest,
    dir,
    segmenter,
    config,
    engine,
    toolbar: null,
    border: null,
    camera,
    phase: 'starting',
    startedAt: 0,
    pausedAt: null,
    pausedTotal: 0,
    systemAudio: false,
    systemAudioSilent: false,
    systemAudioHeard: false,
    microphone: 'off',
    error: null,
    timers: [],
    ready: null,
    stopped: null,
    stopping: null,
    minimizedMain: false
  }
  active = a
  // Screen video, and system audio for any kind (Chromium only offers loopback with a screen capture).
  if (kind === 'screen' || wantsSystemAudio(audio)) {
    armDisplayRequest(engine.webContents, area?.displayId ?? String(displayFor(null).id), wantsSystemAudio(audio))
  }

  engine.webContents.on('render-process-gone', (_e, details) => {
    if (active !== a) return
    logger.error('[recorder] capture window died', details)
    a.ready?.reject(new Error('The capture process stopped while starting.'))
    a.error = 'The capture process stopped unexpectedly. What was recorded so far is kept.'
    a.stopped?.()
    void stopRecording('engine-crashed')
  })
  broadcastStatus()

  try {
    const started = await new Promise<{ mimeType: string; systemAudio: boolean; microphone: boolean }>((resolve, reject) => {
      a.ready = { resolve, reject }
      // Long enough for a first-run OS permission prompt.
      a.timers.push(setTimeout(() => reject(new Error('The capture did not start within 60 seconds.')), 60_000))
    })
    a.ready = null
    a.timers.forEach(clearTimeout)
    a.timers = []
    a.manifest.mimeType = started.mimeType
    a.systemAudio = started.systemAudio
    a.microphone = started.microphone ? 'on' : 'off'
  } catch (error) {
    a.ready = null
    await abortStart(a, error instanceof Error ? error.message : String(error))
    throw error
  }

  a.phase = 'recording'
  a.startedAt = Date.now()
  a.manifest.status = 'recording'
  persist(a)
  logger.info('[recorder] recording', { id, kind, audio, area, mimeType: a.manifest.mimeType, dir })

  if (kind === 'screen') {
    a.toolbar = createToolbarWindow(area)
    if (area) a.border = createBorderWindow(area)
    // Out of the way of what is being recorded; the toolbar has the controls.
    const main = getWindow()
    if (main?.isVisible() && !main.isMinimized()) {
      main.minimize()
      a.minimizedMain = true
    }
  }

  a.timers.push(setInterval(() => broadcastStatus(), 1000))
  a.timers.push(setInterval(() => persist(a), RECORDER_TUNING.heartbeatMs))
  a.timers.push(
    setInterval(() => {
      void freeBytes().then(bytes => {
        if (active !== a || bytes === null || bytes >= RECORDER_TUNING.minFreeBytesWhileRecording) return
        logger.warn('[recorder] disk almost full, stopping', { bytes })
        a.error = `Recording stopped: only ${formatBytes(bytes)} left on the disk.`
        void stopRecording('disk-full')
      })
    }, RECORDER_TUNING.diskCheckMs)
  )
  broadcastStatus()
  return { sessionId: id }
}

/** Start failed: tidy up, keep nothing half-made except the folder's manifest. */
const abortStart = async (a: Active, reason: string): Promise<void> => {
  logger.warn('[recorder] start failed', reason)
  a.timers.forEach(clearTimeout)
  closeWindow(a.engine)
  closeWindow(a.camera)
  await a.segmenter.end(5000)
  a.manifest.status = 'failed'
  a.manifest.note = reason
  persist(a)
  // Nothing was recorded: drop the empty session folder.
  if (a.manifest.segments.every(s => s.bytes === 0)) {
    rmSync(a.dir, { recursive: true, force: true })
  }
  if (active === a) active = null
  broadcastStatus()
}

// ── from the capture window ─────────────────────────────────────────────────

export const engineReady = (contents: WebContents, info: { mimeType: string; systemAudio: boolean; microphone: boolean }): void => {
  if (active && isEngine(contents)) active.ready?.resolve(info)
}

export const engineFailed = (contents: WebContents, message: string): void => {
  if (!active || !isEngine(contents)) return
  if (active.ready) active.ready.reject(new Error(message))
  else {
    active.error = message
    void stopRecording('engine-error')
  }
}

export const engineChunk = async (contents: WebContents, bytes: Uint8Array): Promise<void> => {
  if (!active || !isEngine(contents)) throw new Error('No recording is running.')
  // Development only: RECORDER_DEBUG_RAW=1 keeps the raw MediaRecorder stream as raw-input.mkv.
  if (!app.isPackaged && process.env['RECORDER_DEBUG_RAW']) appendFileSync(join(active.dir, 'raw-input.mkv'), bytes)
  await active.segmenter.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

export const engineStopped = (contents: WebContents): void => {
  if (active && isEngine(contents)) active.stopped?.()
}

export const SILENT_SYSTEM_AUDIO_HINT =
  process.platform === 'darwin'
    ? 'If sound was playing, macOS is blocking it: allow this app (or the terminal/IDE that started it) under System Settings → Privacy & Security → Screen & System Audio Recording, then restart it.'
    : 'If sound was playing, check that the right output device is in use and that the app may capture audio.'

/** The main window is minimised while recording, so say it where it will be seen too. */
const notifySilentSystemAudio = (): void => {
  if (!Notification.isSupported()) return
  const note = new Notification({ title: 'No system sound is being recorded', body: 'Other people in a call will not be heard. Click to open the privacy settings.' })
  note.on('click', () => void openPrivacySettings('audio').catch(() => undefined))
  note.show()
}

export const engineEvent = (contents: WebContents, event: string): void => {
  if (!active || !isEngine(contents)) return
  if (event === 'mic-lost') {
    active.microphone = 'lost'
    logger.warn('[recorder] microphone disconnected; recording continues without it')
  } else if (event === 'mic-restored') {
    active.microphone = 'on'
  } else if (event === 'system-silent') {
    if (active.systemAudioSilent) return
    active.systemAudioSilent = true
    logger.warn('[recorder] system audio is digitally silent; the OS may be blocking it')
    notifySilentSystemAudio()
  } else if (event === 'system-audible') {
    active.systemAudioHeard = true
    if (!active.systemAudioSilent) return
    active.systemAudioSilent = false
  } else if (event === 'video-ended') {
    active.error = 'The screen or camera stopped sending video (disconnected?). The recording was stopped and saved.'
    void stopRecording('video-ended')
    return
  }
  broadcastStatus()
}

// ── controls ────────────────────────────────────────────────────────────────

const command = (a: Active, name: 'pause' | 'resume' | 'stop'): void => {
  if (!a.engine.isDestroyed()) a.engine.webContents.send(RECORDER_IPC.engineCommand, name)
}

export const pauseRecording = (): void => {
  const a = active
  if (!a || a.phase !== 'recording') throw new Error('Nothing is recording.')
  command(a, 'pause')
  a.phase = 'paused'
  a.pausedAt = Date.now()
  a.manifest.status = 'paused'
  persist(a)
  broadcastStatus()
}

export const resumeRecording = (): void => {
  const a = active
  if (!a || a.phase !== 'paused' || a.pausedAt === null) throw new Error('The recording is not paused.')
  command(a, 'resume')
  a.pausedTotal += Date.now() - a.pausedAt
  a.pausedAt = null
  a.phase = 'recording'
  a.manifest.status = 'recording'
  persist(a)
  broadcastStatus()
}

/**
 * Stops the capture, waits for its last chunk, closes the last segment, then
 * (unless `merge` is false) checks and joins the segments.
 */
export const stopRecording = (reason = 'user', opts: { merge?: boolean } = {}): Promise<void> => {
  const a = active
  if (!a) return Promise.resolve()
  if (a.stopping) return a.stopping
  a.stopping = (async () => {
    logger.info('[recorder] stopping', { id: a.manifest.id, reason })
    if (a.pausedAt !== null) {
      a.pausedTotal += Date.now() - a.pausedAt
      a.pausedAt = null
    }
    const recorded = elapsedSeconds(a)
    a.phase = 'stopping'
    a.manifest.status = 'stopping'
    persist(a)
    broadcastStatus()

    await new Promise<void>(resolve => {
      a.stopped = resolve
      if (a.engine.isDestroyed()) resolve()
      else command(a, 'stop')
      setTimeout(resolve, RECORDER_TUNING.stopTimeoutMs)
    })
    a.timers.forEach(t => clearInterval(t))
    a.timers = []
    const { code, stderr } = await a.segmenter.end()
    if (code !== 0) logger.warn('[recorder] ffmpeg ended with', { code, stderr: stderr.slice(-500) })

    closeWindow(a.engine)
    closeWindow(a.toolbar)
    closeWindow(a.border)
    closeWindow(a.camera)
    if (a.minimizedMain) showWindow()

    a.manifest.recordedSeconds = recorded
    a.manifest.stoppedAt = new Date().toISOString()
    a.manifest.status = 'stopped'
    a.manifest.note = a.error
    a.manifest.segments = readSegments(a.dir, false)
    persist(a)
    active = null
    const warning = a.systemAudio && !a.systemAudioHeard && recorded * 1000 >= RECORDER_TUNING.systemSilenceWarnMs ? `System audio was silent for the whole recording. ${SILENT_SYSTEM_AUDIO_HINT}` : null

    const shouldMerge = opts.merge ?? getSettings().recorder.autoMerge
    if (!shouldMerge) {
      lastResult = { sessionId: a.manifest.id, file: null, error: a.error, warning }
      broadcastStatus()
      broadcastLibraryChanged()
      return
    }
    try {
      const { file } = await finalizeSession(a.dir, a.manifest)
      lastResult = { sessionId: a.manifest.id, file, error: a.error, warning }
    } catch (error) {
      lastResult = { sessionId: a.manifest.id, file: null, error: error instanceof Error ? error.message : String(error), warning }
    }
    broadcastStatus()
    broadcastLibraryChanged()
  })()
  return a.stopping
}

/**
 * Checks, repairs and joins a session's segments into the final file;
 * deletes the segments only after the joined file is validated (and only if
 * the user does not keep them). Used after Stop and by recovery.
 */
export interface FinalizeResult {
  file: string
  used: number
  skipped: { file: string; reason: string }[]
}

export const finalizeSession = async (dir: string, manifest: SessionManifest): Promise<FinalizeResult> => {
  const paths = requireFfmpeg()
  merging = manifest.id
  broadcastStatus()
  manifest.status = 'merging'
  saveManifest(dir, manifest)
  try {
    const checked = await checkSegments(paths, dir, readSegments(dir, false), manifest.kind, m => logger.warn(`[recorder] ${m}`))
    manifest.segments = checked.map(({ usable: _u, duration: _d, reason: _r, ...segment }) => segment)
    const bad = checked.filter(s => !s.usable)
    const merged = await mergeSegments(paths, dir, checked, {
      kind: manifest.kind,
      mimeType: manifest.mimeType,
      format: getSettings().recorder.videoFormat,
      baseName: safeRecordingFileName(manifest.name)
    })
    manifest.final = { file: merged.file.split(/[\\/]/).pop() ?? merged.file, bytes: merged.bytes, duration: merged.duration }
    manifest.recordedSeconds = merged.duration
    if (manifest.kind !== 'audio') {
      const thumb = await makeThumbnail(paths, merged.file, dir, merged.duration)
      manifest.thumbnail = thumb ? 'thumbnail.jpg' : null
    }
    const notes = [manifest.note, bad.length ? `${bad.length} unreadable segment(s) skipped: ${bad.map(s => s.file).join(', ')}.` : null].filter(Boolean)
    manifest.note = notes.length ? notes.join(' ') : null
    if (!getSettings().recorder.keepSegments && bad.length === 0) {
      removeSegments(dir, checked)
      manifest.segments = []
    }
    manifest.status = 'complete'
    saveManifest(dir, manifest)
    logger.info('[recorder] saved', { file: merged.file, duration: merged.duration, bytes: merged.bytes })
    return { file: merged.file, used: checked.length - bad.length, skipped: bad.map(s => ({ file: s.file, reason: s.reason ?? 'Unreadable' })) }
  } catch (error) {
    manifest.status = 'failed'
    manifest.note = `Merging failed: ${error instanceof Error ? error.message : String(error)} The segments are kept in the session folder.`
    saveManifest(dir, manifest)
    logger.error('[recorder] merge failed', error)
    throw error
  } finally {
    merging = null
  }
}

/**
 * App quitting: stop capture and close the last segment cleanly, but leave
 * the join for the next start (it can take a while). The session is marked
 * interrupted so the recovery prompt offers it.
 */
export const shutdownRecorder = async (): Promise<void> => {
  const a = active
  if (!a) return
  a.error = 'The app was closed while recording.'
  await stopRecording('quit', { merge: false })
  a.manifest.status = 'interrupted'
  saveManifest(a.dir, a.manifest)
}

/** The camera the bubble should show (the one chosen for this recording). */
export const activeCameraDevice = (): string | null => active?.config.cameraDeviceId ?? getSettings().recorder.cameraDeviceId

export const hasActiveRecording = (): boolean => active !== null

export const isMerging = (id: string): boolean => merging === id || active?.manifest.id === id
