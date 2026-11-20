import type { ApiConfig } from '@shared/types/screenshot'
import { isHttpUrl, valueAtPath } from '@shared/utils/screenshot'

/*
 * Your own upload endpoint. The request and the answer it must give are
 * described in docs/SCREENSHOT_UPLOAD_API.md and on the Uploading tab.
 *
 *   multipart/form-data:  <fileField>=<image file>, fileName, mimeType, width,
 *                         height, capturedAt, source
 *   application/json:     { "<fileField>": "<base64>", fileName, mimeType,
 *                           width, height, capturedAt, source }
 *
 *   answer: 2xx with JSON holding the link at `urlPath` (default "url"),
 *           or a plain-text body that is just the link.
 */

export interface UploadFile {
  fileName: string
  mimeType: string
  bytes: Uint8Array
  width: number
  height: number
  capturedAt: string
}

/** The link from an answer body, or an error that says what came back. */
export const linkFromResponse = (body: string, urlPath: string): string => {
  const trimmed = body.trim()
  try {
    const value = valueAtPath(JSON.parse(trimmed) as unknown, urlPath)
    if (isHttpUrl(value)) return value
  } catch {
    if (isHttpUrl(trimmed)) return trimmed
  }
  throw new Error(`The upload API answered without a link at "${urlPath || '(whole body)'}": ${trimmed.slice(0, 200) || '(empty)'}`)
}

export const uploadToApi = async (config: ApiConfig, file: UploadFile): Promise<string> => {
  if (!isHttpUrl(config.url)) throw new Error('Enter the URL of your upload API.')
  const headers: Record<string, string> = { accept: 'application/json' }
  for (const header of config.headers) {
    // For multipart, fetch writes Content-Type itself (it carries the boundary).
    if (config.bodyType === 'multipart' && header.name.toLowerCase() === 'content-type') continue
    headers[header.name] = header.value
  }
  const meta = {
    fileName: file.fileName,
    mimeType: file.mimeType,
    width: file.width,
    height: file.height,
    capturedAt: file.capturedAt,
    source: 'featured-app'
  }

  let body: FormData | string
  if (config.bodyType === 'json') {
    headers['content-type'] = 'application/json'
    body = JSON.stringify({ ...meta, [config.fileField]: Buffer.from(file.bytes).toString('base64') })
  } else {
    const form = new FormData()
    form.append(config.fileField, new Blob([Buffer.from(file.bytes)], { type: file.mimeType }), file.fileName)
    for (const [key, value] of Object.entries(meta)) form.append(key, String(value))
    body = form
  }

  let response: Response
  try {
    response = await fetch(config.url, { method: config.method, headers, body, signal: AbortSignal.timeout(120_000) })
  } catch (error) {
    throw new Error(`Could not reach the upload API: ${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)}`, { cause: error })
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) throw new Error(`The upload API answered ${response.status} ${response.statusText}: ${text.trim().slice(0, 200) || '(empty)'}`)
  return linkFromResponse(text, config.urlPath)
}
