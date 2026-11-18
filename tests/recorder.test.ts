import { describe, expect, it } from 'vitest'
import { RECORDER_DEFAULTS } from '@shared/constants/recorder'
import {
  concatLine,
  evenCrop,
  finalOutputPlan,
  formatDuration,
  isInterrupted,
  isValidManifest,
  parseSegmentList,
  planSegments,
  safeRecordingFileName,
  sanitiseRecorderSettings,
  segmenterArgs,
  segmentIndexOf,
  segmentPosition,
  segmentSecondsFor,
  sessionFolderName,
  uniqueName,
  videoCodecOf
} from '@shared/utils/recorder'

describe('recorder settings', () => {
  it('defaults to system audio, 30-minute segments, auto-merge and recovery on', () => {
    const s = sanitiseRecorderSettings(undefined)
    expect(s.defaultAudioSource).toBe('system')
    expect(s.autoSegment).toBe(true)
    expect(s.segmentMinutes).toBe(30)
    expect(s.autoMerge).toBe(true)
    expect(s.recoverInterrupted).toBe(true)
    expect(s).toEqual(RECORDER_DEFAULTS)
  })

  it('keeps valid values and replaces invalid ones', () => {
    const s = sanitiseRecorderSettings({ segmentMinutes: 45, fps: 60, resolution: '2160p', segmentMinutesX: 1, micVolume: 999, defaultAudioSource: 'loud' })
    expect(s.segmentMinutes).toBe(45)
    expect(s.fps).toBe(60)
    expect(s.resolution).toBe('2160p')
    expect(s.micVolume).toBe(200)
    expect(s.defaultAudioSource).toBe('system')
    expect(sanitiseRecorderSettings({ segmentMinutes: 20 }).segmentMinutes).toBe(30)
  })

  it('segment length follows the switch', () => {
    expect(segmentSecondsFor({ autoSegment: true, segmentMinutes: 15 })).toBe(900)
    expect(segmentSecondsFor({ autoSegment: false, segmentMinutes: 15 })).toBeNull()
  })
})

describe('segment planning', () => {
  it('splits a 140-minute recording into 30,30,30,30,20 minutes', () => {
    expect(planSegments(140 * 60, 30 * 60).map(s => s / 60)).toEqual([30, 30, 30, 30, 20])
  })

  it('handles exact multiples and short recordings', () => {
    expect(planSegments(60 * 60, 30 * 60)).toEqual([1800, 1800])
    expect(planSegments(90, 1800)).toEqual([90])
    expect(planSegments(0, 1800)).toEqual([])
  })

  it('reports the live segment and time into it', () => {
    expect(segmentPosition(35 * 60 + 24, 1800)).toEqual({ segment: 2, into: 5 * 60 + 24 })
    expect(segmentPosition(1800, 1800)).toEqual({ segment: 2, into: 0 })
    expect(segmentPosition(500, null)).toEqual({ segment: 1, into: 500 })
  })
})

describe('ffmpeg wiring', () => {
  it('stream-copies stdin into numbered Matroska segments with a CSV list', () => {
    const args = segmenterArgs({ segmentSeconds: 1800, listFile: '/r/segments.csv', pattern: '/r/segment_%03d.mkv' })
    expect(args).toContain('pipe:0')
    expect(args.join(' ')).toContain('-c copy -f segment -segment_format matroska -segment_format_options cluster_time_limit=1000:flush_packets=1 -segment_time 1800 -reset_timestamps 1')
    expect(args.at(-1)).toBe('/r/segment_%03d.mkv')
  })

  it('uses one long segment when segmentation is off', () => {
    const args = segmenterArgs({ segmentSeconds: null, listFile: 'l', pattern: 'p' })
    expect(Number(args[args.indexOf('-segment_time') + 1])).toBeGreaterThan(100 * 3600)
  })

  it('parses the segment list', () => {
    expect(parseSegmentList('segment_001.mkv,0.000000,1800.021000\nsegment_002.mkv,1800.021000,3600.000000\n')).toEqual([
      { file: 'segment_001.mkv', start: 0, end: 1800.021 },
      { file: 'segment_002.mkv', start: 1800.021, end: 3600 }
    ])
    expect(parseSegmentList('')).toEqual([])
  })

  it('quotes concat paths safely', () => {
    expect(concatLine("/rec/it's here/segment_001.mkv")).toBe("file '/rec/it'\\''s here/segment_001.mkv'")
    expect(concatLine('C:\\Rec\\segment_001.mkv')).toBe("file 'C:/Rec/segment_001.mkv'")
  })

  it('chooses the output container from the codec', () => {
    expect(finalOutputPlan('screen', 'video/x-matroska;codecs=avc1,opus', 'mp4').ext).toBe('mp4')
    expect(finalOutputPlan('screen', 'video/webm;codecs=vp9,opus', 'mp4').ext).toBe('webm')
    expect(finalOutputPlan('screen', 'video/webm;codecs=vp9,opus', 'mkv').ext).toBe('mkv')
    expect(finalOutputPlan('audio', 'audio/webm;codecs=opus', 'mp4').ext).toBe('m4a')
    expect(videoCodecOf('video/webm;codecs=h264,opus')).toBe('h264')
  })
})

describe('files and sessions', () => {
  it('names session folders by local time and never reuses one', () => {
    expect(sessionFolderName(new Date(2026, 10, 17, 10, 0, 5))).toBe('Session_2026-11-17_10-00-05')
    const taken = new Set(['S', 'S (2)'])
    expect(uniqueName('S', n => taken.has(n))).toBe('S (3)')
  })

  it('reads segment numbers', () => {
    expect(segmentIndexOf('segment_012.mkv')).toBe(12)
    expect(segmentIndexOf('segment_012.repaired.mkv')).toBeNull()
  })

  it('makes names safe for every OS', () => {
    expect(safeRecordingFileName('Meet: Q3 / plan?')).toBe('Meet_ Q3 _ plan_')
    expect(safeRecordingFileName('...')).toBe('recording')
  })

  it('treats any live status found at start-up as interrupted', () => {
    for (const status of ['starting', 'recording', 'paused', 'stopping', 'merging', 'interrupted'] as const) expect(isInterrupted({ status })).toBe(true)
    for (const status of ['complete', 'stopped', 'failed'] as const) expect(isInterrupted({ status })).toBe(false)
  })

  it('validates manifests', () => {
    expect(isValidManifest({ version: 1, id: 'a', kind: 'screen', status: 'recording', segments: [] })).toBe(true)
    expect(isValidManifest({ version: 2, id: 'a', kind: 'screen', status: 'recording', segments: [] })).toBe(false)
    expect(isValidManifest(null)).toBe(false)
  })

  it('formats durations', () => {
    expect(formatDuration(35 * 60 + 24)).toBe('35:24')
    expect(formatDuration(2 * 3600 + 20 * 60)).toBe('2:20:00')
  })
})

describe('region crop', () => {
  it('maps a DIP region onto a 2x frame with even sizes', () => {
    expect(evenCrop({ x: 101, y: 51, width: 301, height: 201 }, 2, { width: 3024, height: 1964 })).toEqual({ x: 202, y: 102, width: 602, height: 402 })
  })

  it('keeps the crop inside the frame', () => {
    const r = evenCrop({ x: 1400, y: 900, width: 400, height: 300 }, 1, { width: 1512, height: 982 })
    expect(r.x + r.width).toBeLessThanOrEqual(1512)
    expect(r.y + r.height).toBeLessThanOrEqual(982)
    expect(r.width % 2).toBe(0)
  })
})
