import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { BrowserWindow, clipboard, dialog, nativeImage, Notification, shell, type Display, type NativeImage, type WebContents } from 'electron'
import { SCREENSHOT_IPC } from '@shared/constants/channels'
import type { AreaPick, CaptureImage, CaptureInfo, ExportAction, ExportResult, ScreenshotAction, ScreenshotSettings } from '@shared/types/screenshot'
import { chooseFormat, screenshotFileName, uniqueFileName } from '@shared/utils/screenshot'
import { logger } from '../logger'
import { getWindow, showWindow } from '../window'
import {
  captureActiveWindow,
  captureDisplays,
  captureWindowById,
  composeBackground,
  cropArea,
  cursorDisplay,
  pickWindowMac,
  screenPermission,
  type DisplayShot
} from './capture'
import { getScreenshotSettings, screenshotsFolder } from './config'
import { uploadImage } from './upload'
import { bringForward, closeWindow, createAreaWindow, createEditorWindow, createPinWindow, createThumbnailWindow, createWindowPicker } from './windows'

/*
 * One screenshot from key press to clipboard / file / link:
 *
 *   capture  → the picture is held here under an id
 *   deliver  → the "After screenshot" settings: copy, save, upload, show
 *   show     → editor, thumbnail or pin windows read it by id; when the last
 *              one closes, it is dropped
 *   export   → the editor sends back its annotated PNG to copy / save / upload
 */

interface Held {
  info: CaptureInfo
  image: NativeImage
  png: Buffer | null
  /** webContents ids of the windows showing it. */
  viewers: Set<number>
  /** Work still running on it (an upload) — keeps it after its windows close. */
  busy: number
}

const held = new Map<string, Held>()
const editors = new Set<number>()
let capturing = false
let lastArea: AreaPick | null = null

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const hold = (image: NativeImage, scaleFactor: number, kind: CaptureInfo['kind'], savedPath: string | null = null): Held => {
  const { width, height } = image.getSize()
  const entry: Held = {
    info: { id: randomUUID(), width, height, scaleFactor, kind, createdAt: new Date().toISOString(), savedPath, link: null },
    image,
    png: null,
    viewers: new Set(),
    busy: 0
  }
  held.set(entry.info.id, entry)
  return entry
}

const dropIfUnused = (entry: Held): void => {
  if (!entry.viewers.size && entry.busy <= 0) held.delete(entry.info.id)
}

const attach = (entry: Held, win: BrowserWindow): BrowserWindow => {
  const id = win.webContents.id
  entry.viewers.add(id)
  win.once('closed', () => {
    entry.viewers.delete(id)
    editors.delete(id)
    dropIfUnused(entry)
  })
  return win
}

const pngOf = (entry: Held): Buffer => (entry.png ??= entry.image.toPNG())

const broadcastCapture = (entry: Held): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && entry.viewers.has(win.webContents.id)) win.webContents.send(SCREENSHOT_IPC.captureUpdated, entry.info)
  }
}

export const broadcastLibraryChanged = (): void => {
  getWindow()?.webContents.send(SCREENSHOT_IPC.libraryChanged)
}

// ── notifications ───────────────────────────────────────────────────────────

const confirm = (title: string, body: string, open?: { path?: string; link?: string }): void => {
  if (getScreenshotSettings().confirmation !== 'notification' || !Notification.isSupported()) return
  try {
    const notification = new Notification({ title, body, silent: true })
    notification.on('click', () => {
      if (open?.link) void shell.openExternal(open.link)
      else if (open?.path) shell.showItemInFolder(open.path)
    })
    notification.show()
  } catch (error) {
    logger.warn('[screenshot] notification failed', error)
  }
}

/** Errors always show, whatever the confirmation setting: something the user asked for did not happen. */
const fail = (title: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error)
  logger.warn(`[screenshot] ${title}: ${message}`)
  if (!Notification.isSupported()) return
  try {
    new Notification({ title, body: message }).show()
  } catch {
    // nothing more to do
  }
}

// ── encode / save / upload ──────────────────────────────────────────────────

interface Encoded {
  bytes: Buffer
  ext: 'png' | 'jpg'
  mimeType: string
  width: number
  height: number
}

/** The picture as it should be written: 1× when asked, PNG or JPEG per the save format. */
const encode = (image: NativeImage, png: Buffer | null, scaleFactor: number, settings: ScreenshotSettings, force?: 'png' | 'jpeg'): Encoded => {
  let output = image
  let pngBytes = png
  if (settings.downscaleRetina && scaleFactor > 1) {
    output = image.resize({ width: Math.max(1, Math.round(image.getSize().width / scaleFactor)), quality: 'best' })
    pngBytes = null
  }
  const { width, height } = output.getSize()
  if (force === 'jpeg') return { bytes: output.toJPEG(92), ext: 'jpg', mimeType: 'image/jpeg', width, height }
  pngBytes ??= output.toPNG()
  if (force === 'png') return { bytes: pngBytes, ext: 'png', mimeType: 'image/png', width, height }
  const jpeg = settings.saveFormat === 'png' ? null : output.toJPEG(90)
  return chooseFormat(settings.saveFormat, pngBytes.length, jpeg?.length ?? null) === 'jpeg' && jpeg
    ? { bytes: jpeg, ext: 'jpg', mimeType: 'image/jpeg', width, height }
    : { bytes: pngBytes, ext: 'png', mimeType: 'image/png', width, height }
}

const writeToFolder = (encoded: Encoded): string => {
  const folder = screenshotsFolder()
  mkdirSync(folder, { recursive: true })
  const name = uniqueFileName(screenshotFileName(new Date(), encoded.ext), candidate => existsSync(join(folder, candidate)))
  const path = join(folder, name)
  writeFileSync(path, encoded.bytes)
  broadcastLibraryChanged()
  return path
}

const upload = async (entry: Held, image: NativeImage, png: Buffer | null): Promise<string | null> => {
  const settings = getScreenshotSettings()
  const encoded = encode(image, png, entry.info.scaleFactor, settings)
  entry.busy++
  try {
    const link = await uploadImage(settings, {
      fileName: screenshotFileName(new Date(), encoded.ext),
      mimeType: encoded.mimeType,
      bytes: encoded.bytes,
      width: encoded.width,
      height: encoded.height,
      capturedAt: entry.info.createdAt
    })
    entry.info.link = link
    if (link && settings.upload.copyLink) clipboard.writeText(link)
    broadcastCapture(entry)
    return link
  } finally {
    entry.busy--
    dropIfUnused(entry)
  }
}

// ── windows ─────────────────────────────────────────────────────────────────

const openEditor = (entry: Held): void => {
  const win = createEditorWindow(entry.info, { alwaysOnTop: getScreenshotSettings().editorAlwaysOnTop })
  editors.add(win.webContents.id)
  attach(entry, win)
}

const openThumbnail = (entry: Held, display: Display): void => {
  attach(entry, createThumbnailWindow(entry.info, display))
}

const openPin = (entry: Held): void => {
  attach(entry, createPinWindow(entry.info))
}

// ── after a capture ─────────────────────────────────────────────────────────

const deliver = (image: NativeImage, scaleFactor: number, kind: CaptureInfo['kind'], display: Display): void => {
  const settings = getScreenshotSettings()
  const entry = hold(image, scaleFactor, kind)
  entry.busy++
  const done: string[] = []
  try {
    if (settings.afterCopy) {
      clipboard.writeImage(image)
      done.push('copied to the clipboard')
    }
    if (settings.afterSave) {
      try {
        entry.info.savedPath = writeToFolder(encode(image, null, scaleFactor, settings))
        done.push('saved')
      } catch (error) {
        fail('Could not save the screenshot', error)
      }
    }
    const show = settings.afterShow
    if (show) {
      if (kind === 'area' && settings.afterAreaShow === 'thumbnail') openThumbnail(entry, display)
      else openEditor(entry)
    }
    if (settings.afterUpload) {
      upload(entry, image, null)
        .then(link => confirm('Screenshot uploaded', link ? (settings.upload.copyLink ? `Link copied: ${link}` : link) : 'No link to share.', link ? { link } : {}))
        .catch((error: unknown) => fail('Upload failed', error))
    } else if (!show && done.length) {
      confirm('Screenshot taken', `${done.join(' and ')}${entry.info.savedPath ? `: ${entry.info.savedPath}` : '.'}`.replace(/^./, c => c.toUpperCase()), entry.info.savedPath ? { path: entry.info.savedPath } : {})
    }
  } finally {
    entry.busy--
    dropIfUnused(entry)
  }
}

// ── area picking ────────────────────────────────────────────────────────────

let areaPick: {
  shots: Map<string, DisplayShot>
  windows: BrowserWindow[]
  /** webContents id → the display that overlay covers. */
  displays: Map<number, string>
  resolve: (result: { shot: DisplayShot; area: AreaPick } | null) => void
} | null = null

const finishArea = (area: AreaPick | null): void => {
  const pick = areaPick
  if (!pick) return
  areaPick = null
  pick.windows.forEach(closeWindow)
  const shot = area ? pick.shots.get(area.displayId) : undefined
  pick.resolve(shot && area ? { shot, area } : null)
}

const pickArea = async (): Promise<{ shot: DisplayShot; area: AreaPick } | null> => {
  if (areaPick) finishArea(null)
  const shots = await captureDisplays()
  return new Promise(resolve => {
    const entries = [...shots.entries()].map(([displayId, shot]) => ({ displayId, win: createAreaWindow(shot.display) }))
    const windows = entries.map(e => e.win)
    areaPick = { shots, windows, displays: new Map(entries.map(e => [e.win.webContents.id, e.displayId])), resolve }
    // An overlay closed some other way (crash, OS) cancels the pick.
    windows.forEach(win => win.once('closed', () => areaPick?.windows.includes(win) && finishArea(null)))
  })
}

const areaWindowOf = (sender: WebContents): BrowserWindow | undefined =>
  areaPick?.windows.find(win => !win.isDestroyed() && win.webContents.id === sender.id)


/** The frozen screen for one overlay, as JPEG (fast to encode; only a backdrop to aim at). */
export const overlayImage = (sender: WebContents, displayId: string): Uint8Array | null => {
  if (!areaWindowOf(sender)) return null
  const shot = areaPick?.shots.get(displayId)
  return shot ? shot.image.toJPEG(95) : null
}

export const overlayReady = (sender: WebContents): void => {
  const win = areaWindowOf(sender)
  if (!win) return
  if (areaPick?.displays.get(sender.id) === String(cursorDisplay().id)) bringForward(win)
  else win.showInactive()
}

export const overlayStarted = (sender: WebContents): void => {
  for (const win of areaPick?.windows ?? []) {
    if (!win.isDestroyed() && win.webContents.id !== sender.id) win.webContents.send(SCREENSHOT_IPC.overlayReset)
  }
}

export const overlayDone = (sender: WebContents, area: AreaPick | null): void => {
  if (!areaWindowOf(sender) || !areaPick) return
  // The display is the one this overlay covers, whatever the page says.
  const displayId = areaPick.displays.get(sender.id)
  finishArea(area && displayId ? { ...area, displayId } : null)
}

// ── window picker (Windows / Linux) ─────────────────────────────────────────

let windowPick: { win: BrowserWindow; resolve: (id: string | null) => void } | null = null

const pickWindowFromList = (): Promise<string | null> =>
  new Promise(resolve => {
    windowPick?.resolve(null)
    const win = createWindowPicker()
    windowPick = { win, resolve }
    win.once('closed', () => {
      if (windowPick?.win === win) {
        windowPick = null
        resolve(null)
      }
    })
  })

export const windowPicked = (sender: WebContents, id: string | null): void => {
  const pick = windowPick
  if (!pick || pick.win.isDestroyed() || pick.win.webContents.id !== sender.id) return
  windowPick = null
  closeWindow(pick.win)
  pick.resolve(id)
}

// ── capture ─────────────────────────────────────────────────────────────────

const PRIVACY_SCREEN = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

/**
 * Take a screenshot. `origin` decides what gets out of the way first: from the
 * app's own page the main window hides, from the tray its menu fades.
 */
export const takeScreenshot = async (action: ScreenshotAction, origin: 'hotkey' | 'tray' | 'page'): Promise<void> => {
  if (action === 'showApp') {
    showWindow()
    return
  }
  if (capturing) return
  capturing = true
  try {
    if (screenPermission() === 'denied' || screenPermission() === 'restricted') {
      fail('Screen Recording permission needed', new Error('Allow Featured App in System Settings → Privacy & Security → Screen Recording, then restart it.'))
      void shell.openExternal(PRIVACY_SCREEN)
      return
    }
    if (origin === 'page') {
      getWindow()?.hide()
      await delay(300)
    } else if (origin === 'tray') {
      await delay(250)
    }
    const settings = getScreenshotSettings()

    switch (action) {
      case 'fullscreen': {
        const display = cursorDisplay()
        const shots = await captureDisplays()
        const shot = shots.get(String(display.id)) ?? [...shots.values()][0]
        if (shot) deliver(shot.image, shot.display.scaleFactor, 'fullscreen', shot.display)
        break
      }
      case 'area':
      case 'repeatArea': {
        let picked: { shot: DisplayShot; area: AreaPick } | null = null
        if (action === 'repeatArea' && lastArea) {
          const shot = (await captureDisplays()).get(lastArea.displayId)
          if (shot) picked = { shot, area: lastArea }
        }
        picked ??= await pickArea()
        if (!picked) break
        lastArea = picked.area
        deliver(cropArea(picked.shot, picked.area), picked.shot.display.scaleFactor, 'area', picked.shot.display)
        break
      }
      case 'window':
      case 'activeWindow': {
        const display = cursorDisplay()
        let image: NativeImage | null
        if (action === 'activeWindow') image = await captureActiveWindow(settings.windowBackground)
        else if (process.platform === 'darwin') image = await pickWindowMac(settings.windowBackground)
        else {
          const id = await pickWindowFromList()
          image = id ? await captureWindowById(id) : null
        }
        if (!image) {
          if (action === 'activeWindow') fail('No window to capture', new Error('Click the window you want, then press the shortcut again.'))
          break
        }
        deliver(composeBackground(image, settings.windowBackground, settings.backgroundColor), display.scaleFactor, 'window', display)
        break
      }
    }
  } catch (error) {
    fail('Screenshot failed', error)
  } finally {
    capturing = false
  }
}

// ── the windows' requests ───────────────────────────────────────────────────

export const captureFor = (id: string): CaptureImage | null => {
  const entry = held.get(id)
  return entry ? { ...entry.info, png: pngOf(entry) } : null
}

export const captureInfo = (id: string): CaptureInfo | null => held.get(id)?.info ?? null

/** The editor for a picture already open in a thumbnail (or the page's Recent list). */
export const openInEditor = (id: string): void => {
  const entry = held.get(id)
  if (entry) openEditor(entry)
}

export const openFileInEditor = (path: string): void => {
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) throw new Error('This file is not a picture that can be opened.')
  openEditor(hold(image, cursorDisplay().scaleFactor, 'file', path))
}

/**
 * Do something with a picture. The editor sends its annotated PNG along; the
 * thumbnail sends nothing and the picture as captured is used.
 */
export const exportCapture = async (sender: WebContents, id: string, action: ExportAction, png: Uint8Array | null): Promise<ExportResult> => {
  const entry = held.get(id)
  if (!entry) throw new Error('This screenshot is no longer open.')
  let image = entry.image
  let pngBytes: Buffer | null = entry.png
  if (png) {
    pngBytes = Buffer.from(png)
    image = nativeImage.createFromBuffer(pngBytes)
    if (image.isEmpty()) throw new Error('The edited picture could not be read.')
  }
  // The editor shows its own toasts; a notification is for the thumbnail.
  const quiet = editors.has(sender.id)
  const settings = getScreenshotSettings()

  switch (action) {
    case 'copy':
      clipboard.writeImage(image)
      if (!quiet) confirm('Copied', 'The screenshot is on the clipboard.')
      return {}
    case 'save': {
      const path = writeToFolder(encode(image, pngBytes, entry.info.scaleFactor, settings))
      entry.info.savedPath = path
      broadcastCapture(entry)
      if (!quiet) confirm('Screenshot saved', path, { path })
      return { path }
    }
    case 'saveAs': {
      const parent = BrowserWindow.fromWebContents(sender)
      const folder = screenshotsFolder()
      const preferJpeg = settings.saveFormat === 'jpeg'
      const options: Electron.SaveDialogOptions = {
        title: 'Save screenshot',
        defaultPath: join(existsSync(folder) ? folder : '', screenshotFileName(new Date(), preferJpeg ? 'jpg' : 'png')),
        filters: preferJpeg
          ? [{ name: 'JPEG', extensions: ['jpg', 'jpeg'] }, { name: 'PNG', extensions: ['png'] }]
          : [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg', 'jpeg'] }]
      }
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return {}
      const jpeg = /^\.jpe?g$/i.test(extname(result.filePath))
      writeFileSync(result.filePath, encode(image, pngBytes, entry.info.scaleFactor, settings, jpeg ? 'jpeg' : 'png').bytes)
      entry.info.savedPath = result.filePath
      broadcastCapture(entry)
      broadcastLibraryChanged()
      return { path: result.filePath }
    }
    case 'upload': {
      const link = await upload(entry, image, pngBytes)
      if (!quiet) confirm('Screenshot uploaded', link ? (settings.upload.copyLink ? `Link copied: ${link}` : link) : 'No link to share.', link ? { link } : {})
      return link ? { link } : {}
    }
    case 'pin': {
      openPin(hold(image, entry.info.scaleFactor, entry.info.kind, entry.info.savedPath))
      return {}
    }
  }
}

/** Drag the picture out of a thumbnail into another app, as a file. */
export const startDrag = (sender: WebContents, id: string): void => {
  const entry = held.get(id)
  if (!entry) return
  let file = entry.info.savedPath
  if (!file || !existsSync(file)) {
    const dir = join(tmpdir(), 'featured-app-screenshots')
    mkdirSync(dir, { recursive: true })
    file = join(dir, screenshotFileName(new Date(entry.info.createdAt), 'png'))
    writeFileSync(file, pngOf(entry))
  }
  const icon = entry.image.resize({ width: 96, quality: 'good' })
  sender.startDrag({ file, icon })
}

export const closeSender = (sender: WebContents): void => {
  closeWindow(BrowserWindow.fromWebContents(sender))
}

export const hasLastArea = (): boolean => lastArea !== null
