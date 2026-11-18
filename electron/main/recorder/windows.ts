import { BrowserWindow, screen, type Rectangle } from 'electron'
import { OVERLAY_SIZE_PX } from '@shared/constants/recorder'
import type { CaptureArea, OverlayCorner, OverlaySize } from '@shared/types/recorder'
import { logger } from '../logger'
import { loadRendererRoute, preloadPath } from '../window'

/*
 * The recorder's helper windows. All load the same page and preload as the
 * main window, at a hash route:
 *
 *   #engine   hidden; owns the capture streams and MediaRecorder
 *   #toolbar  floating REC / timer / pause / stop — excluded from the capture
 *   #region   one transparent overlay per display to drag a region
 *   #border   click-through frame around the recorded region — excluded
 *   #camera   webcam bubble over a screen recording — deliberately captured
 */

const webPreferences = (extra: Partial<Electron.WebPreferences> = {}): Electron.WebPreferences => ({
  preload: preloadPath(),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  // Capture and timers must run at full speed while hidden or covered.
  backgroundThrottling: false,
  ...extra
})

const watch = (win: BrowserWindow, name: string): BrowserWindow => {
  win.webContents.on('render-process-gone', (_e, details) => logger.error(`[recorder:${name}] renderer gone`, details))
  win.webContents.on('did-fail-load', (_e, code, description) => logger.error(`[recorder:${name}] failed to load`, { code, description }))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

export const displayFor = (displayId: string | null): Electron.Display => {
  const all = screen.getAllDisplays()
  return all.find(d => String(d.id) === displayId) ?? screen.getPrimaryDisplay()
}

// ── engine ──────────────────────────────────────────────────────────────────

export const createEngineWindow = (): BrowserWindow => {
  const win = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: webPreferences() })
  watch(win, 'engine')
  loadRendererRoute(win, 'engine')
  return win
}

// ── toolbar ─────────────────────────────────────────────────────────────────

const TOOLBAR = { width: 520, height: 64 }

export const createToolbarWindow = (area: CaptureArea | null): BrowserWindow => {
  const display = displayFor(area?.displayId ?? null)
  const { x, y, width } = display.workArea
  const win = new BrowserWindow({
    width: TOOLBAR.width,
    height: TOOLBAR.height,
    x: Math.round(x + (width - TOOLBAR.width) / 2),
    y: y + 12,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    show: false,
    webPreferences: webPreferences()
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Keep the toolbar out of the recording (macOS, Windows 10 2004+).
  win.setContentProtection(true)
  watch(win, 'toolbar')
  loadRendererRoute(win, 'toolbar')
  win.once('ready-to-show', () => win.showInactive())
  return win
}

// ── region selection ────────────────────────────────────────────────────────

export const createRegionWindows = (): BrowserWindow[] =>
  screen.getAllDisplays().map(display => {
    const { x, y, width, height } = display.bounds
    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      show: false,
      webPreferences: webPreferences()
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Exact display bounds (some window managers shrink a frameless window).
    win.setBounds({ x, y, width, height })
    watch(win, 'region')
    loadRendererRoute(win, `region?display=${display.id}`)
    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })
    return win
  })

// ── region border while recording ───────────────────────────────────────────

const BORDER = 3

export const createBorderWindow = (area: CaptureArea): BrowserWindow | null => {
  if (area.type !== 'region') return null
  const display = displayFor(area.displayId)
  const bounds: Rectangle = {
    x: Math.round(display.bounds.x + area.x - BORDER),
    y: Math.round(display.bounds.y + area.y - BORDER),
    width: Math.round(area.width + BORDER * 2),
    height: Math.round(area.height + BORDER * 2)
  }
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: webPreferences()
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)
  win.setContentProtection(true)
  watch(win, 'border')
  loadRendererRoute(win, 'border')
  win.once('ready-to-show', () => win.showInactive())
  return win
}

// ── camera bubble ───────────────────────────────────────────────────────────

export const createCameraWindow = (area: CaptureArea | null, corner: OverlayCorner, size: OverlaySize): BrowserWindow => {
  const side = OVERLAY_SIZE_PX[size]
  const display = displayFor(area?.displayId ?? null)
  // Inside the recorded area, so the bubble is part of the video.
  const box =
    area?.type === 'region'
      ? { x: display.bounds.x + area.x, y: display.bounds.y + area.y, width: area.width, height: area.height }
      : display.workArea
  const margin = 24
  const fit = Math.min(side, Math.max(80, Math.min(box.width, box.height) - margin * 2))
  const left = corner.endsWith('left') ? box.x + margin : box.x + box.width - fit - margin
  const top = corner.startsWith('top') ? box.y + margin : box.y + box.height - fit - margin
  const win = new BrowserWindow({
    x: Math.round(left),
    y: Math.round(top),
    width: fit,
    height: fit,
    minWidth: 80,
    minHeight: 80,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: webPreferences()
  })
  win.setAspectRatio(1)
  win.setAlwaysOnTop(true, 'floating')
  watch(win, 'camera')
  loadRendererRoute(win, 'camera')
  win.once('ready-to-show', () => win.showInactive())
  return win
}

export const closeWindow = (win: BrowserWindow | null | undefined): void => {
  if (win && !win.isDestroyed()) win.destroy()
}
