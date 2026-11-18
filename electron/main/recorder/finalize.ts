import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RECORDER_TUNING, SEGMENT_LIST_FILE } from '@shared/constants/recorder'
import type { RecordingKind, SegmentRecord, VideoFormat } from '@shared/types/recorder'
import { concatLine, finalOutputPlan, uniqueName } from '@shared/utils/recorder'
import { probe, run, type FfmpegPaths, type ProbeResult } from './ffmpeg'

/*
 * After Stop (or on recovery): check every segment, repair what can be
 * repaired, join the good ones in order into one file without re-encoding the
 * video, and only then — once the joined file has been probed and its length
 * matches — delete the segments.
 */

export interface CheckedSegment extends SegmentRecord {
  /** The file to merge (the repaired copy when one was made). */
  usable: string | null
  duration: number
  reason: string | null
}

const MIN_SEGMENT_SECONDS = 0.2

const usableProbe = (p: ProbeResult, needsVideo: boolean): number => {
  const d = Math.max(p.duration, p.video?.duration ?? 0, p.audio?.duration ?? 0)
  if (needsVideo && !p.video) return 0
  return d
}

/**
 * Probes each segment. One that ffprobe cannot read or that has no duration
 * (cut short by a crash: no cues, no length) is remuxed with errors ignored,
 * which keeps every whole cluster that reached the disk.
 */
export const checkSegments = async (
  paths: FfmpegPaths,
  dir: string,
  segments: SegmentRecord[],
  kind: RecordingKind,
  log: (message: string) => void = () => undefined
): Promise<CheckedSegment[]> => {
  const needsVideo = kind !== 'audio'
  const out: CheckedSegment[] = []
  for (const segment of [...segments].sort((a, b) => a.index - b.index)) {
    const file = join(dir, segment.file)
    if (!existsSync(file) || statSync(file).size === 0) {
      out.push({ ...segment, status: 'corrupt', usable: null, duration: 0, reason: 'File is missing or empty.' })
      continue
    }
    let duration = 0
    try {
      duration = usableProbe(await probe(paths, file), needsVideo)
    } catch (error) {
      log(`segment ${segment.file} unreadable: ${String(error)}`)
    }
    // A complete segment from ffmpeg has a duration in its header. One without
    // (or unreadable) is rewritten from whatever whole data it holds.
    const listed = segment.end !== null
    if (duration >= MIN_SEGMENT_SECONDS && listed) {
      out.push({ ...segment, status: 'complete', usable: file, duration, reason: null })
      continue
    }
    const repaired = file.replace(/\.mkv$/, '.repaired.mkv')
    try {
      rmSync(repaired, { force: true })
      await run(paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-err_detect', 'ignore_err', '-fflags', '+genpts+discardcorrupt', '-i', file, '-map', '0', '-c', 'copy', '-f', 'matroska', repaired], {
        timeoutMs: 10 * 60_000
      })
      const fixed = usableProbe(await probe(paths, repaired), needsVideo)
      if (fixed >= MIN_SEGMENT_SECONDS) {
        out.push({ ...segment, status: 'repaired', usable: repaired, duration: fixed, reason: listed ? null : 'Cut short; recovered up to the last data written.' })
        continue
      }
      rmSync(repaired, { force: true })
    } catch (error) {
      log(`segment ${segment.file} could not be repaired: ${String(error)}`)
      rmSync(repaired, { force: true })
    }
    out.push({ ...segment, status: 'corrupt', usable: null, duration: 0, reason: 'No readable media in this file.' })
  }
  return out
}

export interface MergeResult {
  file: string
  duration: number
  bytes: number
}

/**
 * Joins the usable segments in order. Video is stream-copied; audio is copied
 * too, except for MP4/M4A output, where Opus becomes AAC so every player can
 * read it. Writes to a temporary name and renames only after validation.
 */
export const mergeSegments = async (
  paths: FfmpegPaths,
  dir: string,
  checked: CheckedSegment[],
  opts: { kind: RecordingKind; mimeType: string | null; format: VideoFormat; baseName: string }
): Promise<MergeResult> => {
  const parts = checked.filter(s => s.usable)
  if (parts.length === 0) throw new Error('There is no readable recording data to merge.')
  const expected = parts.reduce((sum, s) => sum + s.duration, 0)
  const plan = finalOutputPlan(opts.kind, opts.mimeType, opts.format)
  const listFile = join(dir, 'concat.txt')
  writeFileSync(listFile, parts.map(p => concatLine(p.usable as string)).join('\n') + '\n')
  const partial = join(dir, `merging.part.${plan.ext}`)
  rmSync(partial, { force: true })
  const videoArgs = opts.kind === 'audio' ? ['-vn'] : ['-c:v', 'copy']
  try {
    await run(
      paths.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-map',
        '0',
        ...videoArgs,
        ...plan.audioArgs,
        '-avoid_negative_ts',
        'make_zero',
        ...plan.extraArgs,
        '-f',
        plan.muxer,
        '-y',
        partial
      ],
      { timeoutMs: 60 * 60_000 }
    )
    const result = await probe(paths, partial)
    const duration = usableProbe(result, opts.kind !== 'audio')
    if (duration < expected * RECORDER_TUNING.mergeMinDurationRatio - 1) {
      throw new Error(`Merged file is ${duration.toFixed(1)} s but the segments hold ${expected.toFixed(1)} s.`)
    }
    const name = uniqueName(opts.baseName, n => existsSync(join(dir, `${n}.${plan.ext}`)))
    const file = join(dir, `${name}.${plan.ext}`)
    renameSync(partial, file)
    return { file, duration, bytes: statSync(file).size }
  } finally {
    rmSync(listFile, { force: true })
    rmSync(partial, { force: true })
  }
}

/** Deletes segment files (and repaired copies) once the merged file is safe. */
export const removeSegments = (dir: string, checked: CheckedSegment[]): void => {
  for (const s of checked) {
    rmSync(join(dir, s.file), { force: true })
    if (s.usable && s.usable !== join(dir, s.file)) rmSync(s.usable, { force: true })
  }
  rmSync(join(dir, SEGMENT_LIST_FILE), { force: true })
}

/** A small JPEG from a second into the video, for the library. Failure is not an error. */
export const makeThumbnail = async (paths: FfmpegPaths, video: string, dir: string, duration: number): Promise<string | null> => {
  const out = join(dir, 'thumbnail.jpg')
  try {
    await run(paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.min(1, duration / 2)), '-i', video, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', '-y', out], {
      timeoutMs: 60_000
    })
    return existsSync(out) ? out : null
  } catch {
    return null
  }
}
