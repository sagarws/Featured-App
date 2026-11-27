/*
 * VPS Manager — turns this computer into an SSH server (password login) that
 * other machines on the same network or VPN can reach. See electron/main/vps
 * and docs/vps-manager.md.
 */

export type VpsPlatform = 'darwin' | 'linux' | 'win32'

/**
 * How other computers reach the server:
 *   local  same network (LAN address)
 *   vpn    Tailscale / WireGuard address
 *   relay  from any internet connection, through the relay VPS (an SSH tunnel; see electron/main/vps/tunnel.ts)
 */
export type VpsAccessMode = 'local' | 'vpn' | 'relay'

export interface VpsTunnelStatus {
  state: 'off' | 'connecting' | 'online' | 'error'
  /** The relay's public host — where visitors connect. */
  host: string | null
  /** This computer's public port on the relay. */
  port: number | null
  error: string | null
  /** Visitor addresses banned on the relay for wrong passwords (last hour). */
  bannedRecently: number
}

/**
 * A change the setup script made to the system, so that Disconnect undoes it
 * and nothing else.
 */
export type VpsChange =
  /** openssh-server (Ubuntu) / the OpenSSH Server capability (Windows) was installed by the app. */
  | 'package-installed'
  /** The distribution's own ssh.service was switched off after the app installed it (it would expose port 22). */
  | 'default-service-disabled'
  | 'user-created'
  /** The `featuredvps` group (only its members may log in) was created. */
  | 'group-created'
  /** An account the app made earlier (kept on disconnect, disabled) was switched back on. */
  | 'user-reenabled'
  /** macOS: the user was added to com.apple.access_ssh (Remote Login restricted to listed users). */
  | 'ssh-group-added'
  /** ssh-keygen -A created missing host keys. They are kept, so the server's identity stays stable. */
  | 'host-keys-generated'
  | 'service-installed'
  /** The once-a-minute job that locks the account after repeated wrong passwords. */
  | 'guard-installed'
  | 'firewall-rule'
  /** macOS application firewall: /usr/sbin/sshd was added to the allowed list. */
  | 'mac-firewall-app'

export const VPS_CHANGES: readonly VpsChange[] = [
  'package-installed',
  'default-service-disabled',
  'user-created',
  'group-created',
  'user-reenabled',
  'ssh-group-added',
  'host-keys-generated',
  'service-installed',
  'guard-installed',
  'firewall-rule',
  'mac-firewall-app'
]

export type VpsFirewallResult = 'rule-added' | 'declined' | 'no-firewall' | 'unknown'

/**
 * What the app changed, on disk in userData (no secrets). It is written
 * before the administrator prompt so that a crash mid-setup can still be
 * cleaned up.
 */
export interface VpsManifest {
  version: 1
  platform: VpsPlatform
  state: 'configuring' | 'running' | 'stopped' | 'failed'
  username: string
  port: number
  accessMode: VpsAccessMode
  changes: VpsChange[]
  firewall: VpsFirewallResult
  hostKeyFingerprint: string | null
  /** The account was kept (disabled) on the last disconnect and can be switched back on. */
  userKept: boolean
  /** The public port the relay gave this computer last time (asked for again, so it stays the same). */
  tunnelPort?: number | null
  createdAt: number
  startedAt: number | null
  stoppedAt: number | null
  lastError: string | null
}

export type VpsStepId = 'checks' | 'port' | 'credentials' | 'authorize' | 'install' | 'user' | 'config' | 'firewall' | 'service' | 'verify'

export interface VpsStep {
  id: VpsStepId
  label: string
  state: 'pending' | 'running' | 'done' | 'skipped' | 'failed'
  detail?: string
}

export type VpsState =
  /** Nothing set up (or disconnected). */
  | 'disconnected'
  /** Setup is running. */
  | 'configuring'
  /** The server answers on its port. */
  | 'connected'
  /** Set up, but the server does not answer (service stopped or failed). */
  | 'unreachable'
  /** A setup was interrupted (crash, power cut): leftovers to clean up. */
  | 'needs-recovery'

export type VpsBusy = 'convert' | 'disconnect' | 'password' | 'recover' | null

export interface VpsStatus {
  platform: string
  /** Can this system run it at all (and why not)? */
  support: { ok: boolean; reason: string | null }
  state: VpsState
  busy: VpsBusy
  /** The setup steps while converting (and after a failed one). */
  steps: VpsStep[] | null
  server: {
    username: string
    port: number
    accessMode: VpsAccessMode
    startedAt: number | null
    hostKeyFingerprint: string | null
    firewall: VpsFirewallResult
  } | null
  /** False after a restart where the OS offers no encrypted storage: regenerate to see it. */
  passwordAvailable: boolean
  /** An account kept from an earlier disconnect (disabled), reused by the next Convert. */
  keptUser: string | null
  lockout: { lockedUntil: number | null; recentFailures: number } | null
  /** Internet access through the relay (when the access mode is "relay"). */
  tunnel: VpsTunnelStatus
  /** The stored password is weak — worth a warning when the server is reachable from the internet. */
  passwordWeak: boolean
  lastError: string | null
}

export interface VpsSystemInfo {
  os: string
  osVersion: string
  arch: string
  cpuModel: string
  cpuCores: number
  totalMemory: number
  disk: { total: number; free: number } | null
  hostname: string
}

export type VpsInterfaceKind = 'lan' | 'vpn' | 'link-local' | 'loopback' | 'other'

export interface VpsInterface {
  name: string
  address: string
  family: 'IPv4' | 'IPv6'
  kind: VpsInterfaceKind
}

export interface VpsNetwork {
  online: boolean
  interfaces: VpsInterface[]
  lanIp: string | null
  lanInterface: string | null
  vpnIp: string | null
  vpnInterface: string | null
  ipv6: string | null
  /** Only after the user asked for it (it is a request to an outside service). */
  publicIp: string | null
  publicIpError: string | null
  /** How reachable this machine is from the internet. */
  nat: 'unknown' | 'behind-nat' | 'direct'
}

export interface VpsMetrics {
  cpuPercent: number
  memory: { used: number; total: number }
  disk: { used: number; total: number } | null
  network: { rxPerSec: number; txPerSec: number } | null
  systemUptime: number
  /** Seconds the server has been up, or null when it is not running. */
  serverUptime: number | null
  activeConnections: number | null
  serviceRunning: boolean
}

export interface VpsConvertOptions {
  accessMode: VpsAccessMode
  /** Add a firewall rule (limited to private / VPN addresses) for the SSH port. */
  firewallConsent: boolean
  /** The login name (see isVpsUsername). */
  username: string
  /** The password the user typed or generated in the window; a strong one is generated when absent. */
  password?: string
}

export interface VpsLoginChange {
  username: string
  password?: string
}

export interface VpsDisconnectOptions {
  /** Delete the account and its home folder; otherwise it is disabled and kept for next time. */
  removeUser: boolean
}
