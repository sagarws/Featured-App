import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { shell } from 'electron'
import type { GoogleDriveConfig } from '@shared/types/screenshot'
import { logger } from '../../logger'
import { googleSecrets, setGoogleConnection, setGoogleFolder } from '../config'

/*
 * Google Drive, with the OAuth flow Google prescribes for desktop apps:
 * the browser signs in, Google redirects to a one-off server on 127.0.0.1,
 * and the code is exchanged with PKCE. Scope: drive.file — the app can only
 * see and change the files it created, nothing else in the Drive.
 *
 * The refresh token is kept encrypted (see ../config.ts) and never reaches a
 * window.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const DRIVE = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

const base64url = (bytes: Buffer): string => bytes.toString('base64url')

let access: { token: string; expiresAt: number; refreshToken: string } | null = null
let pendingSignIn: { server: Server; cancel: (reason: Error) => void } | null = null

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

const tokenRequest = async (body: Record<string, string>): Promise<TokenResponse> => {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30_000)
  })
  const data = (await response.json().catch(() => ({}))) as TokenResponse
  if (!response.ok || data.error) {
    throw Object.assign(new Error(`Google sign-in failed: ${data.error_description ?? data.error ?? response.status}`), { code: data.error ?? '' })
  }
  return data
}

const driveJson = async <T>(token: string, url: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(60_000)
  })
  const text = await response.text()
  if (!response.ok) {
    let message = text.slice(0, 300)
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message
    } catch {
      // not JSON
    }
    const error = new Error(`Google Drive answered ${response.status}: ${message}`)
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }
  return (text ? JSON.parse(text) : {}) as T
}

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;display:grid;place-items:center;height:90vh;color:#222"><div style="text-align:center"><h2>${title}</h2><p>${body}</p></div></body>`

/** Open the browser to sign in; resolves with the account once Google sends the user back. */
export const connectGoogle = async (config: GoogleDriveConfig): Promise<{ email: string; name: string }> => {
  if (!config.clientId || !config.clientSecret) throw new Error('Enter the OAuth client ID and client secret first.')
  pendingSignIn?.cancel(new Error('Sign-in restarted.'))

  const verifier = base64url(randomBytes(48))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(16))

  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const redirectUri = `http://127.0.0.1:${port}`

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Google sign-in timed out. Try again.')), SIGN_IN_TIMEOUT_MS)
    const finish = (result: Error | string): void => {
      clearTimeout(timer)
      pendingSignIn = null
      server.close()
      if (typeof result === 'string') resolve(result)
      else reject(result)
    }
    pendingSignIn = { server, cancel: finish }
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri)
      if (url.pathname !== '/') {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const got = url.searchParams.get('code')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (url.searchParams.get('state') !== state) {
        res.end(page('Sign-in link expired', 'Start again from Featured App.'))
        return
      }
      if (error || !got) {
        res.end(page('Not connected', 'Google did not give access. You can close this tab.'))
        finish(new Error(error === 'access_denied' ? 'Google access was not given.' : `Google sign-in failed: ${error ?? 'no code'}`))
        return
      }
      res.end(page('Connected to Featured App', 'You can close this tab and go back to the app.'))
      finish(got)
    })
    const auth = new URL(AUTH_URL)
    auth.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      // Always ask, so Google always returns a refresh token.
      prompt: 'consent'
    }).toString()
    shell.openExternal(auth.toString()).catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))))
  })

  const tokens = await tokenRequest({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier
  })
  if (!tokens.access_token || !tokens.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.')

  const about = await driveJson<{ user?: { displayName?: string; emailAddress?: string } }>(tokens.access_token, `${DRIVE}/about?fields=user(displayName,emailAddress)`)
  const account = { email: about.user?.emailAddress ?? 'Google account', name: about.user?.displayName ?? '' }
  access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, refreshToken: tokens.refresh_token }
  setGoogleConnection(account, tokens.refresh_token)
  logger.info('[screenshot] Google Drive connected')
  return account
}

export const cancelGoogleSignIn = (): void => pendingSignIn?.cancel(new Error('Sign-in cancelled.'))

export const disconnectGoogle = async (): Promise<void> => {
  const { googleRefreshToken } = googleSecrets()
  access = null
  setGoogleConnection(null, '')
  if (googleRefreshToken) {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(googleRefreshToken)}`, { method: 'POST', signal: AbortSignal.timeout(15_000) }).catch(() => undefined)
  }
}

const accessToken = async (config: GoogleDriveConfig): Promise<string> => {
  const { googleRefreshToken } = googleSecrets()
  if (!googleRefreshToken) throw new Error('Connect your Google account in Screenshots → Uploading.')
  if (access && access.refreshToken === googleRefreshToken && access.expiresAt - 60_000 > Date.now()) return access.token
  try {
    const tokens = await tokenRequest({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: googleRefreshToken,
      grant_type: 'refresh_token'
    })
    if (!tokens.access_token) throw new Error('Google did not return an access token.')
    access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, refreshToken: googleRefreshToken }
    return access.token
  } catch (error) {
    if ((error as { code?: string }).code === 'invalid_grant') {
      // Revoked, expired (7 days for an app in "Testing"), or the password changed.
      setGoogleConnection(null, '')
      throw new Error('The Google sign-in has expired or was revoked. Connect your Google account again.', { cause: error })
    }
    throw error
  }
}

const escapeQuery = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

const folderId = async (token: string, name: string): Promise<string> => {
  const saved = googleSecrets()
  if (saved.googleFolderId && saved.googleFolderName === name) return saved.googleFolderId
  const q = `name='${escapeQuery(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`
  const found = await driveJson<{ files?: { id: string }[] }>(token, `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`)
  let id = found.files?.[0]?.id
  if (!id) {
    const created = await driveJson<{ id: string }>(token, `${DRIVE}/files?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME })
    })
    id = created.id
  }
  setGoogleFolder(id, name)
  return id
}

const multipart = (metadata: object, bytes: Uint8Array, contentType: string): { body: Buffer; boundary: string } => {
  const boundary = `featured-${randomBytes(12).toString('hex')}`
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
  return { body, boundary }
}

/** Upload into the screenshots folder; returns the Drive link. */
export const uploadToGoogleDrive = async (config: GoogleDriveConfig, fileName: string, bytes: Uint8Array, contentType: string): Promise<string> => {
  const token = await accessToken(config)
  const upload = async (parent: string): Promise<{ id: string; webViewLink?: string }> => {
    const { body, boundary } = multipart({ name: fileName, parents: [parent] }, bytes, contentType)
    return driveJson(token, `${UPLOAD}?uploadType=multipart&fields=id,webViewLink`, {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body
    })
  }
  let file: { id: string; webViewLink?: string }
  try {
    file = await upload(await folderId(token, config.folderName))
  } catch (error) {
    // The saved folder was deleted in Drive: find or make it again, once.
    if ((error as { status?: number }).status !== 404) throw error
    setGoogleFolder('', '')
    file = await upload(await folderId(token, config.folderName))
  }
  if (config.makePublic) {
    await driveJson(token, `${DRIVE}/files/${encodeURIComponent(file.id)}/permissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    })
  }
  return file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`
}

export const testGoogleDrive = async (config: GoogleDriveConfig): Promise<string> => {
  const token = await accessToken(config)
  await folderId(token, config.folderName)
  return `Connected as ${config.account?.email ?? 'your Google account'}. Screenshots go to "${config.folderName}" in My Drive.`
}
