import type { QualityPreset, SessionMinutes } from '../types/remote'

/** Prefix of every device ID: WD-123-456-789. */
export const DEVICE_ID_PREFIX = 'WD'

/** TCP port for sessions; discovery uses the next one over UDP. */
export const DEFAULT_REMOTE_PORT = 47800

/** Protocol version spoken on the wire; a peer with another major version is refused. */
export const REMOTE_PROTOCOL_VERSION = 1

export const SESSION_MINUTES: readonly { value: SessionMinutes; label: string }[] = [
  { value: 5, label: '5 minutes' },
  { value: 10, label: '10 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 240, label: '4 hours' },
  { value: 0, label: 'Unlimited' }
]

export const DEFAULT_SESSION_MINUTES: SessionMinutes = 30

/** Warn both sides this long before a time-limited session ends. */
export const EXPIRY_WARNING_MS = 5 * 60_000

/** How long a host keeps a session whose connection dropped, waiting for the viewer to come back. */
export const RESUME_WINDOW_MS = 30_000

/** Both sides ping this often while a session is up… */
export const KEEPALIVE_MS = 2000

/** …and treat this much silence as a lost link (the controller closed, crashed, slept or lost the network). */
export const LINK_TIMEOUT_MS = 8000

/** How long the person at the host has to answer a request. */
export const REQUEST_TIMEOUT_MS = 60_000

export interface QualityProfile {
  label: string
  /** Target height in pixels; null = the display's own size. */
  maxHeight: number | null
  fps: number
  /** Encoder ceiling, bits per second. */
  maxBitrate: number
  hint: string
}

/**
 * Targets, not promises: the encoder still adapts to the network (WebRTC
 * congestion control) and to the CPU underneath these ceilings.
 */
export const QUALITY_PROFILES: Record<QualityPreset, QualityProfile> = {
  'ultra-low': { label: 'Ultra Low', maxHeight: 480, fps: 12, maxBitrate: 500_000, hint: '480p · 10–15 fps' },
  low: { label: 'Low', maxHeight: 720, fps: 18, maxBitrate: 1_500_000, hint: '720p · 15–20 fps' },
  balanced: { label: 'Balanced', maxHeight: 900, fps: 30, maxBitrate: 3_500_000, hint: '900p · 20–30 fps' },
  high: { label: 'High', maxHeight: 1080, fps: 60, maxBitrate: 8_000_000, hint: '1080p · 30–60 fps' },
  ultra: { label: 'Ultra', maxHeight: null, fps: 60, maxBitrate: 25_000_000, hint: 'Native / 1440p / 4K · up to 60 fps' },
  auto: { label: 'Auto', maxHeight: null, fps: 60, maxBitrate: 15_000_000, hint: 'Adapts to the network' }
}

export const QUALITY_ORDER: readonly QualityPreset[] = ['auto', 'ultra-low', 'low', 'balanced', 'high', 'ultra']

/** Largest file-transfer chunk on the wire. */
export const FILE_CHUNK_BYTES = 256 * 1024

/** Clipboard text larger than this is not synced. */
export const MAX_CLIPBOARD_CHARS = 1_000_000

export const MIN_PASSWORD_LENGTH = 8
