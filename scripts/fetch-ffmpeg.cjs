#!/usr/bin/env node
/*
 * Puts an LGPL ffmpeg + ffprobe in resources/ffmpeg/<target>/, which
 * electron-builder ships as <resources>/ffmpeg/ (see electron-builder.yml).
 * The recorder only stream-copies video, encodes AAC audio and makes JPEG
 * thumbnails — no GPL codec (x264/x265) is needed, so the app can ship it.
 *
 *   node scripts/fetch-ffmpeg.cjs                 # this machine's target
 *   node scripts/fetch-ffmpeg.cjs win-x64         # or: win-arm64, linux-x64, linux-arm64, mac-arm64, mac-x64
 *   node scripts/fetch-ffmpeg.cjs --force …       # replace an existing copy
 *
 * Windows / Linux: the LGPL static builds from github.com/BtbN/FFmpeg-Builds.
 * macOS: there is no trusted LGPL download, so it is compiled here from the
 * official source with only what the recorder uses (needs Xcode command line
 * tools; about 2–4 minutes). mac-x64 can be cross-built on Apple Silicon.
 *
 * Node built-ins and the system tar/curl/make only, like the other scripts.
 */
const { execFileSync } = require('node:child_process')
const { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, chmodSync } = require('node:fs')
const { tmpdir, cpus } = require('node:os')
const { join } = require('node:path')

const FFMPEG_VERSION = '9.0'
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
const BTBN_BUILD = `ffmpeg-n${FFMPEG_VERSION}-latest`
const ROOT = join(__dirname, '..')

const args = process.argv.slice(2)
const force = args.includes('--force')
const hostTarget = () => {
  const os = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
  return `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
}
const target = args.find(a => !a.startsWith('--')) ?? hostTarget()
const TARGETS = ['mac-arm64', 'mac-x64', 'win-x64', 'win-arm64', 'linux-x64', 'linux-arm64']
if (!TARGETS.includes(target)) {
  console.error(`Unknown target ${target}. One of: ${TARGETS.join(', ')}`)
  process.exit(1)
}

const out = join(ROOT, 'resources', 'ffmpeg', target)
const exe = name => (target.startsWith('win') ? `${name}.exe` : name)
if (!force && existsSync(join(out, exe('ffmpeg'))) && existsSync(join(out, exe('ffprobe')))) {
  console.log(`ffmpeg for ${target} already in ${out} (use --force to replace)`)
  process.exit(0)
}

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...opts })
const work = mkdtempSync(join(tmpdir(), 'ffmpeg-'))

const findFile = (dir, name) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      const found = findFile(path, name)
      if (found) return found
    } else if (entry === name) return path
  }
  return null
}

const install = (ffmpeg, ffprobe) => {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  cpSync(ffmpeg, join(out, exe('ffmpeg')))
  cpSync(ffprobe, join(out, exe('ffprobe')))
  if (!target.startsWith('win')) {
    chmodSync(join(out, 'ffmpeg'), 0o755)
    chmodSync(join(out, 'ffprobe'), 0o755)
  }
  console.log(`\nffmpeg ${FFMPEG_VERSION} (LGPL) for ${target} → ${out}`)
}

try {
  if (target.startsWith('win') || target.startsWith('linux')) {
    const name = { 'win-x64': 'win64', 'win-arm64': 'winarm64', 'linux-x64': 'linux64', 'linux-arm64': 'linuxarm64' }[target]
    const file = `${BTBN_BUILD}-${name}-lgpl-${FFMPEG_VERSION}.${target.startsWith('win') ? 'zip' : 'tar.xz'}`
    const archive = join(work, file)
    console.log(`Downloading ${file}…`)
    run('curl', ['-fL', '--retry', '3', '-o', archive, `${BTBN}/${file}`])
    // bsdtar (macOS, Windows 10+) reads zip; GNU tar reads tar.xz.
    if (file.endsWith('.zip') && process.platform === 'linux') run('unzip', ['-q', archive, '-d', work])
    else run('tar', ['-xf', archive, '-C', work])
    const ffmpeg = findFile(work, exe('ffmpeg'))
    const ffprobe = findFile(work, exe('ffprobe'))
    if (!ffmpeg || !ffprobe) throw new Error('ffmpeg/ffprobe not found in the archive')
    install(ffmpeg, ffprobe)
  } else {
    if (process.platform !== 'darwin') throw new Error('The macOS build must run on a Mac.')
    const arch = target === 'mac-arm64' ? 'arm64' : 'x86_64'
    const src = join(work, `ffmpeg-${FFMPEG_VERSION}`)
    console.log(`Downloading ffmpeg ${FFMPEG_VERSION} source…`)
    run('curl', ['-fL', '--retry', '3', '-o', join(work, 'src.tar.xz'), `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`])
    run('tar', ['-xf', join(work, 'src.tar.xz'), '-C', work])
    const list = items => items.join(',')
    const configure = [
      // LGPL: no --enable-gpl, no --enable-nonfree.
      '--disable-everything',
      '--disable-autodetect',
      '--disable-doc',
      '--disable-network',
      '--disable-ffplay',
      '--disable-debug',
      '--enable-static',
      '--disable-shared',
      '--enable-ffmpeg',
      '--enable-ffprobe',
      '--enable-swscale',
      '--enable-swresample',
      '--enable-avfilter',
      `--arch=${arch}`,
      '--cc=clang',
      `--extra-cflags=-arch ${arch} -mmacosx-version-min=11.0`,
      `--extra-ldflags=-arch ${arch} -mmacosx-version-min=11.0`,
      ...(arch !== process.arch.replace('x64', 'x86_64') ? ['--enable-cross-compile', '--target-os=darwin'] : []),
      `--enable-protocol=${list(['file', 'pipe'])}`,
      `--enable-demuxer=${list(['matroska', 'concat', 'mov', 'ogg', 'wav', 'image2'])}`,
      `--enable-muxer=${list(['matroska', 'webm', 'mp4', 'ipod', 'mov', 'segment', 'null', 'image2', 'mjpeg'])}`,
      `--enable-decoder=${list(['h264', 'vp8', 'vp9', 'opus', 'aac', 'pcm_s16le', 'pcm_f32le', 'mjpeg'])}`,
      `--enable-encoder=${list(['aac', 'mjpeg'])}`,
      `--enable-parser=${list(['h264', 'vp8', 'vp9', 'opus', 'aac', 'mjpeg'])}`,
      `--enable-bsf=${list(['h264_mp4toannexb', 'aac_adtstoasc', 'vp9_superframe', 'extract_extradata'])}`,
      `--enable-filter=${list(['scale', 'format', 'null', 'anull', 'aresample', 'aformat', 'volumedetect'])}`
    ]
    console.log('Configuring (LGPL, recorder features only)…')
    run('./configure', configure, { cwd: src })
    run('make', [`-j${Math.max(2, cpus().length)}`, 'ffmpeg', 'ffprobe'], { cwd: src })
    install(join(src, 'ffmpeg'), join(src, 'ffprobe'))
    // Confirm the licence of what was built.
    run(join(out, 'ffmpeg'), ['-hide_banner', '-L'], { stdio: ['ignore', 'ignore', 'inherit'] })
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
