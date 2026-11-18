import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { SystemAudioPermission } from '@shared/types/recorder'
import { logger } from '../logger'
import { systemAudioSupport } from './capture'

/*
 * macOS "System Audio Recording" (TCC service kTCCServiceAudioCapture).
 *
 * Without it, macOS does not fail the capture: it hands over pure silence.
 * There is no public API to check or ask for it, so a tiny helper
 * (native/mac/audio-permission.c) calls the TCC framework. macOS attributes
 * the helper to the app that launched it: the packaged app, or in development
 * the terminal/IDE that ran `npm run dev`.
 */

const helperPath = (): string | null => {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'native', 'audio-permission')
    : join(app.getAppPath(), 'resources', 'native', 'mac', 'audio-permission')
  return existsSync(path) ? path : null
}

const STATES: readonly SystemAudioPermission[] = ['granted', 'denied', 'not-determined', 'unknown']

const runHelper = (mode: 'status' | 'request', timeoutMs: number): Promise<SystemAudioPermission> =>
  new Promise(resolve => {
    const helper = helperPath()
    if (!helper) {
      logger.warn('[recorder] audio-permission helper missing; run `npm run native`')
      return resolve('unknown')
    }
    execFile(helper, [mode], { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        logger.warn(`[recorder] audio-permission ${mode} failed`, error)
        return resolve('unknown')
      }
      const value = stdout.trim() as SystemAudioPermission
      resolve(STATES.includes(value) ? value : 'unknown')
    })
  })

export const systemAudioPermission = async (): Promise<SystemAudioPermission> => {
  if (process.platform !== 'darwin') return 'granted'
  if (!systemAudioSupport().supported) return 'unsupported'
  return runHelper('status', 5000)
}

/** Shows the macOS prompt if the user has not decided yet; otherwise just reports. */
export const requestSystemAudioPermission = async (): Promise<SystemAudioPermission> => {
  const current = await systemAudioPermission()
  if (current !== 'not-determined') return current
  return runHelper('request', 5 * 60_000)
}

/** Can system audio be recorded right now? 'unknown' is let through (the silence warning still guards it). */
export const systemAudioAllowed = (state: SystemAudioPermission): boolean => state === 'granted' || state === 'unknown'
