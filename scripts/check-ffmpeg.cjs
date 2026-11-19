/*
 * electron-builder beforePack hook: stops the build when this target's ffmpeg
 * + ffprobe are missing from resources/ffmpeg/<os>-<arch>/. Without them the
 * packaged app can only record on machines that have ffmpeg installed
 * themselves. Fetch/build them with `npm run ffmpeg -- <os>-<arch>`.
 */
const { existsSync } = require('node:fs')
const { join } = require('node:path')

// electron-builder's Arch enum (builder-util): ia32, x64, armv7l, arm64, universal
const ARCHES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']
const OS = { darwin: 'mac', mas: 'mac', win32: 'win', linux: 'linux' }

exports.default = async context => {
  const os = OS[context.electronPlatformName]
  const arch = ARCHES[context.arch]
  const target = `${os}-${arch}`
  const dir = join(__dirname, '..', 'resources', 'ffmpeg', target)
  const exe = name => (os === 'win' ? `${name}.exe` : name)
  const missing = ['ffmpeg', 'ffprobe'].filter(name => !existsSync(join(dir, exe(name))))
  if (missing.length) {
    throw new Error(`${missing.join(' and ')} missing from ${dir}. Run: npm run ffmpeg -- ${target}`)
  }
  console.log(`  • ffmpeg check  bundled ffmpeg + ffprobe found for ${target}`)
}
