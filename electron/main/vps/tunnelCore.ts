import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { RELAY_TUNNEL_LABEL, readLine, relayDeviceId, writeLine, type RelayConn } from '../../../tools/remote-relay/relay'
import { openRelay } from '../remote/core/relayClient'

/*
 * VPS Manager's SSH tunnel through the relay (tools/remote-relay, 2.0.0+).
 * No Electron here, so it is tested over real TCP.
 *
 *   control   one outbound connection, registered with an Ed25519 proof;
 *             the relay opens a public port for this computer and says
 *             "tunnel-incoming" for every visitor.
 *   data      per visitor, a new outbound connection ("tunnel-accept"),
 *             piped to the local SSH server on 127.0.0.1.
 *
 * SSH encrypts and authenticates end to end; the relay only copies bytes.
 * Because every visitor reaches sshd from 127.0.0.1, the local source port
 * of each data connection is reported (onSession) so failed logins in the
 * server's log can be traced back to the visitor's real address and banned
 * on the relay (ban()).
 */

export interface TunnelIdentity {
  id: string
  /** SPKI DER. */
  publicKey: Buffer
  privateKey: KeyObject
}

export const newTunnelIdentity = (): { identity: TunnelIdentity; pkcs8: Buffer } => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { identity: identityFrom(privateKey, publicKey), pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }) }
}

export const identityFromPkcs8 = (pkcs8: Buffer): TunnelIdentity => {
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
  return identityFrom(privateKey, createPublicKey(privateKey))
}

const identityFrom = (privateKey: KeyObject, publicKey: KeyObject): TunnelIdentity => {
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  return { id: relayDeviceId(spki), publicKey: spki, privateKey }
}

export type TunnelState = 'connecting' | 'online' | 'error'

export interface TunnelEvents {
  onState: (state: TunnelState, info: { port: number | null; error: string | null }) => void
  /** A visitor is connected to the local SSH server; `localPort` is what sshd logs as "from 127.0.0.1 port …". */
  onSession?: (from: string, localPort: number) => void
  onSessionEnd?: (localPort: number) => void
}

export interface TunnelOptions {
  relay: string
  identity: () => TunnelIdentity
  /** The local SSH server's port. */
  target: () => number
  /** The public port this computer had last time (kept when free). */
  preferredPort?: () => number | null
  events: TunnelEvents
}

/** Stays registered, reconnecting with backoff, until stopped. */
export class TunnelHost {
  private control: RelayConn | null = null
  private stopped = true
  private retry: NodeJS.Timeout | null = null
  private backoff = 2000
  private readonly sessions = new Set<Socket | RelayConn>()

  constructor(private readonly options: TunnelOptions) {}

  get running(): boolean {
    return !this.stopped
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.backoff = 2000
    void this.connectLoop()
  }

  /** Close the tunnel and every session through it. */
  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.control?.destroy()
    this.control = null
    for (const socket of this.sessions) socket.destroy()
    this.sessions.clear()
  }

  /** Ask the relay to refuse this visitor address for a while. */
  ban(ip: string, minutes: number): void {
    if (this.control && !this.control.destroyed) writeLine(this.control, { op: 'tunnel-ban', ip, minutes })
  }

  private scheduleRetry(error: string): void {
    if (this.stopped) return
    this.options.events.onState('error', { port: null, error })
    this.retry = setTimeout(() => void this.connectLoop(), this.backoff)
    this.backoff = Math.min(60_000, this.backoff * 2)
  }

  private async connectLoop(): Promise<void> {
    if (this.stopped) return
    this.options.events.onState('connecting', { port: null, error: null })
    let socket: RelayConn
    try {
      socket = await openRelay(this.options.relay)
    } catch (error) {
      return this.scheduleRetry(error instanceof Error ? error.message : String(error))
    }
    if (this.stopped) return void socket.destroy()
    this.control = socket
    let port: number
    try {
      const hello = await readLine(socket, 8000)
      const nonce = Buffer.from(typeof hello['nonce'] === 'string' ? hello['nonce'] : '', 'base64')
      const identity = this.options.identity()
      const sig = sign(null, Buffer.concat([Buffer.from(RELAY_TUNNEL_LABEL), nonce]), identity.privateKey)
      writeLine(socket, {
        op: 'tunnel-register',
        id: identity.id,
        pub: identity.publicKey.toString('base64'),
        sig: sig.toString('base64'),
        port: this.options.preferredPort?.() ?? 0
      })
      const answer = await readLine(socket, 8000)
      if (answer['op'] !== 'tunnel-ready' || typeof answer['port'] !== 'number') {
        throw new Error(typeof answer['message'] === 'string' ? answer['message'] : 'The relay refused the tunnel.')
      }
      port = answer['port']
    } catch (error) {
      socket.destroy()
      if (this.control === socket) this.control = null
      return this.scheduleRetry(error instanceof Error ? error.message : String(error))
    }
    this.backoff = 2000
    this.options.events.onState('online', { port, error: null })
    void this.listen(socket)
  }

  private async listen(socket: RelayConn): Promise<void> {
    for (;;) {
      let line: Record<string, unknown>
      try {
        // The relay pings every 25 s; silence for longer means the link is dead.
        line = await readLine(socket, 70_000)
      } catch (error) {
        socket.destroy()
        if (this.control === socket) this.control = null
        return this.scheduleRetry(error instanceof Error && error.message !== 'closed' ? error.message : 'Lost the connection to the relay.')
      }
      if (line['op'] === 'ping') writeLine(socket, { op: 'pong' })
      else if (line['op'] === 'tunnel-incoming' && typeof line['token'] === 'string') {
        void this.accept(line['token'], typeof line['from'] === 'string' ? line['from'] : '?')
      }
    }
  }

  private async accept(token: string, from: string): Promise<void> {
    let relay: RelayConn | null = null
    try {
      relay = await openRelay(this.options.relay)
      await readLine(relay, 8000)
      writeLine(relay, { op: 'tunnel-accept', token })
      const answer = await readLine(relay, 8000)
      if (answer['op'] !== 'ready') throw new Error('not ready')
    } catch {
      relay?.destroy()
      return
    }
    if (this.stopped) return void relay.destroy()
    const remote = relay
    const local = connect({ host: '127.0.0.1', port: this.options.target() })
    this.sessions.add(remote)
    this.sessions.add(local)
    let localPort = 0
    const close = (): void => {
      remote.destroy()
      local.destroy()
      this.sessions.delete(remote)
      this.sessions.delete(local)
      if (localPort) this.options.events.onSessionEnd?.(localPort)
      localPort = 0
    }
    remote.on('error', close)
    local.on('error', close)
    remote.once('close', close)
    local.once('close', close)
    local.once('connect', () => {
      localPort = local.localPort ?? 0
      if (localPort) this.options.events.onSession?.(from, localPort)
      remote.pipe(local)
      local.pipe(remote)
      remote.resume()
    })
  }
}

/**
 * Failed logins in the server's log that came through the tunnel (from
 * 127.0.0.1): their local source ports, to trace back to visitors.
 */
export const failedLoopbackPorts = (log: string): number[] => {
  const ports: number[] = []
  for (const line of log.split('\n')) {
    // One "Failed password" line per wrong attempt ("Invalid user" lines repeat the same attempt).
    const m = /Failed password for .* from (127\.0\.0\.1|::1) port (\d+)/.exec(line)
    if (m) ports.push(Number(m[2]))
  }
  return ports
}
