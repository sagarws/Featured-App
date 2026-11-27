/*
 * Featured App — Remote Desktop relay (optional, self-hosted).
 *
 * Only needed to reach a computer OUTSIDE the office network. On the LAN the
 * app connects directly and never uses this.
 *
 * The relay only introduces two computers and then copies bytes between them.
 * The session itself is end-to-end encrypted and authenticated by the two
 * apps (X25519 + AES-256-GCM, Ed25519 identities, Argon2id passwords), so the
 * relay can neither read nor alter it. A host must prove it owns the key its
 * device ID is derived from before it can register that ID.
 *
 *   node tools/remote-relay/relay.ts [port]        (Node 22.18+; default 47900)
 *
 * GET /version answers {"name","version","turn","uptimeSec"} as JSON, to see
 * which relay a server runs (RELAY_VERSION below; keep package.json equal).
 *
 * No dependencies. Line-delimited JSON during setup, raw bytes after "ready".
 *
 * Two ways in, on the same port:
 *   plain TCP   the app connects to host:47900 (a VPS with the port open)
 *   WebSocket   the app connects to wss://name (behind Cloudflare Tunnel or any
 *               HTTPS proxy, which only pass HTTP/WebSocket). The same bytes go
 *               inside binary WebSocket frames; everything else is identical.
 * A connection that sends "GET " first is a WebSocket; one that stays silent
 * (plain TCP clients wait for the relay's nonce) is plain TCP.
 */
import { createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto'
import { connect as netConnect, createServer, isIP, type AddressInfo, type Server, type Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'

/**
 * This relay's version, shown on GET /version. Bump it (and package.json's
 * "version") with every change, so a deployed server can be told apart.
 *   1.0.0  relay over TCP and WebSocket
 *   1.1.0  short-lived TURN logins (TURN_SECRET / TURN_URLS), GET /version
 *   2.0.0  SSH tunnels for VPS Manager: a public port per computer (SSH_TUNNEL_PORTS)
 */
export const RELAY_VERSION = '2.0.0'
const STARTED_AT = Date.now()

const REGISTER_LABEL = 'featured-remote-relay/v1 register'
/** What a VPS Manager computer signs to open its SSH tunnel (a different label: a Remote Desktop registration cannot be replayed as one). */
const TUNNEL_LABEL = 'featured-remote-relay/v1 tunnel'
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const SETUP_TIMEOUT_MS = 10_000
const PING_MS = 25_000
const MAX_LINE = 8 * 1024

/** The 8-digit device ID of a key — the same rule as the app (electron/main/remote/core/crypto.ts). */
export const relayDeviceId = (spki: Buffer): string =>
  (createHash('sha256').update(spki).digest().readBigUInt64BE(0) % 100_000_000n).toString().padStart(8, '0')

// ── WebSocket (RFC 6455), just what the relay needs ─────────────────────────

/** A connection the relay protocol runs over: a TCP socket, or a WebSocket made to look like one. */
export type RelayConn = Duplex & {
  setNoDelay(noDelay?: boolean): unknown
  setKeepAlive(enable?: boolean, initialDelay?: number): unknown
  readonly remoteAddress?: string | undefined
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** Larger than any frame either side sends (the app's session frames are far smaller). */
const MAX_WS_PAYLOAD = 32 * 1024 * 1024
const MAX_WS_HEADER = 16 * 1024

const wsAccept = (key: string): string => createHash('sha1').update(key + WS_GUID).digest('base64')

/**
 * A WebSocket carrying a byte stream, as a Duplex: bytes written go out as
 * binary frames, frames received come out as bytes. Clients mask what they
 * send (`mask`), servers do not, as the RFC requires.
 */
export class WsStream extends Duplex {
  remoteAddress: string | undefined
  private readonly raw: Socket
  private readonly mask: boolean
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private closeSent = false

  constructor(raw: Socket, mask: boolean, head: Buffer | null, remoteAddress?: string) {
    super()
    this.raw = raw
    this.mask = mask
    this.remoteAddress = remoteAddress ?? raw.remoteAddress
    raw.on('data', (data: Buffer) => this.onRaw(data))
    raw.on('end', () => this.push(null))
    raw.on('close', () => this.destroy())
    raw.on('error', error => this.destroy(error))
    if (head?.length) this.onRaw(head)
  }

  setNoDelay(noDelay = true): this {
    this.raw.setNoDelay(noDelay)
    return this
  }

  setKeepAlive(enable = false, initialDelay = 0): this {
    this.raw.setKeepAlive(enable, initialDelay)
    return this
  }

  override _read(): void {
    this.raw.resume()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.raw.destroyed) return callback(new Error('closed'))
    this.raw.write(this.frame(0x2, chunk), callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.sendClose()
    this.raw.end()
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.raw.destroy()
    callback(error)
  }

  private sendClose(): void {
    if (this.closeSent || this.raw.destroyed) return
    this.closeSent = true
    this.raw.write(this.frame(0x8, Buffer.from([0x03, 0xe8])))
  }

  private frame(opcode: number, payload: Buffer): Buffer {
    const length = payload.length
    const extra = length < 126 ? 0 : length < 65536 ? 2 : 8
    const header = Buffer.alloc(2 + extra + (this.mask ? 4 : 0))
    header[0] = 0x80 | opcode
    header[1] = (this.mask ? 0x80 : 0) | (length < 126 ? length : length < 65536 ? 126 : 127)
    if (extra === 2) header.writeUInt16BE(length, 2)
    else if (extra === 8) header.writeBigUInt64BE(BigInt(length), 2)
    if (!this.mask) return Buffer.concat([header, payload])
    const key = randomBytes(4)
    key.copy(header, 2 + extra)
    const masked = Buffer.allocUnsafe(length)
    for (let i = 0; i < length; i++) masked[i] = (payload[i] ?? 0) ^ (key[i & 3] ?? 0)
    return Buffer.concat([header, masked])
  }

  private onRaw(data: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data
    for (;;) {
      if (this.buffer.length < 2) return
      const b0 = this.buffer[0] ?? 0
      const b1 = this.buffer[1] ?? 0
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let length = b1 & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_WS_PAYLOAD)) return void this.destroy(new Error('WebSocket frame too large'))
        length = Number(big)
        offset = 10
      }
      if (length > MAX_WS_PAYLOAD) return void this.destroy(new Error('WebSocket frame too large'))
      const keyAt = offset
      if (masked) offset += 4
      if (this.buffer.length < offset + length) return
      let payload = this.buffer.subarray(offset, offset + length)
      if (masked) {
        const key = this.buffer.subarray(keyAt, keyAt + 4)
        const out = Buffer.allocUnsafe(length)
        for (let i = 0; i < length; i++) out[i] = (payload[i] ?? 0) ^ (key[i & 3] ?? 0)
        payload = out
      }
      this.buffer = this.buffer.subarray(offset + length)

      if (opcode === 0x8) {
        // Close: answer it, and that is the end of the stream.
        this.sendClose()
        this.raw.end()
        this.push(null)
        return
      }
      if (opcode === 0x9) {
        if (!this.raw.destroyed) this.raw.write(this.frame(0xa, payload))
        continue
      }
      if (opcode === 0xa) continue
      if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) return void this.destroy(new Error('Unknown WebSocket frame'))
      this.fragments.push(Buffer.from(payload))
      if (!fin) continue
      const message = this.fragments.length === 1 ? (this.fragments[0] as Buffer) : Buffer.concat(this.fragments)
      this.fragments = []
      if (message.length && !this.push(message)) this.raw.pause()
    }
  }
}

const isLoopback = (address: string | undefined): boolean =>
  !address || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'

/**
 * Server: answer an HTTP request that has already arrived on `socket`.
 * A WebSocket upgrade becomes a WsStream; anything else (a browser, a health
 * check) gets a one-line page and is closed. Behind Cloudflare / a proxy on
 * this machine, the visitor's address comes from the proxy's header, so the
 * per-address limits apply to visitors rather than to the proxy.
 */
/** What GET /version shows. Nothing secret: no addresses, IDs or TURN details. */
export interface RelayInfo {
  name: 'featured-remote-relay'
  version: string
  /** Does this relay hand out TURN logins? */
  turn: boolean
  /** Does this relay open SSH tunnels (VPS Manager)? */
  tunnels: boolean
  uptimeSec: number
}

const upgradeToWebSocket = (socket: Socket, request: Buffer, info: () => RelayInfo): WsStream | null => {
  const end = request.indexOf('\r\n\r\n')
  const lines = request.subarray(0, end).toString('latin1').split('\r\n')
  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  const key = headers.get('sec-websocket-key')
  if ((headers.get('upgrade') ?? '').toLowerCase() !== 'websocket' || !key) {
    const path = (lines[0] ?? '').split(' ')[1] ?? '/'
    if (path.split('?')[0] === '/version') {
      const body = `${JSON.stringify(info())}\n`
      socket.end(
        `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
      )
    } else {
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nFeatured App relay ${RELAY_VERSION}: running.\n`)
    }
    return null
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`)
  const forwarded = headers.get('cf-connecting-ip') ?? headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return new WsStream(socket, false, request.subarray(end + 4), isLoopback(socket.remoteAddress) && forwarded ? forwarded : undefined)
}

/**
 * Client: open a WebSocket to `url` (wss://host[:port][/path], ws:// for tests
 * on this machine). Resolves once the server has switched protocols.
 */
export const wsConnect = (url: string, timeoutMs: number): Promise<WsStream> =>
  new Promise((resolve, reject) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return reject(new Error(`Not a relay address: ${url}`))
    }
    const secure = target.protocol === 'wss:' || target.protocol === 'https:'
    const host = target.hostname.replace(/^\[|\]$/g, '')
    const port = Number(target.port) || (secure ? 443 : 80)
    const raw: Socket = secure ? tlsConnect({ host, port, servername: host, ALPNProtocols: ['http/1.1'] }) : netConnect({ host, port })
    const key = randomBytes(16).toString('base64')
    let response = Buffer.alloc(0)
    const timer = setTimeout(() => fail(new Error('The relay did not answer.')), timeoutMs)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      raw.removeListener('data', onData)
      raw.destroy()
      reject(error)
    }
    const onData = (data: Buffer): void => {
      response = Buffer.concat([response, data])
      const end = response.indexOf('\r\n\r\n')
      if (end < 0) {
        if (response.length > MAX_WS_HEADER) fail(new Error('The relay sent a bad answer.'))
        return
      }
      clearTimeout(timer)
      raw.removeListener('data', onData)
      raw.pause()
      const head = response.subarray(0, end).toString('latin1')
      const status = /^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]
      if (status !== '101') return fail(new Error(`The relay answered HTTP ${status ?? '?'}${status === '502' || status === '530' ? ' — is the relay running behind the tunnel?' : ''}.`))
      const accept = /\r\nsec-websocket-accept:\s*(\S+)/i.exec(head)?.[1]
      if (accept !== wsAccept(key)) return fail(new Error('The relay sent a bad answer.'))
      resolve(new WsStream(raw, true, response.subarray(end + 4)))
      raw.resume()
    }
    raw.once(secure ? 'secureConnect' : 'connect', () => {
      const path = `${target.pathname || '/'}${target.search}`
      raw.write(
        `GET ${path} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: FeaturedApp-Relay/1\r\n\r\n`
      )
    })
    raw.on('data', onData)
    raw.once('error', error => fail(error))
  })

/** Read one JSON line; the bytes after it are pushed back onto the socket. */
export const readLine = (socket: RelayConn, timeoutMs: number): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('closed'))
    }
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf(10)
      if (newline < 0) {
        if (buffer.length > MAX_LINE) {
          cleanup()
          reject(new Error('line too long'))
        }
        return
      }
      cleanup()
      socket.pause()
      const rest = buffer.subarray(newline + 1)
      if (rest.length) socket.unshift(rest)
      try {
        const value = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as unknown
        if (!value || typeof value !== 'object') throw new Error('bad line')
        resolve(value as Record<string, unknown>)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timeout'))
    }, timeoutMs)
    socket.on('data', onData)
    socket.once('close', onClose)
    socket.resume()
  })

export const writeLine = (socket: RelayConn, value: Record<string, unknown>): void => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`)
}

interface Waiting {
  client: RelayConn
  timer: NodeJS.Timeout
}

/**
 * TURN for the video, when coturn runs with `use-auth-secret` (see
 * deploy/turnserver.conf). The relay hands each app a short-lived TURN login
 * (coturn's REST scheme: user = "<expiry>:featured", password =
 * base64(HMAC-SHA1(secret, user))), so no TURN password ships inside the apps
 * and a leaked one stops working by itself.
 */
export interface RelayTurn {
  secret: string
  urls: string[]
  /** How long a login stays valid, in seconds (default 12 h; coturn also checks it when a session refreshes, so keep it longer than a session). */
  ttlSec?: number
}

export interface IceGrant {
  urls: string[]
  username: string
  credential: string
  /** Unix ms after which the login no longer works. */
  expiresAt: number
}

export const turnGrant = (turn: RelayTurn, now = Date.now()): IceGrant => {
  const expiry = Math.floor(now / 1000) + (turn.ttlSec ?? 12 * 3600)
  const username = `${expiry}:featured`
  return { urls: turn.urls, username, credential: createHmac('sha1', turn.secret).update(username).digest('base64'), expiresAt: expiry * 1000 }
}

/** TURN_SECRET + TURN_URLS (comma-separated) from the environment, or null. */
export const turnFromEnv = (env: NodeJS.ProcessEnv = process.env): RelayTurn | null => {
  const secret = env['TURN_SECRET'] ?? ''
  const urls = (env['TURN_URLS'] ?? '').split(',').map(u => u.trim()).filter(u => /^turns?:/i.test(u))
  if (secret.length < 16 || !urls.length) return null
  const ttl = Number(env['TURN_TTL_SEC'])
  return { secret, urls, ...(ttl > 0 ? { ttlSec: ttl } : {}) }
}

/**
 * SSH tunnels (VPS Manager): ports the relay may open, one per computer. A
 * computer behind any router or CGNAT keeps an outbound control connection;
 * anyone can then `ssh -p <port> user@relay` and the bytes are piped to that
 * computer's SSH server. SSH itself encrypts and authenticates end to end,
 * so the relay sees nothing. `first: 0` = any free port (tests).
 */
export interface TunnelPorts {
  first: number
  last: number
}

/** Limits per visitor address on a tunnel port (the relay cannot see SSH logins; the computer reports bad ones with tunnel-ban). */
export const TUNNEL_LIMITS = {
  /** New connections per address per minute; more = banned for banMinutes. */
  perMinute: 10,
  /** Open connections per address at once. */
  concurrent: 4,
  /** Waiting (not yet accepted) connections per tunnel. */
  pending: 20,
  banMinutes: 10,
  /** The longest ban a computer may ask for. */
  maxBanMinutes: 24 * 60
} as const

/** SSH_TUNNEL_PORTS="22000-22999" from the environment; unset = 22000-22999, "off" = no tunnels. */
export const tunnelPortsFromEnv = (env: NodeJS.ProcessEnv = process.env): TunnelPorts | null => {
  const value = (env['SSH_TUNNEL_PORTS'] ?? '22000-22999').trim()
  if (value === 'off' || value === '') return null
  const m = /^(\d{2,5})-(\d{2,5})$/.exec(value)
  if (!m) return null
  const first = Number(m[1])
  const last = Number(m[2])
  return first >= 1024 && last <= 65535 && first <= last ? { first, last } : null
}

/** "::ffff:1.2.3.4" → "1.2.3.4". */
const plainAddress = (address: string | undefined): string => (address ?? '?').replace(/^::ffff:/, '')

export interface RelayOptions {
  port: number
  host?: string
  log?: (line: string) => void
  /** Hand out TURN logins (see RelayTurn). Omitted = the apps use their own TURN settings. */
  turn?: RelayTurn | null
  /** Ports for VPS Manager SSH tunnels. Omitted / null = tunnels are refused. */
  tunnels?: TunnelPorts | null
}

export const startRelay = (options: RelayOptions): Promise<Server> => {
  const log = options.log ?? ((line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`))
  const hosts = new Map<string, RelayConn>()
  const waiting = new Map<string, Waiting>()
  const attempts = new Map<string, number[]>()
  const turn = options.turn ?? null
  /** Added to 'registered' and 'ready': a fresh TURN login, when this relay has a TURN server. */
  const ice = (): Record<string, unknown> => (turn ? { ice: turnGrant(turn) } : {})
  const info = (): RelayInfo => ({ name: 'featured-remote-relay', version: RELAY_VERSION, turn: !!turn, tunnels: !!options.tunnels, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000) })

  // ── SSH tunnels (VPS Manager) ───────────────────────────────────────────
  interface Tunnel {
    id: string
    control: RelayConn
    server: Server
    port: number
    /** Visitor address → banned until (ms). */
    bans: Map<string, number>
    /** Visitor address → recent connection times (ms). */
    recent: Map<string, number[]>
    /** Visitor address → open connections. */
    open: Map<string, number>
    pending: number
  }
  const tunnels = new Map<string, Tunnel>()
  const tunnelTokens = new Map<string, { tunnel: Tunnel; client: Socket; timer: NodeJS.Timeout }>()

  /** Keep the per-address maps from growing without bound under a scan. */
  const prune = (tunnel: Tunnel, now: number): void => {
    if (tunnel.recent.size > 10_000) for (const [ip, times] of tunnel.recent) if (!times.some(t => now - t < 60_000)) tunnel.recent.delete(ip)
    if (tunnel.bans.size > 10_000) for (const [ip, until] of tunnel.bans) if (until <= now) tunnel.bans.delete(ip)
  }

  const ban = (tunnel: Tunnel, ip: string, minutes: number, why: string): void => {
    tunnel.bans.set(ip, Date.now() + minutes * 60_000)
    log(`tunnel ${tunnel.id}: banned ${ip} for ${minutes} min (${why})`)
  }

  /** A visitor on a tunnel's public port: checked, held paused, and announced to the computer. */
  const onVisitor = (tunnel: Tunnel, socket: Socket): void => {
    socket.on('error', () => undefined)
    socket.pause()
    const ip = plainAddress(socket.remoteAddress)
    const now = Date.now()
    prune(tunnel, now)
    const until = tunnel.bans.get(ip)
    if (until && until > now) return void socket.destroy()
    if (until) tunnel.bans.delete(ip)
    const recent = (tunnel.recent.get(ip) ?? []).filter(t => now - t < 60_000)
    recent.push(now)
    tunnel.recent.set(ip, recent)
    if (recent.length > TUNNEL_LIMITS.perMinute) {
      ban(tunnel, ip, TUNNEL_LIMITS.banMinutes, 'too many connections')
      return void socket.destroy()
    }
    if ((tunnel.open.get(ip) ?? 0) >= TUNNEL_LIMITS.concurrent || tunnel.pending >= TUNNEL_LIMITS.pending) return void socket.destroy()
    tunnel.open.set(ip, (tunnel.open.get(ip) ?? 0) + 1)
    socket.once('close', () => {
      const left = (tunnel.open.get(ip) ?? 1) - 1
      if (left > 0) tunnel.open.set(ip, left)
      else tunnel.open.delete(ip)
    })
    const token = randomBytes(18).toString('base64url')
    tunnel.pending++
    const settle = (): void => {
      if (!tunnelTokens.delete(token)) return
      clearTimeout(timer)
      tunnel.pending--
    }
    const timer = setTimeout(() => {
      settle()
      socket.destroy()
    }, SETUP_TIMEOUT_MS)
    tunnelTokens.set(token, { tunnel, client: socket, timer })
    socket.once('close', settle)
    writeLine(tunnel.control, { op: 'tunnel-incoming', token, from: ip })
  }

  const listenOn = (port: number): Promise<Server | null> =>
    new Promise(resolve => {
      const server = createServer()
      server.once('error', () => resolve(null))
      server.listen(port, options.host ?? '0.0.0.0', () => resolve(server))
    })

  /**
   * The computer's public port: the one it had before (it asks for it), else
   * one derived from its ID — so it stays the same across restarts of either
   * side and the connection details do not change — else the next free one.
   */
  const openTunnelPort = async (id: string, preferred: number): Promise<{ server: Server; port: number } | null> => {
    const range = options.tunnels as TunnelPorts
    if (range.first === 0) {
      const server = await listenOn(0)
      return server ? { server, port: (server.address() as AddressInfo).port } : null
    }
    const size = range.last - range.first + 1
    const hashed = range.first + (createHash('sha256').update(id).digest().readUInt32BE(0) % size)
    const taken = new Set([...tunnels.values()].map(t => t.port))
    const candidates = [preferred >= range.first && preferred <= range.last ? preferred : null, ...Array.from({ length: size }, (_, i) => range.first + ((hashed - range.first + i) % size))]
    for (const port of candidates) {
      if (port === null || taken.has(port)) continue
      const server = await listenOn(port)
      if (server) return { server, port }
    }
    return null
  }

  /** Does `first` prove ownership of the Ed25519 key its ID comes from (signature over label + nonce)? */
  const proves = (first: Record<string, unknown>, nonce: Buffer, label: string): boolean => {
    try {
      const pub = Buffer.from(str(first['pub']), 'base64')
      const key = createPublicKey({ key: pub, format: 'der', type: 'spki' })
      return key.asymmetricKeyType === 'ed25519' && relayDeviceId(pub) === str(first['id']) && verify(null, Buffer.concat([Buffer.from(label), nonce]), key, Buffer.from(str(first['sig']), 'base64'))
    } catch {
      return false
    }
  }

  const allowed = (address: string): boolean => {
    const now = Date.now()
    const list = (attempts.get(address) ?? []).filter(t => now - t < 60_000)
    list.push(now)
    attempts.set(address, list)
    return list.length <= 60
  }

  const handle = async (socket: RelayConn): Promise<void> => {
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 10_000)
    socket.on('error', () => undefined)
    const address = socket.remoteAddress ?? '?'
    if (!allowed(address)) return void socket.destroy()
    const nonce = randomBytes(32)
    writeLine(socket, { op: 'nonce', nonce: nonce.toString('base64') })
    const first = await readLine(socket, SETUP_TIMEOUT_MS)

    if (first['op'] === 'register') {
      const pub = Buffer.from(str(first['pub']), 'base64')
      const sig = Buffer.from(str(first['sig']), 'base64')
      const id = str(first['id'])
      const ok = ((): boolean => {
        try {
          const key = createPublicKey({ key: pub, format: 'der', type: 'spki' })
          return key.asymmetricKeyType === 'ed25519' && relayDeviceId(pub) === id && verify(null, Buffer.concat([Buffer.from(REGISTER_LABEL), nonce]), key, sig)
        } catch {
          return false
        }
      })()
      if (!ok) {
        writeLine(socket, { op: 'error', message: 'Registration refused.' })
        return void socket.end()
      }
      hosts.get(id)?.destroy()
      hosts.set(id, socket)
      writeLine(socket, { op: 'registered', id, ...ice() })
      log(`host online ${id} (${address})`)
      // Once an hour (144 × 25 s) a ping also carries a fresh TURN login, so a host that stays online for days never holds an expired one.
      let pings = 0
      const ping = setInterval(() => writeLine(socket, { op: 'ping', ...(++pings % 144 === 0 ? ice() : {}) }), PING_MS)
      socket.on('data', () => undefined)
      socket.resume()
      socket.once('close', () => {
        clearInterval(ping)
        if (hosts.get(id) === socket) hosts.delete(id)
        log(`host offline ${id}`)
      })
      return
    }

    if (first['op'] === 'tunnel-register') {
      if (!options.tunnels) {
        writeLine(socket, { op: 'error', message: 'This relay does not offer SSH tunnels (it needs relay 2.0.0 with SSH_TUNNEL_PORTS).' })
        return void socket.end()
      }
      if (!proves(first, nonce, TUNNEL_LABEL)) {
        writeLine(socket, { op: 'error', message: 'Registration refused.' })
        return void socket.end()
      }
      const id = str(first['id'])
      const previous = tunnels.get(id)
      if (previous) {
        tunnels.delete(id)
        previous.server.close()
        previous.control.destroy()
      }
      const opened = await openTunnelPort(id, Number(first['port']))
      if (!opened) {
        writeLine(socket, { op: 'error', message: 'The relay has no free tunnel port.' })
        return void socket.end()
      }
      const tunnel: Tunnel = { id, control: socket, server: opened.server, port: opened.port, bans: new Map(), recent: new Map(), open: new Map(), pending: 0 }
      opened.server.on('connection', visitor => onVisitor(tunnel, visitor))
      tunnels.set(id, tunnel)
      writeLine(socket, { op: 'tunnel-ready', id, port: opened.port })
      log(`tunnel online ${id} on :${opened.port} (${address})`)
      const ping = setInterval(() => writeLine(socket, { op: 'ping' }), PING_MS)
      socket.once('close', () => {
        clearInterval(ping)
        // The port closes with the computer: nothing listens for SSH while it is offline.
        tunnel.server.close()
        for (const [token, entry] of tunnelTokens) {
          if (entry.tunnel !== tunnel) continue
          tunnelTokens.delete(token)
          clearTimeout(entry.timer)
          entry.client.destroy()
        }
        if (tunnels.get(id) === tunnel) tunnels.delete(id)
        log(`tunnel offline ${id}`)
      })
      // Control messages from the computer: pongs, and bans for addresses that failed to log in.
      void (async () => {
        for (;;) {
          let line: Record<string, unknown>
          try {
            line = await readLine(socket, 70_000)
          } catch {
            return void socket.destroy()
          }
          if (line['op'] === 'tunnel-ban') {
            const ip = str(line['ip'])
            const minutes = Math.min(TUNNEL_LIMITS.maxBanMinutes, Math.max(1, Math.round(Number(line['minutes']) || 60)))
            if (isIP(ip)) ban(tunnel, ip, minutes, 'reported by the computer')
          }
        }
      })()
      return
    }

    if (first['op'] === 'tunnel-accept') {
      const token = str(first['token'])
      const entry = tunnelTokens.get(token)
      if (!entry) return void socket.destroy()
      tunnelTokens.delete(token)
      clearTimeout(entry.timer)
      entry.tunnel.pending--
      const client = entry.client
      // Only the computer's side gets "ready": the visitor's side is raw SSH from the first byte.
      writeLine(socket, { op: 'ready' })
      client.pipe(socket)
      socket.pipe(client)
      client.resume()
      socket.resume()
      const close = (): void => {
        client.destroy()
        socket.destroy()
      }
      client.once('close', close)
      socket.once('close', close)
      return
    }

    if (first['op'] === 'lookup') {
      writeLine(socket, { op: 'status', online: hosts.has(str(first['id'])) })
      return void socket.end()
    }

    if (first['op'] === 'connect') {
      const id = str(first['id'])
      const host = hosts.get(id)
      if (!host) {
        writeLine(socket, { op: 'error', message: 'That computer is not online on the relay.' })
        return void socket.end()
      }
      if (waiting.size > 1000) return void socket.destroy()
      const token = randomBytes(18).toString('base64url')
      const timer = setTimeout(() => {
        waiting.delete(token)
        writeLine(socket, { op: 'error', message: 'The other computer did not answer.' })
        socket.end()
      }, SETUP_TIMEOUT_MS)
      waiting.set(token, { client: socket, timer })
      socket.once('close', () => {
        clearTimeout(timer)
        waiting.delete(token)
      })
      writeLine(host, { op: 'incoming', token, from: address })
      return
    }

    if (first['op'] === 'accept') {
      const token = str(first['token'])
      const entry = waiting.get(token)
      if (!entry) return void socket.destroy()
      waiting.delete(token)
      clearTimeout(entry.timer)
      const client = entry.client
      writeLine(client, { op: 'ready', ...ice() })
      writeLine(socket, { op: 'ready', ...ice() })
      client.pipe(socket)
      socket.pipe(client)
      client.resume()
      socket.resume()
      const close = (): void => {
        client.destroy()
        socket.destroy()
      }
      client.once('close', close)
      socket.once('close', close)
      return
    }

    socket.destroy()
  }

  // Plain TCP clients say nothing until they get the nonce; a WebSocket (or a
  // browser) starts with "GET ". Wait briefly to tell them apart.
  const SNIFF_MS = 300
  const server = createServer(socket => {
    socket.on('error', () => undefined)
    let request = Buffer.alloc(0)
    const asTcp = (): void => {
      socket.removeListener('data', onData)
      socket.pause()
      if (request.length) socket.unshift(request)
      handle(socket).catch(() => socket.destroy())
    }
    const timer = setTimeout(asTcp, SNIFF_MS)
    const onData = (data: Buffer): void => {
      request = Buffer.concat([request, data])
      if (request.length >= 4 && request.subarray(0, 4).toString('latin1') !== 'GET ') {
        clearTimeout(timer)
        return asTcp()
      }
      if (request.indexOf('\r\n\r\n') < 0) {
        if (request.length > MAX_WS_HEADER) socket.destroy()
        return
      }
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.pause()
      const ws = upgradeToWebSocket(socket, request, info)
      if (ws) {
        ws.on('error', () => undefined)
        handle(ws).catch(() => ws.destroy())
      }
    }
    socket.on('data', onData)
  })
  // Closing the relay closes the tunnel ports too.
  server.on('close', () => {
    for (const tunnel of tunnels.values()) {
      tunnel.server.close()
      tunnel.control.destroy()
    }
    tunnels.clear()
  })
  return new Promise(resolve => server.listen(options.port, options.host ?? '0.0.0.0', () => resolve(server)))
}

export const RELAY_REGISTER_LABEL = REGISTER_LABEL
export const RELAY_TUNNEL_LABEL = TUNNEL_LABEL

// Run directly: node tools/remote-relay/relay.ts [port]
const invokedDirectly = typeof process !== 'undefined' && process.argv[1] && /relay\.(ts|js|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  const port = Number(process.argv[2] ?? process.env['RELAY_PORT'] ?? 47900)
  const turn = turnFromEnv()
  const tunnels = tunnelPortsFromEnv()
  void startRelay({ port, turn, tunnels }).then(() =>
    process.stdout.write(
      `Featured App relay ${RELAY_VERSION} listening on :${port}${turn ? ` · TURN logins for ${turn.urls.join(', ')}` : ' · no TURN (set TURN_SECRET + TURN_URLS)'}${tunnels ? ` · SSH tunnels on ${tunnels.first}-${tunnels.last}` : ' · no SSH tunnels'}\n`
    )
  )
}
