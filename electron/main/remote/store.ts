import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { hostname, networkInterfaces, release } from 'node:os'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { AuthorizedDevice, DeviceIdentityInfo, HistoryEntry, RemotePlatform, RemoteSettings, SavedDevice } from '@shared/types/remote'
import { sanitiseRemoteSettings } from '@shared/utils/remote'
import { readDurableJson, writeDurableJson } from '../durableJson'
import { logger } from '../logger'
import { getSettings, updateSettings } from '../settings'
import { deviceIdFromPublicKey, fingerprintOf, generateIdentityKeys, privateKeyFromDer, randomToken, type KdfParams, type LocalIdentity } from './core/crypto'

/*
 * What Remote Desktop keeps on disk, in the app-data folder:
 *
 *   settings.json          remoteDesktop: the plain settings
 *   remote-secrets.json    identity private key, unattended-password verifier,
 *                          TURN credential — encrypted with the OS keychain /
 *                          DPAPI / libsecret through safeStorage
 *   remote-devices.json    saved devices (with pinned key fingerprints),
 *                          devices authorised for unattended access, blocked devices
 *   remote-history.log     the connection audit log, one JSON line per event
 *
 * No password is ever stored: only Argon2id(password, salt).
 */

export const platform = (): RemotePlatform => (process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux')

// ── settings ────────────────────────────────────────────────────────────────

export const getRemoteSettings = (): RemoteSettings => getSettings().remoteDesktop

export const updateRemoteSettings = (patch: Partial<RemoteSettings>): RemoteSettings =>
  updateSettings({ remoteDesktop: sanitiseRemoteSettings({ ...getRemoteSettings(), ...patch }) }).remoteDesktop

// ── secrets ─────────────────────────────────────────────────────────────────

export interface UnattendedRecord {
  salt: string
  params: KdfParams
  verifier: string
  setAt: number
}

interface Secrets {
  identityPublic: string
  identityPrivate: string
  unattended: UnattendedRecord | null
  turnCredential: string
}

interface SecretsFile {
  encrypted: boolean
  data: string
}

let secrets: Secrets | null = null
const secretsPath = (): string => join(app.getPath('userData'), 'remote-secrets.json')

export const encryptionAvailable = (): boolean => {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

const writeSecrets = (next: Secrets): void => {
  const json = JSON.stringify(next)
  const encrypted = encryptionAvailable()
  if (!encrypted) logger.warn('[remote] OS encryption unavailable: secrets stored unencrypted (file permissions only)')
  const file: SecretsFile = encrypted ? { encrypted, data: safeStorage.encryptString(json).toString('base64') } : { encrypted, data: json }
  const path = secretsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeDurableJson(path, file)
  secrets = next
}

const readSecrets = (): Secrets => {
  if (secrets) return secrets
  try {
    const file = readDurableJson<SecretsFile>(secretsPath(), v => typeof v?.data === 'string')
    const raw = JSON.parse(file.encrypted ? safeStorage.decryptString(Buffer.from(file.data, 'base64')) : file.data) as Partial<Secrets>
    if (typeof raw.identityPrivate !== 'string' || typeof raw.identityPublic !== 'string') throw new Error('no identity')
    secrets = {
      identityPublic: raw.identityPublic,
      identityPrivate: raw.identityPrivate,
      unattended: raw.unattended && typeof raw.unattended.verifier === 'string' ? raw.unattended : null,
      turnCredential: typeof raw.turnCredential === 'string' ? raw.turnCredential : ''
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Keep the unreadable file: a keychain problem should not silently change the device ID for good.
      try {
        renameSync(secretsPath(), `${secretsPath()}.unreadable-${Date.now()}`)
      } catch {
        // nothing to keep
      }
      logger.error('[remote] remote-secrets.json unreadable; a new device identity is created', error)
    }
    const keys = generateIdentityKeys()
    writeSecrets({ identityPublic: keys.publicKey.toString('base64'), identityPrivate: keys.privateKey.toString('base64'), unattended: null, turnCredential: '' })
    logger.info('[remote] new device identity', { id: deviceIdFromPublicKey(keys.publicKey) })
  }
  return secrets!
}

export const getUnattended = (): UnattendedRecord | null => readSecrets().unattended

export const setUnattended = (record: UnattendedRecord | null): void => writeSecrets({ ...readSecrets(), unattended: record })

export const getTurnCredential = (): string => readSecrets().turnCredential

export const setTurnCredential = (value: string): void => writeSecrets({ ...readSecrets(), turnCredential: value.slice(0, 512) })

export const newSalt = (): Buffer => randomToken(16)

// ── identity ────────────────────────────────────────────────────────────────

const osLabel = (): string => {
  if (process.platform === 'darwin') return `macOS ${process.getSystemVersion()}`
  if (process.platform === 'win32') {
    const build = Number(release().split('.')[2] ?? 0)
    return build >= 22000 ? 'Windows 11' : 'Windows 10'
  }
  return `Linux ${release().split('-')[0] ?? ''}`.trim()
}

let identityCache: LocalIdentity | null = null

export const localIdentity = (): LocalIdentity => {
  const s = readSecrets()
  const name = getRemoteSettings().deviceName || hostname().replace(/\.local$/, '')
  if (!identityCache || identityCache.publicKey.toString('base64') !== s.identityPublic) {
    const publicKey = Buffer.from(s.identityPublic, 'base64')
    identityCache = { id: deviceIdFromPublicKey(publicKey), name, os: osLabel(), platform: platform(), publicKey, privateKey: privateKeyFromDer(Buffer.from(s.identityPrivate, 'base64')) }
  }
  identityCache.name = name
  return identityCache
}

export const lanAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address)

export const identityInfo = (): DeviceIdentityInfo => {
  const id = localIdentity()
  return { id: id.id, name: id.name, hostname: hostname(), os: id.os, platform: id.platform, fingerprint: fingerprintOf(id.publicKey), addresses: lanAddresses() }
}

// ── devices ─────────────────────────────────────────────────────────────────

interface DevicesFile {
  saved: SavedDevice[]
  authorized: AuthorizedDevice[]
  blocked: AuthorizedDevice[]
}

let devices: DevicesFile | null = null
const devicesPath = (): string => join(app.getPath('userData'), 'remote-devices.json')

const readDevices = (): DevicesFile => {
  if (devices) return devices
  try {
    const raw = readDurableJson<Partial<DevicesFile>>(devicesPath())
    devices = {
      saved: Array.isArray(raw.saved) ? raw.saved.filter(d => typeof d?.id === 'string' && typeof d.fingerprint === 'string') : [],
      authorized: Array.isArray(raw.authorized) ? raw.authorized.filter(d => typeof d?.id === 'string') : [],
      blocked: Array.isArray(raw.blocked) ? raw.blocked.filter(d => typeof d?.id === 'string') : []
    }
  } catch {
    devices = { saved: [], authorized: [], blocked: [] }
  }
  return devices
}

const writeDevices = (next: DevicesFile): void => {
  const path = devicesPath()
  mkdirSync(dirname(path), { recursive: true })
  writeDurableJson(path, next)
  devices = next
}

export const savedDevices = (): SavedDevice[] => readDevices().saved
export const authorizedDevices = (): AuthorizedDevice[] => readDevices().authorized
export const blockedDevices = (): AuthorizedDevice[] => readDevices().blocked

export const savedDevice = (id: string): SavedDevice | undefined => readDevices().saved.find(d => d.id === id)

/** Remember a device after a successful connection (pins its key fingerprint). */
export const rememberDevice = (device: Omit<SavedDevice, 'favorite' | 'name'> & { name?: string }): void => {
  const current = readDevices()
  const existing = current.saved.find(d => d.id === device.id)
  const next: SavedDevice = {
    ...device,
    name: existing?.name || device.name || device.id,
    favorite: existing?.favorite ?? false,
    fingerprint: existing?.fingerprint || device.fingerprint
  }
  writeDevices({ ...current, saved: [next, ...current.saved.filter(d => d.id !== device.id)].slice(0, 200) })
}

export const updateSavedDevice = (id: string, patch: Partial<Pick<SavedDevice, 'name' | 'favorite'>>): void => {
  const current = readDevices()
  writeDevices({ ...current, saved: current.saved.map(d => (d.id === id ? { ...d, ...patch, name: (patch.name ?? d.name).slice(0, 64) || d.id } : d)) })
}

export const forgetDevice = (id: string): void => {
  const current = readDevices()
  writeDevices({ ...current, saved: current.saved.filter(d => d.id !== id) })
}

/** A device that got in with the unattended password: listed so the owner can revoke it. */
export const recordAuthorized = (peer: { id: string; name: string; fingerprint: string }): void => {
  const current = readDevices()
  const now = Date.now()
  const existing = current.authorized.find(d => d.id === peer.id)
  const entry: AuthorizedDevice = { id: peer.id, name: peer.name, fingerprint: peer.fingerprint, firstSeen: existing?.firstSeen ?? now, lastSeen: now }
  writeDevices({ ...current, authorized: [entry, ...current.authorized.filter(d => d.id !== peer.id)].slice(0, 500) })
}

/** Revoke: off the authorised list and onto the blocked list. */
export const blockDevice = (peer: { id: string; name: string; fingerprint: string }): void => {
  const current = readDevices()
  const now = Date.now()
  writeDevices({
    ...current,
    authorized: current.authorized.filter(d => d.id !== peer.id),
    blocked: [{ id: peer.id, name: peer.name, fingerprint: peer.fingerprint, firstSeen: now, lastSeen: now }, ...current.blocked.filter(d => d.id !== peer.id)]
  })
}

export const unblockDevice = (id: string): void => {
  const current = readDevices()
  writeDevices({ ...current, blocked: current.blocked.filter(d => d.id !== id) })
}

export const isBlocked = (id: string): boolean => readDevices().blocked.some(d => d.id === id)

export const clearAuthorized = (): void => writeDevices({ ...readDevices(), authorized: [] })

// ── history / audit log ─────────────────────────────────────────────────────

const historyPath = (): string => join(app.getPath('userData'), 'remote-history.log')
const MAX_HISTORY_BYTES = 2 * 1024 * 1024

export const appendHistory = (entry: HistoryEntry): void => {
  try {
    const path = historyPath()
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path) && statSync(path).size > MAX_HISTORY_BYTES) {
      // Keep the newer half.
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      writeFileSync(path, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n')
    }
    appendFileSync(path, JSON.stringify(entry) + '\n')
  } catch (error) {
    logger.warn('[remote] could not write the history', error)
  }
  logger.info(`[remote] ${entry.direction} ${entry.event} ${entry.peerId} ${entry.address} ${entry.detail}`)
}

export const readHistory = (limit = 500): HistoryEntry[] => {
  try {
    return readFileSync(historyPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map(line => {
        try {
          return JSON.parse(line) as HistoryEntry
        } catch {
          return null
        }
      })
      .filter((e): e is HistoryEntry => e !== null)
      .reverse()
  } catch {
    return []
  }
}

export const clearHistory = (): void => {
  try {
    writeFileSync(historyPath(), '')
  } catch {
    // nothing to clear
  }
}
