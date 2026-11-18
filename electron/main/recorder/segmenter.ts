import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { SEGMENT_LIST_FILE } from '@shared/constants/recorder'
import type { SegmentRecord } from '@shared/types/recorder'
import { parseSegmentList, segmentIndexOf, segmenterArgs } from '@shared/utils/recorder'
import type { FfmpegPaths } from './ffmpeg'

/**
 * One ffmpeg process per recording. MediaRecorder's Matroska/WebM stream goes
 * in on stdin, chunk by chunk, and ffmpeg copies it — no re-encoding — into
 * segment_001.mkv, segment_002.mkv … in the session folder, closing each one
 * the moment it is complete.
 *
 * Why this survives a crash:
 *   - the recording never lives in memory: each chunk (~1 s) is on its way to
 *     disk as soon as it arrives, and ffmpeg flushes every packet;
 *   - finished segments are closed files that nothing touches again;
 *   - if the app dies, ffmpeg's stdin closes and ffmpeg finishes the current
 *     segment properly on its own. If ffmpeg dies too, the partial .mkv is
 *     still readable up to its last cluster and recovery remuxes it.
 */
export class Segmenter {
  private child: ChildProcessByStdio<Writable, null, Readable>
  private stderr = ''
  private exited: Promise<number | null>
  private exitCode: number | null | undefined = undefined
  private ending = false
  bytesWritten = 0

  constructor(
    paths: FfmpegPaths,
    readonly dir: string,
    segmentSeconds: number | null,
    private readonly onUnexpectedExit: (message: string) => void
  ) {
    const args = segmenterArgs({
      segmentSeconds,
      listFile: join(dir, SEGMENT_LIST_FILE),
      pattern: join(dir, 'segment_%03d.mkv')
    })
    this.child = spawn(paths.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-10_000)
    })
    // A write after ffmpeg died must not crash the main process.
    this.child.stdin.on('error', () => undefined)
    this.exited = new Promise(resolve => {
      this.child.on('error', error => {
        this.stderr += String(error)
        this.exitCode = -1
        resolve(-1)
      })
      this.child.on('close', code => {
        this.exitCode = code
        resolve(code)
        if (!this.ending) this.onUnexpectedExit(`ffmpeg stopped unexpectedly (${code}): ${this.stderr.trim().slice(-300)}`)
      })
    })
  }

  get alive(): boolean {
    return this.exitCode === undefined
  }

  /** Appends one MediaRecorder chunk; waits when ffmpeg is behind, so memory stays flat. */
  async write(chunk: Buffer): Promise<void> {
    if (!this.alive || this.ending) throw new Error('The recorder is not accepting data.')
    this.bytesWritten += chunk.length
    if (!this.child.stdin.write(chunk)) {
      await new Promise<void>(resolve => {
        const done = () => {
          this.child.stdin.off('drain', done)
          this.child.stdin.off('close', done)
          resolve()
        }
        this.child.stdin.once('drain', done)
        this.child.stdin.once('close', done)
      })
    }
  }

  /** Closes stdin and waits for ffmpeg to finish the last segment. */
  async end(timeoutMs = 30_000): Promise<{ code: number | null; stderr: string }> {
    this.ending = true
    if (this.alive) this.child.stdin.end()
    const timer = setTimeout(() => {
      if (this.alive) this.child.kill('SIGKILL')
    }, timeoutMs)
    const code = await this.exited
    clearTimeout(timer)
    return { code, stderr: this.stderr }
  }

  /** For tests: die the way a crash would. */
  kill(): void {
    this.ending = true
    this.child.kill('SIGKILL')
  }
}

/**
 * The segments in a session folder, in order: the ones ffmpeg listed as
 * finished in segments.csv, plus any file it had not listed yet (the one being
 * written, or the last one of a crash).
 */
export const readSegments = (dir: string, live: boolean): SegmentRecord[] => {
  const listPath = join(dir, SEGMENT_LIST_FILE)
  const listed = existsSync(listPath) ? parseSegmentList(readFileSync(listPath, 'utf8')) : []
  const byName = new Map(listed.map(row => [row.file.split(/[\\/]/).pop() ?? row.file, row]))
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter(name => segmentIndexOf(name) !== null)
        .sort((a, b) => (segmentIndexOf(a) ?? 0) - (segmentIndexOf(b) ?? 0))
    : []
  return files.map(name => {
    const row = byName.get(name)
    let bytes = 0
    try {
      bytes = statSync(join(dir, name)).size
    } catch {
      // Removed between listing and stat.
    }
    return {
      index: segmentIndexOf(name) ?? 0,
      file: name,
      // Not in the list yet: still being written (live) or cut short (after a crash).
      status: row ? 'complete' : live ? 'recording' : 'complete',
      start: row?.start ?? null,
      end: row?.end ?? null,
      bytes
    }
  })
}
