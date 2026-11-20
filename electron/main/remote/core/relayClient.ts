import { connect, type Socket } from 'node:net'
import { RELAY_REGISTER_LABEL, readLine, writeLine } from '../../../../tools/remote-relay/relay'
import { signTranscript, type LocalIdentity } from './crypto'

/*
 * The app's side of the optional self-hosted relay (tools/remote-relay).
 * Host: keeps one control connection registered under its device ID and
 * opens a data connection per incoming client. Client: asks the relay for a
 * device ID and gets a byte pipe to it. Either way the result is a plain
 * socket on which the normal end-to-end handshake runs.
 */

const splitHostPort = (relay: string): { host: string; port: number } => {
  const index = relay.lastIndexOf(':')
  return { host: relay.slice(0, index).replace(/^\[|\]$/g, ''), port: Number(relay.slice(index + 1)) }
}

const open = (relay: string, timeoutMs = 8000): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const { host, port } = splitHostPort(relay)
    const socket = connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('The relay did not answer.'))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 10_000)
      resolve(socket)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })

/** Client: a pipe to `deviceId` through the relay. */
export const dialThroughRelay = async (relay: string, deviceId: string): Promise<Socket> => {
  const socket = await open(relay)
  try {
    await readLine(socket, 8000)
    writeLine(socket, { op: 'connect', id: deviceId })
    const answer = await readLine(socket, 15_000)
    if (answer['op'] !== 'ready') throw new Error(typeof answer['message'] === 'string' ? answer['message'] : 'The relay refused the connection.')
    return socket
  } catch (error) {
    socket.destroy()
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** Is `deviceId` registered on the relay right now? */
export const relayLookup = async (relay: string, deviceId: string): Promise<boolean> => {
  const socket = await open(relay, 4000)
  try {
    await readLine(socket, 4000)
    writeLine(socket, { op: 'lookup', id: deviceId })
    const answer = await readLine(socket, 4000)
    return answer['op'] === 'status' && answer['online'] === true
  } finally {
    socket.destroy()
  }
}

export interface RelayHostEvents {
  onState: (state: 'connecting' | 'online' | 'error', error: string | null) => void
  /** A client is waiting: run the host handshake on this socket. */
  onIncoming: (socket: Socket, from: string) => void
}

/** Host: stays registered, reconnecting with backoff, until stopped. */
export class RelayHost {
  private control: Socket | null = null
  private stopped = false
  private retry: NodeJS.Timeout | null = null
  private backoff = 2000

  constructor(
    private readonly relay: string,
    private readonly identity: () => LocalIdentity,
    private readonly events: RelayHostEvents
  ) {}

  start(): void {
    this.stopped = false
    void this.connectLoop()
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.control?.destroy()
    this.control = null
  }

  private scheduleRetry(error: string): void {
    if (this.stopped) return
    this.events.onState('error', error)
    this.retry = setTimeout(() => void this.connectLoop(), this.backoff)
    this.backoff = Math.min(60_000, this.backoff * 2)
  }

  private async connectLoop(): Promise<void> {
    if (this.stopped) return
    this.events.onState('connecting', null)
    let socket: Socket
    try {
      socket = await open(this.relay)
    } catch (error) {
      return this.scheduleRetry(error instanceof Error ? error.message : String(error))
    }
    if (this.stopped) return void socket.destroy()
    this.control = socket
    try {
      const hello = await readLine(socket, 8000)
      const nonce = Buffer.from(typeof hello['nonce'] === 'string' ? hello['nonce'] : '', 'base64')
      const identity = this.identity()
      const sig = signTranscript(identity.privateKey, Buffer.concat([Buffer.from(RELAY_REGISTER_LABEL), nonce]))
      writeLine(socket, { op: 'register', id: identity.id, pub: identity.publicKey.toString('base64'), sig: sig.toString('base64') })
      const answer = await readLine(socket, 8000)
      if (answer['op'] !== 'registered') throw new Error(typeof answer['message'] === 'string' ? answer['message'] : 'The relay refused this computer.')
    } catch (error) {
      socket.destroy()
      return this.scheduleRetry(error instanceof Error ? error.message : String(error))
    }
    this.backoff = 2000
    this.events.onState('online', null)
    void this.listen(socket)
  }

  private async listen(socket: Socket): Promise<void> {
    for (;;) {
      let line: Record<string, unknown>
      try {
        // The relay pings every 25 s; silence for longer means the link is dead.
        line = await readLine(socket, 70_000)
      } catch (error) {
        socket.destroy()
        if (this.control === socket) this.control = null
        return this.scheduleRetry(error instanceof Error ? error.message : 'Lost the relay.')
      }
      if (line['op'] === 'ping') writeLine(socket, { op: 'pong' })
      else if (line['op'] === 'incoming' && typeof line['token'] === 'string') void this.accept(line['token'], typeof line['from'] === 'string' ? line['from'] : 'relay')
    }
  }

  private async accept(token: string, from: string): Promise<void> {
    let socket: Socket | null = null
    try {
      socket = await open(this.relay)
      await readLine(socket, 8000)
      writeLine(socket, { op: 'accept', token })
      const answer = await readLine(socket, 8000)
      if (answer['op'] !== 'ready') throw new Error('not ready')
      this.events.onIncoming(socket, `relay:${from}`)
    } catch {
      socket?.destroy()
    }
  }
}
