import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { app, dialog, Notification, powerMonitor, powerSaveBlocker, screen, type BrowserWindow, type WebContents } from 'electron'
import { REMOTE_IPC } from '@shared/constants/channels'
import { DIRECT_DIAL_TIMEOUT_MS, REMOTE_SERVER } from '@shared/constants/remote'
import type {
  ConnectRequest,
  HistoryEntry,
  IceServer,
  IncomingRequest,
  RemotePermission,
  RemoteSettings,
  RemoteStatus,
  ServerStatus,
  SessionMinutes
} from '@shared/types/remote'
import { parseConnectTarget, passwordProblem } from '@shared/utils/remote'
import { logger } from '../logger'
import { screenPermission } from '../recorder/capture'
import { getWindow } from '../window'
import { DEFAULT_KDF, kdfParamsAcceptable, legacyDeviceIdFromPublicKey, passwordVerifier } from './core/crypto'
import { RemoteError, runClientHandshake, runHostHandshake, type HostInfo, type HostPolicy, type PeerInfo, type UnattendedSecret } from './core/handshake'
import { AuthLimiter, WindowCounter } from './core/limiter'
import { onRelayIce, RelayHost } from './core/relayClient'
import type { RemoteContext } from './context'
import type { IceGrant, RelayConn } from '../../../tools/remote-relay/relay'
import { dial, routeLabel, type Route } from './dial'
import { Discovery } from './discovery'
import { HostSession } from './hostSession'
import { InputInjector } from './input/injector'
import { SecureDesktop } from './secureDesktop'
import * as store from './store'
import { Transfers, type TransferLink } from './transfers'
import { ViewerSession } from './viewerSession'
import { createHostBarWindow, createRequestWindow } from './windows'

/*
 * Remote Desktop, main process: the listener other computers connect to, LAN
 * discovery, the optional relay, incoming requests, and both kinds of
 * session. Windows only ever talk to this through ipc.ts.
 */

const MAX_PENDING_HANDSHAKES = 16
const MAX_PENDING_REQUESTS = 3

const hostSessions = new Map<string, HostSession>()
const viewerSessions = new Map<string, ViewerSession>()
const requests = new Map<string, { info: IncomingRequest; resolve: (answer: { permission: RemotePermission; minutes: SessionMinutes } | null) => void; window: BrowserWindow | null }>()
const attempts = new Map<string, AbortController>()
const limiter = new AuthLimiter()
const requestCounter = new WindowCounter(3, 60_000)
const injector = new InputInjector()
const secure = new SecureDesktop()
/** This computer's screen is locked (OS events, confirmed by the Windows agent when installed). */
let hostLocked = false
let lockPoll: NodeJS.Timeout | null = null
let awakeBlocker: number | null = null
let server: Server | null = null
let serverStatus: ServerStatus = { listening: false, port: 0, error: null, relay: 'off', relayError: null }
let relayHost: RelayHost | null = null
let relayAddress = ''
let discovery: Discovery | null = null
let discoveryPort = 0
let hostBar: BrowserWindow | null = null
let pendingHandshakes = 0
let pushTimer: NodeJS.Timeout | null = null
let permissions: RemoteStatus['permissions'] = { screen: 'unknown', input: 'unknown', inputDetail: null }

const transfers = new Transfers({
  changed: () => notify(),
  done: info => {
    const session = hostSessions.get(info.sessionId) ?? viewerSessions.get(info.sessionId)
    const peer = session instanceof HostSession ? session.peer : session?.host
    if (!peer || (info.state !== 'done' && info.state !== 'failed')) return
    history({
      direction: session instanceof HostSession ? 'incoming' : 'outgoing',
      event: info.direction === 'receive' ? 'file-received' : 'file-sent',
      peerId: peer.id,
      peerName: peer.name,
      address: peer.address,
      detail: `${info.files.length} file(s), ${Math.round(info.totalBytes / 1024)} KB${info.state === 'failed' ? ` — failed: ${info.error ?? ''}` : info.folder ? ` → ${info.folder}` : ''}`
    })
  },
  decide: (link, files) => decideIncomingFiles(link, files)
})

const settings = (): RemoteSettings => store.getRemoteSettings()

/** The relay in use: this computer's own setting, else the built-in server (shared/constants/remote.ts). */
const relayInUse = (): string => settings().relay || REMOTE_SERVER.relay

/** The newest TURN login from the relay (when the relay server has coturn), until it expires. */
let relayTurn: IceGrant | null = null
onRelayIce(grant => {
  relayTurn = grant
})

/**
 * STUN/TURN for the video. WebRTC always tries a direct path first (same
 * network, then through both NATs with STUN) and only sends the video through
 * TURN when nothing direct works, so the server carries video only for the
 * sessions that need it. TURN, in order: this computer's own setting, a
 * short-lived login from the relay, the built-in one.
 */
export const iceServers = (): IceServer[] => {
  const s = settings()
  if (s.turnUrl) {
    const credential = store.getTurnCredential()
    return [{ urls: s.turnUrl, ...(s.turnUsername ? { username: s.turnUsername } : {}), ...(credential ? { credential } : {}) }]
  }
  const servers: IceServer[] = []
  if (REMOTE_SERVER.stun.length) servers.push({ urls: [...REMOTE_SERVER.stun] })
  const turn = relayTurn && relayTurn.expiresAt - Date.now() > 60_000 ? relayTurn : REMOTE_SERVER.turn
  if (turn) servers.push({ urls: [...turn.urls], username: turn.username, credential: turn.credential })
  return servers
}

const history = (entry: Omit<HistoryEntry, 'at'>): void => store.appendHistory({ at: Date.now(), ...entry })

const transferLink = (session: HostSession | ViewerSession): TransferLink =>
  session instanceof HostSession
    ? { sessionId: session.id, channel: () => session.channel, peerName: session.peer.name }
    : { sessionId: session.id, channel: () => session.currentChannel(), peerName: session.host.name }

const ctx: RemoteContext = {
  settings,
  iceServers,
  notify: () => notify(),
  history,
  injector,
  secure,
  hostLocked: () => hostLocked,
  transfers,
  transferLink,
  hostSessionEnded: session => {
    setTimeout(() => {
      hostSessions.delete(session.id)
      updateHostBar()
      notify()
    }, 1500)
    notify()
  },
  viewerSessionEnded: session => {
    setTimeout(() => {
      viewerSessions.delete(session.id)
      notify()
    }, 1500)
    notify()
  }
}

// ── status ──────────────────────────────────────────────────────────────────

export const status = (): RemoteStatus => {
  const s = settings()
  return {
    identity: store.identityInfo(),
    settings: s,
    server: serverStatus,
    unattendedPasswordSet: store.getUnattended() !== null,
    discovered: discovery?.list() ?? [],
    saved: store.savedDevices(),
    sessions: [...[...hostSessions.values()].map(h => h.info()), ...[...viewerSessions.values()].map(v => v.info())],
    requests: [...requests.values()].map(r => r.info),
    authorized: store.authorizedDevices(),
    blocked: store.blockedDevices(),
    transfers: transfers.list(),
    permissions,
    encryption: store.encryptionAvailable(),
    secureAgent: secure.agentState()
  }
}

/** Windows that get the status push: the app, the viewers, the host bar. */
const statusTargets = (): WebContents[] => {
  const list: WebContents[] = []
  const main = getWindow()
  if (main) list.push(main.webContents)
  for (const v of viewerSessions.values()) if (v.window && !v.window.isDestroyed()) list.push(v.window.webContents)
  if (hostBar && !hostBar.isDestroyed()) list.push(hostBar.webContents)
  return list
}

export const notify = (): void => {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    const snapshot = status()
    for (const target of statusTargets()) target.send(REMOTE_IPC.status, snapshot)
  }, 80)
}

const refreshPermissions = async (): Promise<void> => {
  const input = await injector.check()
  permissions = { screen: screenPermission(), input: input.state, inputDetail: input.detail }
  notify()
}

// ── host bar (the visible "being controlled" indicator) ─────────────────────

const updateHostBar = (): void => {
  const live = [...hostSessions.values()].some(s => s.state !== 'ended')
  // While shared, the display must not sleep (and the screen saver must not lock it):
  // a sleeping display stops screen capture.
  if (live && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-display-sleep')
  if (!live && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker)
    awakeBlocker = null
  }
  if (live && (!hostBar || hostBar.isDestroyed())) {
    hostBar = createHostBarWindow()
    hostBar.on('closed', () => (hostBar = null))
  } else if (!live && hostBar && !hostBar.isDestroyed()) {
    hostBar.setClosable(true)
    hostBar.destroy()
    hostBar = null
  }
}

// ── host policy ─────────────────────────────────────────────────────────────

const unattendedSecret = (): UnattendedSecret | null => {
  const s = settings()
  const record = store.getUnattended()
  if (!s.unattendedEnabled || !record || !kdfParamsAcceptable(record.params)) return null
  return {
    salt: Buffer.from(record.salt, 'base64'),
    params: record.params,
    verifier: Buffer.from(record.verifier, 'base64'),
    permission: s.controlDisabled ? 'view' : s.unattendedPermission,
    minutes: s.defaultMinutes
  }
}

const firstTimePeer = (id: string): boolean => !store.readHistory(1000).some(e => e.peerId === id && e.direction === 'incoming' && e.event === 'connected')

const approve = (request: { peer: PeerInfo; verificationCode: string; requestedPermission: RemotePermission; expiresInMs: number }, signal: AbortSignal) =>
  new Promise<{ permission: RemotePermission; minutes: SessionMinutes } | null>(resolve => {
    if (requests.size >= MAX_PENDING_REQUESTS) return resolve(null)
    const requestId = randomBytes(12).toString('hex')
    const info: IncomingRequest = {
      requestId,
      peerId: request.peer.id,
      peerName: request.peer.name,
      peerOs: request.peer.os,
      address: request.peer.address,
      verificationCode: request.verificationCode,
      firstTime: firstTimePeer(request.peer.id),
      receivedAt: Date.now(),
      expiresAt: Date.now() + request.expiresInMs
    }
    const finish = (answer: { permission: RemotePermission; minutes: SessionMinutes } | null): void => {
      const entry = requests.get(requestId)
      if (!entry) return
      requests.delete(requestId)
      if (entry.window && !entry.window.isDestroyed()) entry.window.destroy()
      notify()
      resolve(answer)
    }
    const win = createRequestWindow(requestId)
    win.on('closed', () => finish(null))
    requests.set(requestId, { info, resolve: finish, window: win })
    signal.addEventListener('abort', () => finish(null))
    new Notification({ title: 'Remote access request', body: `${request.peer.name} (${request.peer.id}) wants to ${request.requestedPermission === 'view' ? 'view' : 'control'} this computer.` }).show()
    notify()
  })

export const answerRequest = (requestId: string, answer: { allow: boolean; permission: RemotePermission; minutes: SessionMinutes }): void => {
  const entry = requests.get(requestId)
  if (!entry) return
  const permission: RemotePermission = settings().controlDisabled ? 'view' : answer.permission
  entry.resolve(answer.allow ? { permission, minutes: answer.minutes } : null)
}

export const requestInfo = (requestId: string): (IncomingRequest & { defaultMinutes: SessionMinutes; controlDisabled: boolean }) | null => {
  const entry = requests.get(requestId)
  return entry ? { ...entry.info, defaultMinutes: settings().defaultMinutes, controlDisabled: settings().controlDisabled } : null
}

const policy: HostPolicy = {
  identity: () => store.localIdentity(),
  attended: () => settings().enabled,
  unattended: unattendedSecret,
  busy: peerId => [...hostSessions.values()].some(s => s.state !== 'ended' && s.peer.id !== peerId),
  isBlocked: id => store.isBlocked(id),
  canShareScreen: () => {
    const state = screenPermission()
    return state !== 'denied' && state !== 'restricted'
  },
  limiter,
  requests: requestCounter,
  approve,
  grant: session => {
    // The same controller connecting again (its app was closed or crashed, or the network dropped):
    // its identity is proven by the handshake, so the stale session gives way at once.
    for (const old of hostSessions.values()) {
      if (old.state !== 'ended' && old.peer.id === session.peer.id) old.end('Replaced by a new connection from the same computer.')
    }
    const host = new HostSession(ctx, session.peer, session.method, session.permission, session.minutes, session.channel)
    hostSessions.set(host.id, host)
    if (session.method === 'password') store.recordAuthorized(session.peer)
    return {
      sessionId: host.id,
      resumeToken: host.resumeToken,
      permission: host.permission,
      expiresInMs: host.expiresAt === null ? null : host.expiresAt - Date.now(),
      extra: host.extra(),
      onSent: () => {
        host.start()
        updateHostBar()
      }
    }
  },
  resume: (sessionId, peer, check, channel) => {
    const host = hostSessions.get(sessionId)
    if (!host || host.state !== 'reconnecting' || host.peer.id !== peer.id || !check(host.resumeToken)) return 'no-session'
    if (store.isBlocked(peer.id)) return 'blocked'
    return {
      sessionId: host.id,
      resumeToken: host.resumeToken,
      permission: host.permission,
      expiresInMs: host.expiresAt === null ? null : Math.max(1, host.expiresAt - Date.now()),
      extra: host.resumeExtra(),
      onSent: () => host.resume(channel)
    }
  },
  audit: (event, peer, detail) => history({ direction: 'incoming', event, peerId: peer.id, peerName: peer.name, address: peer.address, detail })
}

const onIncomingSocket = (socket: RelayConn, address: string): void => {
  if (pendingHandshakes >= MAX_PENDING_HANDSHAKES) return void socket.destroy()
  pendingHandshakes++
  socket.setNoDelay(true)
  socket.setKeepAlive(true, 5000)
  socket.on('error', () => undefined)
  void runHostHandshake(socket, address, policy).finally(() => pendingHandshakes--)
}

// ── listener, discovery, relay ──────────────────────────────────────────────

const stopServer = (): void => {
  server?.close()
  server = null
  serverStatus = { ...serverStatus, listening: false, port: 0 }
}

const startServer = (port: number): void => {
  stopServer()
  const next = createServer(socket => onIncomingSocket(socket, (socket.remoteAddress ?? '?').replace(/^::ffff:/, '')))
  server = next
  next.on('error', error => {
    const code = (error as NodeJS.ErrnoException).code
    serverStatus = { ...serverStatus, listening: false, error: code === 'EADDRINUSE' ? `Port ${port} is in use by another program. Choose another port in Settings.` : error.message }
    logger.error('[remote] listener failed', error)
    notify()
  })
  next.listen({ port, host: '::', ipv6Only: false }, () => {
    serverStatus = { ...serverStatus, listening: true, port, error: null }
    logger.info(`[remote] listening on ${port}`)
    notify()
  })
}

const applyNetwork = (): void => {
  const s = settings()
  if (s.enabled && (!server || serverStatus.port !== s.port)) startServer(s.port)
  if (!s.enabled && server) stopServer()

  // Discovery listens on the session port + 1: follow a port change.
  if (discovery && (!s.lanDiscovery || discoveryPort !== s.port + 1)) {
    discovery.stop()
    discovery = null
  }
  if (s.lanDiscovery) {
    if (!discovery) {
      discoveryPort = s.port + 1
      discovery = new Discovery(
        s.port + 1,
        () => {
          const id = store.identityInfo()
          // Announced in the old form so builds up to 0.1.5 still list this computer; newer ones read it as the 8-digit ID.
          return { id: legacyDeviceIdFromPublicKey(store.localIdentity().publicKey), name: id.name, os: id.os, platform: id.platform, port: settings().port, fp: id.fingerprint }
        },
        notify
      )
      discovery.start(s.enabled)
    } else discovery.setAnnounce(s.enabled)
  }

  const wantRelay = s.enabled ? relayInUse() : ''
  if (wantRelay !== relayAddress) {
    relayHost?.stop()
    relayHost = null
    relayAddress = wantRelay
    serverStatus = { ...serverStatus, relay: 'off', relayError: null }
    if (wantRelay) {
      relayHost = new RelayHost(wantRelay, () => store.localIdentity(), {
        onState: (state, error) => {
          serverStatus = { ...serverStatus, relay: state, relayError: error }
          notify()
        },
        onIncoming: (socket, from) => onIncomingSocket(socket, from)
      })
      relayHost.start()
    }
  }
  notify()
}

// ── connecting to another computer ──────────────────────────────────────────

const progress = (sender: WebContents, attemptId: string, stage: string, message: string, extra: Record<string, unknown> = {}): void => {
  if (!sender.isDestroyed()) sender.send(REMOTE_IPC.connectProgress, { attemptId, stage, message, ...extra })
}

const routesFor = (target: NonNullable<ReturnType<typeof parseConnectTarget>>): Route[] => {
  if (target.kind === 'address') return [{ kind: 'direct', host: target.host, port: target.port }]
  const routes: Route[] = []
  const found = discovery?.find(target.id)
  if (found) routes.push({ kind: 'direct', host: found.address, port: found.port })
  const saved = store.savedDevice(target.id)
  if (saved?.address && !routes.some(r => r.kind === 'direct' && r.host === saved.address)) routes.push({ kind: 'direct', host: saved.address, port: saved.port })
  const relay = relayInUse()
  if (relay) routes.push({ kind: 'relay', relay, deviceId: target.id })
  return routes
}

export const connect = async (request: ConnectRequest, sender: WebContents, attemptId: string): Promise<string> => {
  const target = parseConnectTarget(request.target, settings().port)
  if (!target) throw new Error('Enter the other computer’s 8-digit ID (for example 19304289).')
  if (target.kind === 'id' && target.id === store.localIdentity().id) throw new Error('That is this computer’s own ID.')
  const routes = routesFor(target)
  if (!routes.length) throw new Error(notReachableMessage(null))
  const abort = new AbortController()
  attempts.set(attemptId, abort)
  const expectedId = target.kind === 'id' ? target.id : undefined
  let lastError: Error | null = null
  try {
    for (const route of routes) {
      if (abort.signal.aborted) throw new RemoteError('cancelled', 'Cancelled.')
      progress(sender, attemptId, 'connecting', `Connecting via ${routeLabel(route)}…`)
      let socket: RelayConn
      try {
        // A stale LAN address should not hold up the relay behind it.
        socket = await dial(route, route.kind === 'direct' && routes.some(r => r.kind === 'relay') ? DIRECT_DIAL_TIMEOUT_MS : undefined)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        continue
      }
      const pinned = expectedId ? store.savedDevice(expectedId)?.fingerprint : undefined
      progress(sender, attemptId, 'authenticating', request.password ? 'Checking the password…' : 'Securing the connection…')
      try {
        const result = await runClientHandshake(socket, route.kind === 'direct' ? route.host : `relay:${route.relay}`, {
          identity: store.localIdentity(),
          purpose: 'connect',
          ...(expectedId ? { expectedId } : {}),
          ...(pinned ? { pinnedFingerprint: pinned } : {}),
          ...(request.password ? { password: request.password } : {}),
          signal: abort.signal,
          onHost: (host: HostInfo) => {
            const saved = store.savedDevice(host.id)
            if (saved && saved.fingerprint !== host.fingerprint) {
              throw new RemoteError('identity', 'This computer’s security key changed since your last connection. Remove it from Saved devices if it was reinstalled.')
            }
            if (!request.password && !host.attended) throw new RemoteError('not-accepting', `${host.name} only accepts connections with its unattended password.`)
          },
          onPending: info =>
            progress(sender, attemptId, 'waiting', 'Waiting for the person at the other computer to accept…', {
              verificationCode: info.verificationCode,
              expiresAt: Date.now() + info.expiresInMs
            })
        })
        const granted = result.granted
        if (!granted) throw new Error('The other computer did not start a session.')
        store.rememberDevice({
          id: result.host.id,
          name: result.host.name,
          os: result.host.os,
          address: route.kind === 'direct' ? route.host : (store.savedDevice(result.host.id)?.address ?? ''),
          port: route.kind === 'direct' ? route.port : settings().port,
          fingerprint: result.host.fingerprint,
          lastConnectedAt: Date.now()
        })
        const session = new ViewerSession(ctx, result.host, granted, result.channel, route)
        viewerSessions.set(session.id, session)
        session.start()
        history({
          direction: 'outgoing',
          event: 'connected',
          peerId: result.host.id,
          peerName: result.host.name,
          address: result.host.address,
          detail: `${granted.method === 'password' ? 'Unattended' : 'Accepted'} · ${granted.permission === 'control' ? 'full control' : 'view only'}${route.kind === 'relay' ? ' · via relay' : ''}`
        })
        progress(sender, attemptId, 'connected', `Connected to ${result.host.name}.`)
        return session.id
      } catch (error) {
        if (error instanceof RemoteError && error.code !== 'network') {
          history({ direction: 'outgoing', event: error.code === 'rejected' ? 'rejected' : 'failed', peerId: expectedId ?? '', peerName: '', address: routeLabel(route), detail: error.message })
          throw error
        }
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
    if (routes.every(r => r.kind === 'direct') && target.kind === 'id') throw new Error(notReachableMessage(routes[0]?.kind === 'direct' ? routes[0].host : null))
    throw lastError ?? new Error('Could not connect.')
  } finally {
    attempts.delete(attemptId)
  }
}

const subnetOf = (address: string): string | null => /^(\d+\.\d+\.\d+)\.\d+$/.exec(address)?.[1] ?? null

/**
 * Why a device ID could not be reached when only this network was tried —
 * naming the two networks when the computer was last seen on a different one,
 * because "no answer" alone sends people looking at the wrong thing.
 */
const notReachableMessage = (lastAddress: string | null): string => {
  const ours = store.lanAddresses()
  const theirNet = lastAddress ? subnetOf(lastAddress) : null
  const otherNetwork = theirNet !== null && !ours.some(a => subnetOf(a) === theirNet)
  const where = otherNetwork
    ? `It was last seen at ${lastAddress ?? ''}, on a different network from this computer (${ours.join(', ') || 'no network'}). `
    : 'It is not answering on this network. '
  return `${where}Check the app is open there with remote access on. To connect between different networks, the remote server must be set up (Remote Desktop → Settings → Network, or REMOTE_SERVER in shared/constants/remote.ts).`
}

export const cancelConnect = (attemptId: string): void => attempts.get(attemptId)?.abort()

/** Diagnostics: reach a computer and read its identity without authenticating. */
export const probe = async (input: string): Promise<{ id: string; name: string; os: string; fingerprint: string; attended: boolean; unattended: boolean; busy: boolean; route: string; ms: number }> => {
  const target = parseConnectTarget(input, settings().port)
  if (!target) throw new Error('Enter a device ID or an IP address.')
  const routes = routesFor(target)
  if (!routes.length) throw new Error('Not found on this network.')
  let lastError: unknown = null
  for (const route of routes) {
    const started = performance.now()
    try {
      const socket = await dial(route, 3000)
      const result = await runClientHandshake(socket, routeLabel(route), {
        identity: store.localIdentity(),
        purpose: 'probe',
        ...(target.kind === 'id' ? { expectedId: target.id } : {})
      })
      const h = result.host
      return { id: h.id, name: h.name, os: h.os, fingerprint: h.fingerprint, attended: h.attended, unattended: h.unattended, busy: h.busy, route: routeLabel(route), ms: Math.round(performance.now() - started) }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not reach it.')
}

// ── files ───────────────────────────────────────────────────────────────────

export const defaultTransferFolder = (): string => join(app.getPath('downloads'), 'Remote Transfers')

const decideIncomingFiles = async (link: TransferLink, files: { name: string; size: number }[]): Promise<string | null> => {
  const host = hostSessions.get(link.sessionId)
  const viewer = viewerSessions.get(link.sessionId)
  const total = files.reduce((n, f) => n + f.size, 0)
  const summary = `${files.length === 1 ? files[0]!.name : `${files.length} files`} (${(total / 1024 / 1024).toFixed(1)} MB)`
  let parent: BrowserWindow | null
  if (host) {
    const s = settings()
    // Writing to this computer's disk needs a full-control session.
    if (s.incomingFiles === 'off' || !host.canControl()) return null
    if (s.incomingFiles === 'trusted-folder') return s.trustedFolder || defaultTransferFolder()
    parent = hostBar
  } else if (viewer) {
    parent = viewer.window
  } else return null

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 120_000)
  try {
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Incoming files',
      message: `${link.peerName} wants to send you ${summary}.`,
      detail: files.slice(0, 10).map(f => `• ${f.name}`).join('\n') + (files.length > 10 ? `\n… and ${files.length - 10} more` : '') + '\n\nFiles are saved only; nothing is opened or run.',
      buttons: ['Save to Downloads', 'Choose folder…', 'Decline'],
      defaultId: 0,
      cancelId: 2,
      signal: abort.signal
    }
    const answer = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (answer.response === 0) return defaultTransferFolder()
    if (answer.response === 1) {
      const pick = await dialog.showOpenDialog({ title: 'Save incoming files to', defaultPath: defaultTransferFolder(), properties: ['openDirectory', 'createDirectory'] })
      return pick.canceled ? null : (pick.filePaths[0] ?? null)
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const sendFiles = async (sessionId: string, parent: BrowserWindow | null): Promise<void> => {
  const host = hostSessions.get(sessionId)
  const viewer = viewerSessions.get(sessionId)
  const session = host ?? viewer
  if (!session || session.state !== 'active') throw new Error('The session is not connected.')
  if (viewer && !viewer.fileTransfer) throw new Error('The other computer does not accept files.')
  if (viewer && viewer.permission !== 'control') throw new Error('Sending files needs a full-control session.')
  const options: Electron.OpenDialogOptions = { title: 'Send files', properties: ['openFile', 'multiSelections'] }
  const pick = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (pick.canceled || !pick.filePaths.length) return
  await transfers.send(transferLink(session), pick.filePaths)
}

export const cancelTransfer = (id: string): void => transfers.cancel(id)

// ── sessions (actions from the windows) ─────────────────────────────────────

export const hostSession = (id: string): HostSession | undefined => hostSessions.get(id)
export const viewerSession = (id: string): ViewerSession | undefined => viewerSessions.get(id)

export const hostSessionForEngine = (sender: WebContents): HostSession | undefined =>
  [...hostSessions.values()].find(s => s.engine && !s.engine.isDestroyed() && s.engine.webContents.id === sender.id)

export const viewerSessionForWindow = (sender: WebContents): ViewerSession | undefined =>
  [...viewerSessions.values()].find(s => s.window && !s.window.isDestroyed() && s.window.webContents.id === sender.id)

export const isHostBar = (sender: WebContents): boolean => !!hostBar && !hostBar.isDestroyed() && hostBar.webContents.id === sender.id

export const requestForWindow = (sender: WebContents): string | null => {
  for (const [id, entry] of requests) if (entry.window && !entry.window.isDestroyed() && entry.window.webContents.id === sender.id) return id
  return null
}

export const endIncoming = (id: string): void => hostSessions.get(id)?.end('The owner of this computer ended the session.')

export const endAllIncoming = (): void => {
  for (const s of hostSessions.values()) s.end('The owner of this computer ended the session.')
}

export const disconnectOutgoing = (id: string): void => viewerSessions.get(id)?.disconnect()

// ── settings & security ─────────────────────────────────────────────────────

export const updateSettings = (patch: Partial<RemoteSettings>): RemoteSettings => {
  const before = settings()
  const next = store.updateRemoteSettings(patch)
  if (next.controlDisabled !== before.controlDisabled) for (const s of hostSessions.values()) s.controlSettingChanged()
  if (before.enabled && !next.enabled) endAllIncoming()
  if (before.unattendedEnabled && !next.unattendedEnabled) {
    for (const s of hostSessions.values()) if (s.method === 'password') s.end('Unattended access was switched off.', 'revoked')
  }
  applyNetwork()
  notify()
  return next
}

export const setPassword = async (password: string): Promise<void> => {
  const problem = passwordProblem(password)
  if (problem) throw new Error(problem)
  const salt = store.newSalt()
  const verifier = await passwordVerifier(password, salt, DEFAULT_KDF)
  store.setUnattended({ salt: salt.toString('base64'), params: DEFAULT_KDF, verifier: verifier.toString('base64'), setAt: Date.now() })
  notify()
}

/** Removes the password: unattended access stops, and its sessions end. */
export const clearPassword = (): void => {
  store.setUnattended(null)
  store.updateRemoteSettings({ unattendedEnabled: false })
  for (const s of hostSessions.values()) if (s.method === 'password') s.end('Unattended access was revoked.', 'revoked')
  notify()
}

export const revokeDevice = (id: string): void => {
  const known = store.authorizedDevices().find(d => d.id === id) ?? store.savedDevices().find(d => d.id === id)
  const session = [...hostSessions.values()].find(s => s.peer.id === id)
  store.blockDevice({ id, name: known?.name ?? session?.peer.name ?? id, fingerprint: known?.fingerprint ?? session?.peer.fingerprint ?? '' })
  for (const s of hostSessions.values()) if (s.peer.id === id) s.end('Access was revoked by the owner.', 'revoked')
  history({ direction: 'incoming', event: 'revoked', peerId: id, peerName: known?.name ?? '', address: '', detail: 'Device blocked.' })
  notify()
}

/** Revoke all unattended access: password removed, list cleared, sessions ended. */
export const revokeAll = (): void => {
  store.clearAuthorized()
  clearPassword()
  history({ direction: 'incoming', event: 'revoked', peerId: '', peerName: '', address: '', detail: 'All unattended access revoked.' })
}

export const refreshDiscovery = (): void => {
  discovery?.query()
  void refreshPermissions()
}

export const diagnostics = async (): Promise<Record<string, unknown>> => {
  await refreshPermissions()
  const s = settings()
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: `${process.platform} ${process.arch}`,
    os: store.identityInfo().os,
    listening: serverStatus.listening ? `TCP ${serverStatus.port} on all interfaces` : `not listening${serverStatus.error ? ` (${serverStatus.error})` : ''}`,
    discovery: s.lanDiscovery ? `UDP ${s.port + 1} — ${discovery?.list().length ?? 0} device(s) seen` : 'off',
    relay: relayInUse() ? `${relayInUse()}${s.relay ? '' : ' (built in)'} — ${serverStatus.relay}${serverStatus.relayError ? ` (${serverStatus.relayError})` : ''}` : 'not configured (same network only)',
    turn: s.turnUrl || (REMOTE_SERVER.turn ? `${REMOTE_SERVER.turn.urls.join(', ')} (built in)` : 'none'),
    stun: s.turnUrl ? '—' : REMOTE_SERVER.stun.join(', ') || 'none',
    addresses: store.lanAddresses(),
    screenPermission: permissions.screen,
    inputPermission: `${permissions.input}${permissions.inputDetail ? ` — ${permissions.inputDetail}` : ''}`,
    secretsEncrypted: store.encryptionAvailable(),
    displays: screen.getAllDisplays().map(d => `${d.size.width}×${d.size.height} @${d.scaleFactor}x`)
  }
}

// ── lock screen ─────────────────────────────────────────────────────────────

const setHostLocked = (locked: boolean): void => {
  if (locked === hostLocked) return
  hostLocked = locked
  logger.info(`[remote] screen ${locked ? 'locked' : 'unlocked'}`)
  for (const s of hostSessions.values()) s.setLocked(locked)
  notify()
}

const recaptureAll = (): void => {
  for (const s of hostSessions.values()) s.recapture()
}

let recaptureTimer: NodeJS.Timeout | null = null
const recaptureSoon = (): void => {
  if (recaptureTimer) clearTimeout(recaptureTimer)
  recaptureTimer = setTimeout(recaptureAll, 1000)
}

/** The Windows agent knows the real lock state (also when the app started while locked). */
const pollAgent = async (): Promise<void> => {
  const before = secure.agentState()
  const { locked } = await secure.refresh()
  if (locked !== null) setHostLocked(locked)
  if (secure.agentState() !== before) notify()
}

export const installSecureAgent = async (): Promise<void> => {
  await secure.install()
  history({ direction: 'incoming', event: 'permission', peerId: '', peerName: '', address: '', detail: 'Lock screen access (Windows agent) installed.' })
  notify()
}

export const removeSecureAgent = async (): Promise<void> => {
  await secure.uninstall()
  history({ direction: 'incoming', event: 'permission', peerId: '', peerName: '', address: '', detail: 'Lock screen access (Windows agent) removed.' })
  notify()
}

export const requestInputPermission = (): void => {
  injector.requestPermission()
  setTimeout(() => void refreshPermissions(), 1500)
}

export { history as appendHistory }

// ── lifecycle ───────────────────────────────────────────────────────────────

/** Before app ready: make WebRTC put real LAN addresses in its candidates (mDNS names often do not resolve between office PCs). */
export const configureRemoteBeforeReady = (): void => {
  const existing = app.commandLine.getSwitchValue('disable-features')
  app.commandLine.appendSwitch('disable-features', [existing, 'WebRtcHideLocalIpsWithMdns'].filter(Boolean).join(','))
}

export const startRemoteDesktop = (): void => {
  try {
    store.localIdentity()
  } catch (error) {
    logger.error('[remote] could not load the device identity', error)
    return
  }
  applyNetwork()
  void refreshPermissions()
  screen.on('display-added', notifyDisplays)
  screen.on('display-removed', notifyDisplays)
  // Another remote tool closing, a resolution change, sleep / wake: capture may have stopped.
  screen.on('display-metrics-changed', recaptureSoon)
  powerMonitor.on('resume', recaptureSoon)
  powerMonitor.on('lock-screen', () => setHostLocked(true))
  powerMonitor.on('unlock-screen', () => setHostLocked(false))
  if (process.platform === 'win32') {
    void pollAgent()
    lockPoll = setInterval(() => void pollAgent(), 2000)
  }
}

const notifyDisplays = (): void => {
  for (const s of hostSessions.values()) if (s.state === 'active') s.engineState({ kind: 'display', id: s.displayId })
  recaptureSoon()
}

export const stopRemoteDesktop = (): void => {
  for (const s of hostSessions.values()) s.end('The app on that computer was closed.')
  for (const v of viewerSessions.values()) v.disconnect()
  for (const r of requests.values()) r.resolve(null)
  relayHost?.stop()
  discovery?.stop()
  stopServer()
  injector.stop()
  if (lockPoll) clearInterval(lockPoll)
  secure.close()
  if (awakeBlocker !== null) powerSaveBlocker.stop(awakeBlocker)
  awakeBlocker = null
}
