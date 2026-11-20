import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { FILESHARE_IPC, GOOGLE_IPC } from '@shared/constants/channels'
import type { Result } from '@shared/types/agent'
import type { UploadJob } from '@shared/types/google'
import { logger } from '../logger'
import { getWindow, isRendererUrl } from '../window'
import { cancelConnect, connectGoogle, disconnectGoogle, getStored, googleStatus, onGoogleChanged, updateStored } from '../google/auth'
import { createFolder, downloadFile, ensureAppFolder, fileSize, folderTree, listFiles, shareFile, thumbnail, trashFile, updateDescription, uploadFile, type UploadSource } from '../google/drive'
import { notifyScreenshotSettings } from '../screenshot/config'

/*
 * File Share: the signed-in user's OWN Google Drive (never a shared or
 * company Drive), the way share-chat's File Share page works — pick a folder,
 * upload, share a public link, describe, download, delete.
 */

const handle = <A extends unknown[], T>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: A) => T | Promise<T>): void => {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<Result<T>> => {
    if (!isRendererUrl(event.senderFrame?.url ?? '')) return { ok: false, error: 'Not allowed.' }
    try {
      return { ok: true, value: await fn(event, ...(args as A)) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`[fileshare] ${channel} failed: ${message}`)
      return { ok: false, error: message }
    }
  })
}

const driveId = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{5,128}$/.test(v)) throw new Error('Unknown Drive item.')
  return v
}

const send = (channel: string, value: unknown): void => {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, value)
}

// ── uploads ─────────────────────────────────────────────────────────────────

const jobs = new Map<string, UploadJob>()
const controllers = new Map<string, AbortController>()

const pushJob = (job: UploadJob): void => send(FILESHARE_IPC.job, job)

const startUpload = (folderId: string, source: UploadSource): UploadJob => {
  const job: UploadJob = { id: randomUUID(), name: source.name, size: source.size, sent: 0, folderId, status: 'uploading' }
  const controller = new AbortController()
  jobs.set(job.id, job)
  controllers.set(job.id, controller)
  pushJob(job)
  let lastPush = 0
  uploadFile(folderId, source, {
    signal: controller.signal,
    onProgress: sent => {
      job.sent = sent
      // A few updates a second is plenty for a progress bar.
      if (Date.now() - lastPush > 200) {
        lastPush = Date.now()
        pushJob(job)
      }
    }
  })
    .then(file => {
      Object.assign(job, { status: 'done', sent: job.size, file })
      send(FILESHARE_IPC.filesChanged, folderId)
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) job.status = 'cancelled'
      else Object.assign(job, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    })
    .finally(() => {
      controllers.delete(job.id)
      pushJob(job)
      // Finished jobs are kept a while for the page, then dropped.
      setTimeout(() => jobs.delete(job.id), 10 * 60_000)
    })
  return job
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}
const mimeOf = (name: string): string => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

const uploadPaths = async (paths: string[], folderId: string, description: string): Promise<UploadJob[]> => {
  const out: UploadJob[] = []
  for (const path of paths) {
    const size = await fileSize(path)
    if (size <= 0) throw new Error(`${basename(path)} is empty.`)
    out.push(startUpload(folderId, { name: basename(path), mime: mimeOf(path), size, path, description }))
  }
  return out
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// ── register ────────────────────────────────────────────────────────────────

export const registerFileShare = (): void => {
  onGoogleChanged(status => {
    send(GOOGLE_IPC.changed, status)
    // The Screenshots page shows the same account.
    notifyScreenshotSettings()
  })

  // Google account
  handle(GOOGLE_IPC.status, () => googleStatus())
  handle(GOOGLE_IPC.connect, async () => {
    const account = await connectGoogle(ensureAppFolder)
    // Back to the app from the browser.
    const win = getWindow()
    if (win) {
      if (process.platform === 'darwin') app.focus({ steal: true })
      win.show()
      win.focus()
    }
    return account
  })
  handle(GOOGLE_IPC.cancelConnect, () => cancelConnect())
  handle(GOOGLE_IPC.disconnect, async () => {
    cancelConnect()
    await disconnectGoogle()
  })
  handle(GOOGLE_IPC.folders, () => folderTree())
  handle(GOOGLE_IPC.createFolder, (_e, name: unknown, parentId: unknown) => {
    const clean = text(name, 100).replace(/[\\/]/g, '-')
    if (!clean) throw new Error('Enter a folder name.')
    return createFolder(clean, driveId(parentId))
  })

  // Folder File Share shows
  handle(FILESHARE_IPC.getFolder, async () => getStored().fileShareFolderId || (await ensureAppFolder()))
  handle(FILESHARE_IPC.setFolder, (_e, id: unknown) => {
    updateStored({ fileShareFolderId: driveId(id) })
  })

  // Files
  handle(FILESHARE_IPC.list, (_e, folderId: unknown) => listFiles(driveId(folderId)))
  handle(FILESHARE_IPC.chooseAndUpload, async (event, folderId: unknown, description: unknown) => {
    const folder = driveId(folderId)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { title: 'Upload to Google Drive', properties: ['openFile', 'multiSelections'] }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths.length) return []
    return uploadPaths(result.filePaths.slice(0, 100), folder, text(description, 500))
  })
  handle(FILESHARE_IPC.uploadPaths, (_e, paths: unknown, folderId: unknown, description: unknown) => {
    if (!Array.isArray(paths) || !paths.length || paths.length > 100 || !paths.every(p => typeof p === 'string' && p.length > 0 && p.length < 4096)) {
      throw new Error('Drop one or more files.')
    }
    return uploadPaths(paths as string[], driveId(folderId), text(description, 500))
  })
  handle(FILESHARE_IPC.uploadBytes, (_e, name: unknown, mime: unknown, bytes: unknown, folderId: unknown, description: unknown) => {
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Nothing to upload.')
    const fileName = text(name, 200) || `Pasted ${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    return startUpload(driveId(folderId), { name: fileName, mime: text(mime, 100) || mimeOf(fileName), size: bytes.length, bytes, description: text(description, 500) })
  })
  handle(FILESHARE_IPC.cancelUpload, (_e, id: unknown) => {
    if (typeof id === 'string') controllers.get(id)?.abort()
  })
  handle(FILESHARE_IPC.jobs, () => [...jobs.values()])
  handle(FILESHARE_IPC.thumbnail, (_e, id: unknown, size: unknown) => thumbnail(driveId(id), typeof size === 'number' ? Math.min(1600, Math.max(64, Math.round(size))) : 400))
  handle(FILESHARE_IPC.share, async (_e, id: unknown) => shareFile(driveId(id)))
  handle(FILESHARE_IPC.describe, (_e, id: unknown, description: unknown) => updateDescription(driveId(id), text(description, 500)))
  handle(FILESHARE_IPC.remove, (_e, id: unknown) => trashFile(driveId(id)))
  handle(FILESHARE_IPC.download, async (event, id: unknown, name: unknown) => {
    const fileId = driveId(id)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = { title: 'Download from Google Drive', defaultPath: (text(name, 200) || 'file').replace(/[\\/]/g, '-') }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await downloadFile(fileId, result.filePath)
    shell.showItemInFolder(result.filePath)
    return result.filePath
  })
  handle(FILESHARE_IPC.openLink, async (_e, url: unknown) => {
    // Only Google Drive / Docs pages.
    if (typeof url !== 'string' || !/^https:\/\/(drive|docs)\.google\.com\//.test(url)) throw new Error('Not a Google Drive link.')
    await shell.openExternal(url)
  })
}
