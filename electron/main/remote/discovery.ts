import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import type { DiscoveredDevice, RemotePlatform } from '@shared/types/remote'
import { parseDeviceId, stripControl } from '@shared/utils/remote'
import { logger } from '../logger'

/*
 * Finding the other office computers: every few seconds each app broadcasts
 * a small UDP datagram on the LAN (port = session port + 1) with its device
 * ID, name and session port, and answers queries. Nothing leaves the local
 * network segment. The announcement is not trusted for identity: the
 * connection itself proves who is at that address (handshake.ts).
 */

const APP_TAG = 'featured-rd'
const ANNOUNCE_MS = 5000
/** A device not heard from for this long is shown offline. */
export const ONLINE_MS = 16_000

interface Announcement {
  id: string
  name: string
  os: string
  platform: RemotePlatform
  port: number
  fp: string
}

const broadcastAddresses = (): string[] => {
  const out = new Set<string>(['255.255.255.255'])
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue
      const ip = i.address.split('.').map(Number)
      const mask = i.netmask.split('.').map(Number)
      if (ip.length === 4 && mask.length === 4) out.add(ip.map((octet, n) => (octet | (~mask[n]! & 255)) & 255).join('.'))
    }
  }
  return [...out]
}

export const parseAnnouncement = (data: Buffer): (Announcement & { query: boolean }) | null => {
  if (data.length > 2048) return null
  try {
    const v = JSON.parse(data.toString('utf8')) as Record<string, unknown>
    if (v['app'] !== APP_TAG || v['v'] !== 1) return null
    if (v['q'] === 1) return { id: '', name: '', os: '', platform: 'linux', port: 0, fp: '', query: true }
    const id = typeof v['id'] === 'string' ? parseDeviceId(v['id']) : null
    const port = v['port']
    if (!id || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
    const text = (k: string, max: number): string => {
      const value = v[k]
      return typeof value === 'string' ? stripControl(value).slice(0, max) : ''
    }
    const platform = (['darwin', 'win32', 'linux'] as const).find(p => p === v['platform']) ?? 'linux'
    return { id, name: text('name', 64) || id, os: text('os', 64), platform, port, fp: text('fp', 64), query: false }
  } catch {
    return null
  }
}

export class Discovery {
  private socket: Socket | null = null
  private timer: NodeJS.Timeout | null = null
  private devices = new Map<string, DiscoveredDevice>()
  private announcing = false

  constructor(
    private readonly port: number,
    private readonly self: () => Announcement,
    private readonly onChange: () => void
  ) {}

  /** Listen (always, to list others) and announce this computer if `announce`. */
  start(announce: boolean): void {
    this.announcing = announce
    if (this.socket) return
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('error', error => {
      logger.warn('[remote] discovery socket error', error)
      this.stop()
    })
    socket.on('message', (data, rinfo) => this.onMessage(data, rinfo.address))
    socket.bind(this.port, () => {
      try {
        socket.setBroadcast(true)
      } catch (error) {
        logger.warn('[remote] broadcast unavailable', error)
      }
      this.send({ app: APP_TAG, v: 1, q: 1 })
      this.tick()
    })
    this.timer = setInterval(() => this.tick(), ANNOUNCE_MS)
  }

  setAnnounce(announce: boolean): void {
    this.announcing = announce
    if (announce) this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try {
      this.socket?.close()
    } catch {
      // already closed
    }
    this.socket = null
    this.devices.clear()
    this.onChange()
  }

  /** Ask everyone to announce now (Refresh button). */
  query(): void {
    this.send({ app: APP_TAG, v: 1, q: 1 })
  }

  list(): DiscoveredDevice[] {
    const now = Date.now()
    return [...this.devices.values()].filter(d => now - d.lastSeen < ONLINE_MS).sort((a, b) => a.name.localeCompare(b.name))
  }

  find(id: string): DiscoveredDevice | undefined {
    const d = this.devices.get(id)
    return d && Date.now() - d.lastSeen < ONLINE_MS ? d : undefined
  }

  private tick(): void {
    if (this.announcing) this.send({ app: APP_TAG, v: 1, ...this.self() })
    // Drop the ones gone quiet.
    const now = Date.now()
    let changed = false
    for (const [id, d] of this.devices) {
      if (now - d.lastSeen > ONLINE_MS * 4) {
        this.devices.delete(id)
        changed = true
      }
    }
    if (changed) this.onChange()
  }

  private send(message: Record<string, unknown>): void {
    const socket = this.socket
    if (!socket) return
    const data = Buffer.from(JSON.stringify(message))
    for (const address of broadcastAddresses()) {
      socket.send(data, this.port, address, error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'EHOSTUNREACH') logger.warn(`[remote] discovery send to ${address} failed: ${error.message}`)
      })
    }
  }

  private onMessage(data: Buffer, address: string): void {
    const a = parseAnnouncement(data)
    if (!a) return
    if (a.query) {
      if (this.announcing) this.send({ app: APP_TAG, v: 1, ...this.self() })
      return
    }
    if (a.id === this.self().id) return
    const previous = this.devices.get(a.id)
    this.devices.set(a.id, { id: a.id, name: a.name, os: a.os, platform: a.platform, address, port: a.port, fingerprint: a.fp, lastSeen: Date.now() })
    if (!previous || previous.name !== a.name || previous.address !== address || Date.now() - previous.lastSeen > ONLINE_MS) this.onChange()
  }
}
