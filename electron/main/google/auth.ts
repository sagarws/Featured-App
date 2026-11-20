import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { shell } from 'electron'
import type { GoogleAccount, GoogleStatus } from '@shared/types/google'
import { logger } from '../logger'
import { readSecure, writeSecure } from '../secureStore'

/*
 * Sign in to the user's OWN Google account, the way share-chat does it
 * (share-chat/drive.js): the same OAuth client, the same scopes
 * (drive.file + openid/email/profile), offline access with a consent prompt.
 *
 * The client is a "Web application" client whose local redirect is
 * http://localhost:3000/oauth2callback, so for the minute the user is on
 * Google's consent screen this app listens on that address to catch the
 * code. Google's account chooser is always shown, so any account can be
 * connected — not only the one signed in to the browser.
 *
 * drive.file means the app only ever sees files and folders created by this
 * OAuth client (Featured App or share-chat), never the rest of the Drive.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const SCOPES = [DRIVE_SCOPE, 'openid', 'email', 'profile'].join(' ')
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

const clientId = (): string => import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID || process.env['GOOGLE_CLIENT_ID'] || ''
const clientSecret = (): string => import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET || process.env['GOOGLE_CLIENT_SECRET'] || ''
export const redirectUri = (): string => import.meta.env.MAIN_VITE_GOOGLE_REDIRECT_URI || process.env['GOOGLE_REDIRECT_URI'] || 'http://localhost:3000/oauth2callback'

// ── stored account ──────────────────────────────────────────────────────────

const FILE = 'google-account.json'

interface Stored {
  account: GoogleAccount | null
  refreshToken: string
  /** The "Featured App" folder in the user's My Drive. */
  appFolderId: string
  /** The folder File Share last showed. */
  fileShareFolderId: string
}

const EMPTY: Stored = { account: null, refreshToken: '', appFolderId: '', fileShareFolderId: '' }
let stored: Stored | null = null

export const getStored = (): Stored => (stored ??= { ...EMPTY, ...(readSecure<Partial<Stored>>(FILE) ?? {}) })

export const updateStored = (patch: Partial<Stored>): Stored => {
  stored = { ...getStored(), ...patch }
  writeSecure(FILE, stored)
  return stored
}

// ── status ──────────────────────────────────────────────────────────────────

let pending: { server: Server[]; cancel: (reason: Error) => void } | null = null
const listeners = new Set<(status: GoogleStatus) => void>()

export const googleStatus = (): GoogleStatus => ({
  configured: !!(clientId() && clientSecret()),
  account: getStored().account,
  connecting: pending !== null,
  redirectUri: redirectUri()
})

const changed = (): void => {
  const status = googleStatus()
  listeners.forEach(listener => listener(status))
}

export const onGoogleChanged = (listener: (status: GoogleStatus) => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ── tokens ──────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

let access: { token: string; expiresAt: number; refreshToken: string } | null = null

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

/** A valid access token for the connected account (refreshed a minute early). */
export const accessToken = async (): Promise<string> => {
  const { refreshToken } = getStored()
  if (!refreshToken) throw Object.assign(new Error('Connect your Google Drive first.'), { code: 'DRIVE_RECONNECT' })
  if (access && access.refreshToken === refreshToken && access.expiresAt - 60_000 > Date.now()) return access.token
  try {
    const tokens = await tokenRequest({ client_id: clientId(), client_secret: clientSecret(), refresh_token: refreshToken, grant_type: 'refresh_token' })
    if (!tokens.access_token) throw new Error('Google did not return an access token.')
    access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, refreshToken }
    return access.token
  } catch (error) {
    if ((error as { code?: string }).code === 'invalid_grant') {
      // Revoked, expired (7 days while the OAuth app is in "Testing"), or the password changed.
      access = null
      updateStored({ ...EMPTY })
      changed()
      throw Object.assign(new Error('Your Google Drive connection has expired or was removed. Connect it again.', { cause: error }), { code: 'DRIVE_RECONNECT' })
    }
    throw error
  }
}

// ── sign in ─────────────────────────────────────────────────────────────────

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0;color:#222"><div style="text-align:center;max-width:420px"><h2>${title}</h2><p style="color:#555">${body}</p></div></body>`

/** Listen on the redirect address (IPv4 and, where possible, IPv6 — "localhost" may be either). */
const listen = async (port: number): Promise<Server[]> => {
  const open = (host: string): Promise<Server> =>
    new Promise((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(port, host, () => resolve(server))
    })
  let v4: Server
  try {
    v4 = await open('127.0.0.1')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`Port ${port} is in use, and Google sends the sign-in back to it. Stop whatever runs there (the share-chat dev server?) and try again.`, { cause: error })
    }
    throw error
  }
  const v6 = await open('::1').catch(() => null)
  return v6 ? [v4, v6] : [v4]
}

/**
 * Open Google's consent screen in the browser and wait for the user to allow
 * access. Resolves with the connected account.
 */
export const connectGoogle = async (ensureAppFolder: () => Promise<string>): Promise<GoogleAccount> => {
  if (!clientId() || !clientSecret()) throw new Error('This build has no Google OAuth client. Set MAIN_VITE_GOOGLE_CLIENT_ID and MAIN_VITE_GOOGLE_CLIENT_SECRET in .env and rebuild.')
  pending?.cancel(new Error('Sign-in restarted.'))

  const redirect = new URL(redirectUri())
  const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80))
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('base64url')
  const servers = await listen(port)

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Google sign-in timed out. Try again.')), SIGN_IN_TIMEOUT_MS)
    const finish = (result: Error | string): void => {
      clearTimeout(timer)
      pending = null
      // Let the browser get its answer page before the sockets go.
      setTimeout(() => servers.forEach(s => s.close()), 500)
      changed()
      if (typeof result === 'string') resolve(result)
      else reject(result)
    }
    pending = { server: servers, cancel: finish }
    changed()
    for (const server of servers) {
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirect.origin)
        if (url.pathname !== redirect.pathname) {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        if (url.searchParams.get('state') !== state) {
          res.end(page('Sign-in link expired', 'Start again from Featured App.'))
          return
        }
        const error = url.searchParams.get('error')
        const got = url.searchParams.get('code')
        if (error || !got) {
          res.end(page('Not connected', 'Google Drive access was not allowed. You can close this tab.'))
          finish(new Error(error === 'access_denied' ? 'Google Drive access was not allowed.' : `Google said: ${error ?? 'no code'}`))
          return
        }
        res.end(page('Google Drive connected', 'You can close this tab and go back to Featured App.'))
        finish(got)
      })
    }
    const auth = new URL(AUTH_URL)
    auth.search = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPES,
      // offline + consent: Google always returns a refresh token.
      access_type: 'offline',
      // select_account: always the account chooser, so another account can be used.
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state
    }).toString()
    shell.openExternal(auth.toString()).catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))))
  })

  const tokens = await tokenRequest({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
    code_verifier: verifier
  })
  if (!tokens.access_token || !tokens.refresh_token) throw new Error('Google did not return offline access. Please connect again.')
  // Drive access is a checkbox on the consent screen; without it nothing works.
  if (!String(tokens.scope ?? '').split(' ').includes(DRIVE_SCOPE)) {
    throw new Error('Google Drive access was not allowed. Connect again and tick the Google Drive box.')
  }

  const info = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15_000) })
  const user = (await info.json().catch(() => ({}))) as { email?: string; name?: string; picture?: string }
  const account: GoogleAccount = { email: user.email ?? '', name: user.name ?? user.email ?? 'Google user', picture: user.picture ?? '' }

  // A different account than before: forget the old account's folders.
  const previous = getStored()
  const same = previous.account?.email === account.email
  access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, refreshToken: tokens.refresh_token }
  updateStored({ account, refreshToken: tokens.refresh_token, appFolderId: same ? previous.appFolderId : '', fileShareFolderId: same ? previous.fileShareFolderId : '' })
  try {
    await ensureAppFolder()
  } catch (error) {
    logger.warn('[google] could not create the app folder yet', error)
  }
  changed()
  logger.info('[google] Drive connected')
  return account
}

export const cancelConnect = (): void => pending?.cancel(new Error('Sign-in cancelled.'))

/** Revoke the app's access at Google and forget the account. Files already uploaded stay in the Drive. */
export const disconnectGoogle = async (): Promise<void> => {
  const { refreshToken } = getStored()
  access = null
  updateStored({ ...EMPTY })
  changed()
  if (refreshToken) {
    await fetch(`${REVOKE_URL}?${new URLSearchParams({ token: refreshToken }).toString()}`, { method: 'POST', signal: AbortSignal.timeout(15_000) }).catch(() => undefined)
  }
}
