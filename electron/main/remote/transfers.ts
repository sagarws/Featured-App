import { createHash, randomBytes, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, type WriteStream } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { FILE_CHUNK_BYTES } from '@shared/constants/remote'
import type { FileTransferInfo } from '@shared/types/remote'
import { safeFileName, uniqueName } from '@shared/utils/remote'
import { logger } from '../logger'
import type { Channel, WireMessage } from './core/channel'

/*
 * Files between the two computers, over the session's encrypted channel.
 *
 *   sender → file-offer {id, files:[{name,size}]}
 *   receiver → file-answer {id, accept}          (the person there decides,
 *                                                 or a trusted-folder policy)
 *   sender → file-chunk {id, i} + bytes …  file-end {id, i, sha256} … file-done
 *   either → file-cancel {id, reason}
 *
 * The receiver keeps only the last path component of each name (no ../),
 * strips reserved characters, never overwrites (name (2).ext), writes to
 * .part and renames only after the size and SHA-256 match. Received files are
 * never opened or executed.
 */

const MAX_FILES = 1000
const MAX_TOTAL = 100 * 1024 ** 3

export interface TransferLink {
  sessionId: string
  channel: () => Channel | null
  peerName: string
}

interface Outgoing {
  info: FileTransferInfo
  link: TransferLink
  paths: string[]
  cancelled: boolean
  resolveAnswer: ((accept: boolean) => void) | null
}

interface Incoming {
  info: FileTransferInfo
  link: TransferLink
  folder: string
  current: { index: number; stream: WriteStream; hash: Hash; written: number; part: string; final: string } | null
  saved: string[]
  /** Files being flushed and renamed. */
  pending: number
}

export interface TransferHost {
  /** Where incoming files go: a folder, or null = declined. Asks the person when the policy says so. */
  decide: (link: TransferLink, files: { name: string; size: number }[]) => Promise<string | null>
  changed: () => void
  done: (info: FileTransferInfo) => void
}

const speedTracker = () => {
  const samples: { at: number; bytes: number }[] = []
  return (total: number): number => {
    const now = Date.now()
    samples.push({ at: now, bytes: total })
    while (samples.length > 2 && now - samples[0]!.at > 3000) samples.shift()
    const first = samples[0]!
    return now - first.at > 200 ? ((total - first.bytes) * 1000) / (now - first.at) : 0
  }
}

/** Is `path` inside `folder` (after resolving)? Guards against anything that slipped past the name cleaning. */
export const insideFolder = (folder: string, path: string): boolean => {
  const root = resolve(folder) + sep
  return resolve(path).startsWith(root)
}

export class Transfers {
  private outgoing = new Map<string, Outgoing>()
  private incoming = new Map<string, Incoming>()
  private finished: FileTransferInfo[] = []
  private lastPush = 0

  constructor(private readonly host: TransferHost) {}

  list(): FileTransferInfo[] {
    return [...[...this.outgoing.values()].map(o => o.info), ...[...this.incoming.values()].map(i => i.info), ...this.finished].slice(0, 50)
  }

  private push(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastPush < 250) return
    this.lastPush = now
    this.host.changed()
  }

  private finish(info: FileTransferInfo): void {
    this.outgoing.delete(info.transferId)
    this.incoming.delete(info.transferId)
    this.finished = [info, ...this.finished.filter(f => f.transferId !== info.transferId)].slice(0, 20)
    this.host.done(info)
    this.push(true)
  }

  // ── sending ──

  async send(link: TransferLink, paths: string[]): Promise<void> {
    const files = paths.map(p => ({ name: basename(p), size: statSync(p).size }))
    if (!files.length) return
    if (files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files at a time.`)
    const total = files.reduce((n, f) => n + f.size, 0)
    if (total > MAX_TOTAL) throw new Error('That is too much data for one transfer.')
    const id = randomBytes(12).toString('hex')
    const out: Outgoing = {
      link,
      paths,
      cancelled: false,
      resolveAnswer: null,
      info: { transferId: id, sessionId: link.sessionId, direction: 'send', peerName: link.peerName, files, totalBytes: total, doneBytes: 0, speed: 0, state: 'waiting', error: null, folder: null, startedAt: Date.now() }
    }
    this.outgoing.set(id, out)
    this.push(true)
    const channel = link.channel()
    if (!channel) return this.fail(out.info, 'Not connected.')
    const answer = new Promise<boolean>(resolveAnswer => (out.resolveAnswer = resolveAnswer))
    channel.send({ t: 'file-offer', id, files })
    const accepted = await answer
    if (out.cancelled) return
    if (!accepted) {
      out.info.state = 'declined'
      out.info.error = 'The other computer declined the files.'
      return this.finish(out.info)
    }
    out.info.state = 'transferring'
    this.push(true)
    const speed = speedTracker()
    try {
      for (let i = 0; i < paths.length; i++) {
        const hash = createHash('sha256')
        const stream = createReadStream(paths[i]!, { highWaterMark: FILE_CHUNK_BYTES })
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          if (out.cancelled) {
            stream.destroy()
            return
          }
          const ch = link.channel()
          if (!ch || ch.isClosed) throw new Error('The connection was lost.')
          hash.update(chunk)
          if (!ch.send({ t: 'file-chunk', id, i }, chunk)) await ch.drain()
          out.info.doneBytes += chunk.length
          out.info.speed = speed(out.info.doneBytes)
          this.push()
        }
        link.channel()?.send({ t: 'file-end', id, i, sha256: hash.digest('hex') })
      }
      link.channel()?.send({ t: 'file-done', id })
      out.info.state = 'done'
      this.finish(out.info)
    } catch (error) {
      if (out.cancelled) return
      link.channel()?.send({ t: 'file-cancel', id, reason: 'The sender hit an error.' })
      this.fail(out.info, error instanceof Error ? error.message : String(error))
    }
  }

  // ── receiving ──

  private async offer(link: TransferLink, msg: WireMessage): Promise<void> {
    const id = typeof msg['id'] === 'string' && /^[0-9a-f]{24}$/.test(msg['id']) ? msg['id'] : null
    const raw = Array.isArray(msg['files']) ? (msg['files'] as unknown[]) : []
    if (!id || this.incoming.has(id)) return
    const files = raw
      .slice(0, MAX_FILES + 1)
      .map(f => {
        const entry = f as { name?: unknown; size?: unknown }
        const name = safeFileName(entry?.name)
        const size = typeof entry?.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : -1
        return name && size >= 0 ? { name, size } : null
      })
      .filter((f): f is { name: string; size: number } => f !== null)
    const total = files.reduce((n, f) => n + f.size, 0)
    const channel = link.channel()
    if (!files.length || files.length !== raw.length || files.length > MAX_FILES || total > MAX_TOTAL) {
      channel?.send({ t: 'file-answer', id, accept: false })
      return
    }
    const entry: Incoming = {
      link,
      folder: '',
      current: null,
      saved: [],
      pending: 0,
      info: { transferId: id, sessionId: link.sessionId, direction: 'receive', peerName: link.peerName, files, totalBytes: total, doneBytes: 0, speed: 0, state: 'offered', error: null, folder: null, startedAt: Date.now() }
    }
    this.incoming.set(id, entry)
    this.push(true)
    const folder = await this.host.decide(link, files).catch(() => null)
    if (!this.incoming.has(id)) return
    if (!folder) {
      link.channel()?.send({ t: 'file-answer', id, accept: false })
      entry.info.state = 'declined'
      return this.finish(entry.info)
    }
    mkdirSync(folder, { recursive: true })
    entry.folder = folder
    entry.info.folder = folder
    entry.info.state = 'transferring'
    link.channel()?.send({ t: 'file-answer', id, accept: true })
    this.push(true)
  }

  private speeds = new Map<string, (n: number) => number>()

  private chunk(msg: WireMessage, binary: Buffer | null): void {
    const entry = this.incoming.get(String(msg['id']))
    const index = msg['i']
    if (!entry || entry.info.state !== 'transferring' || !binary || typeof index !== 'number') return
    const file = entry.info.files[index]
    if (!file) return this.abort(entry, 'Unexpected data.')
    if (!entry.current || entry.current.index !== index) {
      if (entry.current) return this.abort(entry, 'A file arrived incomplete.')
      const final = join(entry.folder, uniqueName(file.name, n => existsSync(join(entry.folder, n)) || existsSync(join(entry.folder, `${n}.part`))))
      const part = `${final}.part`
      if (!insideFolder(entry.folder, final)) return this.abort(entry, 'Refused an unsafe file name.')
      entry.current = { index, stream: createWriteStream(part, { flags: 'wx' }), hash: createHash('sha256'), written: 0, part, final }
      entry.current.stream.on('error', error => this.abort(entry, error.message))
    }
    const current = entry.current
    current.written += binary.length
    if (current.written > file.size) return this.abort(entry, 'A file was larger than announced.')
    current.hash.update(binary)
    current.stream.write(binary)
    entry.info.doneBytes += binary.length
    const speed = this.speeds.get(entry.info.transferId) ?? speedTracker()
    this.speeds.set(entry.info.transferId, speed)
    entry.info.speed = speed(entry.info.doneBytes)
    this.push()
  }

  private fileEnd(msg: WireMessage): void {
    const entry = this.incoming.get(String(msg['id']))
    if (!entry || entry.info.state !== 'transferring') return
    const index = msg['i']
    const file = typeof index === 'number' ? entry.info.files[index] : undefined
    if (!file) return this.abort(entry, 'Unexpected data.')
    // An empty file has no chunks.
    if (!entry.current && file.size === 0) {
      const final = join(entry.folder, uniqueName(file.name, n => existsSync(join(entry.folder, n))))
      if (!insideFolder(entry.folder, final)) return this.abort(entry, 'Refused an unsafe file name.')
      createWriteStream(final, { flags: 'wx' }).end()
      entry.saved.push(final)
      return
    }
    const current = entry.current
    if (!current || current.index !== index) return this.abort(entry, 'A file arrived incomplete.')
    entry.current = null
    const digest = current.hash.digest('hex')
    entry.pending++
    current.stream.end(() => {
      entry.pending--
      if (current.written !== file.size || digest !== msg['sha256']) {
        rmSync(current.part, { force: true })
        return this.abort(entry, `${file.name} was damaged on the way.`)
      }
      try {
        renameSync(current.part, current.final)
        entry.saved.push(current.final)
      } catch (error) {
        this.abort(entry, error instanceof Error ? error.message : String(error))
      }
    })
  }

  private abort(entry: Incoming, reason: string, notify = true): void {
    if (entry.current) {
      const { stream, part } = entry.current
      stream.destroy()
      setTimeout(() => rmSync(part, { force: true }), 100)
      entry.current = null
    }
    if (notify) entry.link.channel()?.send({ t: 'file-cancel', id: entry.info.transferId, reason })
    this.fail(entry.info, reason)
  }

  private fail(info: FileTransferInfo, reason: string): void {
    info.state = info.state === 'cancelled' ? 'cancelled' : 'failed'
    info.error = reason
    logger.warn(`[remote] transfer ${info.transferId} ${info.state}: ${reason}`)
    this.finish(info)
  }

  /** A transfer message from `link`'s peer; true if it was one. */
  handle(link: TransferLink, msg: WireMessage, binary: Buffer | null): boolean {
    switch (msg.t) {
      case 'file-offer':
        void this.offer(link, msg)
        return true
      case 'file-answer': {
        const out = this.outgoing.get(String(msg['id']))
        out?.resolveAnswer?.(msg['accept'] === true)
        return true
      }
      case 'file-chunk':
        this.chunk(msg, binary)
        return true
      case 'file-end':
        this.fileEnd(msg)
        return true
      case 'file-done': {
        const entry = this.incoming.get(String(msg['id']))
        if (entry && entry.info.state === 'transferring') {
          if (entry.current) {
            this.abort(entry, 'A file arrived incomplete.')
            return true
          }
          // Done once the last files are flushed and renamed.
          const started = Date.now()
          const settle = (): void => {
            if (entry.info.state !== 'transferring') return
            if (entry.pending > 0 && Date.now() - started < 60_000) return void setTimeout(settle, 50)
            entry.info.state = 'done'
            this.finish(entry.info)
          }
          settle()
        }
        return true
      }
      case 'file-cancel': {
        const id = String(msg['id'])
        const reason = typeof msg['reason'] === 'string' ? msg['reason'].slice(0, 200) : 'Cancelled by the other computer.'
        const out = this.outgoing.get(id)
        if (out) {
          out.cancelled = true
          out.resolveAnswer?.(false)
          out.info.state = 'cancelled'
          this.fail(out.info, reason)
        }
        const entry = this.incoming.get(id)
        if (entry) {
          entry.info.state = 'cancelled'
          this.abort(entry, reason, false)
        }
        return true
      }
      default:
        return false
    }
  }

  cancel(transferId: string): void {
    const out = this.outgoing.get(transferId)
    if (out) {
      out.cancelled = true
      out.resolveAnswer?.(false)
      out.link.channel()?.send({ t: 'file-cancel', id: transferId, reason: 'Cancelled by the sender.' })
      out.info.state = 'cancelled'
      this.fail(out.info, 'Cancelled.')
    }
    const entry = this.incoming.get(transferId)
    if (entry) {
      entry.info.state = 'cancelled'
      this.abort(entry, 'Cancelled by the receiver.')
    }
  }

  /** The session ended: stop whatever was in flight for it. */
  endSession(sessionId: string): void {
    for (const out of [...this.outgoing.values()].filter(o => o.info.sessionId === sessionId)) {
      out.cancelled = true
      out.resolveAnswer?.(false)
      out.info.state = 'cancelled'
      this.fail(out.info, 'The session ended.')
    }
    for (const entry of [...this.incoming.values()].filter(i => i.info.sessionId === sessionId)) {
      entry.info.state = 'cancelled'
      this.abort(entry, 'The session ended.', false)
    }
  }
}
