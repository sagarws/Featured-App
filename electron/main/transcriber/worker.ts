import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { join } from 'node:path'
import type * as Transformers from '@huggingface/transformers'
import type { TranscriptLanguage, TranscriptModel, TranscriptSegment } from '@shared/types/transcriber'
import { chunkBoundaries, collapseRepeats, TRANSCRIPT_MODELS } from '@shared/utils/transcriber'

/*
 * Runs in an Electron utility process (see service.ts), so the model — over
 * 1 GB in memory, with seconds of CPU per chunk — never blocks or bloats the
 * main process, and Cancel is just killing this process.
 *
 * Per job: ffmpeg decodes the file's audio to 16 kHz mono floats on stdout →
 * cut into ≤ 30 s chunks at quiet moments → Whisper on each chunk, with the
 * language fixed → segments streamed back as each chunk finishes.
 */

export interface WorkerJob {
  type: 'run'
  ffmpeg: string
  file: string
  language: TranscriptLanguage
  model: TranscriptModel
  cacheDir: string
}

export type WorkerMessage =
  | { type: 'duration'; seconds: number }
  | { type: 'downloading'; progress: number }
  | { type: 'progress'; progress: number; segments: TranscriptSegment[] }
  | { type: 'done' }
  | { type: 'error'; message: string }

const SAMPLE_RATE = 16_000

/*
 * transformers.js loads `sharp` (native image library) at startup and throws
 * if it is missing. Images are never used here, so a stand-in is given and
 * sharp is not shipped (it would need a native build per platform/arch).
 */
const loadTransformers = (): typeof Transformers => {
  const mod = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }
  const original = mod._load
  mod._load = function (request: string, ...rest: unknown[]) {
    if (request === 'sharp')
      return () => {
        throw new Error('Image input is not supported.')
      }
    return original.call(this, request, ...rest)
  }
  return createRequire(__filename)('@huggingface/transformers') as typeof Transformers
}

let transformers: typeof Transformers | null = null

/** Loaded on first use, so a machine without a speech engine build gets a message, not a crash. */
const getTransformers = (): typeof Transformers => {
  try {
    transformers ??= loadTransformers()
    return transformers
  } catch (error) {
    throw new Error(
      `Transcription is not available on this computer (${process.platform} ${process.arch}): the speech engine could not be loaded. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}

type Asr = Awaited<ReturnType<typeof Transformers.pipeline<'automatic-speech-recognition'>>>
const loaded = new Map<TranscriptModel, Asr>()

const send = (message: WorkerMessage): void => process.parentPort.postMessage(message)

/** The whole audio track as 16 kHz mono float samples. */
const decodeAudio = (ffmpeg: string, file: string): Promise<Float32Array> =>
  new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000)
    })
    child.on('error', reject)
    child.on('close', code => {
      const all = Buffer.concat(chunks)
      if (code !== 0 || all.length < 4) {
        const reason = /does not contain any stream|Output file .* does not contain|matches no streams/i.test(stderr)
          ? 'This file has no audio track.'
          : stderr.trim().split('\n').pop() || 'The file could not be read.'
        reject(new Error(code === 0 ? 'This file has no audio track.' : reason))
        return
      }
      // Copy into an aligned buffer: Buffer.concat may hand back an unaligned view.
      const samples = new Float32Array(Math.floor(all.length / 4))
      new Uint8Array(samples.buffer).set(all.subarray(0, samples.length * 4))
      resolve(samples)
    })
  })

const loadModel = async (model: TranscriptModel, cacheDir: string): Promise<Asr> => {
  const existing = loaded.get(model)
  if (existing) return existing
  const transformers = getTransformers()
  transformers.env.cacheDir = cacheDir
  transformers.env.allowLocalModels = false
  const { id, dtype, files } = TRANSCRIPT_MODELS[model]
  // Progress events also fire while reading cached files; only report a real download.
  const cached = files.every(f => existsSync(join(cacheDir, id, f)))
  let last = -1
  const asr = await transformers.pipeline('automatic-speech-recognition', id, {
    device: 'cpu',
    dtype: { encoder_model: dtype, decoder_model_merged: dtype } as never,
    progress_callback: (info: { status: string; progress?: number }) => {
      // Only reported while files are actually downloading (not when cached).
      if (cached || info.status !== 'progress_total' || typeof info.progress !== 'number') return
      const p = Math.min(1, info.progress / 100)
      if (p - last >= 0.01 || p === 1) {
        last = p
        send({ type: 'downloading', progress: p })
      }
    }
  })
  loaded.set(model, asr)
  return asr
}

type AsrOutput = { text: string; chunks?: { timestamp: [number, number | null]; text: string }[] }

const run = async (job: WorkerJob): Promise<void> => {
  const samples = await decodeAudio(job.ffmpeg, job.file)
  const duration = samples.length / SAMPLE_RATE
  send({ type: 'duration', seconds: duration })
  if (duration < 0.3) throw new Error('The audio is too short to transcribe.')

  const asr = await loadModel(job.model, job.cacheDir)
  const bounds = chunkBoundaries(samples, SAMPLE_RATE)
  send({ type: 'progress', progress: 0, segments: [] })

  for (let i = 0; i + 1 < bounds.length; i++) {
    const from = bounds[i]!
    const to = bounds[i + 1]!
    const offset = from / SAMPLE_RATE
    const end = to / SAMPLE_RATE
    const out = (await asr(samples.subarray(from, to), {
      language: job.language,
      task: 'transcribe',
      return_timestamps: true
    })) as AsrOutput

    const parts = out.chunks?.length ? out.chunks : [{ timestamp: [0, end - offset] as [number, number | null], text: out.text }]
    const segments: TranscriptSegment[] = []
    for (const part of parts) {
      const text = collapseRepeats(part.text).trim()
      if (!text) continue
      const start = Math.min(end, offset + (part.timestamp[0] ?? 0))
      const stop = Math.min(end, part.timestamp[1] === null ? end : offset + part.timestamp[1])
      segments.push({ start, end: Math.max(start, stop), text })
    }
    send({ type: 'progress', progress: to / samples.length, segments })
  }
}

process.parentPort.on('message', event => {
  const job = event.data as WorkerJob
  if (job?.type !== 'run') return
  run(job).then(
    () => send({ type: 'done' }),
    (error: unknown) => send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  )
})
