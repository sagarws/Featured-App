import { app, BrowserWindow, screen } from 'electron'
import { logger } from '../logger'
import { loadRendererRoute, preloadPath } from '../window'

/*
 * Remote Desktop windows. All load the app's page and preload at a hash route
 * (electron/renderer/main.tsx → remote/windows/mountRemote.tsx):
 *
 *   #rd-viewer   the remote screen (viewer side), its own resizable window
 *   #rd-host     hidden (host side): captures the screen, runs WebRTC
 *   #rd-hostbar  host side, always on top: "X is controlling this computer",
 *                timer, view-only, extend, stop — the visible indicator
 *   #rd-request  host side: an incoming request to Allow / Reject
 */

const webPreferences = (): Electron.WebPreferences => ({
  preload: preloadPath(),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  // Capture, video and timers must keep full speed when covered or hidden.
  backgroundThrottling: false
})

const watch = (win: BrowserWindow, name: string): BrowserWindow => {
  win.webContents.on('render-process-gone', (_e, details) => logger.error(`[remote:${name}] renderer gone`, details))
  win.webContents.on('did-fail-load', (_e, code, description) => logger.error(`[remote:${name}] failed to load`, { code, description }))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  return win
}

export const bringForward = (win: BrowserWindow): void => {
  if (process.platform === 'darwin') {
    void app.dock?.show()
    app.focus({ steal: true })
  }
  win.show()
  win.focus()
}

export const createViewerWindow = (sessionId: string, title: string): BrowserWindow => {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(1600, Math.round(area.width * 0.9))
  const height = Math.min(1000, Math.round(area.height * 0.9))
  const win = new BrowserWindow({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    minWidth: 640,
    minHeight: 420,
    title,
    backgroundColor: '#0d0e12',
    show: false,
    autoHideMenuBar: true,
    fullscreenable: true,
    webPreferences: webPreferences()
  })
  watch(win, 'viewer')
  loadRendererRoute(win, `rd-viewer?session=${sessionId}`)
  win.once('ready-to-show', () => bringForward(win))
  return win
}

export const createHostEngineWindow = (sessionId: string): BrowserWindow => {
  const win = new BrowserWindow({ show: false, width: 320, height: 240, skipTaskbar: true, webPreferences: webPreferences() })
  watch(win, 'host')
  loadRendererRoute(win, `rd-host?session=${sessionId}`)
  return win
}

const HOSTBAR = { width: 620, height: 58 }

export const createHostBarWindow = (): BrowserWindow => {
  const { x, y, width } = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({
    width: HOSTBAR.width,
    height: HOSTBAR.height,
    x: Math.round(x + (width - HOSTBAR.width) / 2),
    y: y + 8,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    show: false,
    webPreferences: webPreferences()
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // The person at the host always sees it; the remote viewer does not need it in the stream.
  win.setContentProtection(true)
  watch(win, 'hostbar')
  loadRendererRoute(win, 'rd-hostbar')
  win.once('ready-to-show', () => win.showInactive())
  return win
}

export const createRequestWindow = (requestId: string): BrowserWindow => {
  const area = screen.getPrimaryDisplay().workArea
  const width = 460
  const height = 520
  const win = new BrowserWindow({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 3),
    width,
    height,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'Remote access request',
    backgroundColor: '#1b1c22',
    show: false,
    autoHideMenuBar: true,
    webPreferences: webPreferences()
  })
  win.setAlwaysOnTop(true, 'modal-panel')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setContentProtection(true)
  watch(win, 'request')
  loadRendererRoute(win, `rd-request?id=${requestId}`)
  win.once('ready-to-show', () => bringForward(win))
  return win
}
