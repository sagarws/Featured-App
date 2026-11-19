/**
 * Transcripts: speech in an uploaded video or audio file turned into text,
 * on this machine (Whisper via transformers.js, see electron/main/transcriber).
 */

/** The language spoken in the file. Whisper is told it, not left to guess. */
export type TranscriptLanguage = 'en' | 'hi'

/**
 * accurate: Whisper large-v3-turbo (4-bit), good for Hindi and English.
 * fast: Whisper small (8-bit), about 5× quicker, English only.
 */
export type TranscriptModel = 'accurate' | 'fast'

export type TranscriptStatus = 'queued' | 'downloading' | 'transcribing' | 'done' | 'failed' | 'cancelled'

export interface TranscriptSegment {
  /** Seconds from the start of the file. */
  start: number
  end: number
  text: string
}

export interface TranscriptJob {
  id: string
  /** The uploaded file (left where it is; only read). */
  sourcePath: string
  fileName: string
  language: TranscriptLanguage
  model: TranscriptModel
  status: TranscriptStatus
  /** 0–1 within the current status (download, then transcription). */
  progress: number
  /** Length of the audio, once read. */
  durationSec: number | null
  segments: TranscriptSegment[]
  error: string | null
  createdAt: string
  finishedAt: string | null
}

export interface TranscriptModelInfo {
  model: TranscriptModel
  /** Already on this machine: no download before the first transcript. */
  downloaded: boolean
  /** Approximate download size, MB. */
  sizeMb: number
}

export type TranscriptExportFormat = 'txt' | 'srt' | 'vtt'
