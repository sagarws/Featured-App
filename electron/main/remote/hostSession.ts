import { createHash, randomBytes } from 'node:crypto'
import { clipboard, Notification, screen, type BrowserWindow } from 'electron'
import { REMOTE_IPC } from '@shared/constants/channels'
import { EXPIRY_WARNING_MS, KEEPALIVE_MS, LINK_TIMEOUT_MS, MAX_CLIPBOARD_CHARS, RESUME_WINDOW_MS } from '@shared/constants/remote'
import type { HistoryEvent, InputEvent, QualityPreset, RemoteDisplay, RemotePermission, RemoteSessionInfo, SessionMinutes, SignalMessage } from '@shared/types/remote'
import { minutesLabel, QUALITY_PRESETS } from '@shared/utils/remote'
import { armDisplayRequest, listDisplays } from '../recorder/capture'
import type { Channel, Received, WireMessage } from './core/channel'
import { randomToken } from './core/crypto'
import type { PeerInfo } from './core/handshake'
import { parseSignal } from './signal'
import type { RemoteContext } from './context'
import { createHostEngineWindow } from './windows'

/** Lock-screen pictures: fast for this long after input, else one per SECURE_IDLE_MS. */
const SECURE_ACTIVE_MS = 3000
const SECURE_IDLE_MS = 2000

/*
 * One incoming session, on the computer being controlled. Everything that
 * matters for safety is decided here, in the main process, not in any window:
 *
 *  - input is injected only while the session is active, not expired, has
 *    full-control permission, and the owner has not disabled control;
 *  - the time limit is a timer here; the viewer's countdown is only a display;
 *  - a dropped connection may be resumed for 30 s with the session's secret
 *    token, with the permission as it is *now* (a revoked control stays revoked);
 *  - ending, revoking, or the owner's Stop closes the channel and destroys the
 *    capture window, so the stream and the input stop at once.
 */

export const remoteDisplays = (): RemoteDisplay[] =>
  listDisplays().map(d => ({
    id: d.id,
    label: d.label,
    primary: d.primary,
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor),
    scaleFactor: d.scaleFactor
  }))

export class HostSession {
  readonly id = randomBytes(16).toString('hex')
  readonly resumeToken = randomToken()
  readonly startedAt = Date.now()
  state: 'active' | 'reconnecting' | 'ended' = 'active'
  expiresAt: number | null
  displayId: string
  quality: QualityPreset
  channel: Channel | null = null
  engine: BrowserWindow | null = null
  endReason: string | null = null
  /** This computer is locked: input and pictures go through the lock-screen agent. */
  locked = false
  private secureTimer: NodeJS.Timeout | null = null
  private secureBusy = false
  private lastSecureHash = ''
  private lastSecureAt = 0
  /** Last input onto the lock screen: pictures come fast for a few seconds after it. */
  private lastSecureInputAt = 0
  private ticker: NodeJS.Timeout | null = null
  private resumeTimer: NodeJS.Timeout | null = null
  private lastClipboard = ''
  private warned = false
  private engineReady = false
  private viewerReady = false
  private ticks = 0

  constructor(
    private readonly ctx: RemoteContext,
    readonly peer: PeerInfo,
    readonly method: 'password' | 'attended',
    public permission: RemotePermission,
    minutes: SessionMinutes,
    channel: Channel
  ) {
    this.expiresAt = minutes > 0 ? this.startedAt + minutes * 60_000 : null
    this.channel = channel
    const displays = remoteDisplays()
    this.displayId = (displays.find(d => d.primary) ?? displays[0])?.id ?? ''
    this.quality = ctx.settings().defaultQuality
  }

  /** Sent with 'granted'. */
  extra(): Record<string, unknown> {
    const settings = this.ctx.settings()
    return {
      displays: remoteDisplays(),
      displayId: this.displayId,
      clipboard: settings.clipboardSync,
      fileTransfer: settings.incomingFiles !== 'off',
      hostPlatform: process.platform,
      inputProblem: this.inputProblem(),
      locked: this.locked,
      secureAgent: this.ctx.secure.available()
    }
  }

  inputProblem(): string | null {
    if (this.ctx.settings().controlDisabled) return 'The owner has switched remote control off.'
    const input = this.ctx.injector.current()
    return input.state === 'denied' || input.state === 'unsupported' ? input.detail : null
  }

  /** Effective right to inject input right now. */
  canControl(): boolean {
    if (this.state !== 'active' || this.permission !== 'control') return false
    if (this.ctx.settings().controlDisabled) return false
    if (this.expiresAt !== null && Date.now() >= this.expiresAt) return false
    return true
  }

  /** Called once 'granted' went out. */
  start(): void {
    this.lastClipboard = safeReadClipboard()
    this.attach(this.channel!)
    this.engine = createHostEngineWindow(this.id)
    this.engine.on('closed', () => {
      this.engine = null
      if (this.state !== 'ended') this.end('Screen sharing stopped on this computer.')
    })
    this.ticker = setInterval(() => this.tick(), 1000)
    this.ctx.history({ direction: 'incoming', event: 'connected', peerId: this.peer.id, peerName: this.peer.name, address: this.peer.address, detail: `${this.method === 'password' ? 'Unattended' : 'Accepted'} · ${this.permission === 'control' ? 'full control' : 'view only'} · ${this.expiresAt ? minutesLabel(Math.round((this.expiresAt - this.startedAt) / 60_000) as SessionMinutes) : 'unlimited'}` })
    void this.ctx.injector.check().then(() => this.sendInputStatus())
    // Connecting to a computer that is already locked.
    if (this.ctx.hostLocked()) this.setLocked(true)
    this.ctx.notify()
  }

  private attach(channel: Channel): void {
    this.channel = channel
    channel.on('message', (item: Received) => this.onMessage(item))
    channel.once('close', () => {
      if (this.channel === channel) this.suspend()
    })
    channel.startPushMode()
  }

  private send(msg: WireMessage): void {
    this.channel?.send(msg)
  }

  private sendInputStatus(): void {
    this.send({ t: 'input-status', problem: this.inputProblem() })
  }

  private onMessage({ msg, binary }: Received): void {
    if (this.state === 'ended') return
    const link = this.ctx.transferLink(this)
    if (this.ctx.transfers.handle(link, msg, binary)) return
    switch (msg.t) {
      case 'ping':
        return
      case 'bye':
        return this.end('The viewer disconnected.')
      case 'viewer-ready':
        this.viewerReady = true
        return this.startEngine()
      case 'signal': {
        const signal = parseSignal(msg['data'])
        if (signal) this.engine?.webContents.send(REMOTE_IPC.engineSignalIn, signal)
        return
      }
      case 'quality': {
        const preset = msg['preset']
        if (!QUALITY_PRESETS.includes(preset as QualityPreset)) return
        this.quality = preset as QualityPreset
        this.engine?.webContents.send(REMOTE_IPC.engineCommand, { type: 'quality', preset: this.quality, priority: msg['priority'] === 'responsiveness' ? 'responsiveness' : 'readability' })
        return
      }
      case 'display': {
        const id = String(msg['id'])
        if (!remoteDisplays().some(d => d.id === id)) return
        this.engine?.webContents.send(REMOTE_IPC.engineCommand, { type: 'display', id })
        return
      }
      case 'secure-sas':
        // Ctrl+Alt+Delete on the lock screen (only there, only with control).
        if (this.locked && this.canControl()) this.ctx.secure.sendCtrlAltDel()
        return
      case 'clipboard': {
        // Writing this computer's clipboard is a form of control: full-control sessions only.
        if (!this.ctx.settings().clipboardSync || !this.canControl()) return
        const text = typeof msg['text'] === 'string' ? msg['text'] : ''
        if (!text || text.length > MAX_CLIPBOARD_CHARS) return
        this.lastClipboard = text
        clipboard.writeText(text)
        return
      }
      default:
        return
    }
  }

  // ── capture window ──

  engineLoaded(): void {
    this.engineReady = true
    this.startEngine()
  }

  private startEngine(): void {
    if (this.engineReady && this.viewerReady && this.state === 'active') {
      this.engine?.webContents.send(REMOTE_IPC.engineCommand, { type: 'start' })
    }
  }

  /** The capture window asks to capture `displayId` next (its getDisplayMedia is answered with it). */
  armCapture(displayId: string): boolean {
    if (!this.engine || this.state === 'ended' || !remoteDisplays().some(d => d.id === displayId)) return false
    armDisplayRequest(this.engine.webContents, displayId, false)
    return true
  }

  engineSignal(signal: SignalMessage): void {
    this.send({ t: 'signal', data: signal })
  }

  engineState(state: { kind: string; id?: string; message?: string }): void {
    if (state.kind === 'display' && state.id && remoteDisplays().some(d => d.id === state.id)) {
      this.displayId = state.id
      this.send({ t: 'displays', displays: remoteDisplays(), current: this.displayId })
      this.ctx.injector.releaseAll()
    } else if (state.kind === 'error' && state.message) {
      // Locked with lock-screen access: the normal capture is expected to fail
      // (the lock screen is sent as pictures instead), so no warning.
      if (this.locked && this.ctx.secure.available()) return
      this.send({ t: 'notice', message: state.message.slice(0, 300) })
    }
  }

  /** Input from the capture window's data channel. Dropped unless control is allowed right now. */
  inject(events: InputEvent[]): void {
    if (!this.canControl()) return
    if (this.locked) {
      // The normal helper cannot reach the lock screen; the SYSTEM agent can (Windows).
      if (this.ctx.secure.available()) {
        this.lastSecureInputAt = Date.now()
        for (const event of events) this.ctx.secure.inject(event)
      }
      return
    }
    const display = screen.getAllDisplays().find(d => String(d.id) === this.displayId) ?? screen.getPrimaryDisplay()
    for (const event of events) this.ctx.injector.inject(event, display)
  }

  // ── timers ──

  private tick(): void {
    if (this.state === 'ended') return
    this.ticks++
    const now = Date.now()
    if (this.expiresAt !== null) {
      const left = this.expiresAt - now
      if (left <= 0) return this.end('The session time is over.', 'expired')
      if (left <= EXPIRY_WARNING_MS && !this.warned) {
        this.warned = true
        this.send({ t: 'warning', remainingMs: left })
        new Notification({ title: 'Remote session ending soon', body: `${this.peer.name}'s session ends in ${Math.ceil(left / 60_000)} minutes. Extend it from the bar at the top of the screen.` }).show()
        this.ctx.notify()
      }
    }
    if (this.state !== 'active' || !this.channel) return
    // Keepalive: is the controller still there? Silence = it closed, crashed, slept or lost the network.
    if ((this.ticks * 1000) % KEEPALIVE_MS === 0) this.send({ t: 'ping' })
    if (now - this.channel.lastReceivedAt > LINK_TIMEOUT_MS) {
      this.channel.close('No answer from the viewer.')
      return
    }
    if (this.ctx.settings().clipboardSync) {
      const text = safeReadClipboard()
      if (text && text !== this.lastClipboard && text.length <= MAX_CLIPBOARD_CHARS) {
        this.lastClipboard = text
        this.send({ t: 'clipboard', text })
      }
    }
  }

  // ── reconnect ──

  private suspend(): void {
    if (this.state !== 'active') return
    this.state = 'reconnecting'
    this.channel = null
    this.ctx.injector.releaseAll()
    this.viewerReady = false
    this.ctx.notify()
    this.resumeTimer = setTimeout(() => this.end('The connection was lost.'), RESUME_WINDOW_MS)
  }

  /** The viewer came back with a valid proof (checked by the handshake). */
  resume(channel: Channel): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.resumeTimer = null
    this.state = 'active'
    channel.once('close', () => undefined)
    // (The handshake already wrote 'reconnected' to the history.)
    this.attach(channel)
    this.ctx.notify()
  }

  /** What the 'granted' message carries on a resume. */
  resumeExtra(): Record<string, unknown> {
    return { ...this.extra(), permission: this.permission }
  }

  // ── owner actions ──

  setPermission(permission: RemotePermission): void {
    if (this.state === 'ended' || permission === this.permission) return
    this.permission = permission
    if (permission === 'view') this.ctx.injector.releaseAll()
    this.send({ t: 'permission', permission })
    this.sendInputStatus()
    this.ctx.history({ direction: 'incoming', event: 'permission', peerId: this.peer.id, peerName: this.peer.name, address: this.peer.address, detail: permission === 'control' ? 'Full control allowed.' : 'Switched to view only.' })
    this.ctx.notify()
  }

  /** Owner extends the session: +minutes, or 0 = unlimited. */
  extend(minutes: SessionMinutes): void {
    if (this.state === 'ended') return
    this.expiresAt = minutes === 0 ? null : Math.max(this.expiresAt ?? Date.now(), Date.now()) + minutes * 60_000
    this.warned = false
    this.send({ t: 'timer', expiresInMs: this.expiresAt === null ? null : this.expiresAt - Date.now() })
    this.ctx.history({ direction: 'incoming', event: 'extended', peerId: this.peer.id, peerName: this.peer.name, address: this.peer.address, detail: minutes === 0 ? 'Now unlimited.' : `+${minutesLabel(minutes)}` })
    this.ctx.notify()
  }

  // ── lock screen ──

  /** The host's screen was locked or unlocked. */
  setLocked(locked: boolean): void {
    if (this.state === 'ended' || locked === this.locked) return
    this.locked = locked
    this.ctx.injector.releaseAll()
    this.ctx.secure.releaseAll()
    this.lastSecureHash = ''
    this.send({ t: 'locked', locked, secure: this.ctx.secure.available() })
    if (locked) {
      if (!this.secureTimer) this.secureTimer = setInterval(() => void this.pumpSecureFrame(), 250)
    } else {
      if (this.secureTimer) clearInterval(this.secureTimer)
      this.secureTimer = null
      // Screen capture often stops while Windows shows the lock screen: start it again.
      this.recapture()
    }
    this.ctx.notify()
  }

  /** Ask the capture window to restart screen capture (after unlock, resume, display change). */
  recapture(): void {
    if (this.state !== 'ended') this.engine?.webContents.send(REMOTE_IPC.engineCommand, { type: 'recapture' })
  }

  /**
   * A picture of the lock screen: 4 a second for 3 s after input (typing the
   * password, clicking), otherwise one every 2 s. The clock and the blinking
   * caret change every picture, so "only when changed" alone sent all of
   * them, and a phone (which decrypts each in JavaScript) fell seconds behind.
   */
  private async pumpSecureFrame(): Promise<void> {
    if (this.secureBusy || !this.locked || this.state !== 'active' || !this.channel || !this.ctx.secure.available()) return
    const now = Date.now()
    const active = now - this.lastSecureInputAt < SECURE_ACTIVE_MS
    if (!active && now - this.lastSecureAt < SECURE_IDLE_MS) return
    this.secureBusy = true
    try {
      // 1280 wide is plenty for a lock screen, and light enough for a phone
      // (it decrypts and decodes each picture in JavaScript; full-size
      // pictures 4 times a second made it lag).
      const frame = await this.ctx.secure.frame(1280, 55)
      if (!frame || !this.locked || !this.channel) return
      const hash = createHash('sha1').update(frame.jpeg).digest('hex')
      if (hash === this.lastSecureHash && Date.now() - this.lastSecureAt < SECURE_IDLE_MS) return
      this.lastSecureHash = hash
      this.lastSecureAt = Date.now()
      this.channel.send({ t: 'secure-frame', width: frame.width, height: frame.height }, frame.jpeg)
    } finally {
      this.secureBusy = false
    }
  }

  controlSettingChanged(): void {
    if (!this.canControl()) this.ctx.injector.releaseAll()
    this.sendInputStatus()
  }

  end(reason: string, event: HistoryEvent = 'ended'): void {
    if (this.state === 'ended') return
    this.state = 'ended'
    this.endReason = reason
    if (this.ticker) clearInterval(this.ticker)
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    if (this.secureTimer) clearInterval(this.secureTimer)
    this.secureTimer = null
    this.ctx.injector.releaseAll()
    if (this.locked) this.ctx.secure.releaseAll()
    this.channel?.closeAfter({ t: 'end', reason })
    this.channel = null
    const engine = this.engine
    this.engine = null
    if (engine && !engine.isDestroyed()) {
      engine.webContents.send(REMOTE_IPC.engineCommand, { type: 'stop' })
      setTimeout(() => !engine.isDestroyed() && engine.destroy(), 300)
    }
    this.ctx.transfers.endSession(this.id)
    this.ctx.history({ direction: 'incoming', event, peerId: this.peer.id, peerName: this.peer.name, address: this.peer.address, detail: reason })
    this.ctx.hostSessionEnded(this)
  }

  info(): RemoteSessionInfo {
    const settings = this.ctx.settings()
    return {
      sessionId: this.id,
      direction: 'incoming',
      peerId: this.peer.id,
      peerName: this.peer.name,
      peerOs: this.peer.os,
      peerPlatform: this.peer.platform,
      address: this.peer.address,
      permission: this.permission,
      method: this.method,
      state: this.state,
      startedAt: this.startedAt,
      expiresAt: this.expiresAt,
      viaRelay: this.peer.address.startsWith('relay:'),
      inputProblem: this.permission === 'control' ? this.inputProblem() : null,
      clipboard: settings.clipboardSync,
      fileTransfer: settings.incomingFiles !== 'off',
      locked: this.locked,
      ...(this.endReason ? { endReason: this.endReason } : {})
    }
  }
}

const safeReadClipboard = (): string => {
  try {
    return clipboard.readText()
  } catch {
    return ''
  }
}
