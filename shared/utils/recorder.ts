import {
  AUDIO_BITRATE,
  MEDIA_SCHEME,
  FRAME_RATES,
  RECORDER_DEFAULTS,
  RECORDER_TUNING,
  RESOLUTIONS,
  SEGMENT_MINUTE_OPTIONS,
  VIDEO_BITRATE_30FPS
} from '../constants/recorder'
import type {
  AudioSource,
  FrameRate,
  OverlayCorner,
  OverlaySize,
  RecorderSettings,
  RecordingKind,
  Resolution,
  SegmentMinutes,
  SessionManifest,
  SessionStatus,
  VideoFormat
} from '../types/recorder'

/*
 * Pure helpers for the recorder: no Electron, no fs. Everything here is
 * covered by tests/recorder.test.ts.
 */

const AUDIO_SOURCES: readonly AudioSource[] = ['system', 'mic', 'system+mic', 'none']
const CORNERS: readonly OverlayCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const SIZES: readonly OverlaySize[] = ['small', 'medium', 'large']

const pick = <T>(list: readonly T[], value: unknown, fallback: T): T => (list.includes(value as T) ? (value as T) : fallback)
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
const deviceId = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length < 512 ? value : null

/** Settings as saved, with anything missing or invalid replaced by its default. */
export const sanitiseRecorderSettings = (raw: unknown): RecorderSettings => {
  const d = RECORDER_DEFAULTS
  if (!raw || typeof raw !== 'object') return { ...d }
  const v = raw as Partial<Record<keyof RecorderSettings, unknown>>
  const volume = typeof v.micVolume === 'number' && Number.isFinite(v.micVolume) ? Math.round(v.micVolume) : d.micVolume
  return {
    resolution: pick<Resolution>(RESOLUTIONS, v.resolution, d.resolution),
    fps: pick<FrameRate>(FRAME_RATES, v.fps, d.fps),
    areaMode: v.areaMode === 'region' ? 'region' : 'display',
    videoFormat: pick<VideoFormat>(['mp4', 'mkv'], v.videoFormat, d.videoFormat),
    outputDir: typeof v.outputDir === 'string' && v.outputDir.trim() ? v.outputDir : null,
    defaultAudioSource: pick(AUDIO_SOURCES, v.defaultAudioSource, d.defaultAudioSource),
    micDeviceId: deviceId(v.micDeviceId),
    micVolume: Math.min(200, Math.max(0, volume)),
    cameraDeviceId: deviceId(v.cameraDeviceId),
    audioQuality: v.audioQuality === 'high' ? 'high' : 'standard',
    autoSegment: bool(v.autoSegment, d.autoSegment),
    segmentMinutes: pick<SegmentMinutes>(SEGMENT_MINUTE_OPTIONS, v.segmentMinutes, d.segmentMinutes),
    autoMerge: bool(v.autoMerge, d.autoMerge),
    keepSegments: bool(v.keepSegments, d.keepSegments),
    recoverInterrupted: bool(v.recoverInterrupted, d.recoverInterrupted),
    webcamOverlay: bool(v.webcamOverlay, d.webcamOverlay),
    overlayCorner: pick(CORNERS, v.overlayCorner, d.overlayCorner),
    overlaySize: pick(SIZES, v.overlaySize, d.overlaySize),
    askSystemAudioOnLaunch: bool(v.askSystemAudioOnLaunch, d.askSystemAudioOnLaunch)
  }
}

export const isAudioSource = (value: unknown): value is AudioSource => AUDIO_SOURCES.includes(value as AudioSource)
export const wantsSystemAudio = (audio: AudioSource): boolean => audio === 'system' || audio === 'system+mic'
export const wantsMic = (audio: AudioSource): boolean => audio === 'mic' || audio === 'system+mic'

/** Segment length in seconds for a session, or null when not segmenting. */
export const segmentSecondsFor = (settings: Pick<RecorderSettings, 'autoSegment' | 'segmentMinutes'>): number | null =>
  settings.autoSegment ? settings.segmentMinutes * 60 : null

/**
 * Expected segment lengths for a recording of `totalSeconds` cut every
 * `segmentSeconds` — e.g. 140 min at 30 min gives [30, 30, 30, 30, 20] min.
 */
export const planSegments = (totalSeconds: number, segmentSeconds: number): number[] => {
  if (totalSeconds <= 0 || segmentSeconds <= 0) return []
  const parts: number[] = []
  let left = totalSeconds
  while (left > 1e-9) {
    const part = Math.min(segmentSeconds, left)
    parts.push(part)
    left -= part
  }
  return parts
}

/** Which segment (1-based) is being written at `elapsed` seconds, and how far into it. */
export const segmentPosition = (elapsed: number, segmentSeconds: number | null): { segment: number; into: number } => {
  if (!segmentSeconds || segmentSeconds <= 0) return { segment: 1, into: Math.max(0, elapsed) }
  const e = Math.max(0, elapsed)
  return { segment: Math.floor(e / segmentSeconds) + 1, into: e % segmentSeconds }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "Session_2026-11-17_10-00-05" in local time. */
export const sessionFolderName = (date: Date): string =>
  `Session_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`

/** A free folder name: "Session_…", then "Session_… (2)", never an existing one. */
export const uniqueName = (base: string, taken: (name: string) => boolean): string => {
  if (!taken(base)) return base
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base} (${n})`
    if (!taken(candidate)) return candidate
  }
  throw new Error(`No free name for ${base}`)
}

export const segmentFileName = (index: number): string => `segment_${String(index).padStart(3, '0')}.mkv`
export const segmentIndexOf = (file: string): number | null => {
  const match = /segment_(\d{3,})\.mkv$/.exec(file)
  return match ? Number(match[1]) : null
}

/** Default display name: "Screen recording 17 Nov 2026, 10:00". */
export const defaultRecordingName = (kind: RecordingKind, date: Date): string => {
  const label = kind === 'screen' ? 'Screen recording' : kind === 'webcam' ? 'Webcam recording' : 'Audio recording'
  const month = date.toLocaleString('en-GB', { month: 'short' })
  return `${label} ${date.getDate()} ${month} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A name fit for a file on every OS. */
export const safeRecordingFileName = (name: string): string =>
  name
    // Control characters are not allowed in file names on Windows.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120) || 'recording'

export const bitrates = (
  resolution: Resolution,
  fps: FrameRate,
  quality: RecorderSettings['audioQuality']
): { video: number; audio: number } => ({
  video: Math.round((VIDEO_BITRATE_30FPS[resolution] * fps) / 30),
  audio: AUDIO_BITRATE[quality]
})

/** MediaRecorder types to try, best first. H.264 is hardware-encoded on most machines. */
export const candidateMimeTypes = (kind: RecordingKind): string[] =>
  kind === 'audio'
    ? ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus']
    : [
        'video/x-matroska;codecs=avc1,opus',
        'video/webm;codecs=h264,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus'
      ]

/** The video codec family inside a MediaRecorder type. */
export const videoCodecOf = (mimeType: string | null): 'h264' | 'vp9' | 'vp8' | null => {
  if (!mimeType) return null
  if (/avc1|h264/i.test(mimeType)) return 'h264'
  if (/vp9/i.test(mimeType)) return 'vp9'
  if (/vp8/i.test(mimeType)) return 'vp8'
  return null
}

/** Container and codec handling of the merged file. */
export const finalOutputPlan = (
  kind: RecordingKind,
  mimeType: string | null,
  format: VideoFormat
): { ext: string; muxer: string; audioArgs: string[]; extraArgs: string[] } => {
  if (kind === 'audio') return { ext: 'm4a', muxer: 'mp4', audioArgs: ['-c:a', 'aac', '-b:a', '192k'], extraArgs: ['-movflags', '+faststart'] }
  if (format === 'mkv') return { ext: 'mkv', muxer: 'matroska', audioArgs: ['-c:a', 'copy'], extraArgs: [] }
  // MP4 players (QuickTime, Windows) want H.264 + AAC. VP8/VP9 go to WebM.
  if (videoCodecOf(mimeType) === 'h264') {
    return { ext: 'mp4', muxer: 'mp4', audioArgs: ['-c:a', 'aac', '-b:a', '192k'], extraArgs: ['-movflags', '+faststart'] }
  }
  return { ext: 'webm', muxer: 'webm', audioArgs: ['-c:a', 'copy'], extraArgs: [] }
}

/**
 * ffmpeg arguments that read MediaRecorder's stream on stdin and write
 * `segment_001.mkv`, `segment_002.mkv` … without re-encoding. Each segment is
 * closed (and listed in segments.csv) as soon as it is complete.
 */
export const segmenterArgs = (opts: { segmentSeconds: number | null; startNumber?: number; listFile: string; pattern: string }): string[] => [
  '-hide_banner',
  '-loglevel',
  'error',
  // Start writing after ~1 s of input instead of ffmpeg's default 5 s / 5 MB analysis,
  // so the first seconds of a recording are on disk as soon as possible.
  '-analyzeduration',
  '1000000',
  '-probesize',
  '1000000',
  '-f',
  'matroska',
  '-i',
  'pipe:0',
  '-map',
  '0',
  '-c',
  'copy',
  '-f',
  'segment',
  '-segment_format',
  'matroska',
  // Close a Matroska cluster and flush it every second (the outer -flush_packets does not reach
  // the segment's own writer), so data is on disk even if ffmpeg itself is killed.
  '-segment_format_options',
  'cluster_time_limit=1000:flush_packets=1',
  '-segment_time',
  String(opts.segmentSeconds ?? RECORDER_TUNING.unsegmentedSeconds),
  '-reset_timestamps',
  '1',
  '-segment_list',
  opts.listFile,
  '-segment_list_type',
  'csv',
  '-segment_start_number',
  String(opts.startNumber ?? 1),
  '-flush_packets',
  '1',
  opts.pattern
]

/** Rows of ffmpeg's CSV segment list: "segment_001.mkv,0.000000,1800.020000". */
export const parseSegmentList = (csv: string): { file: string; start: number; end: number }[] =>
  csv
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(',')
      const end = Number(parts.pop())
      const start = Number(parts.pop())
      return { file: parts.join(','), start, end }
    })
    .filter(row => row.file && Number.isFinite(row.start) && Number.isFinite(row.end))

/** A line of ffmpeg's concat-demuxer list, quoting the path safely. */
export const concatLine = (file: string): string => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`

/** Statuses that mean the app was still working on the session when it last stopped. */
export const LIVE_STATUSES: readonly SessionStatus[] = ['starting', 'recording', 'paused', 'stopping', 'merging']

/** A session found at start-up in a live state was interrupted (only one app instance runs). */
export const isInterrupted = (manifest: Pick<SessionManifest, 'status'>): boolean =>
  manifest.status === 'interrupted' || LIVE_STATUSES.includes(manifest.status)

export const isValidManifest = (value: unknown): value is SessionManifest => {
  if (!value || typeof value !== 'object') return false
  const m = value as Partial<SessionManifest>
  return (
    m.version === 1 &&
    typeof m.id === 'string' &&
    (m.kind === 'screen' || m.kind === 'webcam' || m.kind === 'audio') &&
    typeof m.status === 'string' &&
    Array.isArray(m.segments)
  )
}

/** Rounds a region to even pixel values inside the frame (encoders need even sizes). */
export const evenCrop = (
  region: { x: number; y: number; width: number; height: number },
  scale: number,
  frame: { width: number; height: number }
): { x: number; y: number; width: number; height: number } => {
  const even = (n: number) => Math.max(0, Math.floor(n / 2) * 2)
  const x = Math.min(even(region.x * scale), Math.max(0, frame.width - 2))
  const y = Math.min(even(region.y * scale), Math.max(0, frame.height - 2))
  const width = Math.max(2, Math.min(even(region.width * scale), even(frame.width - x)))
  const height = Math.max(2, Math.min(even(region.height * scale), even(frame.height - y)))
  return { x, y, width, height }
}

/** "1:02:03" / "02:03". */
export const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`
}

/** URL that streams a file from the recordings folder into the window (see library.ts). */
export const mediaUrl = (file: string): string => `${MEDIA_SCHEME}://local/${encodeURIComponent(file)}`
