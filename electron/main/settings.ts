import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { ThemeMode } from '@shared/types/agent'
import type { RecorderSettings } from '@shared/types/recorder'
import type { ScreenshotSettings } from '@shared/types/screenshot'
import type { RemoteSettings } from '@shared/types/remote'
import { sanitiseRecorderSettings } from '@shared/utils/recorder'
import { sanitiseScreenshotSettings } from '@shared/utils/screenshot'
import { sanitiseRemoteSettings } from '@shared/utils/remote'
import { normaliseOrigin } from '@shared/utils/origin'
import { readDurableJson, writeDurableJson } from './durableJson'
import { logger } from './logger'

/**
 * The agent's own settings, as JSON in the OS app-data folder. Printer
 * assignment is NOT here: which printer gets labels and which gets invoices is
 * chosen in the web app's Printer Setup, per browser.
 */
export interface AgentSettings {
  allowedOrigins: string[]
  openAtLogin: boolean
  themeMode: ThemeMode
  /** Refuse a job for a printer that is offline or paused, instead of queueing it. */
  blockOfflinePrinters: boolean
  /** Desktop notifications when a printer needs attention or a job fails. */
  notifications: boolean
  /** Download and install a newer version on its own (checked on every start). Off: only offered. */
  autoUpdate: boolean
  /** Screen / webcam / audio recording. */
  recorder: RecorderSettings
  /** Screenshots. Keys and tokens are blank here: they live encrypted in screenshot-secrets.json. */
  screenshot: ScreenshotSettings
  /** Remote Desktop. The identity key and password verifier live encrypted in remote-secrets.json. */
  remoteDesktop: RemoteSettings
}

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

const defaults = (): AgentSettings => ({
  // Extra sites saved by an earlier version. The built-in list is in
  // shared/constants/agent.ts (ALLOWED_ORIGINS) and is not stored.
  allowedOrigins: [],
  // Only a packaged install registers itself; a dev run must not leave a login
  // item pointing at node_modules/electron behind.
  openAtLogin: app.isPackaged,
  themeMode: 'system',
  blockOfflinePrinters: true,
  notifications: true,
  autoUpdate: true,
  recorder: sanitiseRecorderSettings(null),
  screenshot: sanitiseScreenshotSettings(null),
  remoteDesktop: sanitiseRemoteSettings(null)
})

let cached: AgentSettings | null = null

const filePath = (): string => join(app.getPath('userData'), 'settings.json')

/** The app was called "TrackVid Print Agent" before; keep its settings on first start under the new name. */
const LEGACY_DIR_NAME = 'TrackVid Print Agent'
const migrateLegacySettings = (): void => {
  try {
    const target = filePath()
    if (existsSync(target)) return
    const legacy = join(app.getPath('appData'), LEGACY_DIR_NAME, 'settings.json')
    if (!existsSync(legacy)) return
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(legacy, target)
    logger.info('Settings carried over from the previous app name')
  } catch (error) {
    logger.warn('Could not carry over the previous settings', error)
  }
}

const sanitise = (raw: unknown): AgentSettings => {
  const base = defaults()
  if (!raw || typeof raw !== 'object') return base
  const value = raw as Partial<Record<keyof AgentSettings, unknown>>

  const origins = Array.isArray(value.allowedOrigins)
    ? value.allowedOrigins
        .filter((entry): entry is string => typeof entry === 'string')
        .map(entry => normaliseOrigin(entry))
        .filter((entry): entry is string => entry !== null)
    : base.allowedOrigins

  return {
    allowedOrigins: Array.from(new Set(origins)),
    openAtLogin: typeof value.openAtLogin === 'boolean' ? value.openAtLogin : base.openAtLogin,
    themeMode: THEME_MODES.includes(value.themeMode as ThemeMode) ? (value.themeMode as ThemeMode) : base.themeMode,
    blockOfflinePrinters:
      typeof value.blockOfflinePrinters === 'boolean' ? value.blockOfflinePrinters : base.blockOfflinePrinters,
    notifications: typeof value.notifications === 'boolean' ? value.notifications : base.notifications,
    autoUpdate: typeof value.autoUpdate === 'boolean' ? value.autoUpdate : base.autoUpdate,
    recorder: sanitiseRecorderSettings(value.recorder),
    screenshot: sanitiseScreenshotSettings(value.screenshot),
    remoteDesktop: sanitiseRemoteSettings(value.remoteDesktop)
  }
}

export const getSettings = (): AgentSettings => {
  if (cached) return cached
  migrateLegacySettings()
  try {
    cached = sanitise(readDurableJson(filePath()))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('settings.json unreadable, using defaults', error)
    }
    cached = defaults()
  }
  return cached
}

export const updateSettings = (patch: Partial<AgentSettings>): AgentSettings => {
  const next = sanitise({ ...getSettings(), ...patch })
  const path = filePath()
  mkdirSync(dirname(path), { recursive: true })
  // Flushed with a backup, so a crash or power cut cannot reset the settings.
  writeDurableJson(path, next)
  cached = next
  return next
}
