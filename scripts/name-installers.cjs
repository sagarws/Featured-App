/*
 * electron-builder afterAllArtifactBuild hook: names each installer exactly
 * like its entry in UPDATE_FEEDS (shared/constants/updates.ts), so the file
 * you upload and the name in the software-versions list are the same:
 *
 *   win32-x64     Featured-App-x64-setup.exe  → <softwareName>.exe
 *   darwin-arm64  Featured-App-arm64.dmg      → <softwareName>.dmg
 *   darwin-x64    Featured-App-x64.dmg        → <softwareName>.dmg
 *
 * The names are read from updates.ts itself (one place to change them).
 * Block maps follow their installer. No latest.yml is used by the app.
 */
const { existsSync, readFileSync, renameSync } = require('node:fs')
const { basename, dirname, extname, join } = require('node:path')

const feeds = () => {
  const source = readFileSync(join(__dirname, '..', 'shared', 'constants', 'updates.ts'), 'utf8')
  const out = {}
  for (const m of source.matchAll(/'([a-z0-9-]+)':\s*feed\('([^']+)',\s*'(\w+)'\)/g)) out[m[1]] = { name: m[2], installer: m[3] }
  return out
}

/** Which UPDATE_FEEDS entry a built file is for, from its name and type. */
const targetOf = file => {
  const name = basename(file)
  const ext = extname(file).slice(1).toLowerCase()
  const arch = /arm64/.test(name) ? 'arm64' : /ia32/.test(name) ? 'ia32' : /x64/.test(name) ? 'x64' : null
  if (!arch) return null
  if (ext === 'exe') return `win32-${arch}`
  if (ext === 'dmg') return `darwin-${arch}`
  if (ext === 'appimage') return `linux-${arch}`
  return null
}

/** Pure: the new path for a built installer, or null to leave it as it is. */
const renamedPath = (file, table) => {
  const target = targetOf(file)
  const feed = target ? table[target] : null
  if (!feed || feed.installer !== extname(file).slice(1).toLowerCase()) return null
  const next = join(dirname(file), `${feed.name}.${feed.installer}`)
  return next === file ? null : next
}

const hook = async buildResult => {
  const table = feeds()
  const paths = []
  for (const file of buildResult.artifactPaths) {
    const next = !file.endsWith('.blockmap') && existsSync(file) ? renamedPath(file, table) : null
    if (!next) {
      paths.push(file)
      continue
    }
    renameSync(file, next)
    if (existsSync(`${file}.blockmap`)) renameSync(`${file}.blockmap`, `${next}.blockmap`)
    console.log(`  • installer named for its update feed  ${basename(file)} → ${basename(next)}`)
    paths.push(next)
  }
  return paths.filter(p => !p.endsWith('.blockmap') || existsSync(p))
}

module.exports = hook
module.exports.default = hook
module.exports.renamedPath = renamedPath
module.exports.feeds = feeds
