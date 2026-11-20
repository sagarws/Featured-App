import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { clipboard, nativeImage, shell } from 'electron'
import type { ScreenshotFile } from '@shared/types/screenshot'
import { isImageFile } from '@shared/utils/screenshot'
import { screenshotsFolder } from './config'
import { broadcastLibraryChanged } from './service'

/** The newest pictures in the screenshots folder, for the page's Recent list. */

const RECENT_LIMIT = 48
const thumbnails = new Map<string, string>()

const thumbnailOf = async (path: string, stamp: number): Promise<string> => {
  const key = `${path}\n${stamp}`
  const cached = thumbnails.get(key)
  if (cached) return cached
  let image: Electron.NativeImage
  try {
    // Quick Look / the Windows shell: fast and does not decode the whole file.
    image = await nativeImage.createThumbnailFromPath(path, { width: 360, height: 240 })
  } catch {
    image = nativeImage.createFromPath(path)
    if (!image.isEmpty()) image = image.resize({ width: 360, quality: 'good' })
  }
  const url = image.isEmpty() ? '' : `data:image/jpeg;base64,${image.toJPEG(78).toString('base64')}`
  if (thumbnails.size > 400) thumbnails.clear()
  thumbnails.set(key, url)
  return url
}

export const listRecent = async (): Promise<ScreenshotFile[]> => {
  const folder = screenshotsFolder()
  if (!existsSync(folder)) return []
  const files = readdirSync(folder, { withFileTypes: true })
    .filter(entry => entry.isFile() && isImageFile(entry.name) && !entry.name.startsWith('.'))
    .map(entry => {
      const path = join(folder, entry.name)
      try {
        const stat = statSync(path)
        return { path, name: entry.name, size: stat.size, mtime: stat.mtimeMs }
      } catch {
        return null
      }
    })
    .filter((file): file is NonNullable<typeof file> => file !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, RECENT_LIMIT)
  return Promise.all(
    files.map(async file => ({
      path: file.path,
      name: file.name,
      size: file.size,
      modifiedAt: new Date(file.mtime).toISOString(),
      thumbnail: await thumbnailOf(file.path, file.mtime)
    }))
  )
}

/** A path the page sent, only if it is a picture inside the screenshots folder. */
export const fileInFolder = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Unknown file.')
  const folder = resolve(screenshotsFolder())
  const path = resolve(value)
  if (!path.startsWith(folder + sep) || !isImageFile(path) || !existsSync(path)) throw new Error('That file is no longer in the screenshots folder.')
  return path
}

export const revealFile = (path: string): void => shell.showItemInFolder(path)

export const copyFile = (path: string): void => {
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) throw new Error('This file could not be read.')
  clipboard.writeImage(image)
}

export const deleteFile = async (path: string): Promise<void> => {
  await shell.trashItem(path)
  broadcastLibraryChanged()
}
