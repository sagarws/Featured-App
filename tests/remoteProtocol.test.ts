import { createServer, connect, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Channel } from '../electron/main/remote/core/channel'
import {
  deriveSessionKeys,
  deviceIdFromPublicKey,
  fingerprintOf,
  generateEphemeral,
  generateIdentityKeys,
  legacyDeviceIdFromPublicKey,
  passwordVerifier,
  privateKeyFromDer,
  randomToken,
  sharedSecret,
  type KdfParams,
  type LocalIdentity
} from '../electron/main/remote/core/crypto'
import {
  RemoteError,
  runClientHandshake,
  runHostHandshake,
  type Approval,
  type ApprovalRequest,
  type ClientOptions,
  type GrantPayload,
  type HostPolicy,
  type NewSession,
  type PeerInfo
} from '../electron/main/remote/core/handshake'
import { AuthLimiter, WindowCounter } from '../electron/main/remote/core/limiter'
import { dialThroughRelay, RelayHost, relayLookup } from '../electron/main/remote/core/relayClient'
import { relayDeviceId, startRelay } from '../tools/remote-relay/relay'

// Small Argon2id parameters so the suite stays fast; production uses 64 MiB / t=3.
const FAST_KDF: KdfParams = { t: 1, m: 64, p: 1 }

const makeIdentity = (name: string): LocalIdentity => {
  const keys = generateIdentityKeys()
  return { id: deviceIdFromPublicKey(keys.publicKey), name, os: 'Test OS', platform: 'linux', publicKey: keys.publicKey, privateKey: privateKeyFromDer(keys.privateKey) }
}

interface Harness {
  server: Server
  port: number
  host: LocalIdentity
  sessions: NewSession[]
  audits: string[]
  approvals: ApprovalRequest[]
  policy: HostPolicy
  tokens: Map<string, { token: Buffer; peerId: string; channel: NewSession['channel'] | null }>
}

const servers: Server[] = []
const sockets: { destroy: () => unknown }[] = []
const relayHosts: RelayHost[] = []
afterEach(() => {
  relayHosts.splice(0).forEach(h => h.stop())
  sockets.splice(0).forEach(s => s.destroy())
  servers.splice(0).forEach(s => s.close())
})

const startHost = async (overrides: Partial<HostPolicy> & { password?: string; answer?: Approval | null } = {}): Promise<Harness> => {
  const host = makeIdentity('Office PC 1')
  const sessions: NewSession[] = []
  const audits: string[] = []
  const approvals: ApprovalRequest[] = []
  const tokens = new Map<string, { token: Buffer; peerId: string; channel: NewSession['channel'] | null }>()
  const salt = randomToken(16)
  const verifier = overrides.password ? await passwordVerifier(overrides.password, salt, FAST_KDF) : null
  let counter = 0
  const policy: HostPolicy = {
    identity: () => host,
    attended: () => true,
    unattended: () => (verifier ? { salt, params: FAST_KDF, verifier, permission: 'control', minutes: 30 } : null),
    busy: () => false,
    isBlocked: () => false,
    canShareScreen: () => true,
    limiter: new AuthLimiter(),
    requests: new WindowCounter(5, 60_000),
    approve: request => {
      approvals.push(request)
      return Promise.resolve(overrides.answer === undefined ? { permission: 'control', minutes: 30 } : overrides.answer)
    },
    grant: (session): GrantPayload => {
      sessions.push(session)
      const sessionId = `s${++counter}`
      const token = randomToken()
      tokens.set(sessionId, { token, peerId: session.peer.id, channel: session.channel })
      return {
        sessionId,
        resumeToken: token,
        permission: session.permission,
        expiresInMs: session.minutes ? session.minutes * 60_000 : null,
        extra: { displays: [] },
        onSent: () => undefined
      }
    },
    resume: (sessionId, peer: PeerInfo, check) => {
      const entry = tokens.get(sessionId)
      if (!entry || entry.peerId !== peer.id || !check(entry.token)) return 'no-session'
      return { sessionId, resumeToken: entry.token, permission: 'control', expiresInMs: 1000, extra: {}, onSent: () => undefined }
    },
    audit: (event, peer, detail) => audits.push(`${event}:${peer.id}:${detail}`),
    ...overrides
  }
  const server = createServer(socket => void runHostHandshake(socket, socket.remoteAddress ?? '?', policy))
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, port, host, sessions, audits, approvals, policy, tokens }
}

const dial = (port: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => resolve(socket))
    sockets.push(socket)
    socket.once('error', reject)
  })

const client = makeIdentity('Office PC 2')
const connectTo = async (h: Harness, options: Partial<ClientOptions> = {}) =>
  runClientHandshake(await dial(h.port), '127.0.0.1', { identity: client, purpose: 'connect', expectedId: h.host.id, kdf: (p, s) => passwordVerifier(p, s, FAST_KDF), ...options })

describe('device identity', () => {
  it('derives a stable 8-digit ID from the key: the last 8 digits of the old WD-xxx-xxx-xxx one', () => {
    const keys = generateIdentityKeys()
    const id = deviceIdFromPublicKey(keys.publicKey)
    expect(id).toMatch(/^\d{8}$/)
    expect(deviceIdFromPublicKey(keys.publicKey)).toBe(id)
    const legacy = legacyDeviceIdFromPublicKey(keys.publicKey)
    expect(legacy).toMatch(/^WD-\d{3}-\d{3}-\d{3}$/)
    expect(legacy.replace(/\D/g, '').slice(1)).toBe(id)
    expect(fingerprintOf(keys.publicKey)).toMatch(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/)
  })

  it('gives both sides the same keys and verification code', () => {
    const a = generateEphemeral()
    const b = generateEphemeral()
    const t = randomToken()
    const ka = deriveSessionKeys(sharedSecret(a, b.publicRaw), t)
    const kb = deriveSessionKeys(sharedSecret(b, a.publicRaw), t)
    expect(ka.clientToHost.equals(kb.clientToHost)).toBe(true)
    expect(ka.verificationCode).toBe(kb.verificationCode)
    expect(ka.verificationCode).toMatch(/^\d{3} \d{3}$/)
    expect(() => sharedSecret(a, Buffer.alloc(32))).toThrow()
  })
})

describe('attended access', () => {
  it('asks the host, then grants what the host chose', async () => {
    const h = await startHost({ answer: { permission: 'view', minutes: 15 } })
    let pending = ''
    const result = await connectTo(h, { onPending: info => (pending = info.verificationCode) })
    expect(result.granted?.permission).toBe('view')
    expect(result.granted?.expiresInMs).toBe(15 * 60_000)
    expect(result.granted?.method).toBe('attended')
    // Both screens show the same code.
    expect(h.approvals[0]?.verificationCode).toBe(pending)
    expect(h.approvals[0]?.peer.id).toBe(client.id)
    expect(h.sessions[0]?.peer.name).toBe('Office PC 2')
  })

  it('reports a declined request', async () => {
    const h = await startHost({ answer: null })
    await expect(connectTo(h)).rejects.toMatchObject({ code: 'rejected' })
    expect(h.sessions).toHaveLength(0)
  })

  it('never upgrades a view-only request to control', async () => {
    const h = await startHost({ answer: { permission: 'control', minutes: 0 } })
    const result = await connectTo(h, { requestPermission: 'view' })
    expect(result.granted?.permission).toBe('view')
    expect(result.granted?.expiresInMs).toBeNull()
  })

  it('refuses requests when the host does not accept them', async () => {
    const h = await startHost({ attended: () => false })
    await expect(connectTo(h)).rejects.toMatchObject({ code: 'not-accepting' })
  })

  it('refuses a blocked device without asking', async () => {
    const h = await startHost({ isBlocked: id => id === client.id })
    await expect(connectTo(h)).rejects.toMatchObject({ code: 'blocked' })
    expect(h.approvals).toHaveLength(0)
  })

  it('limits how often one device can pop up requests', async () => {
    const h = await startHost({ requests: new WindowCounter(2, 60_000), answer: null })
    await expect(connectTo(h)).rejects.toMatchObject({ code: 'rejected' })
    await expect(connectTo(h)).rejects.toMatchObject({ code: 'rejected' })
    await expect(connectTo(h)).rejects.toMatchObject({ code: 'rate-limited' })
    expect(h.approvals).toHaveLength(2)
  })
})

describe('unattended access', () => {
  it('grants with the right password, without asking', async () => {
    const h = await startHost({ password: 'Correct-Horse-9' })
    const result = await connectTo(h, { password: 'Correct-Horse-9' })
    expect(result.granted?.method).toBe('password')
    expect(result.granted?.permission).toBe('control')
    expect(h.approvals).toHaveLength(0)
  })

  it('refuses a wrong password and locks out after repeated failures', async () => {
    const h = await startHost({ password: 'Correct-Horse-9' })
    for (let i = 0; i < 3; i++) await expect(connectTo(h, { password: 'wrong-guess-1' })).rejects.toMatchObject({ code: 'wrong-password' })
    // The 3rd failure starts a lockout: even the right password waits now.
    const locked = await connectTo(h, { password: 'Correct-Horse-9' }).catch((e: RemoteError) => e)
    expect(locked).toBeInstanceOf(RemoteError)
    expect((locked as RemoteError).code).toBe('rate-limited')
    expect((locked as RemoteError).retryAfterMs).toBeGreaterThan(0)
    expect(h.sessions).toHaveLength(0)
    expect(h.audits.filter(a => a.startsWith('auth-failed'))).toHaveLength(3)
  })

  it('says so when unattended access is off', async () => {
    const h = await startHost()
    await expect(connectTo(h, { password: 'whatever-123' })).rejects.toMatchObject({ code: 'unattended-off' })
  })
})

describe('a stale session from the same controller', () => {
  it('does not block that controller from connecting again, but still blocks other devices', async () => {
    // The host has a session of `client` that it has not yet noticed is dead.
    const h = await startHost({ password: 'Correct-Horse-9', busy: (peerId?: string) => peerId !== client.id })
    const again = await connectTo(h, { password: 'Correct-Horse-9' })
    expect(again.granted?.method).toBe('password')
    const other = makeIdentity('Office PC 3')
    await expect(connectTo(h, { identity: other, password: 'Correct-Horse-9' })).rejects.toMatchObject({ code: 'busy' })
  })
})

describe('identity checks', () => {
  it('refuses a host whose key does not match the dialled ID', async () => {
    const h = await startHost()
    await expect(connectTo(h, { expectedId: '00000001' })).rejects.toMatchObject({ code: 'identity' })
    expect(h.approvals).toHaveLength(0)
  })

  it('refuses a host whose key changed since it was pinned', async () => {
    const h = await startHost()
    await expect(connectTo(h, { pinnedFingerprint: 'AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA' })).rejects.toMatchObject({ code: 'identity' })
  })

  it('a probe reads the host without authenticating', async () => {
    const h = await startHost({ password: 'Correct-Horse-9' })
    const result = await connectTo(h, { purpose: 'probe' })
    expect(result.granted).toBeNull()
    expect(result.host.id).toBe(h.host.id)
    expect(result.host.unattended).toBe(true)
    expect(h.sessions).toHaveLength(0)
  })
})

describe('resume', () => {
  it('resumes with the session token and refuses a forged one', async () => {
    const h = await startHost({ password: 'Correct-Horse-9' })
    const first = await connectTo(h, { password: 'Correct-Horse-9' })
    const granted = first.granted!
    const resumed = await connectTo(h, { purpose: 'resume', resume: { sessionId: granted.sessionId, token: granted.resumeToken } })
    expect(resumed.granted?.method).toBe('resume')
    await expect(connectTo(h, { purpose: 'resume', resume: { sessionId: granted.sessionId, token: randomToken() } })).rejects.toMatchObject({ code: 'no-session' })
  })
})

describe('encrypted channel', () => {
  it('carries JSON and binary both ways after the handshake', async () => {
    const h = await startHost()
    const result = await connectTo(h)
    const hostChannel = h.sessions[0]!.channel
    hostChannel.startPushMode()
    const got = new Promise<{ t: string; bytes: number }>(resolve =>
      hostChannel.once('message', ({ msg, binary }: { msg: { t: string }; binary: Buffer | null }) => resolve({ t: msg.t, bytes: binary?.length ?? 0 }))
    )
    result.channel.send({ t: 'file-chunk' }, Buffer.alloc(200_000, 7))
    expect(await got).toEqual({ t: 'file-chunk', bytes: 200_000 })
  })

  it('drops the connection on a tampered frame', async () => {
    const h = await startHost()
    const result = await connectTo(h)
    const hostChannel = h.sessions[0]!.channel
    hostChannel.startPushMode()
    const closed = new Promise<string>(resolve => hostChannel.once('close', (reason: string) => resolve(reason)))
    // A frame whose ciphertext was not made with the session key.
    const junk = Buffer.alloc(64, 1)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(junk.length)
    result.channel.socket.write(Buffer.concat([header, junk]))
    expect(await closed).toMatch(/integrity/)
  })

  it('drops the connection on a replayed frame', async () => {
    const h = await startHost()
    const result = await connectTo(h)
    const hostChannel = h.sessions[0]!.channel
    hostChannel.startPushMode()
    const frames: Buffer[] = []
    const socket = result.channel.socket
    const write = socket.write.bind(socket) as (chunk: Buffer) => boolean
    ;(socket as unknown as { write: (chunk: Buffer) => boolean }).write = (chunk: Buffer) => {
      frames.push(Buffer.from(chunk))
      return write(chunk)
    }
    const first = new Promise(resolve => hostChannel.once('message', resolve))
    result.channel.send({ t: 'ping' })
    await first
    const closed = new Promise<string>(resolve => hostChannel.once('close', (reason: string) => resolve(reason)))
    write(frames[0]!)
    expect(await closed).toMatch(/integrity/)
  })

  it('refuses oversized frames before authentication', async () => {
    const h = await startHost()
    const socket = await dial(h.port)
    const closed = new Promise(resolve => socket.once('close', resolve))
    const header = Buffer.alloc(4)
    header.writeUInt32BE(10 * 1024 * 1024)
    socket.write(header)
    await closed
    expect(h.sessions).toHaveLength(0)
  })
})

describe('limiter', () => {
  it('locks out exponentially and globally', () => {
    let now = 0
    const limiter = new AuthLimiter(() => now, { freeAttempts: 2, baseLockMs: 1000, maxLockMs: 8000, globalPerMinute: 100 })
    limiter.failure(['a'])
    expect(limiter.retryAfter(['a'])).toBe(0)
    limiter.failure(['a'])
    expect(limiter.retryAfter(['a'])).toBe(1000)
    limiter.failure(['a'])
    expect(limiter.retryAfter(['a'])).toBe(2000)
    for (let i = 0; i < 10; i++) limiter.failure(['a'])
    expect(limiter.retryAfter(['a'])).toBe(8000)
    expect(limiter.retryAfter(['b'])).toBe(0)
    now += 9000
    expect(limiter.retryAfter(['a'])).toBe(0)
    limiter.success(['a'])

    const global = new AuthLimiter(() => now, { globalPerMinute: 3 })
    global.failure(['x'])
    global.failure(['y'])
    global.failure(['z'])
    expect(global.retryAfter(['someone-else'])).toBe(60_000)
  })

  it('counts requests in a sliding window', () => {
    let now = 0
    const counter = new WindowCounter(2, 1000, () => now)
    expect(counter.hit('a')).toBe(true)
    expect(counter.hit('a')).toBe(true)
    expect(counter.hit('a')).toBe(false)
    now = 1001
    expect(counter.hit('a')).toBe(true)
  })
})

describe('relay (outside the office network)', () => {
  // The same session over plain TCP (a VPS) and over a WebSocket (Cloudflare Tunnel / an HTTPS proxy).
  // RELAY_TEST_URL=wss://… npx vitest run tests/remoteProtocol.test.ts — also runs it through a deployed relay.
  const live = process.env['RELAY_TEST_URL']
  it.each([
    ['plain TCP', (port: number) => `127.0.0.1:${port}`],
    ['WebSocket', (port: number) => `ws://127.0.0.1:${port}`],
    ...(live ? [['the live relay', () => live] as [string, (port: number) => string]] : [])
  ])('pipes an end-to-end session between a registered host and a client over %s', async (_name, addressFor) => {
    const h = await startHost({ password: 'Correct-Horse-9' })
    const relay = await startRelay({ port: 0, host: '127.0.0.1', log: () => undefined })
    servers.push(relay)
    const address = relay.address()
    const relayAddr = addressFor(typeof address === 'object' && address ? address.port : 0)
    expect(relayDeviceId(h.host.publicKey)).toBe(h.host.id)

    const online = new Promise<void>(resolve => {
      const host = new RelayHost(relayAddr, () => h.host, {
        onState: state => state === 'online' && resolve(),
        onIncoming: (socket, from) => void runHostHandshake(socket, from, h.policy)
      })
      host.start()
      relayHosts.push(host)
    })
    await online
    expect(await relayLookup(relayAddr, h.host.id)).toBe(true)
    expect(await relayLookup(relayAddr, '00000000')).toBe(false)

    const socket = await dialThroughRelay(relayAddr, h.host.id)
    sockets.push(socket)
    const result = await runClientHandshake(socket, 'relay', {
      identity: client,
      purpose: 'connect',
      expectedId: h.host.id,
      password: 'Correct-Horse-9',
      kdf: (p, s) => passwordVerifier(p, s, FAST_KDF)
    })
    expect(result.granted?.method).toBe('password')
    // The relay saw only ciphertext; the host still sees the real peer identity.
    expect(h.sessions[0]?.peer.id).toBe(client.id)
    expect(h.sessions[0]?.peer.address).toMatch(/^relay:/)
    expect(result.channel).toBeInstanceOf(Channel)
  })

  it('refuses to register an ID the host cannot prove', async () => {
    const relay = await startRelay({ port: 0, host: '127.0.0.1', log: () => undefined })
    servers.push(relay)
    const address = relay.address()
    const relayAddr = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const real = makeIdentity('Real')
    const impostor = { ...makeIdentity('Impostor'), id: real.id }
    const state = await new Promise<string>(resolve => {
      const host = new RelayHost(relayAddr, () => impostor, { onState: (s, error) => s !== 'connecting' && resolve(`${s}:${error ?? ''}`), onIncoming: () => undefined })
      host.start()
      relayHosts.push(host)
    })
    expect(state).toMatch(/^error:.*refused/i)
  })
})
