import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { ThemeMode } from '@shared/types/agent'
import type { RecorderSettings } from '@shared/types/recorder'
import { sanitiseRecorderSettings } from '@shared/utils/recorder'
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
  /** Screen / webcam / audio recording. */
  recorder: RecorderSettings
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
  recorder: sanitiseRecorderSettings(null)
})

let cached: AgentSettings | null = null

const filePath = (): string => join(app.getPath('userData'), 'settings.json')

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
    recorder: sanitiseRecorderSettings(value.recorder)
  }
}

export const getSettings = (): AgentSettings => {
  if (cached) return cached
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
