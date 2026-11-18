import { app, desktopCapturer, screen, session, shell, systemPreferences, type WebContents } from 'electron'
import type { DisplayInfo, StorageInfo } from '@shared/types/recorder'
import { logger } from '../logger'

/*
 * Screen sources and system audio.
 *
 * The capture window calls getDisplayMedia(); this handler answers it with
 * the display picked in the app (no OS picker) and, for system audio,
 * `audio: 'loopback'`:
 *
 *   Windows  WASAPI loopback — built into Electron.
 *   macOS    Core Audio process tap (macOS 14.2+), Apple's API for capturing
 *            system output, enabled with Chromium's
 *            MacCatapLoopbackAudioForScreenShare feature (see enableCaptureFeatures).
 *   Linux    not through getDisplayMedia; the capture window records the
 *            PulseAudio/PipeWire "Monitor of …" source instead, when there is one.
 *
 * If system audio was asked for and no audio track comes back, the start
 * fails with that reason — it never silently records without sound.
 */

/** Must run before app ready. */
export const enableCaptureFeatures = (): void => {
  const features: string[] = []
  if (process.platform === 'darwin') features.push('MacCatapLoopbackAudioForScreenShare')
  // Wayland screen capture goes through the desktop portal.
  if (process.platform === 'linux') features.push('WebRTCPipeWireCapturer')
  if (features.length) app.commandLine.appendSwitch('enable-features', features.join(','))
}

let pending: { engine: WebContents; displayId: string; loopback: boolean } | null = null

/** The next getDisplayMedia() from `engine` gets this display (and system audio if asked). */
export const armDisplayRequest = (engine: WebContents, displayId: string, loopback: boolean): void => {
  pending = { engine, displayId, loopback }
}

export const registerDisplayMediaHandler = (): void => {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const armed = pending
    pending = null
    if (!armed || request.frame?.processId !== armed.engine.getProcessId()) {
      logger.warn('[recorder] refused an unexpected screen-capture request')
      callback({})
      return
    }
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then(sources => {
        const displays = screen.getAllDisplays()
        const index = displays.findIndex(d => String(d.id) === armed.displayId)
        // display_id is empty on some Linux setups: fall back to the same position.
        const source = sources.find(s => s.display_id === armed.displayId) ?? sources[index] ?? sources[0]
        if (!source) {
          logger.error('[recorder] no screen source — Screen Recording permission missing?')
          callback({})
          return
        }
        const loopback = armed.loopback && process.platform !== 'linux'
        callback(loopback ? { video: source, audio: 'loopback' } : { video: source })
      })
      .catch((error: unknown) => {
        logger.error('[recorder] could not list screens', error)
        callback({})
      })
  })
}

export const listDisplays = (): DisplayInfo[] => {
  const primary = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: d.label || `Display ${i + 1}`,
    primary: d.id === primary,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor
  }))
}

const macVersion = (): [number, number] => {
  const [major = 0, minor = 0] = process.getSystemVersion().split('.').map(Number)
  return [major, minor]
}

export const systemAudioSupport = (): StorageInfo['systemAudio'] => {
  if (process.platform === 'win32') return { supported: true, reason: null }
  if (process.platform === 'darwin') {
    const [major, minor] = macVersion()
    if (major > 14 || (major === 14 && minor >= 2)) return { supported: true, reason: null }
    return { supported: false, reason: `System audio needs macOS 14.2 or later (this Mac runs ${major}.${minor}).` }
  }
  return {
    supported: true,
    reason: 'On Linux, system audio is recorded from the PulseAudio/PipeWire "Monitor" source when one is available.'
  }
}

export const screenPermission = (): StorageInfo['screenPermission'] => {
  if (process.platform !== 'darwin') return 'granted'
  try {
    return systemPreferences.getMediaAccessStatus('screen')
  } catch {
    return 'unknown'
  }
}

/** Asks macOS for camera/microphone access; true elsewhere. */
export const ensureMediaAccess = async (kind: 'microphone' | 'camera'): Promise<boolean> => {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus(kind)
  if (status === 'granted') return true
  if (status === 'denied' || status === 'restricted') return false
  return systemPreferences.askForMediaAccess(kind)
}

const PRIVACY_PANES: Record<string, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  audio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture'
}

const WINDOWS_PANES: Record<string, string> = {
  microphone: 'ms-settings:privacy-microphone',
  camera: 'ms-settings:privacy-webcam'
}

export const openPrivacySettings = async (pane: string): Promise<void> => {
  const url = process.platform === 'darwin' ? PRIVACY_PANES[pane] : process.platform === 'win32' ? WINDOWS_PANES[pane] : undefined
  if (!url) throw new Error('Open the privacy settings from your system menu.')
  await shell.openExternal(url)
}
