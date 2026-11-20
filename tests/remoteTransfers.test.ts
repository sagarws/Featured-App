import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../electron/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), path: () => null } }))

import { Channel, type Received } from '../electron/main/remote/core/channel'
import { randomToken } from '../electron/main/remote/core/crypto'
import { Transfers, type TransferLink } from '../electron/main/remote/transfers'
import type { FileTransferInfo } from '../shared/types/remote'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(f => f()))

/** Two encrypted channels connected over real TCP. */
const pair = async (): Promise<[Channel, Channel]> => {
  const server: Server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const accepted = new Promise<Socket>(resolve => server.once('connection', resolve))
  const client = connect(port, '127.0.0.1')
  const host = await accepted
  cleanup.push(() => {
    client.destroy()
    host.destroy()
    server.close()
  })
  const a = new Channel(client)
  const b = new Channel(host)
  const k1 = randomToken()
  const k2 = randomToken()
  a.setKeys(k1, k2)
  b.setKeys(k2, k1)
  for (const c of [a, b]) {
    c.maxFrame = 2 * 1024 * 1024
    c.endRawMode()
    c.startPushMode()
  }
  return [a, b]
}

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-transfer-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const setup = async (receiveFolder: string | null) => {
  const [a, b] = await pair()
  const done: FileTransferInfo[] = []
  const sender = new Transfers({ decide: () => Promise.resolve(null), changed: () => undefined, done: info => done.push(info) })
  const receiver = new Transfers({ decide: () => Promise.resolve(receiveFolder), changed: () => undefined, done: info => done.push(info) })
  const linkA: TransferLink = { sessionId: 's', channel: () => a, peerName: 'B' }
  const linkB: TransferLink = { sessionId: 's', channel: () => b, peerName: 'A' }
  a.on('message', ({ msg, binary }: Received) => sender.handle(linkA, msg, binary))
  b.on('message', ({ msg, binary }: Received) => receiver.handle(linkB, msg, binary))
  const settled = (direction: 'send' | 'receive') =>
    vi.waitFor(
      () => {
        const info = done.find(d => d.direction === direction)
        if (!info) throw new Error('not yet')
        return info
      },
      { timeout: 10_000, interval: 20 }
    )
  return { sender, receiver, linkA, settled }
}

describe('file transfer', () => {
  it('sends several files intact, including a large one, into the chosen folder', async () => {
    const src = tempDir()
    const dest = tempDir()
    const big = Buffer.alloc(3 * 1024 * 1024 + 123)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251
    writeFileSync(join(src, 'big.bin'), big)
    writeFileSync(join(src, 'notes.txt'), 'hello')
    writeFileSync(join(src, 'empty.txt'), '')
    writeFileSync(join(dest, 'notes.txt'), 'already here')
    const { sender, linkA, settled } = await setup(dest)

    await sender.send(linkA, [join(src, 'big.bin'), join(src, 'notes.txt'), join(src, 'empty.txt')])
    const received = await settled('receive')
    expect(received.state).toBe('done')
    expect((await settled('send')).state).toBe('done')
    expect(readFileSync(join(dest, 'big.bin')).equals(big)).toBe(true)
    // Never overwrites what was there.
    expect(readFileSync(join(dest, 'notes.txt'), 'utf8')).toBe('already here')
    expect(readFileSync(join(dest, 'notes (2).txt'), 'utf8')).toBe('hello')
    expect(readFileSync(join(dest, 'empty.txt'), 'utf8')).toBe('')
    expect(readdirSync(dest).some(n => n.endsWith('.part'))).toBe(false)
  })

  it('does nothing when the receiver declines', async () => {
    const src = tempDir()
    writeFileSync(join(src, 'a.txt'), 'x')
    const { sender, linkA, settled } = await setup(null)
    await sender.send(linkA, [join(src, 'a.txt')])
    expect((await settled('send')).state).toBe('declined')
  })

  it('a traversal name from a malicious sender lands inside the folder', async () => {
    const dest = tempDir()
    const [a, b] = await pair()
    const done: FileTransferInfo[] = []
    const receiver = new Transfers({ decide: () => Promise.resolve(dest), changed: () => undefined, done: info => done.push(info) })
    const linkB: TransferLink = { sessionId: 's', channel: () => b, peerName: 'evil' }
    b.on('message', ({ msg, binary }: Received) => receiver.handle(linkB, msg, binary))
    const answered = new Promise<Record<string, unknown>>(resolve => a.on('message', ({ msg }: Received) => msg.t === 'file-answer' && resolve(msg)))
    const id = 'ab'.repeat(12)
    a.send({ t: 'file-offer', id, files: [{ name: '../../../escape.txt', size: 3 }] })
    expect((await answered)['accept']).toBe(true)
    const { createHash } = await import('node:crypto')
    a.send({ t: 'file-chunk', id, i: 0 }, Buffer.from('pwn'))
    a.send({ t: 'file-end', id, i: 0, sha256: createHash('sha256').update('pwn').digest('hex') })
    a.send({ t: 'file-done', id })
    await vi.waitFor(() => expect(done[0]?.state).toBe('done'), { timeout: 5000 })
    expect(readdirSync(dest)).toEqual(['escape.txt'])
  })

  it('refuses a file that does not match its checksum or announced size', async () => {
    const dest = tempDir()
    const [a, b] = await pair()
    const done: FileTransferInfo[] = []
    const receiver = new Transfers({ decide: () => Promise.resolve(dest), changed: () => undefined, done: info => done.push(info) })
    b.on('message', ({ msg, binary }: Received) => receiver.handle({ sessionId: 's', channel: () => b, peerName: 'x' }, msg, binary))
    const answered = new Promise(resolve => a.on('message', ({ msg }: Received) => msg.t === 'file-answer' && resolve(msg)))
    const id = 'cd'.repeat(12)
    a.send({ t: 'file-offer', id, files: [{ name: 'a.txt', size: 4 }] })
    await answered
    a.send({ t: 'file-chunk', id, i: 0 }, Buffer.from('data'))
    a.send({ t: 'file-end', id, i: 0, sha256: '0'.repeat(64) })
    await vi.waitFor(() => expect(done[0]?.state).toBe('failed'), { timeout: 5000 })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(readdirSync(dest)).toEqual([])
  })
})
