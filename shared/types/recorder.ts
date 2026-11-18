/**
 * Screen, webcam and audio recording — the types shared by the main process
 * (orchestration, ffmpeg, manifests), the hidden capture window and the UI.
 */

export type RecordingKind = 'screen' | 'webcam' | 'audio'

/** Where the sound of a recording comes from. */
export type AudioSource = 'system' | 'mic' | 'system+mic' | 'none'

export type Resolution = '720p' | '1080p' | '1440p' | '2160p'
export type FrameRate = 24 | 30 | 60
export type VideoFormat = 'mp4' | 'mkv'
export type AudioQuality = 'standard' | 'high'
export type SegmentMinutes = 15 | 30 | 45 | 60
export type OverlayCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type OverlaySize = 'small' | 'medium' | 'large'

/** Persisted in settings.json under `recorder`. */
export interface RecorderSettings {
  resolution: Resolution
  fps: FrameRate
  /** Full display or a dragged region, preselected in the New Recording dialog. */
  areaMode: 'display' | 'region'
  videoFormat: VideoFormat
  /** Recordings root. null = <Videos>/Featured Recordings. */
  outputDir: string | null
  defaultAudioSource: AudioSource
  /** MediaDeviceInfo.deviceId of the microphone; null = the OS default. */
  micDeviceId: string | null
  /** 0–200 %, applied with a gain node before the mix. */
  micVolume: number
  cameraDeviceId: string | null
  audioQuality: AudioQuality
  /** Cut the recording into files of `segmentMinutes` while it runs. */
  autoSegment: boolean
  segmentMinutes: SegmentMinutes
  /** Join the segments into one file on Stop. */
  autoMerge: boolean
  /** Keep segment files after a validated merge (they are deleted otherwise). */
  keepSegments: boolean
  /** Offer recovery of interrupted sessions at start. */
  recoverInterrupted: boolean
  /** Camera bubble over a screen recording. */
  webcamOverlay: boolean
  overlayCorner: OverlayCorner
  overlaySize: OverlaySize
  /** Offer the system-audio permission popup when the app starts. */
  askSystemAudioOnLaunch: boolean
}

/** What to capture: one display, or a rectangle on one (DIP, relative to the display's top-left). */
export type CaptureArea =
  | { type: 'display'; displayId: string }
  | { type: 'region'; displayId: string; x: number; y: number; width: number; height: number }

export interface DisplayInfo {
  id: string
  label: string
  primary: boolean
  /** DIP bounds in the virtual desktop. */
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}

export interface StartRecordingRequest {
  kind: RecordingKind
  audio: AudioSource
  /** Screen recordings only. */
  area?: CaptureArea
  /** Overrides the saved device for this recording. */
  micDeviceId?: string | null
  cameraDeviceId?: string | null
  /** Screen recordings only: show the camera bubble. */
  webcamOverlay?: boolean
}

export type SegmentStatus = 'recording' | 'complete' | 'repaired' | 'corrupt'

export interface SegmentRecord {
  index: number
  file: string
  status: SegmentStatus
  /** Seconds from the start of the recording, from ffmpeg's segment list. */
  start: number | null
  end: number | null
  bytes: number
}

export type SessionStatus =
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'merging'
  | 'complete'
  | 'interrupted'
  | 'failed'

/** manifest.json in every session folder — the source of truth for recovery. */
export interface SessionManifest {
  version: 1
  id: string
  kind: RecordingKind
  name: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  stoppedAt: string | null
  audio: AudioSource
  area: CaptureArea | null
  /** Seconds per segment; null when not segmenting (one file). */
  segmentSeconds: number | null
  /** What MediaRecorder produced, e.g. "video/x-matroska;codecs=avc1,opus". */
  mimeType: string | null
  /** Seconds actually recorded (pauses excluded), updated by the heartbeat. */
  recordedSeconds: number
  segments: SegmentRecord[]
  final: { file: string; bytes: number; duration: number } | null
  thumbnail: string | null
  /** Last error or recovery note, for the library. */
  note: string | null
}

/** One row in the library. Paths are absolute. */
export interface RecordingSummary {
  id: string
  kind: RecordingKind
  name: string
  status: SessionStatus
  createdAt: string
  duration: number
  bytes: number
  dir: string
  file: string | null
  thumbnail: string | null
  segments: SegmentRecord[]
  note: string | null
}

/** Pushed to every recorder window while a session is live. */
export interface RecorderStatus {
  active: boolean
  sessionId: string | null
  kind: RecordingKind | null
  phase: 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'merging'
  /** Seconds recorded so far, pauses excluded. */
  elapsed: number
  /** 1-based segment being written, and seconds into it. */
  segment: number
  segmentElapsed: number
  segmentSeconds: number | null
  audio: AudioSource
  systemAudio: boolean
  /** System audio is captured but has carried no sound at all since the start. */
  systemAudioSilent: boolean
  microphone: 'on' | 'off' | 'lost'
  error: string | null
  /** Set when the last stop finished: the merged file or the session folder. */
  lastResult: { sessionId: string; file: string | null; error: string | null; warning: string | null } | null
}

/** What the hidden capture window needs to start. */
export interface EngineConfig {
  sessionId: string
  kind: RecordingKind
  audio: AudioSource
  area: CaptureArea | null
  /** Display size in DIP, to map the region onto captured frames. */
  displayBounds: { width: number; height: number } | null
  micDeviceId: string | null
  cameraDeviceId: string | null
  micVolume: number
  resolution: Resolution
  fps: FrameRate
  audioBitsPerSecond: number
  videoBitsPerSecond: number
  keyframeIntervalMs: number
  timesliceMs: number
}

/**
 * The OS permission to record system audio. macOS 14.2+ asks for it ("System
 * Audio Recording"); Windows and Linux have none ('granted'). 'unknown' means
 * it could not be checked, so the app does not block on it.
 */
export type SystemAudioPermission = 'granted' | 'denied' | 'not-determined' | 'unsupported' | 'unknown'

export interface StorageInfo {
  dir: string
  freeBytes: number | null
  ffmpeg: { found: boolean; path: string | null; version: string | null }
  platform: 'darwin' | 'win32' | 'linux'
  /** Screen recording permission (macOS); 'granted' elsewhere. */
  screenPermission: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  /** Whether system audio can be captured on this OS, and why not. */
  systemAudio: { supported: boolean; reason: string | null }
}

export interface RecoveryResult {
  file: string | null
  recovered: number
  skipped: { file: string; reason: string }[]
}
