import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { VpsManifest, VpsPlatform } from '@shared/types/vps'
import { isAccessMode, isVpsChange, isVpsPort, isVpsUsername } from '@shared/utils/vps'
import { readDurableJson, removeDurableJson, writeDurableJson } from '../durableJson'
import { logger } from '../logger'
import { macos } from './platforms/macos'
import { linux } from './platforms/linux'
import { windows } from './platforms/windows'
import type { PlatformAdapter } from './platforms/types'

/*
 * The manifest: what the app changed on this system (no secrets). Written
 * BEFORE the administrator prompt and updated after it, so that a crash or
 * power cut mid-setup still leaves a record Disconnect / Recover can undo.
 */

const file = (): string => join(app.getPath('userData'), 'vps', 'manifest.json')

const valid = (m: VpsManifest): boolean =>
  m?.version === 1 &&
  ['darwin', 'linux', 'win32'].includes(m.platform) &&
  ['configuring', 'running', 'stopped', 'failed'].includes(m.state) &&
  isVpsUsername(m.username) &&
  isVpsPort(m.port) &&
  isAccessMode(m.accessMode) &&
  Array.isArray(m.changes) &&
  m.changes.every(isVpsChange)

export const readManifest = (): VpsManifest | null => {
  try {
    return readDurableJson<VpsManifest>(file(), valid)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('[vps] manifest unreadable, ignoring it', error)
    return null
  }
}

export const writeManifest = (manifest: VpsManifest): void => {
  mkdirSync(join(app.getPath('userData'), 'vps'), { recursive: true })
  writeDurableJson(file(), manifest)
}

export const removeManifest = (): void => removeDurableJson(file())

export const adapter = (): PlatformAdapter | null =>
  process.platform === 'darwin' ? macos : process.platform === 'linux' ? linux : process.platform === 'win32' ? windows : null

export const currentPlatform = (): VpsPlatform | null => adapter()?.id ?? null
