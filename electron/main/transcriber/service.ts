import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, utilityProcess, type UtilityProcess } from 'electron'
import { TRANSCRIBER_IPC } from '@shared/constants/channels'
import type { TranscriptExportFormat, TranscriptJob, TranscriptLanguage, TranscriptModel, TranscriptModelInfo } from '@shared/types/transcriber'
import { exportTranscript, modelSupports, TRANSCRIPT_MODELS } from '@shared/utils/transcriber'
import { durableJsonNames, readDurableJson, removeDurableJson, writeDurableJson } from '../durableJson'
import { logger } from '../logger'
import { requireFfmpeg } from '../recorder/session'
import type { WorkerJob, WorkerMessage } from './worker'

/*
 * Transcription jobs, one at a time, in a utility process (worker.ts).
 *
 *   <userData>/transcripts/<id>.json   one durable record per job (result included)
 *   <userData>/models/                 Whisper models, downloaded on first use
 *
 * The worker stays alive between queued jobs so the model loads once, and
 * exits when the queue is empty to give its memory back.
 */

const transcriptsDir = (): string => join(app.getPath('userData'), 'transcripts')
const modelsDir = (): string => join(app.getPath('userData'), 'models')
const recordPath = (id: string): string => join(transcriptsDir(), `${id}.json`)

const jobs = new Map<string, TranscriptJob>()
let worker: UtilityProcess | null = null
let current: string | null = null

const isJob = (v: TranscriptJob): boolean => !!v && typeof v.id === 'string' && Array.isArray(v.segments)

const broadcast = (channel: string, payload?: unknown): void => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
}

const save = (job: TranscriptJob): void => {
  try {
    mkdirSync(transcriptsDir(), { recursive: true })
    writeDurableJson(recordPath(job.id), job)
  } catch (error) {
    logger.warn(`[transcriber] could not save ${job.id}: ${String(error)}`)
  }
}

/** Progress pushes are frequent; only status changes and results go to disk. */
const changed = (job: TranscriptJob, persist: boolean): void => {
  if (persist) save(job)
  broadcast(TRANSCRIBER_IPC.job, job)
}

/** On start: read saved jobs; any left mid-run by a quit or crash is marked failed. */
export const loadTranscripts = (): void => {
  const dir = transcriptsDir()
  if (!existsSync(dir)) return
  for (const name of durableJsonNames(readdirSync(dir))) {
    try {
      const job = readDurableJson<TranscriptJob>(join(dir, name), isJob)
      if (job.status === 'queued' || job.status === 'downloading' || job.status === 'transcribing') {
        Object.assign(job, { status: 'failed', error: 'The app closed before this transcript finished. Start it again.', finishedAt: new Date().toISOString() })
        save(job)
      }
      jobs.set(job.id, job)
    } catch (error) {
      logger.warn(`[transcriber] skipped ${name}: ${String(error)}`)
    }
  }
}

export const listJobs = (): TranscriptJob[] => [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

export const modelInfo = (): TranscriptModelInfo[] =>
  (Object.keys(TRANSCRIPT_MODELS) as TranscriptModel[]).map(model => {
    const { id, files, sizeMb } = TRANSCRIPT_MODELS[model]
    return { model, sizeMb, downloaded: files.every(f => existsSync(join(modelsDir(), id, f))) }
  })

const friendly = (message: string): string => {
  if (/fetch failed|ENOTFOUND|ECONNRE|ETIMEDOUT|EAI_AGAIN|network/i.test(message))
    return 'Could not download the speech model. Check your internet connection and try again (it is only needed the first time).'
  if (/ENOSPC/i.test(message)) return 'Not enough disk space for the speech model.'
  if (/Invalid data found|moov atom not found|could not find codec|Error opening input/i.test(message))
    return 'This file could not be read. It may be damaged, or not a video or audio file.'
  return message
}

const stopWorker = (): void => {
  const w = worker
  worker = null
  w?.kill()
}

const finish = (job: TranscriptJob, status: 'done' | 'failed' | 'cancelled', error: string | null = null): void => {
  Object.assign(job, { status, error, finishedAt: new Date().toISOString(), progress: status === 'done' ? 1 : job.progress })
  changed(job, true)
  current = null
  next()
}

const ensureWorker = (): UtilityProcess => {
  if (worker) return worker
  const w = utilityProcess.fork(join(__dirname, 'transcriberWorker.js'), [], { serviceName: 'Featured App Transcriber', stdio: 'pipe' })
  w.stderr?.on('data', (d: Buffer) => logger.warn(`[transcriber] ${d.toString().trim()}`))
  w.on('message', (message: WorkerMessage) => {
    const job = current ? jobs.get(current) : undefined
    if (!job || w !== worker) return
    switch (message.type) {
      case 'duration':
        job.durationSec = message.seconds
        changed(job, false)
        break
      case 'downloading': {
        const first = job.status !== 'downloading'
        Object.assign(job, { status: 'downloading', progress: message.progress })
        changed(job, first)
        break
      }
      case 'progress': {
        const first = job.status !== 'transcribing'
        Object.assign(job, { status: 'transcribing', progress: message.progress })
        job.segments.push(...message.segments)
        changed(job, first)
        break
      }
      case 'done':
        logger.info(`[transcriber] ${job.fileName}: ${job.segments.length} segments`)
        finish(job, 'done')
        break
      case 'error':
        logger.warn(`[transcriber] ${job.fileName} failed: ${message.message}`)
        finish(job, 'failed', friendly(message.message))
        break
    }
  })
  w.on('exit', code => {
    if (w !== worker) return // killed on purpose
    worker = null
    const job = current ? jobs.get(current) : undefined
    if (job) finish(job, 'failed', `The transcriber stopped unexpectedly (code ${code}). The file may be too long for the memory available.`)
  })
  worker = w
  return w
}

/** Starts the oldest queued job, or lets the worker go when there is none. */
const next = (): void => {
  if (current) return
  const queued = listJobs()
    .filter(j => j.status === 'queued')
    .at(-1)
  if (!queued) {
    stopWorker()
    return
  }
  let ffmpeg: string
  try {
    ffmpeg = requireFfmpeg().ffmpeg
  } catch (error) {
    finish(queued, 'failed', error instanceof Error ? error.message : String(error))
    return
  }
  if (!existsSync(queued.sourcePath)) {
    finish(queued, 'failed', 'The file was moved or deleted.')
    return
  }
  current = queued.id
  mkdirSync(modelsDir(), { recursive: true })
  const message: WorkerJob = { type: 'run', ffmpeg, file: queued.sourcePath, language: queued.language, model: queued.model, cacheDir: modelsDir() }
  ensureWorker().postMessage(message)
}

export const startJobs = (files: string[], language: TranscriptLanguage, model: TranscriptModel): TranscriptJob[] => {
  if (!modelSupports(model, language)) throw new Error('The fast model only supports English. Choose High accuracy for Hindi.')
  const created = files.map((file, i): TranscriptJob => {
    if (!existsSync(file)) throw new Error(`File not found: ${basename(file)}`)
    return {
      id: randomUUID(),
      sourcePath: file,
      fileName: basename(file),
      language,
      model,
      status: 'queued',
      progress: 0,
      durationSec: null,
      segments: [],
      error: null,
      // Keep the picked order: later files are a millisecond "newer".
      createdAt: new Date(Date.now() + i).toISOString(),
      finishedAt: null
    }
  })
  for (const job of created) {
    jobs.set(job.id, job)
    save(job)
  }
  broadcast(TRANSCRIBER_IPC.listChanged)
  next()
  return created
}

const getJob = (id: string): TranscriptJob => {
  const job = jobs.get(id)
  if (!job) throw new Error('Transcript not found.')
  return job
}

export const cancelJob = (id: string): void => {
  const job = getJob(id)
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return
  if (current === id) stopWorker()
  finish(job, 'cancelled')
}

export const removeJob = (id: string): void => {
  const job = getJob(id)
  if (current === id) {
    stopWorker()
    current = null
  }
  jobs.delete(id)
  removeDurableJson(recordPath(job.id))
  broadcast(TRANSCRIBER_IPC.listChanged)
  next()
}

export const exportJob = async (parent: BrowserWindow | null, id: string, format: TranscriptExportFormat): Promise<string | null> => {
  const job = getJob(id)
  if (!job.segments.length) throw new Error('This transcript is empty.')
  const base = job.fileName.replace(/\.[^.]+$/, '')
  const options = {
    title: 'Save transcript',
    defaultPath: join(app.getPath('documents'), `${base}.${format}`),
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  }
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  // BOM so Notepad and Excel read Hindi (UTF-8) correctly.
  await writeFile(result.filePath, `\uFEFF${exportTranscript(job.segments, format)}`, 'utf8')
  return result.filePath
}

export const shutdownTranscriber = (): void => {
  stopWorker()
}
