import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkSegments, makeThumbnail, mergeSegments, removeSegments } from '../electron/main/recorder/finalize'
import { findFfmpeg, probe, run, type FfmpegPaths } from '../electron/main/recorder/ffmpeg'
import { readSegments, Segmenter } from '../electron/main/recorder/segmenter'

/*
 * The recording pipeline end to end, with real ffmpeg: a synthetic
 * MediaRecorder-like stream (H.264 + Opus in Matroska, keyframe every 1 s) is
 * fed in ~1 s chunks into the Segmenter, then checked, merged and validated.
 *
 * "140 minutes in 30-minute parts" is the same code path as 14 s in 3 s parts,
 * which is what runs here: 5 segments of 3, 3, 3, 3, 2 s.
 *
 * Skipped when ffmpeg is not installed.
 */
const paths: FfmpegPaths | null = findFfmpeg(null)
const d = paths ? describe : describe.skip

const MIME = 'video/x-matroska;codecs=avc1,opus'
let work: string
let source: Buffer

const makeSource = async (p: FfmpegPaths, seconds: number, out: string) => {
  await run(p.ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    // Keyframe every 1 s so 3 s cuts land exactly (the app asks MediaRecorder for one every 2 s).
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'libopus', '-b:a', '96k',
    '-f', 'matroska', '-y', out
  ])
}

/** Feed the stream the way the capture window does: one chunk at a time, waiting on backpressure. */
const feed = async (segmenter: Segmenter, data: Buffer, upTo = 1) => {
  const chunk = Math.ceil(data.length / 14)
  const stop = Math.floor(data.length * upTo)
  for (let i = 0; i < stop; i += chunk) await segmenter.write(data.subarray(i, Math.min(i + chunk, stop)))
}

d('recording pipeline (ffmpeg)', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'rec-test-'))
    const src = join(work, 'source.mkv')
    await makeSource(paths as FfmpegPaths, 14, src)
    source = readFileSync(src)
  }, 60_000)

  afterAll(() => rmSync(work, { recursive: true, force: true }))

  it('cuts 14 s into five segments (3,3,3,3,2) and merges them into one validated MP4', async () => {
    const p = paths as FfmpegPaths
    const dir = mkdtempSync(join(work, 'session-'))
    const seg = new Segmenter(p, dir, 3, msg => {
      throw new Error(msg)
    })
    await feed(seg, source)
    const { code } = await seg.end()
    expect(code).toBe(0)

    const segments = readSegments(dir, false)
    expect(segments.map(s => s.file)).toEqual(['segment_001.mkv', 'segment_002.mkv', 'segment_003.mkv', 'segment_004.mkv', 'segment_005.mkv'])
    const lengths = segments.map(s => Number(((s.end ?? 0) - (s.start ?? 0)).toFixed(1)))
    expect(lengths.slice(0, 4).every(l => Math.abs(l - 3) <= 0.1)).toBe(true)
    expect(Math.abs((lengths[4] ?? 0) - 2)).toBeLessThanOrEqual(0.1)

    const checked = await checkSegments(p, dir, segments, 'screen')
    expect(checked.every(s => s.status === 'complete')).toBe(true)

    const merged = await mergeSegments(p, dir, checked, { kind: 'screen', mimeType: MIME, format: 'mp4', baseName: 'final_recording' })
    expect(merged.file.endsWith('final_recording.mp4')).toBe(true)
    const info = await probe(p, merged.file)
    expect(info.video?.codec).toBe('h264')
    expect(info.audio?.codec).toBe('aac')
    expect(Math.abs(info.duration - 14)).toBeLessThan(0.25)
    // A/V in step: both streams cover the whole recording.
    expect(Math.abs((info.video?.duration ?? info.duration) - (info.audio?.duration ?? info.duration))).toBeLessThan(0.15)

    // No frame lost or doubled at the cuts: 14 s × 30 fps.
    const frames = await run(p.ffprobe, ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', merged.file])
    expect(Number(frames.stdout.trim())).toBe(420)

    removeSegments(dir, checked)
    expect(readdirSync(dir).filter(n => n.startsWith('segment_'))).toEqual([])
    expect(await makeThumbnail(p, merged.file, dir, merged.duration)).toBe(join(dir, 'thumbnail.jpg'))
  }, 120_000)

  it('keeps finished segments and recovers the cut-short one after a crash mid-segment', async () => {
    const p = paths as FfmpegPaths
    const dir = mkdtempSync(join(work, 'crash-'))
    const seg = new Segmenter(p, dir, 3, () => undefined)
    // About 8 s of the stream, then the process "crashes" (SIGKILL, no clean close).
    await feed(seg, source, 0.6)
    await new Promise(r => setTimeout(r, 500))
    seg.kill()
    await seg.end(2000)

    const segments = readSegments(dir, false)
    expect(segments.length).toBeGreaterThanOrEqual(3)
    expect(segments.filter(s => s.end !== null).length).toBeGreaterThanOrEqual(2)

    const checked = await checkSegments(p, dir, segments, 'screen')
    const good = checked.filter(s => s.usable)
    expect(good.length).toBe(segments.length)
    const merged = await mergeSegments(p, dir, checked, { kind: 'screen', mimeType: MIME, format: 'mp4', baseName: 'final_recording' })
    const info = await probe(p, merged.file)
    // Everything that reached the disk: at least the two finished segments.
    expect(info.duration).toBeGreaterThan(6)
  }, 120_000)

  it('skips a corrupt segment and merges the rest in order', async () => {
    const p = paths as FfmpegPaths
    const dir = mkdtempSync(join(work, 'corrupt-'))
    const seg = new Segmenter(p, dir, 3, () => undefined)
    await feed(seg, source)
    await seg.end()
    writeFileSync(join(dir, 'segment_003.mkv'), Buffer.from('this is not a video'))

    const checked = await checkSegments(p, dir, readSegments(dir, false), 'screen')
    expect(checked.find(s => s.index === 3)?.status).toBe('corrupt')
    expect(checked.filter(s => s.usable).map(s => s.index)).toEqual([1, 2, 4, 5])
    const merged = await mergeSegments(p, dir, checked, { kind: 'screen', mimeType: MIME, format: 'mkv', baseName: 'final_recording' })
    const info = await probe(p, merged.file)
    expect(Math.abs(info.duration - 11)).toBeLessThan(0.3)
    expect(existsSync(join(dir, 'segment_001.mkv'))).toBe(true)
  }, 120_000)

  it('has the live segment on disk while recording (not only after it closes)', async () => {
    const p = paths as FfmpegPaths
    const dir = mkdtempSync(join(work, 'live-'))
    const seg = new Segmenter(p, dir, 60, () => undefined)
    // ~2.8 s of stream: less than ffmpeg's default 5 s input analysis.
    await feed(seg, source, 0.2)
    await new Promise(r => setTimeout(r, 1500))
    const live = readSegments(dir, true)
    expect(live.length).toBe(1)
    expect(live[0]?.bytes ?? 0).toBeGreaterThan(50_000)
    await seg.end()
  }, 60_000)

  it('records audio-only into an M4A', async () => {
    const p = paths as FfmpegPaths
    const dir = mkdtempSync(join(work, 'audio-'))
    const src = join(dir, 'a.webm')
    await run(p.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=5', '-c:a', 'libopus', '-f', 'webm', '-y', src])
    const seg = new Segmenter(p, dir, null, () => undefined)
    await seg.write(readFileSync(src))
    await seg.end()
    rmSync(src)
    const checked = await checkSegments(p, dir, readSegments(dir, false), 'audio')
    const merged = await mergeSegments(p, dir, checked, { kind: 'audio', mimeType: 'audio/webm;codecs=opus', format: 'mp4', baseName: 'final_recording' })
    expect(merged.file.endsWith('.m4a')).toBe(true)
    expect(Math.abs(merged.duration - 5)).toBeLessThan(0.2)
  }, 60_000)
})
