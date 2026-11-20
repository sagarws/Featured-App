import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow, desktopCapturer, nativeImage, screen, systemPreferences, type Display, type NativeImage } from 'electron'
import type { AreaPick, WindowBackground, WindowChoice } from '@shared/types/screenshot'
import { logger } from '../logger'

const run = promisify(execFile)

/*
 * Getting pixels off the screen.
 *
 *   Displays  desktopCapturer at each display's native pixel size — one call
 *             per distinct size, since a call scales every screen to one size.
 *   Windows   macOS: the system `screencapture` (exact pixels, the window's
 *             own shadow, the native hover-to-pick). Elsewhere: desktopCapturer
 *             window sources and a picker.
 */

export interface DisplayShot {
  display: Display
  image: NativeImage
}

export const screenPermission = (): 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown' => {
  if (process.platform !== 'darwin') return 'granted'
  try {
    return systemPreferences.getMediaAccessStatus('screen')
  } catch {
    return 'unknown'
  }
}

const nativeSize = (display: Display): { width: number; height: number } => ({
  width: Math.round(display.bounds.width * display.scaleFactor),
  height: Math.round(display.bounds.height * display.scaleFactor)
})

/** Every display as it looks right now, keyed by display id. */
export const captureDisplays = async (): Promise<Map<string, DisplayShot>> => {
  const displays = screen.getAllDisplays()
  const groups = new Map<string, Display[]>()
  for (const display of displays) {
    const { width, height } = nativeSize(display)
    const key = `${width}x${height}`
    groups.set(key, [...(groups.get(key) ?? []), display])
  }
  const shots = new Map<string, DisplayShot>()
  for (const group of groups.values()) {
    const first = group[0]
    if (!first) continue
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: nativeSize(first) })
    for (const display of group) {
      const index = displays.indexOf(display)
      // display_id is empty on some Linux setups: fall back to the same position.
      const source = sources.find(s => s.display_id === String(display.id)) ?? sources[index] ?? sources[0]
      if (source && !source.thumbnail.isEmpty()) shots.set(String(display.id), { display, image: source.thumbnail })
    }
  }
  if (!shots.size) {
    throw new Error(
      process.platform === 'darwin'
        ? 'Could not read the screen. Allow Featured App in System Settings → Privacy & Security → Screen Recording, then restart it.'
        : 'Could not read the screen.'
    )
  }
  return shots
}

export const cursorDisplay = (): Display => screen.getDisplayNearestPoint(screen.getCursorScreenPoint())

/** A rectangle (CSS px of that display) cut from its capture, in image pixels. */
export const cropArea = (shot: DisplayShot, area: AreaPick): NativeImage => {
  const size = shot.image.getSize()
  const ratio = size.width / shot.display.bounds.width
  const x = Math.max(0, Math.round(area.x * ratio))
  const y = Math.max(0, Math.round(area.y * ratio))
  const width = Math.max(1, Math.min(size.width - x, Math.round(area.width * ratio)))
  const height = Math.max(1, Math.min(size.height - y, Math.round(area.height * ratio)))
  return shot.image.crop({ x, y, width, height })
}

// ── windows: macOS ──────────────────────────────────────────────────────────

const tempFile = (): { dir: string; file: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'featured-shot-'))
  return { dir, file: join(dir, 'window.png') }
}

/**
 * `screencapture` into a temp file. Interactive (`-i -W`: hover a window and
 * click; Esc cancels) or one window by id (`-l`). `-o` leaves the shadow out.
 * null when the user cancelled.
 */
const macScreencapture = async (args: string[]): Promise<NativeImage | null> => {
  const { dir, file } = tempFile()
  try {
    await run('/usr/sbin/screencapture', [...args, '-x', '-t', 'png', file], { timeout: 10 * 60_000 }).catch((error: unknown) => {
      // Exit status 1 is a cancel; the file is simply not there.
      logger.info(`[screenshot] screencapture ended: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (!existsSync(file)) return null
    const image = nativeImage.createFromPath(file)
    return image.isEmpty() ? null : image
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The CGWindowID of the front window of the frontmost app (not this one), from
 * CoreGraphics through JavaScript for Automation. The window list comes
 * front-to-back, and does not need the Screen Recording permission.
 */
const FRONT_WINDOW_JXA = `
ObjC.import('CoreGraphics'); ObjC.import('AppKit');
const own = Number(${'$'}.NSProcessInfo.processInfo.environment.objectForKey('FEATURED_PID').js);
const front = ${'$'}.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
const list = ObjC.deepUnwrap(ObjC.castRefToObject(${'$'}.CGWindowListCopyWindowInfo(17, 0))) || [];
const normal = list.filter(w => w.kCGWindowLayer === 0 && w.kCGWindowOwnerPID !== own && (w.kCGWindowAlpha === undefined || w.kCGWindowAlpha > 0) && w.kCGWindowBounds && w.kCGWindowBounds.Width > 40 && w.kCGWindowBounds.Height > 40);
const win = normal.find(w => w.kCGWindowOwnerPID === front) || normal[0];
win ? String(win.kCGWindowNumber) : '';
`

const macFrontWindowId = async (): Promise<string | null> => {
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', FRONT_WINDOW_JXA], {
      timeout: 5000,
      env: { ...process.env, FEATURED_PID: String(process.pid) }
    })
    const id = stdout.trim()
    return /^\d+$/.test(id) ? id : null
  } catch (error) {
    logger.warn('[screenshot] could not find the front window', error)
    return null
  }
}

// ── windows: everywhere else ────────────────────────────────────────────────

const ownWindowSources = (): Set<string> =>
  new Set(
    BrowserWindow.getAllWindows()
      .filter(w => !w.isDestroyed())
      .map(w => {
        try {
          return w.getMediaSourceId()
        } catch {
          return ''
        }
      })
  )

const largestDisplay = (): { width: number; height: number } =>
  screen.getAllDisplays().reduce((best, d) => {
    const size = nativeSize(d)
    return size.width * size.height > best.width * best.height ? size : best
  }, { width: 1920, height: 1080 })

export const listWindows = async (): Promise<WindowChoice[]> => {
  const own = ownWindowSources()
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 400, height: 260 }, fetchWindowIcons: true })
  return sources
    .filter(s => !own.has(s.id) && !s.thumbnail.isEmpty() && s.name)
    .map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null }))
}

const windowSourceImage = async (id: string | null): Promise<NativeImage | null> => {
  const own = ownWindowSources()
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: largestDisplay() })
  // Without an id: the top-most window that is not ours (sources come in z-order on Windows).
  const source = id ? sources.find(s => s.id === id) : sources.find(s => !own.has(s.id) && !s.thumbnail.isEmpty() && s.name)
  return source && !source.thumbnail.isEmpty() ? source.thumbnail : null
}

// ── public window capture ───────────────────────────────────────────────────

/** macOS only: hover a window and click it. null when cancelled. */
export const pickWindowMac = (background: WindowBackground): Promise<NativeImage | null> =>
  macScreencapture(['-i', '-W', ...(background === 'trim' ? ['-o'] : [])])

/** The window the user is working in. null when there is none to capture. */
export const captureActiveWindow = async (background: WindowBackground): Promise<NativeImage | null> => {
  if (process.platform === 'darwin') {
    const id = await macFrontWindowId()
    if (!id) return null
    return macScreencapture([`-l${id}`, ...(background === 'trim' ? ['-o'] : [])])
  }
  return windowSourceImage(null)
}

/** One window from the picker (Windows / Linux). */
export const captureWindowById = (id: string): Promise<NativeImage | null> => windowSourceImage(id)

// ── window background ───────────────────────────────────────────────────────

const BACKDROP_FROM = [0x43, 0x53, 0xff] // brand blue
const BACKDROP_TO = [0xc0, 0x84, 0xfc] // violet

const hexRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * The window on a gradient or a solid colour, with a margin around it. Works
 * on the raw bitmap (BGRA, premultiplied — Skia's native order on every
 * platform Electron ships), so the window's soft shadow blends onto it.
 */
export const composeBackground = (image: NativeImage, background: WindowBackground, color: string): NativeImage => {
  if (background !== 'backdrop' && background !== 'solid') return image
  const { width: w, height: h } = image.getSize()
  const margin = Math.round(Math.min(160, Math.max(32, Math.max(w, h) * 0.06)))
  const W = w + margin * 2
  const H = h + margin * 2
  const out = Buffer.alloc(W * H * 4)
  const solid = hexRgb(color)

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r: number
      let g: number
      let b: number
      if (background === 'solid') {
        ;[r, g, b] = solid
      } else {
        const t = (x / W + y / H) / 2
        r = BACKDROP_FROM[0]! + (BACKDROP_TO[0]! - BACKDROP_FROM[0]!) * t
        g = BACKDROP_FROM[1]! + (BACKDROP_TO[1]! - BACKDROP_FROM[1]!) * t
        b = BACKDROP_FROM[2]! + (BACKDROP_TO[2]! - BACKDROP_FROM[2]!) * t
      }
      const i = (y * W + x) * 4
      out[i] = b
      out[i + 1] = g
      out[i + 2] = r
      out[i + 3] = 255
    }
  }

  const src = image.toBitmap()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      const a = src[s + 3]!
      if (a === 0) continue
      const d = ((y + margin) * W + (x + margin)) * 4
      const keep = 1 - a / 255
      out[d] = Math.min(255, src[s]! + out[d]! * keep)
      out[d + 1] = Math.min(255, src[s + 1]! + out[d + 1]! * keep)
      out[d + 2] = Math.min(255, src[s + 2]! + out[d + 2]! * keep)
    }
  }
  return nativeImage.createFromBitmap(out, { width: W, height: H })
}
