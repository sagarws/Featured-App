import { DEFAULT_REMOTE_PORT, DEFAULT_SESSION_MINUTES, DEVICE_ID_DIGITS, LEGACY_DEVICE_ID_PREFIX, MIN_PASSWORD_LENGTH, QUALITY_PROFILES, SESSION_MINUTES } from '../constants/remote'
import type {
  CodecPreference,
  HistoryEntry,
  IncomingFilePolicy,
  InputEvent,
  KeyboardMode,
  QualityPreset,
  QualityPriority,
  RemotePermission,
  RemotePlatform,
  RemoteSettings,
  SessionMinutes
} from '../types/remote'

// ── settings ────────────────────────────────────────────────────────────────

export const defaultRemoteSettings = (): RemoteSettings => ({
  // Attended requests are on: every one still needs the person at this computer to accept it.
  enabled: true,
  deviceName: '',
  defaultMinutes: DEFAULT_SESSION_MINUTES,
  unattendedEnabled: false,
  unattendedPermission: 'control',
  controlDisabled: false,
  clipboardSync: true,
  macLockScreen: true,
  incomingFiles: 'ask',
  trustedFolder: '',
  lanDiscovery: true,
  port: DEFAULT_REMOTE_PORT,
  defaultQuality: 'auto',
  priority: 'readability',
  codec: 'auto',
  hardwareAcceleration: true,
  keyboardMode: 'positional',
  mapModifiers: true,
  sendShortcuts: true,
  rememberPasswords: true,
  relay: '',
  turnUrl: '',
  turnUsername: ''
})

// Control characters (C0 + DEL): never kept in names or other text from the network.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

export const stripControl = (value: string): string => value.replace(CONTROL_CHARS, '')

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
const text = (value: unknown, max: number, fallback = ''): string =>
  typeof value === 'string' ? stripControl(value).trim().slice(0, max) : fallback

export const QUALITY_PRESETS: readonly QualityPreset[] = ['ultra-low', 'low', 'balanced', 'high', 'ultra', 'auto']
const PRIORITIES: readonly QualityPriority[] = ['readability', 'responsiveness']
const CODECS: readonly CodecPreference[] = ['auto', 'h264', 'vp9', 'av1']
const KEYBOARD_MODES: readonly KeyboardMode[] = ['positional', 'text']
const FILE_POLICIES: readonly IncomingFilePolicy[] = ['ask', 'trusted-folder', 'off']
const PERMISSIONS: readonly RemotePermission[] = ['control', 'view']
export const MINUTES: readonly SessionMinutes[] = SESSION_MINUTES.map(m => m.value)

export const isSessionMinutes = (value: unknown): value is SessionMinutes => MINUTES.includes(value as SessionMinutes)

/**
 * A relay address, or '' when it is not one:
 *   host:port            plain TCP (a VPS with the port open)
 *   wss://host[/path]    WebSocket (Cloudflare Tunnel, an HTTPS proxy); https:// is taken as wss://
 *   ws://host:port       WebSocket without TLS — for testing on one machine only
 */
export const normaliseRelay = (value: unknown): string => {
  const raw = text(value, 255)
  if (!raw) return ''
  if (/^(wss?|https?):\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      const secure = url.protocol === 'wss:' || url.protocol === 'https:'
      if (!url.hostname || url.username || url.password) return ''
      const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
      return `${secure ? 'wss' : 'ws'}://${url.host}${path}${url.search}`
    } catch {
      return ''
    }
  }
  const match = /^([a-z0-9.-]+|\[[0-9a-f:]+\]):(\d{1,5})$/i.exec(raw)
  if (!match) return ''
  const port = Number(match[2])
  return port > 0 && port < 65536 ? `${match[1]}:${port}` : ''
}

export const normaliseIceUrl = (value: unknown): string => {
  const raw = text(value, 255)
  return /^(stun|turn|turns):[^\s]+$/i.test(raw) ? raw : ''
}

export const sanitiseRemoteSettings = (raw: unknown): RemoteSettings => {
  const base = defaultRemoteSettings()
  if (!raw || typeof raw !== 'object') return base
  const v = raw as Partial<Record<keyof RemoteSettings, unknown>>
  const port = typeof v.port === 'number' && Number.isInteger(v.port) && v.port >= 1024 && v.port <= 65534 ? v.port : base.port
  return {
    enabled: bool(v.enabled, base.enabled),
    deviceName: text(v.deviceName, 64),
    defaultMinutes: isSessionMinutes(v.defaultMinutes) ? v.defaultMinutes : base.defaultMinutes,
    unattendedEnabled: bool(v.unattendedEnabled, base.unattendedEnabled),
    unattendedPermission: pick(v.unattendedPermission, PERMISSIONS, base.unattendedPermission),
    controlDisabled: bool(v.controlDisabled, base.controlDisabled),
    clipboardSync: bool(v.clipboardSync, base.clipboardSync),
    macLockScreen: bool(v.macLockScreen, base.macLockScreen),
    incomingFiles: pick(v.incomingFiles, FILE_POLICIES, base.incomingFiles),
    trustedFolder: text(v.trustedFolder, 1024),
    lanDiscovery: bool(v.lanDiscovery, base.lanDiscovery),
    port,
    defaultQuality: pick(v.defaultQuality, QUALITY_PRESETS, base.defaultQuality),
    priority: pick(v.priority, PRIORITIES, base.priority),
    codec: pick(v.codec, CODECS, base.codec),
    hardwareAcceleration: bool(v.hardwareAcceleration, base.hardwareAcceleration),
    keyboardMode: pick(v.keyboardMode, KEYBOARD_MODES, base.keyboardMode),
    mapModifiers: bool(v.mapModifiers, base.mapModifiers),
    sendShortcuts: bool(v.sendShortcuts, base.sendShortcuts),
    rememberPasswords: bool(v.rememberPasswords, base.rememberPasswords),
    relay: normaliseRelay(v.relay),
    turnUrl: normaliseIceUrl(v.turnUrl),
    turnUsername: text(v.turnUsername, 255)
  }
}

// ── device IDs ──────────────────────────────────────────────────────────────

/** Exactly 8 digits: what a device ID looks like everywhere in the app. */
export const isDeviceId = (value: unknown): value is string => typeof value === 'string' && /^\d{8}$/.test(value)

/** The 8-digit device ID, from its digits (the last 8 when given more). */
export const formatDeviceId = (digits: string): string => digits.slice(-DEVICE_ID_DIGITS).padStart(DEVICE_ID_DIGITS, '0')

/**
 * What someone typed or an older build sent, as an 8-digit ID; null if it is
 * not one. Accepts "19304289" and "1930 4289", and the old 9-digit forms
 * "WD-019-304-289" / "019304289" — the new ID is the old one's last 8 digits.
 */
export const parseDeviceId = (input: string): string | null => {
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, '')
  if (/^\d{8}$/.test(compact)) return compact
  const legacy = compact.startsWith(LEGACY_DEVICE_ID_PREFIX) ? compact.slice(LEGACY_DEVICE_ID_PREFIX.length) : compact
  return /^\d{9}$/.test(legacy) ? formatDeviceId(legacy) : null
}

export type ConnectTarget = { kind: 'id'; id: string } | { kind: 'address'; host: string; port: number }

/** What the user typed in "Remote Device ID": a device ID, or an IP / host name with an optional port. */
export const parseConnectTarget = (input: string, defaultPort = DEFAULT_REMOTE_PORT): ConnectTarget | null => {
  const id = parseDeviceId(input)
  if (id) return { kind: 'id', id }
  const raw = input.trim()
  const v6 = /^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/i.exec(raw)
  if (v6?.[1]) return { kind: 'address', host: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort }
  const m = /^([a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(raw)
  if (!m?.[1]) return null
  const port = m[3] ? Number(m[3]) : defaultPort
  if (port < 1 || port > 65535) return null
  return { kind: 'address', host: m[1], port }
}

// ── passwords ───────────────────────────────────────────────────────────────

/** Why a new unattended password is not acceptable, or null. */
export const passwordProblem = (password: string): string | null => {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (password.length > 256) return 'Use at most 256 characters.'
  if (/^(.)\1*$/.test(password)) return 'Do not repeat one character.'
  if (/^(0123456789|1234567890|password|qwertyuiop)/i.test(password)) return 'That password is too easy to guess.'
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter(r => r.test(password)).length
  if (password.length < 12 && classes < 3) return 'Use 12+ characters, or mix upper case, lower case, digits and symbols.'
  return null
}

// ── sessions ────────────────────────────────────────────────────────────────

export const minutesLabel = (minutes: SessionMinutes): string => SESSION_MINUTES.find(m => m.value === minutes)?.label ?? `${minutes} minutes`

/** 1:05:09 / 4:59 */
export const formatRemaining = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

// ── quality ─────────────────────────────────────────────────────────────────

export interface EncodingPlan {
  scaleResolutionDownBy: number
  maxFramerate: number
  maxBitrate: number
  /** What the encoder receives: always even, so hardware H.264 encoders accept it. */
  width: number
  height: number
}

/**
 * The scale factor that brings `width`×`height` down to about `targetHeight`
 * rows with BOTH sides even. Chromium's hardware H.264 encoders refuse odd
 * sizes (it silently falls back to the slower software encoder), and different
 * parts of Chromium round width / scale differently (the encoder input was seen
 * rounded, the received frame floored). So the target height is lowered 2 px
 * at a time until width / scale lands just above an even number, where floor
 * and round agree.
 */
export const evenScale = (width: number, height: number, targetHeight: number): { scale: number; width: number; height: number } => {
  if (targetHeight >= height) return { scale: 1, width, height }
  for (let h = Math.floor(targetHeight / 2) * 2; h >= 2; h -= 2) {
    // A hair above h so that height / scale floors to exactly h.
    const scale = height / (h + 0.001)
    const exact = width / scale
    const w = Math.floor(exact)
    if (w % 2 === 0 && exact - w < 0.45 && Math.floor(height / scale) === h) return { scale, width: w, height: h }
  }
  return { scale: 1, width, height }
}

/**
 * Encoder settings for a preset on a display of `sourceWidth`×`sourceHeight` pixels.
 * `autoStep` (Auto only) is how far the adaptive loop has stepped down: 0 = full.
 */
export const encodingPlan = (preset: QualityPreset, sourceWidth: number, sourceHeight: number, autoStep = 0): EncodingPlan => {
  const profile = QUALITY_PROFILES[preset]
  let target: number | null = profile.maxHeight
  let fps = profile.fps
  let bitrate = profile.maxBitrate
  if (preset === 'auto') {
    const steps = [
      { height: null, fps: 60, bitrate: profile.maxBitrate },
      { height: 1080, fps: 30, bitrate: 6_000_000 },
      { height: 900, fps: 24, bitrate: 3_000_000 },
      { height: 720, fps: 18, bitrate: 1_500_000 },
      { height: 480, fps: 12, bitrate: 600_000 }
    ]
    const step = steps[Math.min(Math.max(0, autoStep), steps.length - 1)] ?? steps[0]!
    target = step.height
    fps = step.fps
    bitrate = step.bitrate
  }
  const scaled = target === null ? { scale: 1, width: sourceWidth, height: sourceHeight } : evenScale(sourceWidth, sourceHeight, target)
  return { scaleResolutionDownBy: scaled.scale, maxFramerate: fps, maxBitrate: bitrate, width: scaled.width, height: scaled.height }
}

export const AUTO_STEPS = 5

// ── keyboard ────────────────────────────────────────────────────────────────

const MAC_TO_PC: Record<string, string> = {
  MetaLeft: 'ControlLeft',
  MetaRight: 'ControlRight',
  ControlLeft: 'MetaLeft',
  ControlRight: 'MetaRight'
}

/**
 * Swap ⌘ and Ctrl when a Mac controls a PC or a PC controls a Mac, so the
 * shortcuts under the user's fingers keep their meaning (⌘C copies on Windows,
 * Ctrl+C copies on a Mac). The swap is symmetric.
 */
export const mapModifierCode = (code: string, viewer: RemotePlatform, host: RemotePlatform, enabled: boolean): string => {
  if (!enabled) return code
  const viewerMac = viewer === 'darwin'
  const hostMac = host === 'darwin'
  if (viewerMac === hostMac) return code
  return MAC_TO_PC[code] ?? code
}

// ── input validation (host side) ────────────────────────────────────────────

const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
const delta = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10_000

/** Parses one input event from the data channel; anything malformed is dropped. */
export const parseInputEvent = (raw: unknown): InputEvent | null => {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  switch (e['k']) {
    case 'mm':
      return unit(e['x']) && unit(e['y']) ? { k: 'mm', x: e['x'], y: e['y'] } : null
    case 'md':
    case 'mu': {
      const b = e['b']
      return (b === 0 || b === 1 || b === 2) && unit(e['x']) && unit(e['y']) ? { k: e['k'], b, x: e['x'], y: e['y'] } : null
    }
    case 'wh':
      return delta(e['dx']) && delta(e['dy']) ? { k: 'wh', dx: e['dx'], dy: e['dy'] } : null
    case 'kd':
    case 'ku':
      return typeof e['c'] === 'string' && /^[A-Za-z0-9]{1,24}$/.test(e['c']) ? { k: e['k'], c: e['c'] } : null
    case 'tx':
      return typeof e['t'] === 'string' && e['t'].length > 0 && e['t'].length <= 64 ? { k: 'tx', t: e['t'] } : null
    case 'rel':
      return { k: 'rel' }
    default:
      return null
  }
}

// ── files ───────────────────────────────────────────────────────────────────

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/**
 * A file name from the other computer, made safe to create here: no folders
 * (so no ../ traversal), no control or reserved characters, no Windows device
 * names, not empty, not too long. Returns null if nothing usable is left.
 */
export const safeFileName = (name: unknown): string | null => {
  if (typeof name !== 'string') return null
  // Last path component only, whichever separator the sender's OS uses.
  const base = name.split(/[\\/]/).pop() ?? ''
  let clean = stripControl(base)
    .replace(/[<>:"|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!clean || clean === '.' || clean === '..') return null
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`
  if (clean.length > 200) {
    const dot = clean.lastIndexOf('.')
    const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : ''
    clean = clean.slice(0, 200 - ext.length) + ext
  }
  return clean
}

/** name.txt → name (2).txt while `exists` says it is taken. */
export const uniqueName = (name: string, exists: (candidate: string) => boolean): string => {
  if (!exists(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!exists(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}

export const platformLabel = (platform: RemotePlatform): string =>
  platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux'

/** One row of the grouped history: a device's newest entry, and how many entries it stands for. */
export interface HistoryGroup {
  latest: HistoryEntry
  count: number
}

/**
 * History shows each device once per direction (connecting 10 times to the
 * same computer is one row, "10 times"), newest first. Old 9-digit IDs fold
 * into their 8-digit form; entries without an ID group by name. Input is
 * newest first, as stored.
 */
export const groupHistory = (history: HistoryEntry[]): HistoryGroup[] => {
  const groups = new Map<string, HistoryGroup>()
  for (const entry of history) {
    const who = (entry.peerId && parseDeviceId(entry.peerId)) || `name:${entry.peerName || entry.peerId || entry.address}`
    const key = `${entry.direction}|${who}`
    const group = groups.get(key)
    if (group) {
      group.count++
      if (entry.at > group.latest.at) group.latest = entry
    } else groups.set(key, { latest: entry, count: 1 })
  }
  return [...groups.values()].sort((a, b) => b.latest.at - a.latest.at)
}
