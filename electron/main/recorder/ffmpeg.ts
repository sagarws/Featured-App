import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/*
 * Finding and running ffmpeg / ffprobe. No Electron imports, so the segmenter,
 * the merger and recovery can be tested with plain Node.
 *
 * Lookup order:
 *   1. FFMPEG_PATH / FFPROBE_PATH environment variables
 *   2. the bundled copy: <resources>/ffmpeg/ (packaged app — see scripts/fetch-ffmpeg.cjs)
 *   3. ffmpeg on the PATH (and the usual Homebrew folders, which a GUI app's PATH lacks)
 */

export interface FfmpegPaths {
  ffmpeg: string
  ffprobe: string
}

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

const EXTRA_DIRS = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : process.platform === 'linux' ? ['/usr/bin', '/usr/local/bin'] : []

const onPath = (name: string): string | null => {
  const dirs = [...(process.env['PATH'] ?? '').split(delimiter), ...EXTRA_DIRS].filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, exe(name))
    if (existsSync(candidate)) return candidate
  }
  return null
}

export const findFfmpeg = (bundledDir: string | null): FfmpegPaths | null => {
  const envFfmpeg = process.env['FFMPEG_PATH']
  const envProbe = process.env['FFPROBE_PATH']
  if (envFfmpeg && envProbe && existsSync(envFfmpeg) && existsSync(envProbe)) return { ffmpeg: envFfmpeg, ffprobe: envProbe }
  if (bundledDir) {
    const ffmpeg = join(bundledDir, exe('ffmpeg'))
    const ffprobe = join(bundledDir, exe('ffprobe'))
    if (existsSync(ffmpeg) && existsSync(ffprobe)) return { ffmpeg, ffprobe }
  }
  const ffmpeg = onPath('ffmpeg')
  const ffprobe = onPath('ffprobe')
  return ffmpeg && ffprobe ? { ffmpeg, ffprobe } : null
}

export const ffmpegVersion = (paths: FfmpegPaths): string | null => {
  try {
    const out = spawnSync(paths.ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 5000 })
    return out.stdout.split('\n')[0]?.trim() || null
  } catch {
    return null
  }
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string
  ) {
    super(message)
  }
}

/** Runs a binary to the end; rejects with its stderr on a non-zero exit. Never blocks the event loop. */
export const run = (binary: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      // Keep the tail only: a long merge can print a lot.
      stderr = (stderr + d.toString()).slice(-20_000)
    })
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null
    child.on('error', error => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new FfmpegError(`${binary.split(/[\\/]/).pop()} exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`, stderr))
    })
  })

export interface ProbeResult {
  duration: number
  video: { codec: string; width: number; height: number; duration: number | null } | null
  audio: { codec: string; duration: number | null } | null
}

/** Reads a media file's streams and duration; rejects if ffprobe cannot. */
export const probe = async (paths: FfmpegPaths, file: string): Promise<ProbeResult> => {
  const { stdout } = await run(paths.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    timeoutMs: 60_000
  })
  const json = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; tags?: Record<string, string> }[]
  }
  const num = (v: string | undefined): number | null => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  // Matroska keeps a per-stream duration in a DURATION tag ("00:00:10.020000000").
  const tagDuration = (tags?: Record<string, string>): number | null => {
    const raw = tags?.['DURATION'] ?? tags?.['duration']
    const m = raw ? /^(\d+):(\d+):([\d.]+)$/.exec(raw) : null
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null
  }
  const v = json.streams?.find(s => s.codec_type === 'video')
  const a = json.streams?.find(s => s.codec_type === 'audio')
  return {
    duration: num(json.format?.duration) ?? 0,
    video: v ? { codec: v.codec_name ?? '', width: v.width ?? 0, height: v.height ?? 0, duration: num(v.duration) ?? tagDuration(v.tags) } : null,
    audio: a ? { codec: a.codec_name ?? '', duration: num(a.duration) ?? tagDuration(a.tags) } : null
  }
}
