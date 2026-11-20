import { join } from 'node:path'
import { app } from 'electron'
import type { ApiHeader, ScreenshotSettings } from '@shared/types/screenshot'
import { sanitiseScreenshotSettings, SCREENSHOTS_FOLDER_NAME } from '@shared/utils/screenshot'
import { getStored } from '../google/auth'
import { readSecure, writeSecure } from '../secureStore'
import { getSettings, updateSettings } from '../settings'

export { encryptionAvailable } from '../secureStore'

/*
 * Screenshot settings. The plain part lives in settings.json with the rest of
 * the app's settings; the credentials — the S3 secret key and the upload
 * API's headers (usually an Authorization token) — live encrypted in
 * screenshot-secrets.json. The Google account is the app-wide one
 * (../google/auth.ts), mirrored in here for the page.
 */

interface Secrets {
  s3SecretAccessKey: string
  apiHeaders: ApiHeader[]
}

const SECRETS_FILE = 'screenshot-secrets.json'
let secrets: Secrets | null = null
const listeners = new Set<(settings: ScreenshotSettings) => void>()

const readSecrets = (): Secrets => {
  if (secrets) return secrets
  const raw = readSecure<Partial<Secrets>>(SECRETS_FILE) ?? {}
  secrets = {
    s3SecretAccessKey: typeof raw.s3SecretAccessKey === 'string' ? raw.s3SecretAccessKey : '',
    apiHeaders: Array.isArray(raw.apiHeaders) ? raw.apiHeaders : []
  }
  return secrets
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
      google: { ...plain.upload.google, account: getStored().account },
      api: { ...plain.upload.api, headers: s.apiHeaders }
    }
  }
}

const store = (next: ScreenshotSettings): ScreenshotSettings => {
  const nextSecrets: Secrets = { s3SecretAccessKey: next.upload.s3.secretAccessKey, apiHeaders: next.upload.api.headers }
  if (JSON.stringify(nextSecrets) !== JSON.stringify(readSecrets())) {
    writeSecure(SECRETS_FILE, nextSecrets)
    secrets = nextSecrets
  }
  updateSettings({
    screenshot: {
      ...next,
      upload: {
        ...next.upload,
        s3: { ...next.upload.s3, secretAccessKey: '' },
        google: { ...next.upload.google, account: null },
        api: { ...next.upload.api, headers: [] }
      }
    }
  })
  return notifyScreenshotSettings()
}

/** Tell listeners (hotkeys, tray, the page) the settings — or the Google account in them — changed. */
export const notifyScreenshotSettings = (): ScreenshotSettings => {
  const result = getScreenshotSettings()
  listeners.forEach(listener => listener(result))
  return result
}

/** Apply a change from the page. The folder is set through its own dialog. */
export const updateScreenshotSettings = (patch: Partial<ScreenshotSettings>): ScreenshotSettings => {
  const current = getScreenshotSettings()
  return store(sanitiseScreenshotSettings({ ...current, ...patch, folder: current.folder }))
}

export const setScreenshotFolder = (folder: string | null): ScreenshotSettings => store({ ...getScreenshotSettings(), folder })

export const screenshotsFolder = (): string => getSettings().screenshot.folder ?? join(app.getPath('pictures'), SCREENSHOTS_FOLDER_NAME)

export const onScreenshotSettingsChanged = (listener: (settings: ScreenshotSettings) => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
