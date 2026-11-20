import type { Duplex } from 'node:stream'
import { REMOTE_PROTOCOL_VERSION, REQUEST_TIMEOUT_MS } from '@shared/constants/remote'
import type { HistoryEvent, RemotePermission, RemotePlatform, SessionMinutes } from '@shared/types/remote'
import { isSessionMinutes, stripControl } from '@shared/utils/remote'
import { Channel, SESSION_MAX_FRAME, type Received, type WireMessage } from './channel'
import {
  deriveSessionKeys,
  deviceIdFromPublicKey,
  fingerprintOf,
  generateEphemeral,
  isEd25519PublicKey,
  kdfParamsAcceptable,
  passwordProof,
  passwordVerifier,
  randomToken,
  resumeProof,
  safeEqual,
  sharedSecret,
  signTranscript,
  transcriptHash,
  verifyTranscript,
  type KdfParams,
  type LocalIdentity
} from './crypto'
import type { AuthLimiter, WindowCounter } from './limiter'

/*
 * Connection setup, both sides.
 *
 *   client → host   hello  {eph, nonce, id, name, os, pub, purpose}         (raw frame C)
 *   host → client   hello  {eph, nonce, id, name, os, pub, auth modes, kdf} (raw frame H)
 *   host → client   {sig}  Ed25519(host key, T)                              (raw frame)
 *        T = SHA-256(label ‖ C ‖ H); keys = HKDF(X25519(eph, eph'), T)
 *   ── everything below is AES-256-GCM ──
 *   client → host   auth   {method, sig: Ed25519(client key, T), proof?}
 *   host → client   pending | denied | granted
 *
 * The client checks that the host key hashes to the device ID it dialled and
 * matches the key pinned on the first connection. The password never leaves
 * the client: it sends HMAC(Argon2id(password, salt), T), valid for this
 * handshake only.
 */

export interface PeerInfo {
  id: string
  name: string
  os: string
  platform: RemotePlatform
  publicKey: Buffer
  fingerprint: string
  address: string
}

export type DenyCode =
  | 'rejected'
  | 'wrong-password'
  | 'rate-limited'
  | 'blocked'
  | 'busy'
  | 'not-accepting'
  | 'unattended-off'
  | 'timeout'
  | 'no-session'
  | 'screen-permission'

export class RemoteError extends Error {
  constructor(
    readonly code: DenyCode | 'identity' | 'protocol' | 'cancelled' | 'network',
    message: string,
    readonly retryAfterMs = 0
  ) {
    super(message)
    this.name = 'RemoteError'
  }
}

const DENY_MESSAGES: Record<DenyCode, string> = {
  rejected: 'The person at the other computer declined the request.',
  'wrong-password': 'Wrong password.',
  'rate-limited': 'Too many failed attempts. Wait before trying again.',
  blocked: 'This computer is blocked by the other computer.',
  busy: 'The other computer is already in a remote session.',
  'not-accepting': 'The other computer does not accept remote connections.',
  'unattended-off': 'Unattended access is off on the other computer. Connect without a password to ask the person there.',
  timeout: 'Nobody answered the request at the other computer.',
  'no-session': 'The session is over and cannot be resumed.',
  'screen-permission': 'The other computer has not allowed this app to share its screen (macOS Screen Recording).'
}

export const denyMessage = (code: DenyCode): string => DENY_MESSAGES[code]

const HELLO_TIMEOUT_MS = 10_000
const PLATFORMS: readonly RemotePlatform[] = ['darwin', 'win32', 'linux']

const cleanText = (value: unknown, max: number): string =>
  typeof value === 'string' ? stripControl(value).trim().slice(0, max) : ''

const b64 = (value: unknown, bytes?: number): Buffer | null => {
  if (typeof value !== 'string' || value.length > 4096) return null
  const buf = Buffer.from(value, 'base64')
  if (bytes !== undefined && buf.length !== bytes) return null
  return buf
}

interface ParsedHello {
  peer: Omit<PeerInfo, 'address'>
  eph: Buffer
  raw: Record<string, unknown>
}

const parseHello = (frame: Buffer, role: 'client' | 'host'): ParsedHello => {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(frame.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new RemoteError('protocol', 'The other computer is not running a compatible app.')
  }
  if (raw['t'] !== 'hello' || raw['role'] !== role) throw new RemoteError('protocol', 'The other computer is not running a compatible app.')
  if (raw['v'] !== REMOTE_PROTOCOL_VERSION) throw new RemoteError('protocol', 'The other computer runs an incompatible version of the app. Update both.')
  const eph = b64(raw['eph'], 32)
  const pub = b64(raw['pub'])
  if (!eph || !pub || !isEd25519PublicKey(pub) || !b64(raw['nonce'], 32)) throw new RemoteError('protocol', 'Bad handshake from the other computer.')
  const id = deviceIdFromPublicKey(pub)
  if (raw['id'] !== id) throw new RemoteError('identity', 'The other computer’s ID does not match its key.')
  return {
    eph,
    raw,
    peer: {
      id,
      name: cleanText(raw['name'], 64) || id,
      os: cleanText(raw['os'], 64),
      platform: PLATFORMS.includes(raw['platform'] as RemotePlatform) ? (raw['platform'] as RemotePlatform) : 'linux',
      publicKey: pub,
      fingerprint: fingerprintOf(pub)
    }
  }
}

const helloFor = (identity: LocalIdentity, role: 'client' | 'host', ephRaw: Buffer, extra: Record<string, unknown>): Buffer =>
  Buffer.from(
    JSON.stringify({
      t: 'hello',
      v: REMOTE_PROTOCOL_VERSION,
      role,
      eph: ephRaw.toString('base64'),
      nonce: randomToken().toString('base64'),
      id: identity.id,
      name: identity.name,
      os: identity.os,
      platform: identity.platform,
      pub: identity.publicKey.toString('base64'),
      ...extra
    })
  )

// ── host ────────────────────────────────────────────────────────────────────

export interface UnattendedSecret {
  salt: Buffer
  params: KdfParams
  verifier: Buffer
  permission: RemotePermission
  minutes: SessionMinutes
}

export interface ApprovalRequest {
  peer: PeerInfo
  verificationCode: string
  requestedPermission: RemotePermission
  expiresInMs: number
}

export interface Approval {
  permission: RemotePermission
  minutes: SessionMinutes
}

export interface GrantPayload {
  sessionId: string
  resumeToken: Buffer
  permission: RemotePermission
  expiresInMs: number | null
  extra: Record<string, unknown>
  /** Called after 'granted' went out: the session takes the channel over. */
  onSent: () => void
}

export interface NewSession {
  channel: Channel
  peer: PeerInfo
  method: 'password' | 'attended'
  permission: RemotePermission
  minutes: SessionMinutes
}

export interface HostPolicy {
  identity: () => LocalIdentity
  attended: () => boolean
  unattended: () => UnattendedSecret | null
  /** Unattended is switched on but no password is set yet → refuse rather than fall back. */
  busy: () => boolean
  isBlocked: (peerId: string) => boolean
  /** Can this computer share its screen right now (macOS Screen Recording)? */
  canShareScreen: () => boolean
  limiter: AuthLimiter
  requests: WindowCounter
  approve: (request: ApprovalRequest, signal: AbortSignal) => Promise<Approval | null>
  grant: (session: NewSession) => GrantPayload
  /** Resume a suspended session; `check(token)` verifies the client's proof for it. */
  resume: (sessionId: string, peer: PeerInfo, check: (token: Buffer) => boolean, channel: Channel) => GrantPayload | DenyCode
  audit: (event: HistoryEvent, peer: PeerInfo, detail: string) => void
}

const deny = (channel: Channel, code: DenyCode, retryAfterMs = 0): void =>
  channel.closeAfter({ t: 'denied', code, message: denyMessage(code), retryAfterMs })

const sendGrant = (channel: Channel, payload: GrantPayload, method: string): void => {
  channel.maxFrame = SESSION_MAX_FRAME
  channel.send({
    t: 'granted',
    sessionId: payload.sessionId,
    resumeToken: payload.resumeToken.toString('base64'),
    permission: payload.permission,
    expiresInMs: payload.expiresInMs,
    method,
    ...payload.extra
  })
  payload.onSent()
}

/**
 * Runs the host side on a fresh connection. Resolves once the connection is
 * either handed to a session or closed. Never throws.
 */
export const runHostHandshake = async (socket: Duplex, address: string, policy: HostPolicy): Promise<void> => {
  const channel = new Channel(socket)
  let peer: PeerInfo | null = null
  try {
    const clientFrame = await channel.receiveRaw(HELLO_TIMEOUT_MS)
    const client = parseHello(clientFrame, 'client')
    peer = { ...client.peer, address }
    const purpose = client.raw['purpose']
    const identity = policy.identity()

    const unattended = policy.unattended()
    const eph = generateEphemeral()
    const hostFrame = helloFor(identity, 'host', eph.publicRaw, {
      attended: policy.attended(),
      unattended: unattended !== null,
      busy: policy.busy(),
      kdf: unattended ? { salt: unattended.salt.toString('base64'), ...unattended.params } : null
    })
    const transcript = transcriptHash(clientFrame, hostFrame)
    channel.sendRaw(hostFrame)
    channel.sendRaw(Buffer.from(JSON.stringify({ t: 'sig', sig: signTranscript(identity.privateKey, transcript).toString('base64') })))
    if (purpose === 'probe') {
      setTimeout(() => channel.close('Probe done.'), 2000).unref()
      return
    }

    const keys = deriveSessionKeys(sharedSecret(eph, client.eph), transcript)
    channel.setKeys(keys.hostToClient, keys.clientToHost)
    channel.endRawMode()

    const { msg } = await channel.receive(HELLO_TIMEOUT_MS)
    if (msg.t !== 'auth') throw new RemoteError('protocol', 'Expected authentication.')
    const sig = b64(msg['sig'])
    if (!sig || !verifyTranscript(peer.publicKey, transcript, sig)) {
      throw new RemoteError('identity', 'The other computer could not prove its identity.')
    }

    if (policy.isBlocked(peer.id)) {
      policy.audit('blocked', peer, 'Blocked device tried to connect.')
      return deny(channel, 'blocked')
    }

    const limitKeys = [`addr:${address}`, `id:${peer.id}`]
    const wait = policy.limiter.retryAfter(limitKeys)
    if (wait > 0) {
      policy.audit('rate-limited', peer, `Locked out for ${Math.ceil(wait / 1000)} s.`)
      return deny(channel, 'rate-limited', wait)
    }

    const method = msg['method']

    if (method === 'resume') {
      const sessionId = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : ''
      const proof = b64(msg['proof'], 32)
      const check = (token: Buffer): boolean => proof !== null && safeEqual(resumeProof(token, transcript), proof)
      const result = policy.resume(sessionId, peer, check, channel)
      if (typeof result === 'string') {
        if (result === 'no-session') policy.limiter.failure(limitKeys)
        return deny(channel, result)
      }
      policy.audit('reconnected', peer, 'Connection restored.')
      return sendGrant(channel, result, 'resume')
    }

    if (policy.busy()) return deny(channel, 'busy')
    if (!policy.canShareScreen()) return deny(channel, 'screen-permission')

    if (method === 'password') {
      if (!unattended) return deny(channel, 'unattended-off')
      const proof = b64(msg['proof'], 32)
      if (!proof || !safeEqual(passwordProof(unattended.verifier, transcript), proof)) {
        policy.limiter.failure(limitKeys)
        policy.audit('auth-failed', peer, 'Wrong unattended password.')
        return deny(channel, 'wrong-password')
      }
      policy.limiter.success(limitKeys)
      const payload = policy.grant({ channel, peer, method: 'password', permission: unattended.permission, minutes: unattended.minutes })
      return sendGrant(channel, payload, 'password')
    }

    if (method === 'request') {
      if (!policy.attended()) return deny(channel, 'not-accepting')
      if (!policy.requests.hit(peer.id) || !policy.requests.hit(`addr:${address}`)) {
        policy.audit('rate-limited', peer, 'Too many requests.')
        return deny(channel, 'rate-limited', 60_000)
      }
      const requested: RemotePermission = msg['permission'] === 'view' ? 'view' : 'control'
      channel.send({ t: 'pending', expiresInMs: REQUEST_TIMEOUT_MS })
      policy.audit('request', peer, `Asked for ${requested === 'view' ? 'view-only access' : 'full control'}.`)
      const abort = new AbortController()
      const onClose = (): void => abort.abort()
      channel.once('close', onClose)
      const answer = await Promise.race([
        policy.approve({ peer, verificationCode: keys.verificationCode, requestedPermission: requested, expiresInMs: REQUEST_TIMEOUT_MS }, abort.signal),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), REQUEST_TIMEOUT_MS).unref())
      ])
      channel.off('close', onClose)
      if (channel.isClosed) {
        abort.abort()
        return
      }
      if (answer === 'timeout') {
        abort.abort()
        policy.audit('rejected', peer, 'Nobody answered in time.')
        return deny(channel, 'timeout')
      }
      if (!answer) {
        policy.audit('rejected', peer, 'Declined.')
        return deny(channel, 'rejected')
      }
      if (policy.busy()) return deny(channel, 'busy')
      // A view-only request is never upgraded to control by the host's answer.
      const permission: RemotePermission = requested === 'view' ? 'view' : answer.permission
      const payload = policy.grant({ channel, peer, method: 'attended', permission, minutes: answer.minutes })
      return sendGrant(channel, payload, 'attended')
    }

    throw new RemoteError('protocol', 'Unknown authentication method.')
  } catch (error) {
    if (peer && error instanceof RemoteError) policy.audit('failed', peer, error.message)
    channel.close(error instanceof Error ? error.message : 'Handshake failed.')
  }
}

// ── client ──────────────────────────────────────────────────────────────────

export interface HostInfo extends PeerInfo {
  attended: boolean
  unattended: boolean
  busy: boolean
}

export interface Granted {
  sessionId: string
  resumeToken: Buffer
  permission: RemotePermission
  expiresInMs: number | null
  method: 'password' | 'attended' | 'resume'
  raw: WireMessage
}

export interface ClientOptions {
  identity: LocalIdentity
  purpose: 'connect' | 'resume' | 'probe'
  /** The device ID the user dialled; the host's key must hash to it. */
  expectedId?: string
  /** Fingerprint pinned on an earlier connection; a different key is refused. */
  pinnedFingerprint?: string
  password?: string
  requestPermission?: RemotePermission
  resume?: { sessionId: string; token: Buffer }
  onHost?: (host: HostInfo) => void
  onPending?: (info: { verificationCode: string; expiresInMs: number }) => void
  signal?: AbortSignal
  /** Argon2id; replaceable in tests. */
  kdf?: (password: string, salt: Buffer, params: KdfParams) => Promise<Buffer>
}

export interface ClientResult {
  channel: Channel
  host: HostInfo
  verificationCode: string
  granted: Granted | null
}

export const runClientHandshake = async (socket: Duplex, address: string, options: ClientOptions): Promise<ClientResult> => {
  const channel = new Channel(socket)
  const onAbort = (): void => channel.close('Cancelled.')
  options.signal?.addEventListener('abort', onAbort)
  try {
    const eph = generateEphemeral()
    const clientFrame = helloFor(options.identity, 'client', eph.publicRaw, { purpose: options.purpose })
    channel.sendRaw(clientFrame)
    const hostFrame = await channel.receiveRaw(HELLO_TIMEOUT_MS)
    const sigFrame = await channel.receiveRaw(HELLO_TIMEOUT_MS)
    const parsed = parseHello(hostFrame, 'host')
    const transcript = transcriptHash(clientFrame, hostFrame)
    let sig: Buffer | null = null
    try {
      const sigMsg = JSON.parse(sigFrame.toString('utf8')) as Record<string, unknown>
      sig = b64(sigMsg['sig'])
    } catch {
      sig = null
    }
    if (!sig || !verifyTranscript(parsed.peer.publicKey, transcript, sig)) {
      throw new RemoteError('identity', 'The other computer could not prove its identity.')
    }
    if (options.expectedId && parsed.peer.id !== options.expectedId) {
      throw new RemoteError('identity', `That address belongs to ${parsed.peer.id}, not ${options.expectedId}.`)
    }
    if (options.pinnedFingerprint && parsed.peer.fingerprint !== options.pinnedFingerprint) {
      throw new RemoteError(
        'identity',
        'The other computer’s security key changed since your last connection. If it was not reinstalled, someone may be impersonating it. Remove it from Saved devices to trust the new key.'
      )
    }
    const kdfRaw = parsed.raw['kdf'] as Record<string, unknown> | null
    const host: HostInfo = {
      ...parsed.peer,
      address,
      attended: parsed.raw['attended'] === true,
      unattended: parsed.raw['unattended'] === true,
      busy: parsed.raw['busy'] === true
    }
    options.onHost?.(host)
    const keys = deriveSessionKeys(sharedSecret(eph, parsed.eph), transcript)
    if (options.purpose === 'probe') {
      channel.close('Probe done.')
      return { channel, host, verificationCode: keys.verificationCode, granted: null }
    }
    channel.setKeys(keys.clientToHost, keys.hostToClient)
    channel.endRawMode()

    const auth: WireMessage = { t: 'auth', sig: signTranscript(options.identity.privateKey, transcript).toString('base64'), method: 'request' }
    if (options.purpose === 'resume' && options.resume) {
      auth['method'] = 'resume'
      auth['sessionId'] = options.resume.sessionId
      auth['proof'] = resumeProof(options.resume.token, transcript).toString('base64')
    } else if (options.password) {
      if (!host.unattended || !kdfRaw) throw new RemoteError('unattended-off', denyMessage('unattended-off'))
      const salt = b64(kdfRaw['salt'])
      const params: KdfParams = { t: Number(kdfRaw['t']), m: Number(kdfRaw['m']), p: Number(kdfRaw['p']) }
      if (!salt || salt.length < 16 || !kdfParamsAcceptable(params)) throw new RemoteError('protocol', 'The other computer asked for unsafe password settings.')
      const verifier = await (options.kdf ?? passwordVerifier)(options.password, salt, params)
      auth['method'] = 'password'
      auth['proof'] = passwordProof(verifier, transcript).toString('base64')
    } else {
      auth['permission'] = options.requestPermission ?? 'control'
    }
    channel.send(auth)

    for (;;) {
      const { msg }: Received = await channel.receive(options.purpose === 'connect' && !options.password ? REQUEST_TIMEOUT_MS + 15_000 : 30_000)
      if (msg.t === 'pending') {
        options.onPending?.({ verificationCode: keys.verificationCode, expiresInMs: Number(msg['expiresInMs']) || REQUEST_TIMEOUT_MS })
        continue
      }
      if (msg.t === 'denied') {
        const code = (Object.keys(DENY_MESSAGES).includes(String(msg['code'])) ? msg['code'] : 'rejected') as DenyCode
        throw new RemoteError(code, denyMessage(code), Number(msg['retryAfterMs']) || 0)
      }
      if (msg.t === 'granted') {
        const token = b64(msg['resumeToken'], 32)
        if (typeof msg['sessionId'] !== 'string' || !token) throw new RemoteError('protocol', 'Bad answer from the other computer.')
        channel.maxFrame = SESSION_MAX_FRAME
        const expires = msg['expiresInMs']
        return {
          channel,
          host,
          verificationCode: keys.verificationCode,
          granted: {
            sessionId: msg['sessionId'],
            resumeToken: token,
            permission: msg['permission'] === 'view' ? 'view' : 'control',
            expiresInMs: typeof expires === 'number' && expires > 0 ? expires : null,
            method: msg['method'] === 'password' ? 'password' : msg['method'] === 'resume' ? 'resume' : 'attended',
            raw: msg
          }
        }
      }
      throw new RemoteError('protocol', 'Unexpected answer from the other computer.')
    }
  } catch (error) {
    channel.close('Handshake failed.')
    if (options.signal?.aborted) throw new RemoteError('cancelled', 'Cancelled.')
    if (error instanceof RemoteError) throw error
    throw new RemoteError('network', error instanceof Error ? error.message : String(error))
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** Minutes → ms, null for unlimited. */
export const minutesToMs = (minutes: SessionMinutes): number | null => (isSessionMinutes(minutes) && minutes > 0 ? minutes * 60_000 : null)
