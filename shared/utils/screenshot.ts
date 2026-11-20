import type {
  AfterAreaShow,
  ApiConfig,
  ApiHeader,
  ConfirmationStyle,
  GoogleDriveConfig,
  S3Config,
  SaveFormat,
  ScreenshotAction,
  ScreenshotHotkeys,
  ScreenshotSettings,
  ThumbnailTimeout,
  UploadProvider,
  UploadSettings,
  WindowBackground
} from '../types/screenshot'

/*
 * Pure helpers for screenshots: no Electron, no fs, no DOM. Covered by
 * tests/screenshot.test.ts.
 */

export const SCREENSHOT_ACTIONS: readonly ScreenshotAction[] = ['fullscreen', 'area', 'repeatArea', 'window', 'activeWindow', 'showApp']

export const ACTION_LABEL: Record<ScreenshotAction, string> = {
  fullscreen: 'Fullscreen screenshot',
  area: 'Area screenshot',
  repeatArea: 'Repeat area screenshot',
  window: 'Any window screenshot',
  activeWindow: 'Active window screenshot',
  showApp: 'Show Featured App'
}

export const DEFAULT_HOTKEYS: ScreenshotHotkeys = {
  fullscreen: 'CommandOrControl+Shift+1',
  area: 'CommandOrControl+Shift+2',
  repeatArea: '',
  window: '',
  activeWindow: '',
  showApp: ''
}

export const SCREENSHOTS_FOLDER_NAME = 'Featured App Screenshots'

const WINDOW_BACKGROUNDS: readonly WindowBackground[] = ['backdrop', 'transparent', 'solid', 'trim']
const SAVE_FORMATS: readonly SaveFormat[] = ['png', 'jpeg', 'auto']
const AFTER_AREA: readonly AfterAreaShow[] = ['thumbnail', 'editor']
const TIMEOUTS: readonly ThumbnailTimeout[] = [0, 5, 10, 30]
const CONFIRMATIONS: readonly ConfirmationStyle[] = ['notification', 'none']
const PROVIDERS: readonly UploadProvider[] = ['none', 's3', 'google-drive', 'api']

const pick = <T>(list: readonly T[], value: unknown, fallback: T): T => (list.includes(value as T) ? (value as T) : fallback)
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
const text = (value: unknown, fallback = '', max = 2048): string => (typeof value === 'string' ? value.trim().slice(0, max) : fallback)
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {})

export const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)

export const DEFAULT_S3: S3Config = {
  accessKeyId: '',
  secretAccessKey: '',
  bucket: '',
  service: 'aws',
  region: 'us-east-1',
  endpoint: '',
  keyPrefix: '',
  linkSharing: 'public',
  publicBaseUrl: '',
  presignHours: 168
}

export const DEFAULT_GOOGLE: GoogleDriveConfig = {
  clientId: '',
  clientSecret: '',
  folderName: 'Featured App Screenshots',
  makePublic: true,
  account: null
}

export const DEFAULT_API: ApiConfig = {
  url: '',
  method: 'POST',
  bodyType: 'multipart',
  fileField: 'file',
  headers: [],
  urlPath: 'url'
}

const sanitiseS3 = (raw: unknown): S3Config => {
  const v = obj(raw)
  const hours = typeof v['presignHours'] === 'number' && Number.isFinite(v['presignHours']) ? Math.round(v['presignHours']) : DEFAULT_S3.presignHours
  return {
    accessKeyId: text(v['accessKeyId'], '', 256),
    secretAccessKey: text(v['secretAccessKey'], '', 256),
    bucket: text(v['bucket'], '', 255),
    service: v['service'] === 'other' ? 'other' : 'aws',
    region: text(v['region'], DEFAULT_S3.region, 64) || DEFAULT_S3.region,
    endpoint: text(v['endpoint'], '', 512).replace(/\/+$/, ''),
    keyPrefix: text(v['keyPrefix'], '', 512).replace(/^\/+/, ''),
    linkSharing: pick(['public', 'presigned', 'none'] as const, v['linkSharing'], DEFAULT_S3.linkSharing),
    publicBaseUrl: text(v['publicBaseUrl'], '', 512).replace(/\/+$/, ''),
    presignHours: Math.min(168, Math.max(1, hours))
  }
}

const sanitiseAccount = (raw: unknown): GoogleDriveConfig['account'] => {
  const v = obj(raw)
  return typeof v['email'] === 'string' && v['email'] ? { email: text(v['email'], '', 320), name: text(v['name'], '', 256) } : null
}

const sanitiseGoogle = (raw: unknown): GoogleDriveConfig => {
  const v = obj(raw)
  return {
    clientId: text(v['clientId'], '', 512),
    clientSecret: text(v['clientSecret'], '', 512),
    folderName: text(v['folderName'], DEFAULT_GOOGLE.folderName, 200) || DEFAULT_GOOGLE.folderName,
    makePublic: bool(v['makePublic'], DEFAULT_GOOGLE.makePublic),
    account: sanitiseAccount(v['account'])
  }
}

const sanitiseHeaders = (raw: unknown): ApiHeader[] =>
  Array.isArray(raw)
    ? raw
        .map(h => obj(h))
        // Header names: RFC 7230 token characters only.
        .map(h => ({ name: text(h['name'], '', 128), value: typeof h['value'] === 'string' ? h['value'].replace(/[\r\n]/g, '').slice(0, 4096) : '' }))
        .filter(h => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.name))
        .slice(0, 20)
    : []

const sanitiseApi = (raw: unknown): ApiConfig => {
  const v = obj(raw)
  return {
    url: text(v['url'], '', 2048),
    method: v['method'] === 'PUT' ? 'PUT' : 'POST',
    bodyType: v['bodyType'] === 'json' ? 'json' : 'multipart',
    fileField: text(v['fileField'], DEFAULT_API.fileField, 64) || DEFAULT_API.fileField,
    headers: sanitiseHeaders(v['headers']),
    urlPath: text(v['urlPath'], DEFAULT_API.urlPath, 256)
  }
}

const sanitiseUpload = (raw: unknown): UploadSettings => {
  const v = obj(raw)
  return {
    provider: pick(PROVIDERS, v['provider'], 'none'),
    copyLink: bool(v['copyLink'], true),
    s3: sanitiseS3(v['s3']),
    google: sanitiseGoogle(v['google']),
    api: sanitiseApi(v['api'])
  }
}

const sanitiseHotkeys = (raw: unknown): ScreenshotHotkeys => {
  const v = obj(raw)
  const out = { ...DEFAULT_HOTKEYS }
  for (const action of SCREENSHOT_ACTIONS) {
    const value = v[action]
    if (value === '') out[action] = ''
    else if (typeof value === 'string' && isAccelerator(value)) out[action] = value
  }
  return out
}

export const screenshotDefaults = (): ScreenshotSettings => sanitiseScreenshotSettings(null)

/** Settings as saved, with anything missing or invalid replaced by its default. */
export const sanitiseScreenshotSettings = (raw: unknown): ScreenshotSettings => {
  const v = obj(raw)
  return {
    folder: typeof v['folder'] === 'string' && v['folder'].trim() ? v['folder'] : null,
    saveFormat: pick(SAVE_FORMATS, v['saveFormat'], 'png'),
    downscaleRetina: bool(v['downscaleRetina'], false),
    windowBackground: pick(WINDOW_BACKGROUNDS, v['windowBackground'], 'transparent'),
    backgroundColor: isHexColor(v['backgroundColor']) ? v['backgroundColor'] : '#4353FF',
    afterShow: bool(v['afterShow'], true),
    afterCopy: bool(v['afterCopy'], true),
    afterSave: bool(v['afterSave'], false),
    afterUpload: bool(v['afterUpload'], false),
    afterAreaShow: pick(AFTER_AREA, v['afterAreaShow'], 'editor'),
    thumbnailTimeout: pick(TIMEOUTS, v['thumbnailTimeout'], 5),
    hotkeys: sanitiseHotkeys(v['hotkeys']),
    hideTrayIcon: bool(v['hideTrayIcon'], false),
    editorAlwaysOnTop: bool(v['editorAlwaysOnTop'], false),
    preferActualSize: bool(v['preferActualSize'], true),
    escCopy: bool(v['escCopy'], true),
    escSave: bool(v['escSave'], false),
    confirmation: pick(CONFIRMATIONS, v['confirmation'], 'notification'),
    upload: sanitiseUpload(v['upload'])
  }
}

// ── shortcuts ───────────────────────────────────────────────────────────────

const MODIFIERS = ['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta']
const NAMED_KEYS = [
  'Plus', 'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'PrintScreen'
]
const PUNCTUATION = [')', '!', '@', '#', '$', '%', '^', '&', '*', '(', ':', ';', '+', '=', '<', ',', '_', '-', '>', '.', '?', '/', '~', '`', '{', ']', '[', '|', '\\', '}', '"', "'"]

const isKeyName = (key: string): boolean =>
  /^[A-Z0-9]$/.test(key) || /^F([1-9]|1\d|2[0-4])$/.test(key) || NAMED_KEYS.includes(key) || PUNCTUATION.includes(key) || /^num[0-9]$/.test(key)

/** True for an Electron accelerator with one key and, unless it is a function key, a modifier. */
export const isAccelerator = (value: string): boolean => {
  if (!value || value.length > 64) return false
  const parts = value.split('+')
  // "Shift+Plus" is how a plus key is written; a literal "+" key cannot be split.
  const key = parts.pop() ?? ''
  if (!isKeyName(key)) return false
  if (parts.some(part => !MODIFIERS.includes(part))) return false
  if (new Set(parts).size !== parts.length) return false
  const standalone = /^F\d+$/.test(key) || key === 'PrintScreen'
  return standalone || parts.length > 0
}

/** The bits of a keydown the shortcut recorder looks at. */
export interface KeyPress {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const CODE_KEYS: Record<string, string> = {
  Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Enter: 'Return', NumpadEnter: 'Return',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', PrintScreen: 'PrintScreen',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backquote: '`'
}

/**
 * The Electron accelerator for a keydown, from the physical key (`code`), so
 * ⌥ or ⇧ changing the character does not change the shortcut. null while only
 * modifiers are held, or for a key Electron cannot register.
 */
export const acceleratorFromKeys = (press: KeyPress, mac: boolean): string | null => {
  let key: string | null
  const { code } = press
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^Numpad[0-9]$/.test(code)) key = `num${code.slice(6)}`
  else if (/^F([1-9]|1\d|2[0-4])$/.test(code)) key = code
  else key = CODE_KEYS[code] ?? null
  if (!key) return null
  const mods: string[] = []
  if (press.ctrlKey) mods.push('Control')
  if (press.altKey) mods.push('Alt')
  if (press.shiftKey) mods.push('Shift')
  if (press.metaKey) mods.push(mac ? 'Command' : 'Super')
  const accelerator = [...mods, key].join('+')
  return isAccelerator(accelerator) ? accelerator : null
}

const MAC_SYMBOL: Record<string, string> = {
  Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Super: '⌘', Meta: '⌘'
}
const PC_NAME: Record<string, string> = {
  Control: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Option: 'Alt', Shift: 'Shift', Command: 'Win', Cmd: 'Win', CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Super: 'Win', Meta: 'Win'
}
const KEY_LABEL: Record<string, string> = { Return: '↩', Enter: '↩', Up: '↑', Down: '↓', Left: '←', Right: '→', Space: 'Space', Escape: 'Esc', Backspace: '⌫', Delete: '⌦' }

/** "⇧⌘2" on a Mac, "Ctrl+Shift+2" elsewhere. Modifiers in the platform's usual order. */
export const formatAccelerator = (accelerator: string, mac: boolean): string => {
  if (!accelerator) return ''
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  const order = mac ? ['⌃', '⌥', '⇧', '⌘'] : ['Ctrl', 'Win', 'Alt', 'Shift']
  const mods = parts.map(p => (mac ? MAC_SYMBOL[p] : PC_NAME[p]) ?? p).sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const label = KEY_LABEL[key] ?? (key.startsWith('num') ? `Num${key.slice(3)}` : key)
  return mac ? `${mods.join('')}${label}` : [...mods, label].join('+')
}

// ── files ───────────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0')

/** "Screenshot 2026-11-20 at 12.14.33.png" — the macOS naming, sortable by date. */
export const screenshotFileName = (date: Date, ext: 'png' | 'jpg'): string =>
  `Screenshot ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} at ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}.${ext}`

/** "name.png", "name 2.png", "name 3.png" … — the first one `exists` says is free. */
export const uniqueFileName = (name: string, exists: (candidate: string) => boolean): string => {
  if (!exists(name)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base} ${n}${ext}`
    if (!exists(candidate)) return candidate
  }
  return `${base} ${Date.now()}${ext}`
}

export const isImageFile = (name: string): boolean => /\.(png|jpe?g)$/i.test(name)

/**
 * "auto": JPEG when it is much smaller than the PNG (a photo, a video frame),
 * PNG otherwise (text and UI stay crisp). Small pictures are always PNG.
 */
export const chooseFormat = (format: SaveFormat, pngBytes: number, jpegBytes: number | null): 'png' | 'jpeg' => {
  if (format !== 'auto') return format
  if (jpegBytes === null || pngBytes < 512 * 1024) return 'png'
  return jpegBytes < pngBytes * 0.4 ? 'jpeg' : 'png'
}

// ── uploads ─────────────────────────────────────────────────────────────────

/** A value from parsed JSON by dot path: "url", "data.link", "files.0.url". */
export const valueAtPath = (data: unknown, path: string): unknown => {
  if (!path.trim()) return data
  let current: unknown = data
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)]
    else if (typeof current === 'object') current = (current as Record<string, unknown>)[part]
    else return undefined
  }
  return current
}

export const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** The object key in the bucket: prefix (with one slash) + file name. */
export const s3ObjectKey = (prefix: string, fileName: string): string => {
  const clean = prefix.replace(/^\/+/, '').replace(/\/+$/, '')
  return clean ? `${clean}/${fileName}` : fileName
}

/** Each path segment percent-encoded (RFC 3986), slashes kept — as S3 and SigV4 want it. */
export const encodeKey = (key: string): string =>
  key
    .split('/')
    .map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')

/** What is missing before an upload can be tried, or null when ready. */
export const uploadProblem = (upload: UploadSettings): string | null => {
  switch (upload.provider) {
    case 'none':
      return 'Choose where to upload in Screenshots → Uploading.'
    case 's3': {
      const s = upload.s3
      if (!s.accessKeyId || !s.secretAccessKey || !s.bucket) return 'Enter the S3 access key, secret key and bucket.'
      if (s.service === 'other' && !isHttpUrl(s.endpoint)) return 'Enter the endpoint URL of your S3-compatible service.'
      if (s.linkSharing === 'public' && s.publicBaseUrl && !isHttpUrl(s.publicBaseUrl)) return 'The public bucket URL must start with https://.'
      return null
    }
    case 'google-drive':
      if (!upload.google.clientId || !upload.google.clientSecret) return 'Enter the Google OAuth client ID and secret.'
      if (!upload.google.account) return 'Connect your Google account in Screenshots → Uploading.'
      return null
    case 'api':
      if (!isHttpUrl(upload.api.url)) return 'Enter the URL of your upload API (https://…).'
      return null
  }
}
