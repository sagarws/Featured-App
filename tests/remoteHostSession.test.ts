import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The host's session rules, with Electron replaced by small fakes and the
 * clock faked: time limits, warnings, permissions and revocation are enforced
 * by HostSession in the main process, whatever the viewer does.
 */

const clip = vi.hoisted(() => ({ text: 'before the session' }))
vi.mock('electron', () => ({
  clipboard: { readText: () => clip.text, writeText: (t: string) => (clip.text = t) },
  Notification: class {
    show(): void {}
  },
  screen: {
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 })
  }
}))
vi.mock('../electron/main/recorder/capture', () => ({
  listDisplays: () => [{ id: '1', label: 'Display 1', primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
  armDisplayRequest: vi.fn()
}))
const engines = vi.hoisted(() => [] as { destroyed: boolean; sent: unknown[] }[])
vi.mock('../electron/main/remote/windows', () => ({
  createHostEngineWindow: () => {
    const win = Object.assign(new EventEmitter(), {
      destroyed: false,
      sent: [] as unknown[],
      isDestroyed() {
        return this.destroyed
      },
      destroy() {
        this.destroyed = true
      },
      webContents: { send: (_channel: string, payload: unknown) => win.sent.push(payload) }
    })
    engines.push(win)
    return win
  }
}))

import { HostSession } from '../electron/main/remote/hostSession'
import type { RemoteContext } from '../electron/main/remote/context'
import type { Channel } from '../electron/main/remote/core/channel'
import type { PeerInfo } from '../electron/main/remote/core/handshake'
import { defaultRemoteSettings } from '../shared/utils/remote'
import type { RemoteSettings, SessionMinutes } from '../shared/types/remote'

class FakeChannel extends EventEmitter {
  sent: Record<string, unknown>[] = []
  closed = false
  get lastReceivedAt(): number {
    return Date.now()
  }
  send(msg: Record<string, unknown>): boolean {
    this.sent.push(msg)
    return true
  }
  closeAfter(msg: Record<string, unknown>): void {
    this.sent.push(msg)
    this.close()
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
  startPushMode(): void {}
  /** Something the viewer sent. */
  deliver(msg: Record<string, unknown>): void {
    this.emit('message', { msg, binary: null })
  }
  of(t: string): Record<string, unknown>[] {
    return this.sent.filter(m => m['t'] === t)
  }
}

const peer: PeerInfo = { id: 'WD-111-222-333', name: 'Office PC 2', os: 'Windows 11', platform: 'win32', publicKey: Buffer.alloc(0), fingerprint: 'FP', address: '10.0.0.2' }

let settings: RemoteSettings
let ctx: RemoteContext
let ended: HostSession[]
let inject: ReturnType<typeof vi.fn>
let releaseAll: ReturnType<typeof vi.fn>
let history: ReturnType<typeof vi.fn>
let secureInject: ReturnType<typeof vi.fn>
let secureSas: ReturnType<typeof vi.fn>
let agentRunning: boolean
let lockedAtStart: boolean

const start = (permission: 'control' | 'view', minutes: SessionMinutes) => {
  const channel = new FakeChannel()
  const session = new HostSession(ctx, peer, 'attended', permission, minutes, channel as unknown as Channel)
  session.start()
  return { session, channel }
}

const click = { k: 'md', b: 0, x: 0.5, y: 0.5 } as const

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-20T09:00:00Z'))
  settings = defaultRemoteSettings()
  ended = []
  engines.length = 0
  inject = vi.fn()
  releaseAll = vi.fn()
  history = vi.fn()
  secureInject = vi.fn()
  secureSas = vi.fn()
  agentRunning = true
  lockedAtStart = false
  ctx = {
    settings: () => settings,
    iceServers: () => [],
    notify: vi.fn(),
    history,
    injector: {
      inject,
      releaseAll,
      current: () => ({ state: 'granted', detail: null }),
      check: () => Promise.resolve({ state: 'granted', detail: null })
    },
    secure: {
      available: () => agentRunning,
      inject: secureInject,
      sendCtrlAltDel: secureSas,
      releaseAll: vi.fn(),
      frame: () => Promise.resolve({ width: 1920, height: 1080, jpeg: Buffer.from('jpeg') })
    },
    hostLocked: () => lockedAtStart,
    transfers: { handle: () => false, endSession: vi.fn() },
    transferLink: () => ({ sessionId: '', channel: () => null, peerName: '' }),
    hostSessionEnded: (s: HostSession) => ended.push(s),
    viewerSessionEnded: vi.fn()
  } as unknown as RemoteContext
})

afterEach(() => {
  vi.useRealTimers()
})

describe('time limit (enforced on the host)', () => {
  it('defaults to 30 minutes, warns 5 minutes before, then disconnects', () => {
    const { session, channel } = start('control', settings.defaultMinutes)
    expect(settings.defaultMinutes).toBe(30)
    expect(session.expiresAt).toBe(Date.now() + 30 * 60_000)

    vi.advanceTimersByTime(24 * 60_000)
    expect(channel.of('warning')).toHaveLength(0)
    vi.advanceTimersByTime(60_000 + 1000)
    expect(channel.of('warning')).toHaveLength(1)
    session.inject([click])
    expect(inject).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5 * 60_000)
    expect(session.state).toBe('ended')
    expect(channel.of('end')[0]?.['reason']).toMatch(/time is over/)
    expect(ended).toContain(session)
    expect(engines[0]?.destroyed).toBe(true)
    expect(releaseAll).toHaveBeenCalled()
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ event: 'expired' }))

    // Nothing gets through afterwards, whatever the viewer sends.
    session.inject([click])
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('refuses input in the last instant even before the timer fires', () => {
    const { session } = start('control', 5)
    vi.setSystemTime(Date.now() + 5 * 60_000)
    session.inject([click])
    expect(inject).not.toHaveBeenCalled()
  })

  it('unlimited sessions never expire on time', () => {
    const { session, channel } = start('control', 0)
    expect(session.expiresAt).toBeNull()
    vi.advanceTimersByTime(10 * 3600_000)
    expect(session.state).toBe('active')
    expect(channel.of('warning')).toHaveLength(0)
    session.inject([click])
    expect(inject).toHaveBeenCalled()
  })

  it('the owner can extend, or remove the limit', () => {
    const { session, channel } = start('control', 15)
    vi.advanceTimersByTime(12 * 60_000)
    session.extend(30)
    expect(session.expiresAt).toBe(new Date('2026-11-20T09:00:00Z').getTime() + 45 * 60_000)
    expect(channel.of('timer')).toHaveLength(1)
    vi.advanceTimersByTime(20 * 60_000)
    expect(session.state).toBe('active')
    session.extend(0)
    expect(session.expiresAt).toBeNull()
    vi.advanceTimersByTime(5 * 3600_000)
    expect(session.state).toBe('active')
  })
})

describe('permissions (enforced on the host)', () => {
  it('a view-only session cannot inject input or write the clipboard', () => {
    const { session, channel } = start('view', 30)
    session.inject([click, { k: 'kd', c: 'KeyA' }])
    channel.deliver({ t: 'clipboard', text: 'from viewer' })
    expect(inject).not.toHaveBeenCalled()
    expect(clip.text).toBe('before the session')
  })

  it('full control injects and may write the clipboard', () => {
    const { session, channel } = start('control', 30)
    session.inject([click])
    channel.deliver({ t: 'clipboard', text: 'from viewer' })
    expect(inject).toHaveBeenCalledTimes(1)
    expect(clip.text).toBe('from viewer')
  })

  it('the owner switching to view only stops input at once', () => {
    const { session, channel } = start('control', 30)
    session.setPermission('view')
    expect(releaseAll).toHaveBeenCalled()
    expect(channel.of('permission')[0]?.['permission']).toBe('view')
    session.inject([click])
    expect(inject).not.toHaveBeenCalled()
  })

  it('the "disable remote control" kill switch overrides every session', () => {
    const { session } = start('control', 30)
    settings = { ...settings, controlDisabled: true }
    session.controlSettingChanged()
    session.inject([click])
    expect(inject).not.toHaveBeenCalled()
    expect(session.inputProblem()).toMatch(/switched remote control off/)
  })

  it('does not send the clipboard that was there before the session', () => {
    const { channel } = start('control', 30)
    vi.advanceTimersByTime(3000)
    expect(channel.of('clipboard')).toHaveLength(0)
    clip.text = 'copied on the host'
    vi.advanceTimersByTime(1000)
    expect(channel.of('clipboard')[0]?.['text']).toBe('copied on the host')
  })
})

describe('disconnect, revoke and reconnect', () => {
  it('the owner can disconnect immediately', () => {
    const { session, channel } = start('control', 0)
    session.end('The owner of this computer ended the session.')
    expect(channel.closed).toBe(true)
    expect(channel.of('end')).toHaveLength(1)
    expect(session.state).toBe('ended')
    session.inject([click])
    expect(inject).not.toHaveBeenCalled()
  })

  it('the viewer leaving ends the session', () => {
    const { session, channel } = start('control', 30)
    channel.deliver({ t: 'bye' })
    expect(session.state).toBe('ended')
  })

  it('a dropped link pauses input and ends after 30 s without a resume', () => {
    const { session, channel } = start('control', 30)
    channel.close()
    expect(session.state).toBe('reconnecting')
    session.inject([click])
    expect(inject).not.toHaveBeenCalled()
    vi.advanceTimersByTime(30_000)
    expect(session.state).toBe('ended')
  })

  it('a resumed session keeps the permission as it is now (a revoked control stays revoked)', () => {
    const { session, channel } = start('control', 30)
    session.setPermission('view')
    channel.close()
    const again = new FakeChannel()
    session.resume(again as unknown as Channel)
    expect(session.state).toBe('active')
    expect(session.resumeExtra()['permission']).toBe('view')
    session.inject([click])
    expect(inject).not.toHaveBeenCalled()
  })

  it('a resumed session keeps its original deadline', () => {
    const { session, channel } = start('control', 10)
    const deadline = session.expiresAt
    vi.advanceTimersByTime(5 * 60_000)
    channel.close()
    session.resume(new FakeChannel() as unknown as Channel)
    expect(session.expiresAt).toBe(deadline)
    vi.advanceTimersByTime(5 * 60_000 + 1000)
    expect(session.state).toBe('ended')
  })

  it('notices within 8 s that the controller is gone (closed / crashed / asleep)', () => {
    const channel = new FakeChannel()
    const last = Date.now()
    Object.defineProperty(channel, 'lastReceivedAt', { get: () => last })
    const session = new HostSession(ctx, peer, 'password', 'control', 30, channel as unknown as Channel)
    session.start()
    vi.advanceTimersByTime(7000)
    expect(session.state).toBe('active')
    expect(channel.of('ping').length).toBeGreaterThanOrEqual(3)
    vi.advanceTimersByTime(2000)
    expect(session.state).toBe('reconnecting')
  })

  it('a silent link (no keepalive for 20 s) is treated as dropped', () => {
    const channel = new FakeChannel()
    let last = Date.now()
    Object.defineProperty(channel, 'lastReceivedAt', { get: () => last })
    const session = new HostSession(ctx, peer, 'password', 'control', 30, channel as unknown as Channel)
    session.start()
    vi.advanceTimersByTime(10_000)
    last = Date.now()
    vi.advanceTimersByTime(21_000)
    expect(session.state).toBe('reconnecting')
  })
})

describe('lock screen (enforced on the host)', () => {
  it('while locked, input goes to the lock-screen agent only, and the viewer is told', () => {
    const { session, channel } = start('control', 30)
    session.setLocked(true)
    expect(channel.of('locked')[0]).toMatchObject({ locked: true, secure: true })
    session.inject([click, { k: 'kd', c: 'KeyA' }])
    expect(inject).not.toHaveBeenCalled()
    expect(secureInject).toHaveBeenCalledTimes(2)
    channel.deliver({ t: 'secure-sas' })
    expect(secureSas).toHaveBeenCalledTimes(1)
  })

  it('streams the lock screen while locked', async () => {
    const { session, channel } = start('control', 30)
    session.setLocked(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(channel.of('secure-frame')[0]).toMatchObject({ width: 1920, height: 1080 })
    // Unchanged pictures are not sent again for 2 s.
    await vi.advanceTimersByTimeAsync(1000)
    expect(channel.of('secure-frame')).toHaveLength(1)
  })

  it('a view-only session cannot type on the lock screen or press Ctrl+Alt+Delete', () => {
    const { session, channel } = start('view', 30)
    session.setLocked(true)
    session.inject([click])
    channel.deliver({ t: 'secure-sas' })
    expect(secureInject).not.toHaveBeenCalled()
    expect(secureSas).not.toHaveBeenCalled()
  })

  it('without the agent, locked input is dropped (not sent to the normal helper)', () => {
    agentRunning = false
    const { session, channel } = start('control', 30)
    session.setLocked(true)
    expect(channel.of('locked')[0]).toMatchObject({ locked: true, secure: false })
    session.inject([click])
    expect(inject).not.toHaveBeenCalled()
    expect(secureInject).not.toHaveBeenCalled()
  })

  it('unlocking restarts screen capture and returns to normal input', () => {
    const { session, channel } = start('control', 30)
    session.setLocked(true)
    session.setLocked(false)
    expect(channel.of('locked')[1]).toMatchObject({ locked: false })
    expect(engines[0]?.sent).toContainEqual({ type: 'recapture' })
    session.inject([click])
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('knows the computer was already locked when the session started', () => {
    lockedAtStart = true
    const { session } = start('control', 30)
    expect(session.locked).toBe(true)
    expect(session.extra()['locked']).toBe(true)
  })

  it('the time limit still applies on the lock screen', () => {
    const { session } = start('control', 5)
    session.setLocked(true)
    vi.advanceTimersByTime(5 * 60_000 + 1000)
    expect(session.state).toBe('ended')
    session.inject([click])
    expect(secureInject).not.toHaveBeenCalled()
  })
})
