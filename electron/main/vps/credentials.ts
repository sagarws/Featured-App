import { randomInt } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { generatePassword, isVpsPassword } from '@shared/utils/vps'
import { removeDurableJson } from '../durableJson'
import { encryptionAvailable, readSecure, writeSecure } from '../secureStore'

/*
 * The VPS account's password. Generated with the OS CSPRNG, held in this
 * process, and persisted ONLY when the OS can encrypt it (Keychain / DPAPI /
 * libsecret via safeStorage). Where it cannot, it lives in memory only and
 * after a restart the user regenerates it. It is never logged, never in the
 * connection JSON, and reaches the window only when the user asks to see it.
 *
 * JavaScript cannot wipe a string in place; "clearing" drops every
 * reference so the collector can reclaim it.
 */

const FILE = 'vps-credential.json'

let memory: { username: string; password: string } | null = null

export const newPassword = (): string => generatePassword(randomInt)

export const savePassword = (username: string, password: string): void => {
  memory = { username, password }
  if (encryptionAvailable()) writeSecure(FILE, memory)
}

export const getPassword = (username: string): string | null => {
  if (memory?.username === username) return memory.password
  if (!encryptionAvailable()) return null
  const stored = readSecure<{ username: string; password: string }>(FILE)
  if (stored?.username === username && isVpsPassword(stored.password)) {
    memory = stored
    return stored.password
  }
  return null
}

export const clearPassword = (): void => {
  memory = null
  removeDurableJson(join(app.getPath('userData'), FILE))
}
