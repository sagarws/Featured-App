import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REMOTE_SERVER } from '@shared/constants/remote'
import type { VpsTunnelStatus } from '@shared/types/vps'
import { logger } from '../logger'
import { readSecure, writeSecure } from '../secureStore'
import { failedLoopbackPorts, identityFromPkcs8, newTunnelIdentity, TunnelHost, type TunnelIdentity } from './tunnelCore'

/*
 * "Internet (relay)" access for the VPS: the SSH tunnel through the same
 * relay Remote Desktop uses (REMOTE_SERVER.relay, which must be a plain-TCP
 * relay on a public VPS so the tunnel ports are reachable). Runs inside the
 * app, so it is up while the app runs (it lives in the tray).
 *
 * Abuse control: the relay limits connections per address; on top of that
 * this follows the server's log, and an address with BAN_AFTER wrong
 * passwords within BAN_WINDOW is banned on the relay for BAN_MINUTES.
 */

const KEY_FILE = 'vps-tunnel-key.json'
const BAN_AFTER = 3
const BAN_WINDOW_MS = 10 * 60_000
const BAN_MINUTES = 60
const LOG_POLL_MS = 5000

/** The relay's public host (where visitors connect) — from "host:port" or "wss://host". */
export const relayHost = (relay: string): string | null => {
  if (!relay) return null
  if (/^wss?:\/\//i.test(relay)) {
    try {
      return new URL(relay).hostname
    } catch {
      return null
    }
  }
  const index = relay.lastIndexOf(':')
  return index > 0 ? relay.slice(0, index).replace(/^\[|\]$/g, '') : null
}

let identity: TunnelIdentity | null = null
const loadIdentity = (): TunnelIdentity => {
  if (identity) return identity
  const stored = readSecure<{ pkcs8: string }>(KEY_FILE)
  if (stored?.pkcs8) {
    try {
      identity = identityFromPkcs8(Buffer.from(stored.pkcs8, 'base64'))
      return identity
    } catch (error) {
      logger.warn('[vps] tunnel key unreadable, making a new one', error)
    }
  }
  const fresh = newTunnelIdentity()
  writeSecure(KEY_FILE, { pkcs8: fresh.pkcs8.toString('base64') })
  identity = fresh.identity
  return identity
}

let status: VpsTunnelStatus = { state: 'off', host: relayHost(REMOTE_SERVER.relay), port: null, error: null, bannedRecently: 0 }
let host: TunnelHost | null = null
let target = 0
let onChange: () => void = () => undefined

/** Visitor address per local source port (kept a while after the session ends: log lines can come late). */
const visitors = new Map<number, { ip: string; ended: number | null }>()
const failures = new Map<string, number[]>()
const banned = new Map<string, number>()
let logTimer: NodeJS.Timeout | null = null
let logOffset = 0

const set = (patch: Partial<VpsTunnelStatus>): void => {
  status = { ...status, ...patch }
  onChange()
}

/** Read what sshd appended to its log since last time, and ban visitors with too many wrong passwords. */
const followLog = (serverDir: string): void => {
  const file = join(serverDir, 'sshd.log')
  try {
    if (!existsSync(file)) return
    const size = statSync(file).size
    if (size < logOffset) logOffset = 0
    if (size === logOffset) return
    const length = Math.min(size - logOffset, 1024 * 1024)
    const buffer = Buffer.alloc(length)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buffer, 0, length, logOffset)
    } finally {
      closeSync(fd)
    }
    logOffset += length
    const now = Date.now()
    for (const port of failedLoopbackPorts(buffer.toString('utf8'))) {
      const visitor = visitors.get(port)
      if (!visitor) continue
      const list = (failures.get(visitor.ip) ?? []).filter(t => now - t < BAN_WINDOW_MS)
      list.push(now)
      failures.set(visitor.ip, list)
      if (list.length >= BAN_AFTER && (banned.get(visitor.ip) ?? 0) < now) {
        host?.ban(visitor.ip, BAN_MINUTES)
        banned.set(visitor.ip, now + BAN_MINUTES * 60_000)
        failures.delete(visitor.ip)
        logger.warn(`[vps] banned ${visitor.ip} on the relay for ${BAN_MINUTES} min (${BAN_AFTER} wrong passwords)`)
      }
    }
    for (const [port, v] of visitors) if (v.ended && now - v.ended > BAN_WINDOW_MS) visitors.delete(port)
    for (const [ip, until] of banned) if (until < now) banned.delete(ip)
    if (banned.size !== status.bannedRecently) set({ bannedRecently: banned.size })
  } catch (error) {
    logger.warn('[vps] could not read the server log', error instanceof Error ? error.message : String(error))
  }
}

export const tunnelStatus = (): VpsTunnelStatus => status

export const setTunnelListener = (listener: () => void): void => {
  onChange = listener
}

/**
 * Open (or keep open) the tunnel to the local SSH server on `sshPort`.
 * `preferredPort` / `onPort`: the public port is remembered so it stays the same.
 */
export const startTunnel = (sshPort: number, serverDir: string, preferredPort: number | null, onPort: (port: number) => void): void => {
  const relay = REMOTE_SERVER.relay
  if (!relay || !relayHost(relay)) {
    set({ state: 'error', error: 'No relay server is configured (REMOTE_SERVER.relay).' })
    return
  }
  target = sshPort
  if (host?.running) return
  let lastPort = preferredPort
  host = new TunnelHost({
    relay,
    identity: loadIdentity,
    target: () => target,
    preferredPort: () => lastPort,
    events: {
      onState: (state, info) => {
        if (state === 'online' && info.port) {
          lastPort = info.port
          onPort(info.port)
          logger.info('[vps] tunnel online', { relay: relayHost(relay), port: info.port })
        } else if (state === 'error') {
          logger.warn(`[vps] tunnel: ${info.error ?? 'error'}`)
        }
        set({ state, port: state === 'online' ? info.port : status.port, error: info.error })
      },
      onSession: (from, localPort) => visitors.set(localPort, { ip: from, ended: null }),
      onSessionEnd: localPort => {
        const v = visitors.get(localPort)
        if (v) v.ended = Date.now()
      }
    }
  })
  try {
    logOffset = existsSync(join(serverDir, 'sshd.log')) ? statSync(join(serverDir, 'sshd.log')).size : 0
  } catch {
    logOffset = 0
  }
  if (logTimer) clearInterval(logTimer)
  logTimer = setInterval(() => followLog(serverDir), LOG_POLL_MS)
  host.start()
}

export const stopTunnel = (): void => {
  host?.stop()
  host = null
  if (logTimer) clearInterval(logTimer)
  logTimer = null
  visitors.clear()
  failures.clear()
  set({ state: 'off', error: null })
}
