import { createCipheriv, createDecipheriv } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'

/*
 * One TCP connection, as a stream of messages.
 *
 * Frame:   [u32 length][payload]
 * Payload: before keys — the message itself;
 *          after keys  — AES-256-GCM(message) ‖ 16-byte tag, nonce = 4 zero
 *          bytes ‖ u64 counter. Each direction has its own key and counter,
 *          and a receiver accepts only the next counter: a replayed, dropped,
 *          reordered or altered frame ends the connection.
 * Message: [u8 kind][u32 json length][json][binary…]  (binary for file chunks)
 */

const TAG_BYTES = 16
/** Before authentication a peer may not make us buffer much. */
export const HANDSHAKE_MAX_FRAME = 64 * 1024
export const SESSION_MAX_FRAME = 2 * 1024 * 1024

export type WireMessage = Record<string, unknown> & { t: string }

export interface Received {
  msg: WireMessage
  binary: Buffer | null
}

export class ChannelClosedError extends Error {
  constructor(message = 'The connection closed.') {
    super(message)
    this.name = 'ChannelClosedError'
  }
}

const nonceFor = (counter: bigint): Buffer => {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64BE(counter, 4)
  return nonce
}

export class Channel extends EventEmitter {
  private chunks: Buffer[] = []
  private buffered = 0
  private sendKey: Buffer | null = null
  private recvKey: Buffer | null = null
  private sendCounter = 0n
  private recvCounter = 0n
  private queue: Received[] = []
  private waiters: { resolve: (r: Received) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null }[] = []
  private closed = false
  private closeReason: string | null = null
  private pushMode = false
  maxFrame = HANDSHAKE_MAX_FRAME
  lastReceivedAt = Date.now()

  constructor(readonly socket: Duplex) {
    super()
    socket.on('data', (data: Buffer) => this.onData(data))
    socket.on('close', () => this.finish('The connection closed.'))
    socket.on('end', () => this.finish('The other side closed the connection.'))
    socket.on('error', (error: Error) => this.finish(error.message))
    // A socket handed over from the relay setup was paused explicitly; a new
    // 'data' listener alone does not restart it.
    socket.resume()
  }

  get isClosed(): boolean {
    return this.closed
  }

  get encrypted(): boolean {
    return this.sendKey !== null
  }

  /** Switch to encrypted frames, from the next frame on, in both directions. */
  setKeys(sendKey: Buffer, recvKey: Buffer): void {
    this.sendKey = sendKey
    this.recvKey = recvKey
  }

  /** Raw frame — used for the hello messages, whose exact bytes are hashed into the transcript. */
  sendRaw(payload: Buffer): void {
    if (this.closed) throw new ChannelClosedError(this.closeReason ?? undefined)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(payload.length)
    this.socket.write(Buffer.concat([header, payload]))
  }

  send(msg: WireMessage, binary?: Buffer): boolean {
    if (this.closed) return false
    const json = Buffer.from(JSON.stringify(msg))
    const head = Buffer.alloc(5)
    head.writeUInt8(binary ? 1 : 0, 0)
    head.writeUInt32BE(json.length, 1)
    let payload = Buffer.concat(binary ? [head, json, binary] : [head, json])
    if (this.sendKey) {
      const cipher = createCipheriv('aes-256-gcm', this.sendKey, nonceFor(this.sendCounter++))
      payload = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()])
    }
    const header = Buffer.alloc(4)
    header.writeUInt32BE(payload.length)
    return this.socket.write(Buffer.concat([header, payload]))
  }

  /** Resolves once the socket has room again (file transfer backpressure). */
  drain(): Promise<void> {
    const writable = this.socket as Duplex & { writableNeedDrain?: boolean }
    if (this.closed || !writable.writableNeedDrain) return Promise.resolve()
    return new Promise(resolve => {
      const done = (): void => {
        this.socket.off('drain', done)
        this.off('close', done)
        resolve()
      }
      this.socket.on('drain', done)
      this.on('close', done)
    })
  }

  /** The next message (handshake phase). */
  receive(timeoutMs: number): Promise<Received> {
    const next = this.queue.shift()
    if (next) return Promise.resolve(next)
    if (this.closed) return Promise.reject(new ChannelClosedError(this.closeReason ?? undefined))
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null as NodeJS.Timeout | null }
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter)
        reject(new Error('The other computer did not answer in time.'))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  /** The next raw frame (handshake phase, before any JSON parsing). */
  private rawWaiter: ((frame: Buffer) => void) | null = null
  private rawQueue: Buffer[] = []
  private rawMode = true

  receiveRaw(timeoutMs: number): Promise<Buffer> {
    const next = this.rawQueue.shift()
    if (next) return Promise.resolve(next)
    if (this.closed) return Promise.reject(new ChannelClosedError(this.closeReason ?? undefined))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rawWaiter = null
        this.off('close', onClose)
        reject(new Error('The other computer did not answer in time.'))
      }, timeoutMs)
      const onClose = (): void => {
        clearTimeout(timer)
        this.rawWaiter = null
        reject(new ChannelClosedError(this.closeReason ?? undefined))
      }
      this.once('close', onClose)
      this.rawWaiter = frame => {
        clearTimeout(timer)
        this.off('close', onClose)
        this.rawWaiter = null
        resolve(frame)
      }
    })
  }

  /** From now on frames are parsed as messages (after the hello frames). */
  endRawMode(): void {
    this.rawMode = false
    const pending = this.rawQueue
    this.rawQueue = []
    for (const frame of pending) this.onFrame(frame)
  }

  /** From now on every message is emitted as 'message' instead of queued. */
  startPushMode(): void {
    this.pushMode = true
    const pending = this.queue
    this.queue = []
    for (const item of pending) this.emit('message', item)
  }

  close(reason = 'Closed.'): void {
    this.finish(reason)
    this.socket.destroy()
  }

  /** Send a last message, then close once it is flushed (or after a short grace). */
  closeAfter(msg: WireMessage): void {
    if (this.closed) return
    this.send(msg)
    this.socket.end()
    setTimeout(() => this.close('Closed.'), 1000).unref()
  }

  private finish(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    for (const w of this.waiters) {
      if (w.timer) clearTimeout(w.timer)
      w.reject(new ChannelClosedError(reason))
    }
    this.waiters = []
    this.emit('close', reason)
  }

  private onData(data: Buffer): void {
    if (this.closed) return
    this.lastReceivedAt = Date.now()
    this.chunks.push(data)
    this.buffered += data.length
    while (this.buffered >= 4) {
      const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks)
      this.chunks = [all]
      const length = all.readUInt32BE(0)
      if (length > this.maxFrame) {
        this.close('Message too large.')
        return
      }
      if (all.length < 4 + length) return
      const frame = all.subarray(4, 4 + length)
      const rest = all.subarray(4 + length)
      this.chunks = rest.length ? [rest] : []
      this.buffered = rest.length
      if (this.rawMode) {
        if (this.rawWaiter) this.rawWaiter(Buffer.from(frame))
        else this.rawQueue.push(Buffer.from(frame))
        if (this.rawQueue.length > 4) return this.close('Unexpected data.')
      } else {
        this.onFrame(frame)
      }
      if (this.closed) return
    }
  }

  private onFrame(frame: Buffer): void {
    let payload = frame
    if (this.recvKey) {
      if (frame.length < TAG_BYTES + 5) return this.close('Corrupt message.')
      try {
        const decipher = createDecipheriv('aes-256-gcm', this.recvKey, nonceFor(this.recvCounter))
        decipher.setAuthTag(frame.subarray(frame.length - TAG_BYTES))
        payload = Buffer.concat([decipher.update(frame.subarray(0, frame.length - TAG_BYTES)), decipher.final()])
        this.recvCounter++
      } catch {
        // Altered, replayed, reordered or wrong key: never act on it.
        return this.close('A message failed its integrity check.')
      }
    }
    if (payload.length < 5) return this.close('Corrupt message.')
    const kind = payload.readUInt8(0)
    const jsonLength = payload.readUInt32BE(1)
    if (5 + jsonLength > payload.length) return this.close('Corrupt message.')
    let msg: unknown
    try {
      msg = JSON.parse(payload.subarray(5, 5 + jsonLength).toString('utf8'))
    } catch {
      return this.close('Corrupt message.')
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as WireMessage).t !== 'string') return this.close('Corrupt message.')
    const item: Received = { msg: msg as WireMessage, binary: kind === 1 ? Buffer.from(payload.subarray(5 + jsonLength)) : null }
    if (this.pushMode) {
      this.emit('message', item)
      return
    }
    const waiter = this.waiters.shift()
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(item)
    } else {
      this.queue.push(item)
      if (this.queue.length > 64) this.close('Too many messages.')
    }
  }
}
