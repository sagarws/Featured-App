/**
 * Version helpers for the auto-update (electron/main/updates.ts).
 *
 * The update server (check-otp → /api/software/<name>) answers
 *   { softwareName, version, link, updatedAt? }
 * and anything it sends is treated as untrusted: the link must be https
 * before the app will ever download or open it.
 */

export interface UpdateInfo {
  version: string
  link: string
  /** The name the server answered with, when it sent one. */
  softwareName?: string
}

const parts = (version: string): { numbers: number[]; pre: string } => {
  const clean = version.trim().replace(/^v/i, '')
  const [core = '', ...rest] = clean.split('-')
  const numbers = core.split('.').map(part => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) ? n : 0
  })
  return { numbers, pre: rest.join('-') }
}

/**
 * Compare two versions: 1 when a is newer, -1 when b is newer, 0 when the same.
 * "1.2" equals "1.2.0", a leading "v" is ignored, and a pre-release
 * ("1.2.0-beta") is older than its release ("1.2.0").
 */
export const compareVersions = (a: string, b: string): number => {
  const left = parts(a)
  const right = parts(b)
  const length = Math.max(left.numbers.length, right.numbers.length)
  for (let i = 0; i < length; i++) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

const isHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

/** The server's answer, checked. Null when it is not a usable { version, link }. */
export const parseUpdateInfo = (raw: unknown): UpdateInfo | null => {
  if (!raw || typeof raw !== 'object') return null
  const { version, link, softwareName } = raw as Record<string, unknown>
  if (typeof version !== 'string' || !/^v?\d+(\.\d+)*(-[\w.]+)?$/i.test(version.trim())) return null
  if (typeof link !== 'string' || link.length > 2048 || !isHttpsUrl(link.trim())) return null
  return {
    version: version.trim().replace(/^v/i, ''),
    link: link.trim(),
    ...(typeof softwareName === 'string' && softwareName.trim() ? { softwareName: softwareName.trim() } : {})
  }
}

const DRIVE_ID = /^[\w-]{10,}$/

/**
 * The URL that downloads the file itself.
 *
 * The server lists the Google Drive SHARE page
 * (drive.google.com/file/d/<id>/view), which is HTML. A Drive file is
 * downloaded from drive.usercontent.google.com, and `confirm=t` skips the
 * "can't scan this file for viruses" page Drive shows for anything over
 * ~100 MB — every installer is. Any other https link is used as it is.
 */
export const directDownloadUrl = (link: string): string => {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return link
  }
  const host = url.hostname.toLowerCase()
  if (host !== 'drive.google.com' && host !== 'docs.google.com' && host !== 'drive.usercontent.google.com') return link

  const fromPath = /\/file\/d\/([^/]+)/.exec(url.pathname)?.[1]
  const id = fromPath ?? url.searchParams.get('id') ?? ''
  if (!DRIVE_ID.test(id)) return link

  const direct = new URL('https://drive.usercontent.google.com/download')
  direct.searchParams.set('id', id)
  direct.searchParams.set('export', 'download')
  direct.searchParams.set('confirm', 't')
  const resourceKey = url.searchParams.get('resourcekey')
  if (resourceKey) direct.searchParams.set('resourcekey', resourceKey)
  return direct.toString()
}
