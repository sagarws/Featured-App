import type { VpsAccessMode, VpsChange, VpsInterfaceKind, VpsNetwork, VpsPlatform, VpsStepId } from '../types/vps'
import { VPS_CHANGES } from '../types/vps'

/*
 * Pure helpers for the VPS Manager, shared by the main process (scripts,
 * validation) and the window (connection details). No Node, no Electron.
 */

export const VPS_DEFAULT_PORT = 2222
/** Ports tried, in order, when 2222 is taken. */
export const VPS_PORT_RANGE = { first: 2222, last: 2232 } as const
export const VPS_PASSWORD_LENGTH = 24
/** Wrong passwords (any source) in GUARD_WINDOW before the account is locked for GUARD_LOCK. */
export const VPS_GUARD = { threshold: 10, windowSeconds: 600, lockSeconds: 900 } as const
/** Marker in the account's full name / description: only accounts carrying it are ever changed or removed. */
export const VPS_USER_MARKER = 'Featured App VPS'

/**
 * Addresses the server accepts logins from: private LANs, link-local,
 * loopback and the 100.64.0.0/10 range Tailscale (and other VPNs) use.
 * Everything else — the public internet — is refused by sshd itself, even if
 * someone forwards the port on their router.
 */
export const VPS_ALLOWED_SOURCES = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  'fc00::/7',
  'fe80::/10'
] as const

// ── Validation ────────────────────────────────────────────────────────────

export const VPS_DEFAULT_USERNAME = 'vpsuser'
/** Only members of this group may log in to the app's server (the username itself never appears in sshd_config). */
export const VPS_GROUP = 'featuredvps'

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/*
 * Any username the operating system accepts. The app only refuses what no
 * system allows in a login name and what would make paths unsafe: empty,
 * control characters, / or \, "." and "..". The OS decides the rest (its
 * error is shown), and the scripts refuse to take over an existing account
 * the app did not create.
 */
export const usernameProblem = (v: string): string | null => {
  if (!v) return 'Enter a username.'
  if (v.toLowerCase() === 'root') return '"root" is the system superuser and cannot be used. Choose another name.'
  if (v.length > 256) return 'That is too long for any system.'
  if (CONTROL.test(v)) return 'Control characters cannot be part of a username.'
  if (v.includes('/') || v.includes('\\')) return '/ and \\ cannot be part of a username on any system.'
  if (v === '.' || v === '..') return 'That is not a valid username.'
  return null
}

export const isVpsUsername = (v: unknown): v is string => typeof v === 'string' && usernameProblem(v) === null

export const isVpsPort = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= VPS_PORT_RANGE.first && v <= VPS_PORT_RANGE.last

export const isAccessMode = (v: unknown): v is VpsAccessMode => v === 'local' || v === 'vpn' || v === 'relay'

export const isVpsChange = (v: unknown): v is VpsChange => typeof v === 'string' && (VPS_CHANGES as readonly string[]).includes(v)

// ── Credentials ───────────────────────────────────────────────────────────

/*
 * No look-alikes (0/O, 1/l/I) and none of the characters that need quoting
 * in a shell, PowerShell, chpasswd ("user:password") or dscl's command line:
 * no space, quotes, backslash, $, `, #, :, ; or &.
 */
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const DIGITS = '23456789'
const SYMBOLS = '-_.+=@%^*!?'
export const VPS_PASSWORD_ALPHABET = UPPER + LOWER + DIGITS + SYMBOLS

/** `randomInt(max)` → uniform integer in [0, max): pass crypto.randomInt. */
export type RandomInt = (max: number) => number

const pick = (set: string, randomInt: RandomInt): string => set[randomInt(set.length)] as string

/**
 * A password with every character class (Windows' complexity rule wants
 * three of four), uniformly shuffled, from a CSPRNG the caller supplies.
 */
export const generatePassword = (randomInt: RandomInt, length = VPS_PASSWORD_LENGTH): string => {
  if (length < 20) throw new Error('Passwords must be at least 20 characters.')
  const chars = [pick(UPPER, randomInt), pick(LOWER, randomInt), pick(DIGITS, randomInt), pick(SYMBOLS, randomInt)]
  while (chars.length < length) chars.push(pick(VPS_PASSWORD_ALPHABET, randomInt))
  // Fisher–Yates, so the guaranteed classes are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j] as string, chars[i] as string]
  }
  return chars.join('')
}

/** Any password at all — only it cannot be empty or contain a line break (neither can be typed at an SSH password prompt). */
export const passwordProblem = (v: string): string | null => {
  if (!v) return 'Enter a password.'
  if (/[\r\n]/.test(v)) return 'A password cannot contain a line break.'
  return null
}

export const isVpsPassword = (v: unknown): v is string => typeof v === 'string' && passwordProblem(v) === null

/** A rough strength hint for a typed password. */
export const passwordStrength = (v: string): 'weak' | 'fair' | 'strong' => {
  const classes = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(v)).length
  if (v.length >= 16 && classes >= 3) return 'strong'
  if (v.length >= 12 && classes >= 2) return 'fair'
  return 'weak'
}

const NAME_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
export const generateUsername = (randomInt: RandomInt): string => {
  let name = 'vps'
  for (let i = 0; i < 5; i++) name += pick(NAME_CHARS, randomInt)
  return name
}

// ── Connection details ────────────────────────────────────────────────────

/** The exact object the feature hands out — never the password. */
export interface SshConnectionConfig {
  Host: { HostName: string; User: string; Port: number }
}

export const sshConnectionConfig = (host: string, user: string, port: number): SshConnectionConfig => ({
  Host: { HostName: host, User: user, Port: port }
})

/** Pretty-printed JSON of {@link sshConnectionConfig}. */
export const sshConfigJson = (host: string, user: string, port: number): string =>
  JSON.stringify(sshConnectionConfig(host, user, port), null, 2)

/** The ssh command; a username with unusual characters is shell-quoted. */
export const sshCommand = (host: string, user: string, port: number): string =>
  `ssh ${/^[A-Za-z0-9._-]+$/.test(user) ? user : shQuote(user)}@${host} -p ${port}`

/** The address the details should point at for a mode, or null when there is none (no VPN). */
export const hostForMode = (network: Pick<VpsNetwork, 'lanIp' | 'vpnIp'>, mode: VpsAccessMode): string | null =>
  mode === 'vpn' ? network.vpnIp : mode === 'local' ? network.lanIp : null

/** Host and port for the connection details: the relay's for "relay" (once the tunnel is online), else this computer's. */
export const endpointForMode = (
  network: Pick<VpsNetwork, 'lanIp' | 'vpnIp'> | null,
  tunnel: { state: string; host: string | null; port: number | null },
  mode: VpsAccessMode,
  sshPort: number
): { host: string; port: number } | null => {
  if (mode === 'relay') return tunnel.state === 'online' && tunnel.host && tunnel.port ? { host: tunnel.host, port: tunnel.port } : null
  const host = network ? hostForMode(network, mode) : null
  return host ? { host, port: sshPort } : null
}

// ── Addresses ─────────────────────────────────────────────────────────────

const v4 = (address: string): number[] | null => {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map(p => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  return nums.every(n => n >= 0 && n <= 255) ? nums : null
}

export const isPrivateV4 = (address: string): boolean => {
  const p = v4(address)
  if (!p) return false
  const [a, b] = p as [number, number]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** 100.64.0.0/10: carrier-grade NAT, and the range Tailscale hands out. */
export const isCgnatV4 = (address: string): boolean => {
  const p = v4(address)
  return !!p && p[0] === 100 && (p[1] as number) >= 64 && (p[1] as number) <= 127
}

export const isPublicV4 = (address: string): boolean => {
  const p = v4(address)
  if (!p) return false
  const [a, b] = p as [number, number]
  if (a === 0 || a === 127 || a >= 224) return false
  if (a === 169 && b === 254) return false
  return !isPrivateV4(address) && !isCgnatV4(address)
}

const VPN_NAME = /^(tailscale|wg|tun|tap|zt|ppp|ipsec|nordlynx|proton|mullvad)|wireguard|tailscale|zerotier|vpn/i

/**
 * Sort an interface address into what it is good for. A VPN is a
 * Tailscale-range address, or an IPv4 on a tunnel interface (macOS's own
 * utun interfaces carry only IPv6 link-local, so they do not count).
 */
export const classifyAddress = (name: string, address: string, family: 'IPv4' | 'IPv6', internal: boolean): VpsInterfaceKind => {
  if (internal) return 'loopback'
  if (family === 'IPv4') {
    if (isCgnatV4(address)) return 'vpn'
    if (address.startsWith('169.254.')) return 'link-local'
    if (VPN_NAME.test(name) || /^utun\d+$/.test(name)) return 'vpn'
    return isPrivateV4(address) ? 'lan' : 'other'
  }
  const lower = address.toLowerCase()
  if (lower.startsWith('fe80:')) return 'link-local'
  if (lower.startsWith('fd7a:115c:a1e0:')) return 'vpn' // Tailscale's IPv6 range
  if (VPN_NAME.test(name)) return 'vpn'
  return 'other'
}

// ── Scripts ───────────────────────────────────────────────────────────────

/** A POSIX shell single-quoted string. */
export const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** A PowerShell single-quoted string. */
export const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`

/** A value for an sshd_config line (quoted when it holds spaces). */
const cfgValue = (value: string): string => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value)

export interface SshdConfigInput {
  platform: VpsPlatform
  port: number
  hostKeys: string[]
  /** Folder for the pid file (not used on Windows). */
  pidFile: string | null
  /** OpenSSH ≥ 9.8: per-source penalties for failed logins. The script drops the line if sshd rejects it. */
  penalties: boolean
}

/**
 * The server's own sshd_config — separate from the system's
 * /etc/ssh/sshd_config, which the app never edits. Password only, members of
 * the app's group only (so the username can be anything), no root, private /
 * VPN sources only — every other address is refused by the Match block —
 * with tight rate limits.
 */
export const buildSshdConfig = (input: SshdConfigInput): string => {
  if (!isVpsPort(input.port)) throw new Error('Invalid port.')
  const nl = input.platform === 'win32' ? '\r\n' : '\n'
  const lines = [
    '# Managed by Featured App (VPS Manager). Removed on Disconnect - do not edit.',
    `Port ${input.port}`,
    'AddressFamily any',
    ...input.hostKeys.map(key => `HostKey ${cfgValue(key)}`),
    ...(input.pidFile ? [`PidFile ${cfgValue(input.pidFile)}`] : []),
    'PermitRootLogin no',
    `AllowGroups ${VPS_GROUP}`,
    'PasswordAuthentication yes',
    'PermitEmptyPasswords no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication no',
    'HostbasedAuthentication no',
    ...(input.platform === 'win32' ? [] : ['UsePAM yes']),
    'MaxAuthTries 3',
    'MaxSessions 4',
    'MaxStartups 3:50:10',
    'LoginGraceTime 30',
    'ClientAliveInterval 300',
    'ClientAliveCountMax 2',
    'AllowAgentForwarding no',
    'AllowTcpForwarding no',
    'X11Forwarding no',
    'PermitTunnel no',
    'PermitUserEnvironment no',
    'StrictModes yes',
    'LogLevel VERBOSE',
    'Subsystem sftp internal-sftp',
    // Through the relay every visitor arrives from 127.0.0.1: per-address penalties there would let one attacker lock
    // out everyone, so loopback is exempt — the relay and the app ban by the visitor's real address instead.
    ...(input.penalties ? ['PerSourcePenalties authfail:30s max:600s', 'PerSourcePenaltyExemptList 127.0.0.1/32,::1/128'] : []),
    // Last: Match blocks run to the end of the file.
    `Match Address *,${VPS_ALLOWED_SOURCES.map(source => `!${source}`).join(',')}`,
    '\tDenyUsers *',
    '\tPasswordAuthentication no',
    '\tKbdInteractiveAuthentication no'
  ]
  return lines.join(nl) + nl
}

/** Lines the scripts print to their progress file. */
export type ScriptLine =
  | { kind: 'step'; id: VpsStepId; state: 'running' | 'done' | 'skipped'; detail?: string }
  | { kind: 'change'; change: VpsChange }
  | { kind: 'firewall'; result: 'rule-added' | 'declined' | 'no-firewall' }
  | { kind: 'fingerprint'; value: string }
  | { kind: 'error'; message: string }
  | { kind: 'ok' }
  /** The account could not be deleted (macOS without Full Disk Access): it was disabled and kept instead. */
  | { kind: 'user-kept' }

const STEP_IDS: readonly string[] = ['checks', 'port', 'credentials', 'authorize', 'install', 'user', 'config', 'firewall', 'service', 'verify']

/** Parse one line a script wrote (anything unrecognised is ignored). */
export const parseScriptLine = (line: string): ScriptLine | null => {
  const text = line.trim()
  let m = /^STEP (\w+) (running|done|skipped)(?: (.{1,200}))?$/.exec(text)
  if (m && STEP_IDS.includes(m[1] as string)) {
    return { kind: 'step', id: m[1] as VpsStepId, state: m[2] as 'running' | 'done' | 'skipped', ...(m[3] ? { detail: m[3] } : {}) }
  }
  m = /^CHANGE ([a-z-]+)$/.exec(text)
  if (m && isVpsChange(m[1])) return { kind: 'change', change: m[1] }
  m = /^FIREWALL (rule-added|declined|no-firewall)$/.exec(text)
  if (m) return { kind: 'firewall', result: m[1] as 'rule-added' | 'declined' | 'no-firewall' }
  m = /^FINGERPRINT (\S{10,120})$/.exec(text)
  if (m) return { kind: 'fingerprint', value: m[1] as string }
  m = /^ERROR (.{1,300})$/.exec(text)
  if (m) return { kind: 'error', message: m[1] as string }
  if (text === 'OK') return { kind: 'ok' }
  if (text === 'USERKEPT') return { kind: 'user-kept' }
  return null
}

/** Remove every occurrence of a secret from text before it is logged or shown. */
export const redact = (text: string, secrets: (string | null | undefined)[]): string =>
  secrets.reduce<string>((out, secret) => (secret && secret.length >= 6 ? out.split(secret).join('[redacted]') : out), text)

/** "2d 4h", "3h 12m", "45s". */
export const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s % 60}s`
  return `${s}s`
}
