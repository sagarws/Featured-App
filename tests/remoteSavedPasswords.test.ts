import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as StoreModule from '../electron/main/remote/store'

/*
 * Saved connection passwords ("Remember password" in Connect): kept in the
 * encrypted remote-secrets.json only, keyed by 8-digit device ID, capped.
 */

const env = vi.hoisted(() => ({ dir: '', encryption: true }))

// A stand-in for the OS keychain: reversible, but never the plain JSON.
vi.mock('electron', () => ({
  app: { getPath: () => env.dir },
  safeStorage: {
    isEncryptionAvailable: () => env.encryption,
    encryptString: (text: string) => Buffer.from(Buffer.from(text, 'utf8').toString('base64').split('').reverse().join(''), 'utf8'),
    decryptString: (data: Buffer) => Buffer.from(data.toString('utf8').split('').reverse().join(''), 'base64').toString('utf8')
  }
}))
vi.mock('../electron/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), path: () => null } }))
vi.mock('../electron/main/settings', () => ({ getSettings: () => ({ remoteDesktop: {} }), updateSettings: () => ({ remoteDesktop: {} }) }))

const loadStore = async (): Promise<typeof StoreModule> => {
  vi.resetModules()
  return import('../electron/main/remote/store')
}
const secretsFile = (): string => readFileSync(join(env.dir, 'remote-secrets.json'), 'utf8')
/** The secrets JSON inside the file (undoing the stand-in encryption above). */
const secretsJson = (): Record<string, unknown> => {
  const file = JSON.parse(secretsFile()) as { encrypted: boolean; data: string }
  return JSON.parse(file.encrypted ? Buffer.from(Buffer.from(file.data, 'base64').toString('utf8').split('').reverse().join(''), 'base64').toString('utf8') : file.data) as Record<string, unknown>
}

beforeEach(() => {
  env.dir = mkdtempSync(join(tmpdir(), 'remote-pw-'))
  env.encryption = true
})
afterEach(() => rmSync(env.dir, { recursive: true, force: true }))

describe('saved connection passwords', () => {
  it('saves, reads back and refreshes a password by device ID', async () => {
    const store = await loadStore()
    expect(store.getSavedPassword('19304289')).toBeNull()
    expect(store.savePassword('19304289', 'first-Secret1')).toBe(true)
    expect(store.getSavedPassword('19304289')).toBe('first-Secret1')
    expect(store.savePassword('19304289', 'second-Secret2')).toBe(true)
    expect(store.getSavedPassword('19304289')).toBe('second-Secret2')
    expect(store.savedPasswordIds()).toEqual(['19304289'])
  })

  it('keeps it encrypted on disk and across restarts', async () => {
    let store = await loadStore()
    store.savePassword('19304289', 'on-disk-Secret1')
    const raw = secretsFile()
    expect(raw).not.toContain('on-disk-Secret1')
    expect((JSON.parse(raw) as { encrypted: boolean }).encrypted).toBe(true)
    store = await loadStore()
    expect(store.getSavedPassword('19304289')).toBe('on-disk-Secret1')
  })

  it('refuses IDs that are not 8 digits and unusable passwords', async () => {
    const store = await loadStore()
    expect(store.savePassword('WD-019-304-289', 'Secret-pass1')).toBe(false)
    expect(store.savePassword('__proto__', 'Secret-pass1')).toBe(false)
    expect(store.savePassword('19304289', '')).toBe(false)
    expect(store.savePassword('19304289', 'x'.repeat(257))).toBe(false)
    expect(store.savedPasswordIds()).toEqual([])
  })

  it('caps the list, dropping the oldest', async () => {
    const store = await loadStore()
    const now = vi.spyOn(Date, 'now')
    for (let i = 0; i < store.MAX_SAVED_PASSWORDS + 5; i++) {
      now.mockReturnValue(1_000 + i)
      store.savePassword(String(10_000_000 + i), `Secret-${i}`)
    }
    const ids = store.savedPasswordIds()
    expect(ids).toHaveLength(store.MAX_SAVED_PASSWORDS)
    expect(ids).not.toContain('10000000')
    expect(ids).not.toContain('10000004')
    expect(ids).toContain('10000005')
    expect(store.getSavedPassword(String(10_000_000 + store.MAX_SAVED_PASSWORDS + 4))).toBe(`Secret-${store.MAX_SAVED_PASSWORDS + 4}`)
  })

  it('forgets one, then all, without touching the device identity', async () => {
    const store = await loadStore()
    store.savePassword('11111111', 'Secret-one1')
    store.savePassword('22222222', 'Secret-two2')
    expect(store.forgetSavedPassword('11111111')).toBe(true)
    expect(store.forgetSavedPassword('11111111')).toBe(false)
    expect(store.savedPasswordIds()).toEqual(['22222222'])
    const identity = secretsJson().identityPublic
    store.forgetAllSavedPasswords()
    expect(store.savedPasswordIds()).toEqual([])
    expect(secretsJson().identityPublic).toBe(identity)
    expect(secretsJson().savedPasswords).toEqual({})
  })

  it('never saves (or writes) a password when OS encryption is unavailable', async () => {
    env.encryption = false
    const store = await loadStore()
    expect(store.savePassword('19304289', 'plain-Secret1')).toBe(false)
    expect(store.getSavedPassword('19304289')).toBeNull()
    expect(store.savedPasswordIds()).toEqual([])
    store.setTurnCredential('turn-cred') // any other secrets write
    expect(secretsFile()).not.toContain('plain-Secret1')
  })

  it('does not write saved passwords in the clear if encryption goes away later', async () => {
    let store = await loadStore()
    store.savePassword('19304289', 'was-encrypted1')
    env.encryption = false
    expect(store.savedPasswordIds()).toEqual([])
    expect(store.getSavedPassword('19304289')).toBeNull()
    store.setTurnCredential('turn-cred')
    expect(secretsFile()).not.toContain('was-encrypted1')
    expect(secretsJson().savedPasswords).toEqual({})
    env.encryption = true
    store = await loadStore()
    expect(store.savedPasswordIds()).toEqual([])
  })
})

describe('saved password helpers', () => {
  it('withSavedPassword puts the newest first and caps', async () => {
    const { withSavedPassword, MAX_SAVED_PASSWORDS } = await loadStore()
    let map = {}
    for (let i = 0; i < MAX_SAVED_PASSWORDS; i++) map = withSavedPassword(map, String(20_000_000 + i), 'p', i)
    const next = withSavedPassword(map, '30000000', 'new', 999)
    expect(Object.keys(next)).toHaveLength(MAX_SAVED_PASSWORDS)
    expect(next['30000000']).toEqual({ password: 'new', savedAt: 999 })
    expect(next).not.toHaveProperty('20000000')
    // Refreshing an existing one does not drop anything else.
    expect(Object.keys(withSavedPassword(next, '30000000', 'again', 1000))).toHaveLength(MAX_SAVED_PASSWORDS)
  })

  it('cleanSavedPasswords drops malformed entries', async () => {
    const { cleanSavedPasswords } = await loadStore()
    expect(cleanSavedPasswords(null)).toEqual({})
    expect(
      cleanSavedPasswords({
        '19304289': { password: 'ok-Secret1', savedAt: 5 },
        'WD-019-304-289': { password: 'x', savedAt: 1 },
        '12345678': { password: '', savedAt: 1 },
        '87654321': { password: 42, savedAt: 1 },
        '11112222': { password: 'p', savedAt: 'yesterday' }
      })
    ).toEqual({ '19304289': { password: 'ok-Secret1', savedAt: 5 } })
  })
})

describe('legacy history IDs', () => {
  it('normalise to the 8-digit ID used for saved passwords', async () => {
    const { parseDeviceId } = await import('../shared/utils/remote')
    expect(parseDeviceId('WD-019-304-289')).toBe('19304289')
    expect(parseDeviceId('19304289')).toBe('19304289')
    expect(parseDeviceId('')).toBeNull()
  })
})

describe('remember passwords setting', () => {
  it('is on by default and sanitised', async () => {
    const { defaultRemoteSettings, sanitiseRemoteSettings } = await import('../shared/utils/remote')
    expect(defaultRemoteSettings().rememberPasswords).toBe(true)
    expect(sanitiseRemoteSettings({ rememberPasswords: false }).rememberPasswords).toBe(false)
    expect(sanitiseRemoteSettings({ rememberPasswords: 'no' }).rememberPasswords).toBe(true)
  })
})
