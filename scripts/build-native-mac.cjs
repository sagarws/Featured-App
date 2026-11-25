#!/usr/bin/env node
/*
 * Compiles the macOS helpers in native/mac into resources/native/mac/ as
 * universal (arm64 + x86_64) binaries. electron-builder ships that folder as
 * <resources>/native (see electron-builder.yml); in development the app runs
 * them from resources/native/mac directly.
 *
 *   node scripts/build-native-mac.cjs          # skipped when up to date
 *   node scripts/build-native-mac.cjs --force
 *
 * Needs the Xcode command line tools (clang). Does nothing on other systems.
 */
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, statSync } = require('node:fs')
const { dirname, join } = require('node:path')

if (process.platform !== 'darwin') process.exit(0)

const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'resources', 'native', 'mac')
const force = process.argv.includes('--force')

const HELPERS = [
  { name: 'audio-permission', source: 'native/mac/audio-permission.c', frameworks: ['CoreFoundation'] },
  // Remote Desktop: keyboard / mouse injection (CoreGraphics events). The
  // standalone helper is the fallback; the .node module runs the same code in
  // the app's own process, so macOS asks for the permission once, for the app.
  { name: 'remote-input', source: 'native/mac/remote-input.c', frameworks: ['ApplicationServices', 'CoreFoundation'] },
  // …plus the lock-screen picture (remote-capture.m: ScreenCaptureKit / CoreGraphics → JPEG).
  {
    name: 'remote-input.node',
    source: 'native/mac/remote-input.c',
    extra: ['native/mac/remote-capture.m'],
    frameworks: ['ApplicationServices', 'CoreFoundation', 'CoreGraphics', 'Foundation', 'ImageIO'],
    weakFrameworks: ['ScreenCaptureKit'],
    addon: true
  }
]

/** node_api.h: the headers of the Node running this script (Node-API is ABI-stable, so any recent one fits Electron). */
const nodeApiInclude = () => {
  const candidates = [join(dirname(process.execPath), '..', 'include', 'node'), '/opt/homebrew/include/node', '/usr/local/include/node']
  return candidates.find(dir => existsSync(join(dir, 'node_api.h'))) ?? null
}

mkdirSync(OUT, { recursive: true })
for (const helper of HELPERS) {
  const src = join(ROOT, helper.source)
  const out = join(OUT, helper.name)
  const sources = [src, ...(helper.extra ?? []).map(file => join(ROOT, file))]
  if (!force && existsSync(out) && sources.every(file => statSync(out).mtimeMs >= statSync(file).mtimeMs)) continue
  const args = ['-O2', '-fblocks', '-Wall', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0']
  if (helper.addon) {
    const include = nodeApiInclude()
    if (!include) {
      console.warn(`skipped ${helper.name}: node_api.h not found (the standalone helper is used instead)`)
      continue
    }
    // A loadable bundle; Node-API symbols come from the host process (Electron) at load time.
    args.push('-bundle', '-undefined', 'dynamic_lookup', '-DREMOTE_INPUT_ADDON', '-DNODE_GYP_MODULE_NAME=remote_input', '-I', include)
  }
  for (const fw of helper.frameworks) args.push('-framework', fw)
  // Weak: ScreenCaptureKit is macOS 12.3+, the app runs on 11.
  for (const fw of helper.weakFrameworks ?? []) args.push('-weak_framework', fw)
  if (helper.extra) args.push('-fobjc-arc')
  execFileSync('clang', [...args, '-o', out, ...sources], { stdio: 'inherit' })
  console.log(`built ${out}`)
}
