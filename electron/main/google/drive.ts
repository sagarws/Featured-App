import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { DriveFile, DriveFolder } from '@shared/types/google'
import { accessToken, getStored, updateStored } from './auth'

/*
 * Google Drive v3 for the connected account — a TypeScript port of
 * share-chat/drive.js (no SDK, just fetch). Under the drive.file scope Drive
 * only returns what this OAuth client created, so listings are exactly the
 * app's own folders and uploads.
 */

const FILES = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FILE_FIELDS = 'id,name,mimeType,size,createdTime,description,webViewLink,shared,thumbnailLink'
export const APP_FOLDER_NAME = 'Featured App'

const q = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

const auth = async (): Promise<Record<string, string>> => ({ authorization: `Bearer ${await accessToken()}` })

const NOT_FOUND = 'That Drive folder could not be found. It may have been deleted, or it belongs to another Google account.'

const fail = async (response: Response, what: string): Promise<never> => {
  const text = await response.text().catch(() => '')
  let message = text.slice(0, 300)
  try {
    message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message
  } catch {
    // not JSON
  }
  throw Object.assign(new Error(`${what} (${response.status}). ${message}`.trim()), { status: response.status })
}

interface RawFile {
  id: string
  name: string
  mimeType?: string
  size?: string
  createdTime?: string
  description?: string
  webViewLink?: string
  shared?: boolean
  thumbnailLink?: string
}

const toFile = (f: RawFile): DriveFile => ({
  id: f.id,
  name: f.name,
  mime: f.mimeType ?? 'application/octet-stream',
  size: Number(f.size) || 0,
  description: f.description ?? '',
  createdAt: Date.parse(f.createdTime ?? '') || 0,
  link: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
  shared: !!f.shared,
  hasThumb: !!f.thumbnailLink
})

// ── folders ─────────────────────────────────────────────────────────────────

export const createFolder = async (name: string, parentId: string): Promise<{ id: string; name: string }> => {
  const response = await fetch(`${FILES}?fields=id,name`, {
    method: 'POST',
    headers: { ...(await auth()), 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) })
  })
  if (response.status === 404) throw new Error(NOT_FOUND)
  if (!response.ok) await fail(response, 'Could not create the folder')
  return (await response.json()) as { id: string; name: string }
}

/** The "Featured App" folder in My Drive: reused when it exists, so reconnecting never duplicates it. */
export const ensureAppFolder = async (): Promise<string> => {
  const saved = getStored().appFolderId
  if (saved) {
    const check = await fetch(`${FILES}/${encodeURIComponent(saved)}?fields=id,trashed`, { headers: await auth() })
    if (check.ok && !((await check.json()) as { trashed?: boolean }).trashed) return saved
  }
  const params = new URLSearchParams({
    q: `name = '${q(APP_FOLDER_NAME)}' and 'root' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id)',
    orderBy: 'createdTime',
    pageSize: '1'
  })
  const response = await fetch(`${FILES}?${params.toString()}`, { headers: await auth() })
  const found = response.ok ? ((await response.json()) as { files?: { id: string }[] }).files?.[0]?.id : undefined
  const id = found ?? (await createFolder(APP_FOLDER_NAME, '')).id
  updateStored({ appFolderId: id })
  return id
}

const listFolders = async (query: string): Promise<{ id: string; name: string }[]> => {
  const params = new URLSearchParams({ q: `${query} and mimeType = '${FOLDER_MIME}' and trashed = false`, fields: 'files(id,name)', orderBy: 'name', pageSize: '200' })
  const response = await fetch(`${FILES}?${params.toString()}`, { headers: await auth() })
  if (response.status === 404) return []
  if (!response.ok) await fail(response, 'Could not list folders')
  return ((await response.json()) as { files?: { id: string; name: string }[] }).files ?? []
}

/**
 * The folders the app can use, as a tree: every top-level folder in My Drive
 * this OAuth client made (Featured App, share-chat's "Share Chat", …) and
 * their subfolders. Bounded so a huge tree cannot mean endless API calls.
 */
export const folderTree = async (): Promise<DriveFolder[]> => {
  const appFolder = await ensureAppFolder()
  const roots = await listFolders("'root' in parents")
  if (!roots.some(r => r.id === appFolder)) roots.unshift({ id: appFolder, name: APP_FOLDER_NAME })
  roots.sort((a, b) => (a.id === appFolder ? -1 : b.id === appFolder ? 1 : a.name.localeCompare(b.name)))

  let budget = 250
  const walk = async (id: string, depth: number): Promise<DriveFolder[]> => {
    if (depth >= 6 || budget <= 0) return []
    const kids = await listFolders(`'${q(id)}' in parents`).catch(() => [])
    const slice = kids.slice(0, Math.max(0, budget))
    budget -= slice.length
    return Promise.all(slice.map(async k => ({ id: k.id, name: k.name, children: await walk(k.id, depth + 1) })))
  }
  return Promise.all(roots.map(async r => ({ id: r.id, name: r.name, root: true, children: await walk(r.id, 0) })))
}

// ── files ───────────────────────────────────────────────────────────────────

export const listFiles = async (folderId: string): Promise<DriveFile[]> => {
  const out: DriveFile[] = []
  let pageToken = ''
  do {
    const params = new URLSearchParams({
      q: `'${q(folderId)}' in parents and mimeType != '${FOLDER_MIME}' and trashed = false`,
      fields: `nextPageToken, files(${FILE_FIELDS})`,
      orderBy: 'createdTime desc',
      pageSize: '200'
    })
    if (pageToken) params.set('pageToken', pageToken)
    const response = await fetch(`${FILES}?${params.toString()}`, { headers: await auth() })
    if (response.status === 404) throw new Error(NOT_FOUND)
    if (!response.ok) await fail(response, 'Could not list the files')
    const data = (await response.json()) as { files?: RawFile[]; nextPageToken?: string }
    out.push(...(data.files ?? []).map(toFile))
    pageToken = data.nextPageToken ?? ''
  } while (pageToken)
  return out
}

const meta = async (fileId: string): Promise<(DriveFile & { thumbnailLink: string }) | null> => {
  const response = await fetch(`${FILES}/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`, { headers: await auth() })
  if (response.status === 404) return null
  if (!response.ok) await fail(response, 'Drive lookup failed')
  const raw = (await response.json()) as RawFile
  return { ...toFile(raw), thumbnailLink: raw.thumbnailLink ?? '' }
}

export interface UploadSource {
  name: string
  mime: string
  size: number
  description?: string
  /** A file on disk (streamed), or bytes in memory. */
  path?: string
  bytes?: Uint8Array
}

/**
 * Upload with a resumable session so big files stream instead of sitting in
 * memory. `onProgress` gets the bytes sent so far.
 */
export const uploadFile = async (folderId: string, source: UploadSource, options: { signal?: AbortSignal; onProgress?: (sent: number) => void } = {}): Promise<DriveFile> => {
  const init = await fetch(`${UPLOAD}?uploadType=resumable&fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: {
      ...(await auth()),
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': source.mime,
      'x-upload-content-length': String(source.size)
    },
    body: JSON.stringify({ name: source.name, parents: [folderId], ...(source.description ? { description: source.description } : {}) }),
    ...(options.signal ? { signal: options.signal } : {})
  })
  if (init.status === 404) throw new Error(NOT_FOUND)
  if (!init.ok) await fail(init, 'Drive refused the upload')
  const session = init.headers.get('location')
  if (!session) throw new Error('Drive did not return an upload session.')

  let sent = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sent += chunk.length
      options.onProgress?.(sent)
      callback(null, chunk)
    }
  })
  const input = source.path ? createReadStream(source.path) : Readable.from([Buffer.from(source.bytes ?? new Uint8Array())])
  input.on('error', (error: Error) => counter.destroy(error))
  const body = Readable.toWeb(input.pipe(counter)) as unknown as ReadableStream
  // undici needs `duplex` to send a streaming body; it is not in RequestInit's types.
  const putInit: RequestInit & { duplex: 'half' } = {
    method: 'PUT',
    headers: { 'content-type': source.mime, 'content-length': String(source.size) },
    body,
    duplex: 'half',
    ...(options.signal ? { signal: options.signal } : {})
  }
  const put = await fetch(session, putInit)
  if (!put.ok) await fail(put, 'Drive upload failed')
  return toFile((await put.json()) as RawFile)
}

export const fileSize = async (path: string): Promise<number> => (await stat(path)).size

/** Make a file readable by anyone with the link; returns that link. */
export const shareFile = async (fileId: string): Promise<string> => {
  const current = await meta(fileId)
  if (!current) throw new Error('That file is no longer in Drive.')
  if (!current.shared) {
    const response = await fetch(`${FILES}/${encodeURIComponent(fileId)}/permissions`, {
      method: 'POST',
      headers: { ...(await auth()), 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    })
    if (!response.ok) await fail(response, 'Could not share the file')
  }
  return (await meta(fileId))?.link ?? `https://drive.google.com/file/d/${fileId}/view`
}

export const updateDescription = async (fileId: string, description: string): Promise<string> => {
  const response = await fetch(`${FILES}/${encodeURIComponent(fileId)}?fields=description`, {
    method: 'PATCH',
    headers: { ...(await auth()), 'content-type': 'application/json' },
    body: JSON.stringify({ description })
  })
  if (!response.ok) await fail(response, 'Could not save the description')
  return ((await response.json()) as { description?: string }).description ?? ''
}

/** Into the Drive's trash (restorable there for 30 days). */
export const trashFile = async (fileId: string): Promise<void> => {
  const response = await fetch(`${FILES}/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    headers: { ...(await auth()), 'content-type': 'application/json' },
    body: JSON.stringify({ trashed: true })
  })
  if (!response.ok && response.status !== 404) await fail(response, 'Could not delete the file')
}

/** Drive's preview image (images, PDFs, video) as a data: URL, or null when there is none. */
export const thumbnail = async (fileId: string, size: number): Promise<string | null> => {
  const current = await meta(fileId)
  if (!current?.thumbnailLink) return null
  const url = current.thumbnailLink.replace(/=s\d+(-c)?$/, `=s${size}`)
  let response = await fetch(url)
  if (!response.ok) response = await fetch(url, { headers: await auth() })
  if (!response.ok) return null
  const type = response.headers.get('content-type') ?? 'image/jpeg'
  return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`
}

/** Stream a file down to `target`. */
export const downloadFile = async (fileId: string, target: string): Promise<void> => {
  const response = await fetch(`${FILES}/${encodeURIComponent(fileId)}?alt=media`, { headers: await auth() })
  if (!response.ok || !response.body) await fail(response, 'Download failed')
  await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), createWriteStream(target))
}
