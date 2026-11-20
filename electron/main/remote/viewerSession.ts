import { clipboard, type BrowserWindow } from 'electron'
import { REMOTE_IPC } from '@shared/constants/channels'
import { MAX_CLIPBOARD_CHARS, RESUME_WINDOW_MS } from '@shared/constants/remote'
import type { QualityPreset, QualityPriority, RemoteDisplay, RemotePermission, RemoteSessionInfo, SignalMessage, ViewerConfig } from '@shared/types/remote'
import type { Channel, Received, WireMessage } from './core/channel'
import { runClientHandshake, type HostInfo, type Granted } from './core/handshake'
import type { RemoteContext } from './context'
import { dial, type Route } from './dial'
import { parseSignal } from './signal'
import { localIdentity, platform } from './store'
import { createViewerWindow } from './windows'

/*
 * One outgoing session, on the computer doing the controlling: the encrypted
 * channel to the host, the viewer window, and reconnecting with the session
 * token when the network drops (for as long as the host keeps the session).
 */

const parseDisplays = (raw: unknown): RemoteDisplay[] =>
  Array.isArray(raw)
    ? raw
        .slice(0, 16)
        .map(d => d as Record<string, unknown>)
        .filter(d => typeof d['id'] === 'string')
        .map(d => ({
          id: String(d['id']).slice(0, 64),
          label: (typeof d['label'] === 'string' ? d['label'] : 'Display').slice(0, 64),
          primary: d['primary'] === true,
          width: Number(d['width']) || 0,
          height: Number(d['height']) || 0,
          scaleFactor: Number(d['scaleFactor']) || 1
        }))
    : []

export class ViewerSession {
  readonly id: string
  readonly method: 'password' | 'attended'
  readonly startedAt = Date.now()
  state: 'active' | 'reconnecting' | 'ended' = 'active'
  permission: RemotePermission
  expiresAt: number | null
  displays: RemoteDisplay[]
  displayId: string
  quality: QualityPreset
  priority: QualityPriority
  clipboardAllowed: boolean
  fileTransfer: boolean
  inputProblem: string | null
  window: BrowserWindow | null = null
  endReason: string | null = null
  /** The remote area has keyboard focus: intercept shortcuts for it. */
  capture = false
  private channel: Channel | null
  private resumeToken: Buffer
  private queue: SignalMessage[] = []
  private windowReady = false
  private ticker: NodeJS.Timeout | null = null
  private ticks = 0
  private lastClipboard = ''

  constructor(
    private readonly ctx: RemoteContext,
    readonly host: HostInfo,
    granted: Granted,
    channel: Channel,
    readonly route: Route
  ) {
    this.id = granted.sessionId
    this.method = granted.method === 'password' ? 'password' : 'attended'
    this.channel = channel
    this.resumeToken = granted.resumeToken
    this.permission = granted.permission
    this.expiresAt = granted.expiresInMs === null ? null : Date.now() + granted.expiresInMs
    this.displays = parseDisplays(granted.raw['displays'])
    this.displayId = typeof granted.raw['displayId'] === 'string' ? granted.raw['displayId'] : (this.displays[0]?.id ?? '')
    this.clipboardAllowed = granted.raw['clipboard'] === true
    this.fileTransfer = granted.raw['fileTransfer'] === true
    this.inputProblem = typeof granted.raw['inputProblem'] === 'string' ? granted.raw['inputProblem'] : null
    const settings = ctx.settings()
    this.quality = settings.defaultQuality
    this.priority = settings.priority
  }

  start(): void {
    this.lastClipboard = readClipboard()
    this.attach(this.channel!)
    this.openWindow()
    this.ticker = setInterval(() => this.tick(), 1000)
    this.ctx.notify()
  }

  openWindow(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show()
      this.window.focus()
      return
    }
    const win = createViewerWindow(this.id, `${this.host.name} (${this.host.id}) — Remote Desktop`)
    this.window = win
    this.windowReady = false
    // Shortcuts that would act on this app (⌘W, ⌘Q, Ctrl+W, ⌘H…) go to the remote computer instead.
    win.webContents.on('before-input-event', (event, input) => {
      if (!this.capture || !this.ctx.settings().sendShortcuts || this.state !== 'active') return
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return
      event.preventDefault()
      win.webContents.send(REMOTE_IPC.viewerKey, {
        type: input.type === 'keyDown' ? 'down' : 'up',
        code: input.code,
        key: input.key,
        shift: input.shift,
        control: input.control,
        alt: input.alt,
        meta: input.meta,
        repeat: input.isAutoRepeat
      })
    })
    win.on('blur', () => {
      this.capture = false
    })
    // Closing the viewer ends the session.
    win.on('closed', () => {
      this.window = null
      if (this.state !== 'ended') this.disconnect()
    })
  }

  config(): ViewerConfig {
    const settings = this.ctx.settings()
    return {
      sessionId: this.id,
      peerId: this.host.id,
      peerName: this.host.name,
      peerPlatform: this.host.platform,
      viewerPlatform: platform(),
      permission: this.permission,
      expiresAt: this.expiresAt,
      displays: this.displays,
      displayId: this.displayId,
      quality: this.quality,
      priority: this.priority,
      keyboardMode: settings.keyboardMode,
      mapModifiers: settings.mapModifiers,
      sendShortcuts: settings.sendShortcuts,
      clipboard: this.clipboardAllowed && settings.clipboardSync,
      fileTransfer: this.fileTransfer,
      hardwareAcceleration: settings.hardwareAcceleration,
      iceServers: this.ctx.iceServers()
    }
  }

  private attach(channel: Channel): void {
    this.channel = channel
    channel.on('message', (item: Received) => this.onMessage(item))
    channel.once('close', () => {
      if (this.channel === channel) void this.reconnect()
    })
    channel.startPushMode()
  }

  send(msg: WireMessage, binary?: Buffer): boolean {
    return this.channel?.send(msg, binary) ?? false
  }

  currentChannel(): Channel | null {
    return this.channel
  }

  private event(payload: Record<string, unknown>): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(REMOTE_IPC.viewerEvent, payload)
  }

  private onMessage({ msg, binary }: Received): void {
    if (this.state === 'ended') return
    if (this.ctx.transfers.handle(this.ctx.transferLink(this), msg, binary)) return
    switch (msg.t) {
      case 'ping':
        return
      case 'signal': {
        const signal = parseSignal(msg['data'])
        if (!signal) return
        if (this.windowReady && this.window) this.window.webContents.send(REMOTE_IPC.viewerSignalIn, signal)
        else this.queue.push(signal)
        return
      }
      case 'timer': {
        const ms = msg['expiresInMs']
        this.expiresAt = typeof ms === 'number' && ms > 0 ? Date.now() + ms : null
        this.event({ type: 'timer', expiresAt: this.expiresAt })
        this.ctx.notify()
        return
      }
      case 'warning':
        this.event({ type: 'warning', remainingMs: Number(msg['remainingMs']) || 0 })
        return
      case 'permission':
        this.permission = msg['permission'] === 'control' ? 'control' : 'view'
        this.event({ type: 'permission', permission: this.permission })
        this.ctx.notify()
        return
      case 'input-status':
        this.inputProblem = typeof msg['problem'] === 'string' ? msg['problem'].slice(0, 300) : null
        this.event({ type: 'input-status', problem: this.inputProblem })
        return
      case 'displays':
        this.displays = parseDisplays(msg['displays'])
        if (typeof msg['current'] === 'string') this.displayId = msg['current']
        this.event({ type: 'displays', displays: this.displays, current: this.displayId })
        return
      case 'notice':
        this.event({ type: 'notice', message: (typeof msg['message'] === 'string' ? msg['message'] : '').slice(0, 300) })
        return
      case 'clipboard': {
        if (!this.clipboardAllowed || !this.ctx.settings().clipboardSync) return
        const text = typeof msg['text'] === 'string' ? msg['text'] : ''
        if (!text || text.length > MAX_CLIPBOARD_CHARS) return
        this.lastClipboard = text
        clipboard.writeText(text)
        this.event({ type: 'clipboard', chars: text.length })
        return
      }
      case 'end':
        return this.end(typeof msg['reason'] === 'string' ? msg['reason'].slice(0, 300) : 'The other computer ended the session.', false)
      default:
        return
    }
  }

  // ── from the viewer window ──

  viewerReady(): void {
    this.windowReady = true
    const pending = this.queue
    this.queue = []
    for (const signal of pending) this.window?.webContents.send(REMOTE_IPC.viewerSignalIn, signal)
    this.send({ t: 'viewer-ready' })
  }

  /** The viewer's WebRTC connection failed: ask the host for a fresh one. */
  restartMedia(): void {
    this.send({ t: 'viewer-ready' })
  }

  signal(signal: SignalMessage): void {
    this.send({ t: 'signal', data: signal })
  }

  setQuality(preset: QualityPreset, priority: QualityPriority): void {
    this.quality = preset
    this.priority = priority
    this.send({ t: 'quality', preset, priority })
  }

  setDisplay(id: string): void {
    if (this.displays.some(d => d.id === id)) this.send({ t: 'display', id })
  }

  /** Push this computer's clipboard to the host now. */
  sendClipboard(): boolean {
    if (!this.clipboardAllowed || this.permission !== 'control') return false
    const text = readClipboard()
    if (!text || text.length > MAX_CLIPBOARD_CHARS) return false
    this.lastClipboard = text
    return this.send({ t: 'clipboard', text })
  }

  private tick(): void {
    if (this.state !== 'active' || !this.channel) return
    this.ticks++
    if (this.ticks % 5 === 0) this.send({ t: 'ping' })
    if (Date.now() - this.channel.lastReceivedAt > 20_000) {
      this.channel.close('No answer from the other computer.')
      return
    }
    // Local copies go to the host while the viewer has focus (that is when you are about to paste there).
    if (this.clipboardAllowed && this.permission === 'control' && this.ctx.settings().clipboardSync && this.window?.isFocused()) {
      const text = readClipboard()
      if (text && text !== this.lastClipboard && text.length <= MAX_CLIPBOARD_CHARS) {
        this.lastClipboard = text
        this.send({ t: 'clipboard', text })
      }
    }
  }

  // ── reconnect ──

  private async reconnect(): Promise<void> {
    if (this.state !== 'active') return
    this.state = 'reconnecting'
    this.channel = null
    this.event({ type: 'reconnecting' })
    this.ctx.notify()
    const deadline = Date.now() + RESUME_WINDOW_MS
    while (Date.now() < deadline && this.state === 'reconnecting') {
      try {
        const socket = await dial(this.route, 3000)
        const result = await runClientHandshake(socket, this.host.address, {
          identity: localIdentity(),
          purpose: 'resume',
          expectedId: this.host.id,
          pinnedFingerprint: this.host.fingerprint,
          resume: { sessionId: this.id, token: this.resumeToken }
        })
        if (this.state !== 'reconnecting' || !result.granted) {
          result.channel.close()
          return
        }
        // The host's view of the permission wins: a control revoked meanwhile stays revoked.
        this.permission = result.granted.permission
        this.expiresAt = result.granted.expiresInMs === null ? null : Date.now() + result.granted.expiresInMs
        this.resumeToken = result.granted.resumeToken
        this.state = 'active'
        this.attach(result.channel)
        this.event({ type: 'reconnected', permission: this.permission, expiresAt: this.expiresAt })
        this.ctx.history({ direction: 'outgoing', event: 'reconnected', peerId: this.host.id, peerName: this.host.name, address: this.host.address, detail: '' })
        this.ctx.notify()
        return
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code && code !== 'network' && code !== 'timeout') {
          return this.end(error instanceof Error ? error.message : 'The session could not be resumed.', false)
        }
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
    }
    if (this.state === 'reconnecting') this.end('The connection was lost and could not be restored.', false)
  }

  disconnect(): void {
    if (this.state === 'ended') return
    this.channel?.closeAfter({ t: 'bye' })
    this.channel = null
    this.end('You disconnected.', false)
  }

  end(reason: string, notifyHost = true): void {
    if (this.state === 'ended') return
    this.state = 'ended'
    this.endReason = reason
    if (this.ticker) clearInterval(this.ticker)
    if (notifyHost) this.channel?.closeAfter({ t: 'bye' })
    else this.channel?.close('Ended.')
    this.channel = null
    this.capture = false
    this.event({ type: 'end', reason })
    this.ctx.transfers.endSession(this.id)
    this.ctx.history({ direction: 'outgoing', event: 'ended', peerId: this.host.id, peerName: this.host.name, address: this.host.address, detail: reason })
    this.ctx.viewerSessionEnded(this)
  }

  info(): RemoteSessionInfo {
    return {
      sessionId: this.id,
      direction: 'outgoing',
      peerId: this.host.id,
      peerName: this.host.name,
      peerOs: this.host.os,
      peerPlatform: this.host.platform,
      address: this.host.address,
      permission: this.permission,
      method: this.method,
      state: this.state,
      startedAt: this.startedAt,
      expiresAt: this.expiresAt,
      viaRelay: this.route.kind === 'relay',
      inputProblem: this.inputProblem,
      clipboard: this.clipboardAllowed,
      fileTransfer: this.fileTransfer,
      ...(this.endReason ? { endReason: this.endReason } : {})
    }
  }
}

const readClipboard = (): string => {
  try {
    return clipboard.readText()
  } catch {
    return ''
  }
}
