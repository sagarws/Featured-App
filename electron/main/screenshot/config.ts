import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { ApiHeader, ScreenshotSettings } from '@shared/types/screenshot'
import { sanitiseScreenshotSettings, SCREENSHOTS_FOLDER_NAME } from '@shared/utils/screenshot'
import { readDurableJson, writeDurableJson } from '../durableJson'
import { logger } from '../logger'
import { getSettings, updateSettings } from '../settings'

/*
 * Screenshot settings. The plain part lives in settings.json with the rest of
 * the app's settings; everything that is a credential — the S3 secret key, the
 * Google client secret and refresh token, the upload API's headers (usually an
 * Authorization token) — lives in screenshot-secrets.json, encrypted with the
 * OS keychain / DPAPI through safeStorage.
 */

interface Secrets {
  s3SecretAccessKey: string
  googleClientSecret: string
  apiHeaders: ApiHeader[]
  googleRefreshToken: string
  /** The Drive folder screenshots go into, and the name it was found / created under. */
  googleFolderId: string
  googleFolderName: string
}

interface SecretsFile {
  encrypted: boolean
  data: string
}

const EMPTY: Secrets = {
  s3SecretAccessKey: '',
  googleClientSecret: '',
  apiHeaders: [],
  googleRefreshToken: '',
  googleFolderId: '',
  googleFolderName: ''
}

let secrets: Secrets | null = null
const listeners = new Set<(settings: ScreenshotSettings) => void>()

const secretsPath = (): string => join(app.getPath('userData'), 'screenshot-secrets.json')

export const encryptionAvailable = (): boolean => {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

const readSecrets = (): Secrets => {
  if (secrets) return secrets
  try {
    const file = readDurableJson<SecretsFile>(secretsPath(), v => typeof v?.data === 'string')
    const json = file.encrypted ? safeStorage.decryptString(Buffer.from(file.data, 'base64')) : file.data
    const raw = JSON.parse(json) as Partial<Secrets>
    secrets = {
      s3SecretAccessKey: typeof raw.s3SecretAccessKey === 'string' ? raw.s3SecretAccessKey : '',
      googleClientSecret: typeof raw.googleClientSecret === 'string' ? raw.googleClientSecret : '',
      apiHeaders: Array.isArray(raw.apiHeaders) ? raw.apiHeaders : [],
      googleRefreshToken: typeof raw.googleRefreshToken === 'string' ? raw.googleRefreshToken : '',
      googleFolderId: typeof raw.googleFolderId === 'string' ? raw.googleFolderId : '',
      googleFolderName: typeof raw.googleFolderName === 'string' ? raw.googleFolderName : ''
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('[screenshot] saved keys unreadable, starting empty', error)
    secrets = { ...EMPTY }
  }
  return secrets
}

const writeSecrets = (next: Secrets): void => {
  const json = JSON.stringify(next)
  const encrypted = encryptionAvailable()
  const file: SecretsFile = encrypted ? { encrypted, data: safeStorage.encryptString(json).toString('base64') } : { encrypted, data: json }
  const path = secretsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeDurableJson(path, file)
  secrets = next
}

/** The whole settings, credentials included — for the app's own windows and the uploaders. */
export const getScreenshotSettings = (): ScreenshotSettings => {
  const plain = getSettings().screenshot
  const s = readSecrets()
  return {
    ...plain,
    upload: {
      ...plain.upload,
      s3: { ...plain.upload.s3, secretAccessKey: s.s3SecretAccessKey },
      google: { ...plain.upload.google, clientSecret: s.googleClientSecret },
      api: { ...plain.upload.api, headers: s.apiHeaders }
    }
  }
}

const store = (next: ScreenshotSettings, secretPatch: Partial<Secrets> = {}): ScreenshotSettings => {
  const current = readSecrets()
  const nextSecrets: Secrets = {
    ...current,
    s3SecretAccessKey: next.upload.s3.secretAccessKey,
    googleClientSecret: next.upload.google.clientSecret,
    apiHeaders: next.upload.api.headers,
    ...secretPatch
  }
  if (JSON.stringify(nextSecrets) !== JSON.stringify(current)) writeSecrets(nextSecrets)
  updateSettings({
    screenshot: {
      ...next,
      upload: {
        ...next.upload,
        s3: { ...next.upload.s3, secretAccessKey: '' },
        google: { ...next.upload.google, clientSecret: '' },
        api: { ...next.upload.api, headers: [] }
      }
    }
  })
  const result = getScreenshotSettings()
  listeners.forEach(listener => listener(result))
  return result
}

/**
 * Apply a change from the page. The connected Google account and the folder
 * are the main process's to set, so the page cannot overwrite them; a new
 * client ID signs the account out (its token belongs to the old client).
 */
export const updateScreenshotSettings = (patch: Partial<ScreenshotSettings>): ScreenshotSettings => {
  const current = getScreenshotSettings()
  const merged = sanitiseScreenshotSettings({ ...current, ...patch, folder: current.folder })
  const clientChanged = merged.upload.google.clientId !== current.upload.google.clientId
  merged.upload.google.account = clientChanged ? null : current.upload.google.account
  return store(merged, clientChanged ? { googleRefreshToken: '', googleFolderId: '', googleFolderName: '' } : {})
}

export const setScreenshotFolder = (folder: string | null): ScreenshotSettings =>
  store({ ...getScreenshotSettings(), folder })

export const screenshotsFolder = (): string => getSettings().screenshot.folder ?? join(app.getPath('pictures'), SCREENSHOTS_FOLDER_NAME)

export const onScreenshotSettingsChanged = (listener: (settings: ScreenshotSettings) => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ── Google tokens (never sent to a window) ──────────────────────────────────

export const googleSecrets = (): Pick<Secrets, 'googleRefreshToken' | 'googleFolderId' | 'googleFolderName'> => {
  const s = readSecrets()
  return { googleRefreshToken: s.googleRefreshToken, googleFolderId: s.googleFolderId, googleFolderName: s.googleFolderName }
}

export const setGoogleConnection = (account: { email: string; name: string } | null, refreshToken: string): ScreenshotSettings => {
  const current = getScreenshotSettings()
  return store(
    { ...current, upload: { ...current.upload, google: { ...current.upload.google, account } } },
    { googleRefreshToken: refreshToken, googleFolderId: '', googleFolderName: '' }
  )
}

export const setGoogleFolder = (folderId: string, folderName: string): void => {
  writeSecrets({ ...readSecrets(), googleFolderId: folderId, googleFolderName: folderName })
}
