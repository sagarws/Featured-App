/**
 * Remote Desktop: view and control another office computer running this app.
 * See docs/REMOTE_DESKTOP.md for the architecture and the security model.
 */

export type RemotePlatform = 'darwin' | 'win32' | 'linux'

/** What a session may do on the host. Enforced by the host's main process. */
export type RemotePermission = 'control' | 'view'

/** Session length in minutes; 0 = unlimited (no time limit, still ends on disconnect / revoke). */
export type SessionMinutes = 5 | 10 | 15 | 30 | 60 | 120 | 240 | 0

export type QualityPreset = 'ultra-low' | 'low' | 'balanced' | 'high' | 'ultra' | 'auto'

/** readability: keep text sharp, drop frames first. responsiveness: keep frame rate, drop resolution first. */
export type QualityPriority = 'readability' | 'responsiveness'

export type CodecPreference = 'auto' | 'h264' | 'vp9' | 'av1'

/** positional: physical keys (best for shortcuts, host layout decides the character). text: printable characters typed as text. */
export type KeyboardMode = 'positional' | 'text'

/** What happens to files someone sends to this computer. */
export type IncomingFilePolicy = 'ask' | 'trusted-folder' | 'off'

export interface RemoteSettings {
  /** Listen for incoming connections at all. Off = nobody can connect to this computer. */
  enabled: boolean
  /** Friendly name shown to others; '' = the computer name. */
  deviceName: string
  /** Pre-selected length when accepting an attended request, and the length of unattended sessions. */
  defaultMinutes: SessionMinutes
  /** Connect with the permanent password without anyone accepting. Off by default. */
  unattendedEnabled: boolean
  /** What an unattended (password) session may do. */
  unattendedPermission: RemotePermission
  /** Owner kill switch: every session is view-only while this is on. */
  controlDisabled: boolean
  /** Clipboard text may move between this computer and the other one. */
  clipboardSync: boolean
  incomingFiles: IncomingFilePolicy
  /** For 'trusted-folder'; '' = Downloads/Remote Transfers. */
  trustedFolder: string
  /** Announce this computer on the office network and list the others. */
  lanDiscovery: boolean
  /** TCP port for incoming sessions (UDP port + 1 is used for discovery). */
  port: number

  // ── as the viewer ──
  defaultQuality: QualityPreset
  priority: QualityPriority
  codec: CodecPreference
  /** Prefer the hardware (H.264) encoder / decoder where the OS has one. */
  hardwareAcceleration: boolean
  keyboardMode: KeyboardMode
  /** ⌘ on a Mac ↔ Ctrl on Windows/Linux, so ⌘C copies on a Windows host. */
  mapModifiers: boolean
  /** Send shortcuts such as ⌘W, ⌘Q, Ctrl+W to the remote computer instead of this app. */
  sendShortcuts: boolean

  // ── outside the office network (optional, self-hosted) ──
  /** host:port of a self-hosted relay (tools/remote-relay), '' = LAN only. */
  relay: string
  /** stun:/turn:/turns: URL of a self-hosted STUN/TURN server (coturn), '' = none. */
  turnUrl: string
  turnUsername: string
}

export interface DeviceIdentityInfo {
  /** WD-123-456-789, derived from the device's public key. */
  id: string
  /** Friendly name (or the computer name). */
  name: string
  hostname: string
  /** "macOS 15.1", "Windows 11", "Ubuntu…" */
  os: string
  platform: RemotePlatform
  /** First 16 bytes of SHA-256 over the public key, hex in groups — compared on first connect. */
  fingerprint: string
  /** LAN IPv4 addresses. */
  addresses: string[]
}

export interface ServerStatus {
  /** Listening for incoming sessions. */
  listening: boolean
  port: number
  error: string | null
  /** Registered with the relay (if one is set). */
  relay: 'off' | 'connecting' | 'online' | 'error'
  relayError: string | null
}

export interface DiscoveredDevice {
  id: string
  name: string
  os: string
  platform: RemotePlatform
  address: string
  port: number
  fingerprint: string
  lastSeen: number
}

export interface SavedDevice {
  id: string
  /** Your label for it. */
  name: string
  os: string
  /** Last address it answered on (LAN). */
  address: string
  port: number
  /** Pinned on first connect; a different key later is refused. */
  fingerprint: string
  favorite: boolean
  lastConnectedAt: number | null
}

export interface AuthorizedDevice {
  id: string
  name: string
  fingerprint: string
  firstSeen: number
  lastSeen: number
}

export type HistoryEvent =
  | 'request'
  | 'accepted'
  | 'rejected'
  | 'auth-failed'
  | 'rate-limited'
  | 'connected'
  | 'ended'
  | 'expired'
  | 'revoked'
  | 'reconnected'
  | 'permission'
  | 'extended'
  | 'file-received'
  | 'file-sent'
  | 'blocked'
  | 'failed'

export interface HistoryEntry {
  at: number
  direction: 'incoming' | 'outgoing'
  event: HistoryEvent
  peerId: string
  peerName: string
  address: string
  detail: string
}

export type SessionState = 'connecting' | 'waiting' | 'active' | 'reconnecting' | 'ended'

export interface RemoteSessionInfo {
  sessionId: string
  direction: 'incoming' | 'outgoing'
  peerId: string
  peerName: string
  peerOs: string
  peerPlatform: RemotePlatform
  address: string
  permission: RemotePermission
  /** Password (unattended) or accepted by the person at the host. */
  method: 'password' | 'attended'
  state: SessionState
  startedAt: number
  /** Epoch ms in this computer's clock; null = unlimited. */
  expiresAt: number | null
  viaRelay: boolean
  /** Host side: input could not be injected (missing OS permission, Wayland…). */
  inputProblem: string | null
  clipboard: boolean
  fileTransfer: boolean
  endReason?: string
}

export interface IncomingRequest {
  requestId: string
  peerId: string
  peerName: string
  peerOs: string
  address: string
  /** 6-digit code derived from the encryption keys; the same on both screens when nobody is in between. */
  verificationCode: string
  /** First time this device has asked. */
  firstTime: boolean
  receivedAt: number
  expiresAt: number
}

export interface RemoteDisplay {
  id: string
  label: string
  primary: boolean
  width: number
  height: number
  scaleFactor: number
}

export interface FileTransferInfo {
  transferId: string
  sessionId: string
  direction: 'send' | 'receive'
  peerName: string
  files: { name: string; size: number }[]
  totalBytes: number
  doneBytes: number
  /** Bytes / second over the last few seconds. */
  speed: number
  state: 'offered' | 'waiting' | 'transferring' | 'done' | 'failed' | 'cancelled' | 'declined'
  error: string | null
  /** Receive side: where the files were saved. */
  folder: string | null
  startedAt: number
}

export interface PermissionStatus {
  /** macOS Screen Recording (host needs it to share the screen). */
  screen: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  /** Keyboard / mouse injection: macOS Accessibility, Linux X11, Windows always. */
  input: 'granted' | 'denied' | 'unsupported' | 'unknown'
  inputDetail: string | null
}

export interface RemoteStatus {
  identity: DeviceIdentityInfo
  settings: RemoteSettings
  server: ServerStatus
  unattendedPasswordSet: boolean
  discovered: DiscoveredDevice[]
  saved: SavedDevice[]
  sessions: RemoteSessionInfo[]
  requests: IncomingRequest[]
  authorized: AuthorizedDevice[]
  blocked: AuthorizedDevice[]
  transfers: FileTransferInfo[]
  permissions: PermissionStatus
  encryption: boolean
}

export interface ConnectRequest {
  /** Device ID (WD-123-456-789 / 123456789) or an IP address / host[:port]. */
  target: string
  /** Unattended password; omit to ask the person at the other computer. */
  password?: string
}

/** Handed to the viewer window once a session is granted. */
export interface ViewerConfig {
  sessionId: string
  peerId: string
  peerName: string
  peerPlatform: RemotePlatform
  viewerPlatform: RemotePlatform
  permission: RemotePermission
  expiresAt: number | null
  displays: RemoteDisplay[]
  displayId: string
  quality: QualityPreset
  priority: QualityPriority
  keyboardMode: KeyboardMode
  mapModifiers: boolean
  sendShortcuts: boolean
  clipboard: boolean
  fileTransfer: boolean
  hardwareAcceleration: boolean
  iceServers: IceServer[]
}

/** Handed to the host's hidden capture window. */
export interface HostEngineConfig {
  sessionId: string
  displayId: string
  quality: QualityPreset
  priority: QualityPriority
  codec: CodecPreference
  hardwareAcceleration: boolean
  iceServers: IceServer[]
}

export interface IceServer {
  urls: string
  username?: string
  credential?: string
}

/** WebRTC SDP / ICE, passed through the authenticated channel untouched. */
export type SignalMessage =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { type: 'restart' }

/** Input events, viewer → host, over the WebRTC data channel. Coordinates are 0–1 of the shared display. */
export type InputEvent =
  | { k: 'mm'; x: number; y: number; s?: number }
  | { k: 'md' | 'mu'; b: 0 | 1 | 2; x: number; y: number }
  | { k: 'wh'; dx: number; dy: number }
  | { k: 'kd' | 'ku'; c: string }
  | { k: 'tx'; t: string }
  | { k: 'rel' }

export interface ViewerStats {
  fps: number
  width: number
  height: number
  bitrateKbps: number
  rttMs: number | null
  inputRttMs: number | null
  packetLossPct: number
  jitterBufferMs: number | null
  decodeMs: number | null
  codec: string
  route: 'lan' | 'direct' | 'relay' | 'unknown'
  qualityLimitation: string | null
}
