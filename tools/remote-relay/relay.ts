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
 * No dependencies. Line-delimited JSON during setup, raw bytes after "ready".
 */
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'

const REGISTER_LABEL = 'featured-remote-relay/v1 register'
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const SETUP_TIMEOUT_MS = 10_000
const PING_MS = 25_000
const MAX_LINE = 8 * 1024

export const relayDeviceId = (spki: Buffer): string => {
  const digits = (createHash('sha256').update(spki).digest().readBigUInt64BE(0) % 1_000_000_000n).toString().padStart(9, '0')
  return `WD-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}`
}

/** Read one JSON line; the bytes after it are pushed back onto the socket. */
export const readLine = (socket: Socket, timeoutMs: number): Promise<Record<string, unknown>> =>
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

export const writeLine = (socket: Socket, value: Record<string, unknown>): void => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`)
}

interface Waiting {
  client: Socket
  timer: NodeJS.Timeout
}

export interface RelayOptions {
  port: number
  host?: string
  log?: (line: string) => void
}

export const startRelay = (options: RelayOptions): Promise<Server> => {
  const log = options.log ?? ((line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`))
  const hosts = new Map<string, Socket>()
  const waiting = new Map<string, Waiting>()
  const attempts = new Map<string, number[]>()

  const allowed = (address: string): boolean => {
    const now = Date.now()
    const list = (attempts.get(address) ?? []).filter(t => now - t < 60_000)
    list.push(now)
    attempts.set(address, list)
    return list.length <= 60
  }

  const handle = async (socket: Socket): Promise<void> => {
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
      writeLine(socket, { op: 'registered', id })
      log(`host online ${id} (${address})`)
      const ping = setInterval(() => writeLine(socket, { op: 'ping' }), PING_MS)
      socket.on('data', () => undefined)
      socket.resume()
      socket.once('close', () => {
        clearInterval(ping)
        if (hosts.get(id) === socket) hosts.delete(id)
        log(`host offline ${id}`)
      })
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
      writeLine(client, { op: 'ready' })
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

    socket.destroy()
  }

  const server = createServer(socket => {
    handle(socket).catch(() => socket.destroy())
  })
  return new Promise(resolve => server.listen(options.port, options.host ?? '0.0.0.0', () => resolve(server)))
}

export const RELAY_REGISTER_LABEL = REGISTER_LABEL

// Run directly: node tools/remote-relay/relay.ts [port]
const invokedDirectly = typeof process !== 'undefined' && process.argv[1] && /relay\.(ts|js|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  const port = Number(process.argv[2] ?? process.env['RELAY_PORT'] ?? 47900)
  void startRelay({ port }).then(() => process.stdout.write(`Featured App relay listening on :${port}\n`))
}
