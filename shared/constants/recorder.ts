import type { AudioQuality, FrameRate, RecorderSettings, Resolution, SegmentMinutes } from '../types/recorder'

export const SEGMENT_MINUTE_OPTIONS: readonly SegmentMinutes[] = [15, 30, 45, 60]
export const FRAME_RATES: readonly FrameRate[] = [24, 30, 60]
export const RESOLUTIONS: readonly Resolution[] = ['720p', '1080p', '1440p', '2160p']

export const RESOLUTION_SIZE: Record<Resolution, { width: number; height: number; label: string }> = {
  '720p': { width: 1280, height: 720, label: '720p HD' },
  '1080p': { width: 1920, height: 1080, label: '1080p Full HD' },
  '1440p': { width: 2560, height: 1440, label: '1440p QHD' },
  '2160p': { width: 3840, height: 2160, label: '4K UHD' }
}

/** Video bitrate at 30 fps; scaled linearly with the frame rate. */
export const VIDEO_BITRATE_30FPS: Record<Resolution, number> = {
  '720p': 4_000_000,
  '1080p': 8_000_000,
  '1440p': 14_000_000,
  '2160p': 28_000_000
}

export const AUDIO_BITRATE: Record<AudioQuality, number> = { standard: 128_000, high: 256_000 }

export const RECORDER_DEFAULTS: RecorderSettings = {
  resolution: '1080p',
  fps: 30,
  areaMode: 'display',
  videoFormat: 'mp4',
  outputDir: null,
  defaultAudioSource: 'system',
  micDeviceId: null,
  micVolume: 100,
  cameraDeviceId: null,
  audioQuality: 'standard',
  autoSegment: true,
  segmentMinutes: 30,
  autoMerge: true,
  keepSegments: false,
  recoverInterrupted: true,
  webcamOverlay: false,
  overlayCorner: 'bottom-right',
  overlaySize: 'medium',
  askSystemAudioOnLaunch: true
}

export const RECORDER_TUNING = {
  /** MediaRecorder hands a chunk to the main process this often. */
  timesliceMs: 1000,
  /** A keyframe at least this often, so ffmpeg can cut segments close to the mark. */
  keyframeIntervalMs: 2000,
  /** Manifest heartbeat. */
  heartbeatMs: 5000,
  /** Disk checks while recording. */
  diskCheckMs: 15_000,
  /** Refuse to start below this much free space. */
  minFreeBytesToStart: 2 * 1024 ** 3,
  /** Stop gracefully below this much free space. */
  minFreeBytesWhileRecording: 500 * 1024 ** 2,
  /** How long Stop waits for the capture window's last chunk. */
  stopTimeoutMs: 8000,
  /** Warn when system audio has stayed digitally silent this long (macOS permission off, usually). */
  systemSilenceWarnMs: 6000,
  /** "Segment length" when segmentation is off: effectively one file. */
  unsegmentedSeconds: 1_000_000,
  /** A merged file shorter than this share of the segments' total is rejected. */
  mergeMinDurationRatio: 0.95
} as const

export const OVERLAY_SIZE_PX: Record<'small' | 'medium' | 'large', number> = { small: 160, medium: 220, large: 300 }

/** Root folder name under the OS Videos folder. */
export const RECORDINGS_FOLDER_NAME = 'Featured Recordings'
export const KIND_FOLDER = { screen: 'Screen', webcam: 'Webcam', audio: 'Audio' } as const
export const MANIFEST_FILE = 'manifest.json'
export const SEGMENT_LIST_FILE = 'segments.csv'

/** Custom protocol that streams recordings and thumbnails into the window. */
export const MEDIA_SCHEME = 'recording-media'
