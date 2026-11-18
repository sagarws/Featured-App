import { createReadStream, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { BrowserWindow} from 'electron';
import { dialog, protocol, shell } from 'electron'
import { MEDIA_SCHEME } from '@shared/constants/recorder'
import type { RecordingSummary, RecoveryResult, SessionManifest } from '@shared/types/recorder'
import { isInterrupted, safeRecordingFileName, uniqueName } from '@shared/utils/recorder'
import { logger } from '../logger'
import { getSettings } from '../settings'
import { readSegments } from './segmenter'
import { broadcastLibraryChanged, finalizeSession, isMerging } from './session'
import { findSession, listSessions, recordingsRoot, saveManifest } from './storage'

/*
 * The recordings library (list, rename, delete, export, open location),
 * crash recovery, and the recording-media:// protocol that streams files
 * into the window for preview.
 */

const summary = (dir: string, m: SessionManifest): RecordingSummary => {
  const segments = m.status === 'complete' && m.segments.length === 0 ? [] : readSegments(dir, false)
  const file = m.final ? join(dir, m.final.file) : null
  return {
    id: m.id,
    kind: m.kind,
    name: m.name,
    status: m.status,
    createdAt: m.createdAt,
    duration: m.final?.duration ?? m.recordedSeconds,
    bytes: file && existsSync(file) ? statSync(file).size : segments.reduce((sum, s) => sum + s.bytes, 0),
    dir,
    file: file && existsSync(file) ? file : null,
    thumbnail: m.thumbnail && existsSync(join(dir, m.thumbnail)) ? join(dir, m.thumbnail) : null,
    segments,
    note: m.note
  }
}

export const listRecordings = (): RecordingSummary[] => listSessions().map(({ dir, manifest }) => summary(dir, manifest))

const session = (id: string): { dir: string; manifest: SessionManifest } => {
  const found = findSession(id)
  if (!found) throw new Error('That recording no longer exists.')
  return found
}

const busy = (id: string): void => {
  if (isMerging(id)) throw new Error('That recording is still being recorded or saved.')
}

export const renameRecording = (id: string, name: string): void => {
  busy(id)
  const clean = name.trim().slice(0, 120)
  if (!clean) throw new Error('Enter a name.')
  const { dir, manifest } = session(id)
  manifest.name = clean
  if (manifest.final) {
    const ext = extname(manifest.final.file)
    const current = join(dir, manifest.final.file)
    const base = uniqueName(safeRecordingFileName(clean), n => n + ext !== manifest.final?.file && existsSync(join(dir, n + ext)))
    if (existsSync(current) && base + ext !== manifest.final.file) {
      renameSync(current, join(dir, base + ext))
      manifest.final.file = base + ext
    }
  }
  saveManifest(dir, manifest)
  broadcastLibraryChanged()
}

/** To the OS trash, so a mis-click can be undone there. */
export const deleteRecording = async (id: string): Promise<void> => {
  busy(id)
  const { dir } = session(id)
  try {
    await shell.trashItem(dir)
  } catch (error) {
    logger.warn('[recorder] trash failed, deleting', error)
    rmSync(dir, { recursive: true, force: true })
  }
  broadcastLibraryChanged()
}

export const exportRecording = async (id: string, parent: BrowserWindow | null): Promise<string | null> => {
  const { dir, manifest } = session(id)
  if (!manifest.final) throw new Error('This recording has not been merged into one file yet.')
  const source = join(dir, manifest.final.file)
  const options = { defaultPath: manifest.final.file, title: 'Export recording' }
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  // Streams, never loads the file into memory.
  await copyFile(source, result.filePath)
  return result.filePath
}

export const openRecordingLocation = (id: string): void => {
  const { dir, manifest } = session(id)
  const file = manifest.final ? join(dir, manifest.final.file) : null
  if (file && existsSync(file)) shell.showItemInFolder(file)
  else void shell.openPath(dir)
}

/** Joins a stopped (or failed) session's segments by hand. */
export const mergeRecording = async (id: string): Promise<string> => {
  busy(id)
  const { dir, manifest } = session(id)
  if (manifest.final) throw new Error('This recording is already one file.')
  try {
    return (await finalizeSession(dir, manifest)).file
  } finally {
    broadcastLibraryChanged()
  }
}

// ── recovery ────────────────────────────────────────────────────────────────

/**
 * Sessions the app was still working on when it last stopped. Run once at
 * start, before anything records: they are marked 'interrupted' so the state
 * on disk says so even if the user ignores the prompt.
 */
export const markInterruptedSessions = (): number => {
  let count = 0
  for (const { dir, manifest } of listSessions()) {
    if (manifest.status === 'interrupted' || !isInterrupted(manifest)) continue
    manifest.status = 'interrupted'
    manifest.note = manifest.note ?? 'The app closed unexpectedly while recording.'
    manifest.segments = readSegments(dir, false)
    try {
      saveManifest(dir, manifest)
      count++
    } catch (error) {
      logger.error('[recorder] could not mark session interrupted', error)
    }
  }
  if (count) logger.warn(`[recorder] ${count} interrupted recording(s) found`)
  return count
}

export const listInterrupted = (): RecordingSummary[] =>
  getSettings().recorder.recoverInterrupted
    ? listSessions()
        .filter(s => s.manifest.status === 'interrupted')
        .map(s => summary(s.dir, s.manifest))
    : []

export const recoverRecording = async (id: string): Promise<RecoveryResult> => {
  busy(id)
  const { dir, manifest } = session(id)
  try {
    const result = await finalizeSession(dir, manifest)
    return { file: result.file, recovered: result.used, skipped: result.skipped }
  } finally {
    broadcastLibraryChanged()
  }
}

// ── recording-media:// ──────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg'
}

/** Must run before app ready. */
export const registerMediaScheme = (): void => {
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])
}

/**
 * Serves files from the recordings folder only, with Range support so long
 * videos seek without being read whole.
 */
export const registerMediaProtocol = (): void => {
  protocol.handle(MEDIA_SCHEME, request => {
    try {
      const url = new URL(request.url)
      const file = resolve(decodeURIComponent(url.pathname.slice(1)))
      const root = resolve(recordingsRoot())
      const rel = relative(root, file)
      if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || !existsSync(file)) return new Response('Not found', { status: 404 })
      const size = statSync(file).size
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
      const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '')
      if (range) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
        if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
        return new Response(body, {
          status: 206,
          headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' }
        })
      }
      const body = Readable.toWeb(createReadStream(file)) as ReadableStream
      return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
    } catch (error) {
      logger.warn('[recorder] media request failed', error)
      return new Response('Error', { status: 500 })
    }
  })
}
