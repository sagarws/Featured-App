import type { TranscriptExportFormat, TranscriptLanguage, TranscriptModel, TranscriptSegment } from '../types/transcriber'

export const TRANSCRIPT_LANGUAGES: { value: TranscriptLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' }
]

/** Whisper builds on Hugging Face, downloaded into <userData>/models on first use. */
export const TRANSCRIPT_MODELS: Record<TranscriptModel, { id: string; dtype: 'q4' | 'q8'; files: string[]; sizeMb: number }> = {
  accurate: {
    id: 'onnx-community/whisper-large-v3-turbo',
    dtype: 'q4',
    files: ['onnx/encoder_model_q4.onnx', 'onnx/decoder_model_merged_q4.onnx'],
    sizeMb: 760
  },
  fast: {
    id: 'onnx-community/whisper-small',
    dtype: 'q8',
    // transformers.js names its q8 files "_quantized".
    files: ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'],
    sizeMb: 250
  }
}

export const isTranscriptLanguage = (v: unknown): v is TranscriptLanguage => v === 'en' || v === 'hi'
export const isTranscriptModel = (v: unknown): v is TranscriptModel => v === 'accurate' || v === 'fast'

/** The fast model is English-only: its Hindi output is unusable (it loops). */
export const modelSupports = (model: TranscriptModel, language: TranscriptLanguage): boolean => model === 'accurate' || language === 'en'

/** Files the picker and drag-and-drop accept. Anything ffmpeg reads would work; these are the common ones. */
export const MEDIA_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wma', 'aiff', 'aif']

export const isMediaFile = (name: string): boolean => MEDIA_EXTENSIONS.includes(name.split('.').pop()?.toLowerCase() ?? '')

const pad = (n: number, width = 2): string => String(Math.floor(n)).padStart(width, '0')

/** 3725.5 → "01:02:05,500" (SRT) or "01:02:05.500" (VTT). */
export const formatTimestamp = (seconds: number, separator: ',' | '.' = ','): string => {
  const ms = Math.max(0, Math.round(seconds * 1000))
  return `${pad(ms / 3_600_000)}:${pad((ms / 60_000) % 60)}:${pad((ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`
}

/** 65 → "1:05", 3725 → "1:02:05". */
export const formatClock = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  return h ? `${h}:${pad((s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

/** Plain text: one line per segment, optionally with its start time. */
export const toPlainText = (segments: TranscriptSegment[], withTimes = false): string =>
  segments.map(s => (withTimes ? `[${formatClock(s.start)}] ${s.text}` : s.text)).join('\n')

export const toSrt = (segments: TranscriptSegment[]): string =>
  segments.map((s, i) => `${i + 1}\n${formatTimestamp(s.start)} --> ${formatTimestamp(s.end)}\n${s.text}\n`).join('\n')

export const toVtt = (segments: TranscriptSegment[]): string =>
  `WEBVTT\n\n${segments.map(s => `${formatTimestamp(s.start, '.')} --> ${formatTimestamp(s.end, '.')}\n${s.text}\n`).join('\n')}`

export const exportTranscript = (segments: TranscriptSegment[], format: TranscriptExportFormat): string =>
  format === 'srt' ? toSrt(segments) : format === 'vtt' ? toVtt(segments) : toPlainText(segments)

/**
 * Where to cut 16 kHz audio into pieces Whisper can take (≤ 30 s each): near
 * `target` seconds, at the quietest moment in the last `window` seconds before
 * it, so a cut rarely lands mid-word. Returns sample offsets, first 0, last
 * `samples.length`.
 */
export const chunkBoundaries = (samples: Float32Array, sampleRate = 16_000, target = 28, window = 6): number[] => {
  const out = [0]
  const frame = Math.round(sampleRate * 0.1) // 100 ms energy frames
  let start = 0
  while (samples.length - start > target * sampleRate) {
    const hi = start + target * sampleRate
    const lo = hi - window * sampleRate
    let best = hi
    let bestEnergy = Infinity
    for (let f = lo; f + frame <= hi; f += frame) {
      let energy = 0
      for (let i = f; i < f + frame; i++) energy += samples[i]! * samples[i]!
      if (energy < bestEnergy) {
        bestEnergy = energy
        best = f + Math.floor(frame / 2)
      }
    }
    out.push(best)
    start = best
  }
  out.push(samples.length)
  return out
}

/**
 * Whisper sometimes gets stuck repeating one token ("ट्ट्ट्ट…") on a hard
 * piece of audio. Cut any run of the same 1–6 characters repeated more than
 * 8 times down to one, so a bad chunk cannot bury the transcript.
 */
export const collapseRepeats = (text: string): string => text.replace(/(.{1,6}?)\1{8,}/gu, '$1')
