import type { QualityPreset, SessionMinutes } from '../types/remote'

/**
 * A device ID is 8 digits and nothing else: 19304289.
 * Builds up to 0.1.5 showed 9 digits with a prefix (WD-019-304-289); the
 * 8-digit ID is the last 8 of those, so an old ID is still understood.
 */
export const DEVICE_ID_DIGITS = 8
/** Prefix of the old 9-digit IDs (WD-123-456-789), accepted when typed or received from an old build. */
export const LEGACY_DEVICE_ID_PREFIX = 'WD'

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

/**
 * The Featured App remote server: how two computers on DIFFERENT networks
 * reach each other (another office, another Wi-Fi, home ↔ office).
 *
 *   relay  connects the two apps and carries the encrypted control channel
 *          (tools/remote-relay/relay.ts). Either
 *            'wss://relay.example.com'  WebSocket — works behind Cloudflare Tunnel
 *            'relay.example.com:47900'  plain TCP — a VPS with the port open
 *   stun   lets the video find a direct path between the two networks.
 *   turn   carries the video when there is no direct path (coturn on a VPS).
 *
 * Neither can read a session: it is end-to-end encrypted by the apps. On the
 * same network the app connects directly and never uses any of it.
 * Remote Desktop → Settings → Network overrides relay / TURN on one computer,
 * without a rebuild.
 */
export interface RemoteServer {
  /** '' = same-network only. */
  relay: string
  stun: readonly string[]
  turn: { urls: readonly string[]; username: string; credential: string } | null
}

export const REMOTE_SERVER: Readonly<RemoteServer> = {
  /*
   * TESTING: a Cloudflare quick tunnel to the relay on the developer's Mac
   * (`node tools/remote-relay/relay.ts 47900` + `cloudflared tunnel --url http://localhost:47900`).
   * Works only while that Mac is on with both running, and the name changes
   * every time the tunnel restarts. Replace with the real server before release.
   */
  relay: 'wss://adjustable-myth-sounds-night.trycloudflare.com',
  // Cloudflare's free public STUN.
  stun: ['stun:stun.cloudflare.com:3478'],
  // With a VPS: { urls: ['turn:IP:3478?transport=udp', 'turn:IP:3478?transport=tcp'], username: 'featured', credential: '…' }
  turn: null
}

/** How long to try a computer's last known LAN address before moving on (to the relay). */
export const DIRECT_DIAL_TIMEOUT_MS = 2500
