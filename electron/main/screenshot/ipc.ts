import { mkdirSync } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { SCREENSHOT_IPC } from '@shared/constants/channels'
import type { Result } from '@shared/types/agent'
import type { AreaPick, ExportAction, ScreenshotAction, ScreenshotEnvironment, ScreenshotSettings } from '@shared/types/screenshot'
import { SCREENSHOT_ACTIONS, uploadProblem } from '@shared/utils/screenshot'
import { logger } from '../logger'
import { getSettings } from '../settings'
import { getWindow, isRendererUrl } from '../window'
import { listWindows, screenPermission } from './capture'
import { encryptionAvailable, getScreenshotSettings, onScreenshotSettingsChanged, screenshotsFolder, setScreenshotFolder, updateScreenshotSettings } from './config'
import { applyHotkeys, hotkeyStatuses, releaseHotkeys, suspendHotkeys } from './hotkeys'
import { copyFile, deleteFile, fileInFolder, listRecent, revealFile } from './library'
import {
  broadcastLibraryChanged,
  captureFor,
  closeSender,
  exportCapture,
  openFileInEditor,
  openInEditor,
  overlayDone,
  overlayImage,
  overlayReady,
  overlayStarted,
  startDrag,
  takeScreenshot,
  windowPicked
} from './service'
import { testUpload } from './upload'

/** Every call must come from this app's own page (main window or a screenshot window). */
const handle = <A extends unknown[], T>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: A) => T | Promise<T>): void => {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<Result<T>> => {
    if (!isRendererUrl(event.senderFrame?.url ?? '')) return { ok: false, error: 'Not allowed.' }
    try {
      return { ok: true, value: await fn(event, ...(args as A)) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`[screenshot] ${channel} failed: ${message}`)
      return { ok: false, error: message }
    }
  })
}

const listen = (channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void): void => {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    if (isRendererUrl(event.senderFrame?.url ?? '')) fn(event, ...args)
  })
}

const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)
const captureId = (v: unknown): string => {
  if (!isId(v)) throw new Error('Unknown screenshot.')
  return v
}
const isAction = (v: unknown): v is ScreenshotAction => SCREENSHOT_ACTIONS.includes(v as ScreenshotAction)
const EXPORTS: readonly ExportAction[] = ['copy', 'save', 'saveAs', 'upload', 'pin']

const parsePick = (v: unknown): AreaPick | null => {
  if (!v || typeof v !== 'object') return null
  const a = v as Record<string, unknown>
  const n = (k: string): number => (typeof a[k] === 'number' && Number.isFinite(a[k]) ? a[k] : NaN)
  const pick = { displayId: typeof a['displayId'] === 'string' ? a['displayId'] : '', x: n('x'), y: n('y'), width: n('width'), height: n('height') }
  return pick.displayId && [pick.x, pick.y, pick.width, pick.height].every(Number.isFinite) && pick.width >= 1 && pick.height >= 1 ? pick : null
}

const platform = (): ScreenshotEnvironment['platform'] =>
  process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux'

const environment = (): ScreenshotEnvironment => ({
  platform: platform(),
  folder: screenshotsFolder(),
  screenPermission: screenPermission(),
  encryption: encryptionAvailable(),
  hotkeys: hotkeyStatuses(),
  openAtLogin: getSettings().openAtLogin,
  packaged: app.isPackaged
})

const run = (action: ScreenshotAction): void => void takeScreenshot(action, 'hotkey')

const pushChanged = (): void => {
  getWindow()?.webContents.send(SCREENSHOT_IPC.changed)
}

const KEYBOARD_SETTINGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension',
  win32: 'ms-settings:keyboard'
}

/**
 * Register the screenshot IPC and shortcuts. `onTrayIcon` is told whether
 * the menu-bar icon should show, now and whenever that setting changes.
 */
export const registerScreenshots = (onTrayIcon: (visible: boolean) => void): void => {
  applyHotkeys(getScreenshotSettings().hotkeys, run)
  onTrayIcon(!getScreenshotSettings().hideTrayIcon)
  onScreenshotSettingsChanged(settings => {
    applyHotkeys(settings.hotkeys, run)
    onTrayIcon(!settings.hideTrayIcon)
    pushChanged()
  })
  app.on('will-quit', releaseHotkeys)

  // ── the Screenshots page ──
  handle(SCREENSHOT_IPC.capture, (event, action: unknown) => {
    if (!isAction(action)) throw new Error('Unknown screenshot type.')
    const fromMain = getWindow()?.webContents.id === event.sender.id
    void takeScreenshot(action, fromMain ? 'page' : 'hotkey')
  })
  handle(SCREENSHOT_IPC.getSettings, () => getScreenshotSettings())
  handle(SCREENSHOT_IPC.updateSettings, (_e, patch: unknown): ScreenshotSettings => {
    if (!patch || typeof patch !== 'object') throw new Error('Expected settings.')
    return updateScreenshotSettings(patch)
  })
  handle(SCREENSHOT_IPC.environment, () => environment())
  handle(SCREENSHOT_IPC.chooseFolder, async (event): Promise<string | null> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { title: 'Folder for screenshots', defaultPath: screenshotsFolder(), properties: ['openDirectory', 'createDirectory'] }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const dir = result.canceled ? null : (result.filePaths[0] ?? null)
    if (dir) {
      setScreenshotFolder(dir)
      broadcastLibraryChanged()
    }
    return dir
  })
  handle(SCREENSHOT_IPC.resetFolder, () => {
    setScreenshotFolder(null)
    broadcastLibraryChanged()
    return screenshotsFolder()
  })
  handle(SCREENSHOT_IPC.openFolder, async () => {
    mkdirSync(screenshotsFolder(), { recursive: true })
    const error = await shell.openPath(screenshotsFolder())
    if (error) throw new Error(error)
  })
  handle(SCREENSHOT_IPC.openKeyboardSettings, async () => {
    const url = KEYBOARD_SETTINGS[process.platform]
    if (!url) throw new Error('Open the keyboard settings from your system menu.')
    await shell.openExternal(url)
  })
  handle(SCREENSHOT_IPC.openScreenPrivacy, async () => {
    if (process.platform !== 'darwin') return
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })
  handle(SCREENSHOT_IPC.suspendHotkeys, (_e, pause: unknown) => {
    suspendHotkeys(pause === true)
    if (pause !== true) pushChanged()
  })
  handle(SCREENSHOT_IPC.listRecent, () => listRecent())
  handle(SCREENSHOT_IPC.openFile, (_e, path: unknown) => openFileInEditor(fileInFolder(path)))
  handle(SCREENSHOT_IPC.revealFile, (_e, path: unknown) => revealFile(fileInFolder(path)))
  handle(SCREENSHOT_IPC.copyFile, (_e, path: unknown) => copyFile(fileInFolder(path)))
  handle(SCREENSHOT_IPC.deleteFile, (_e, path: unknown) => deleteFile(fileInFolder(path)))
  handle(SCREENSHOT_IPC.testUpload, () => testUpload(getScreenshotSettings()))

  // ── editor / thumbnail / pin ──
  handle(SCREENSHOT_IPC.getCapture, (_e, id: unknown) => captureFor(captureId(id)))
  handle(SCREENSHOT_IPC.editorSettings, () => {
    const s = getScreenshotSettings()
    return {
      preferActualSize: s.preferActualSize,
      escCopy: s.escCopy,
      escSave: s.escSave,
      thumbnailTimeout: s.thumbnailTimeout,
      uploadReady: uploadProblem(s.upload) === null,
      uploadProblem: uploadProblem(s.upload),
      platform: platform()
    }
  })
  handle(SCREENSHOT_IPC.exportImage, (event, id: unknown, action: unknown, png: unknown) => {
    if (!EXPORTS.includes(action as ExportAction)) throw new Error('Unknown action.')
    if (png !== null && png !== undefined && !(png instanceof Uint8Array)) throw new Error('Expected PNG bytes.')
    return exportCapture(event.sender, captureId(id), action as ExportAction, png ?? null)
  })
  handle(SCREENSHOT_IPC.openEditor, (event, id: unknown) => {
    openInEditor(captureId(id))
    closeSender(event.sender)
  })
  handle(SCREENSHOT_IPC.closeSelf, event => closeSender(event.sender))
  listen(SCREENSHOT_IPC.startDrag, (event, id) => {
    if (isId(id)) startDrag(event.sender, id)
  })

  // ── area overlays ──
  handle(SCREENSHOT_IPC.overlayImage, (event, displayId: unknown) => (typeof displayId === 'string' ? overlayImage(event.sender, displayId) : null))
  listen(SCREENSHOT_IPC.overlayReady, event => overlayReady(event.sender))
  listen(SCREENSHOT_IPC.overlayStarted, event => overlayStarted(event.sender))
  listen(SCREENSHOT_IPC.overlayDone, (event, pick) => overlayDone(event.sender, parsePick(pick)))

  // ── window picker ──
  handle(SCREENSHOT_IPC.listWindows, () => listWindows())
  handle(SCREENSHOT_IPC.pickWindow, (event, id: unknown) => windowPicked(event.sender, typeof id === 'string' && id.length < 256 ? id : null))
}
