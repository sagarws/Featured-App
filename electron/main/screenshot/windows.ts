import { app, BrowserWindow, screen, type Display } from 'electron'
import type { CaptureInfo } from '@shared/types/screenshot'
import { logger } from '../logger'
import { loadRendererRoute, preloadPath } from '../window'

/*
 * The screenshot windows. All load the app's page and preload at a hash route
 * (see electron/renderer/main.tsx):
 *
 *   #shot-area     one per display: the frozen screen, drag to pick an area
 *   #shot-editor   the annotation editor
 *   #shot-thumb    floating preview in the corner after a capture
 *   #shot-pin      a picture pinned above every window
 *   #shot-windows  window picker (Windows / Linux)
 */

const webPreferences = (): Electron.WebPreferences => ({
  preload: preloadPath(),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true
})

const watch = (win: BrowserWindow, name: string): BrowserWindow => {
  win.webContents.on('render-process-gone', (_e, details) => logger.error(`[screenshot:${name}] renderer gone`, details))
  win.webContents.on('did-fail-load', (_e, code, description) => logger.error(`[screenshot:${name}] failed to load`, { code, description }))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

/** A background (menu-bar) app has to take focus for its new window to get the keyboard. */
export const bringForward = (win: BrowserWindow): void => {
  if (process.platform === 'darwin') app.focus({ steal: true })
  win.show()
  win.focus()
}

// ── area overlay ────────────────────────────────────────────────────────────

export const createAreaWindow = (display: Display): BrowserWindow => {
  const { x, y, width, height } = display.bounds
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
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
  watch(win, 'area')
  loadRendererRoute(win, `shot-area?display=${display.id}`)
  return win
}

// ── editor ──────────────────────────────────────────────────────────────────

const TOOLBAR_HEIGHT = 52
const STATUS_HEIGHT = 30
/*
 * Smallest editor. A narrow window moves the editing tools to a rail left of
 * the picture (two columns, ~440 px tall) and keeps only the actions and Copy
 * in the top bar, so this is what that compact layout needs to fit unclipped.
 */
const EDITOR_MIN_WIDTH = 640
const EDITOR_MIN_HEIGHT = 560

export const createEditorWindow = (info: CaptureInfo, options: { alwaysOnTop: boolean }): BrowserWindow => {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const area = display.workArea
  // The picture at its on-screen size, plus the toolbar, inside 90% of the screen.
  const wantW = Math.round(info.width / info.scaleFactor) + 48
  const wantH = Math.round(info.height / info.scaleFactor) + TOOLBAR_HEIGHT + STATUS_HEIGHT + 48
  const width = Math.max(760, Math.min(Math.round(area.width * 0.9), wantW))
  const height = Math.max(EDITOR_MIN_HEIGHT, Math.min(Math.round(area.height * 0.9), wantH))
  const win = new BrowserWindow({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    minWidth: EDITOR_MIN_WIDTH,
    minHeight: EDITOR_MIN_HEIGHT,
    title: `Screenshot — ${info.width}×${info.height}`,
    backgroundColor: '#1e1e24',
    show: false,
    alwaysOnTop: options.alwaysOnTop,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 18 } } : {}),
    autoHideMenuBar: true,
    webPreferences: webPreferences()
  })
  watch(win, 'editor')
  loadRendererRoute(win, `shot-editor?id=${info.id}`)
  win.once('ready-to-show', () => bringForward(win))
  return win
}

// ── thumbnail ───────────────────────────────────────────────────────────────

export const createThumbnailWindow = (info: CaptureInfo, display: Display): BrowserWindow => {
  const width = 260
  const ratio = info.height / info.width
  const height = Math.round(Math.min(220, Math.max(90, width * ratio))) + 8
  const area = display.workArea
  const win = new BrowserWindow({
    x: area.x + area.width - width - 20,
    y: area.y + area.height - height - 20,
    width,
    height,
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
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  watch(win, 'thumb')
  loadRendererRoute(win, `shot-thumb?id=${info.id}`)
  win.once('ready-to-show', () => win.showInactive())
  return win
}

// ── pin ─────────────────────────────────────────────────────────────────────

export const createPinWindow = (info: CaptureInfo): BrowserWindow => {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const area = display.workArea
  const scale = Math.min(1, (area.width * 0.6) / (info.width / info.scaleFactor), (area.height * 0.6) / (info.height / info.scaleFactor))
  const width = Math.max(60, Math.round((info.width / info.scaleFactor) * scale))
  const height = Math.max(40, Math.round((info.height / info.scaleFactor) * scale))
  const win = new BrowserWindow({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    frame: false,
    transparent: true,
    resizable: true,
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
  win.setAspectRatio(info.width / info.height)
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  watch(win, 'pin')
  loadRendererRoute(win, `shot-pin?id=${info.id}`)
  win.once('ready-to-show', () => win.showInactive())
  return win
}

// ── window picker ───────────────────────────────────────────────────────────

export const createWindowPicker = (): BrowserWindow => {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(960, area.width - 80)
  const height = Math.min(640, area.height - 80)
  const win = new BrowserWindow({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    title: 'Choose a window',
    backgroundColor: '#1e1e24',
    alwaysOnTop: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: webPreferences()
  })
  watch(win, 'windows')
  loadRendererRoute(win, 'shot-windows')
  win.once('ready-to-show', () => bringForward(win))
  return win
}

export const closeWindow = (win: BrowserWindow | null | undefined): void => {
  if (win && !win.isDestroyed()) win.destroy()
}
