import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import { readDurableJson, writeDurableJson } from './durableJson'
import { logger } from './logger'

/*
 * Small JSON records that hold credentials (tokens, secret keys), encrypted
 * with the OS keychain / DPAPI / libsecret through safeStorage, and written
 * with durableJson so a crash cannot lose them. Falls back to plain text only
 * where the OS offers no encryption (some Linux desktops).
 */

interface SecureFile {
  encrypted: boolean
  data: string
}

export const encryptionAvailable = (): boolean => {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

const pathOf = (name: string): string => join(app.getPath('userData'), name)

/** The stored value, or null when there is none (or it cannot be read). */
export const readSecure = <T>(name: string): T | null => {
  try {
    const file = readDurableJson<SecureFile>(pathOf(name), v => typeof v?.data === 'string')
    const json = file.encrypted ? safeStorage.decryptString(Buffer.from(file.data, 'base64')) : file.data
    return JSON.parse(json) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn(`[secure] ${name} unreadable, starting empty`, error)
    return null
  }
}

export const writeSecure = (name: string, value: unknown): void => {
  const json = JSON.stringify(value)
  const encrypted = encryptionAvailable()
  const path = pathOf(name)
  mkdirSync(dirname(path), { recursive: true })
  writeDurableJson(path, encrypted ? { encrypted, data: safeStorage.encryptString(json).toString('base64') } : { encrypted, data: json })
}
