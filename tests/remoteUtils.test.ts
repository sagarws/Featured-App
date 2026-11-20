import { describe, expect, it, vi } from 'vitest'

vi.mock('../electron/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), path: () => null } }))

import { DEFAULT_REMOTE_PORT, QUALITY_PROFILES } from '../shared/constants/remote'
import {
  defaultRemoteSettings,
  encodingPlan,
  evenScale,
  formatRemaining,
  mapModifierCode,
  parseConnectTarget,
  parseDeviceId,
  parseInputEvent,
  passwordProblem,
  safeFileName,
  sanitiseRemoteSettings,
  uniqueName
} from '../shared/utils/remote'
import { toHostPoint } from '../electron/main/remote/input/geometry'
import { KEYMAP, keyFor } from '../electron/main/remote/input/keymap'
import { parseSignal } from '../electron/main/remote/signal'
import { parseAnnouncement } from '../electron/main/remote/discovery'
import { insideFolder } from '../electron/main/remote/transfers'

describe('remote settings', () => {
  it('is secure by default', () => {
    const s = defaultRemoteSettings()
    expect(s.unattendedEnabled).toBe(false)
    expect(s.defaultMinutes).toBe(30)
    expect(s.incomingFiles).toBe('ask')
    expect(s.relay).toBe('')
    expect(s.turnUrl).toBe('')
    expect(s.port).toBe(DEFAULT_REMOTE_PORT)
  })

  it('drops junk and keeps valid values', () => {
    const s = sanitiseRemoteSettings({
      defaultMinutes: 45,
      unattendedEnabled: 'yes',
      port: 80,
      relay: 'evil host:1',
      turnUrl: 'http://x',
      deviceName: 'Dev\u0000 PC\n',
      defaultQuality: 'high',
      incomingFiles: 'everything'
    })
    expect(s.defaultMinutes).toBe(30)
    expect(s.unattendedEnabled).toBe(false)
    expect(s.port).toBe(DEFAULT_REMOTE_PORT)
    expect(s.relay).toBe('')
    expect(s.turnUrl).toBe('')
    expect(s.deviceName).toBe('Dev PC')
    expect(s.defaultQuality).toBe('high')
    expect(s.incomingFiles).toBe('ask')
    expect(sanitiseRemoteSettings({ defaultMinutes: 0, relay: 'relay.example.com:47900', turnUrl: 'turn:turn.example.com:3478' })).toMatchObject({
      defaultMinutes: 0,
      relay: 'relay.example.com:47900',
      turnUrl: 'turn:turn.example.com:3478'
    })
  })
})

describe('device IDs and targets', () => {
  it('normalises the ways people type an ID', () => {
    expect(parseDeviceId('WD-123-456-789')).toBe('WD-123-456-789')
    expect(parseDeviceId('wd 123 456 789')).toBe('WD-123-456-789')
    expect(parseDeviceId('123456789')).toBe('WD-123-456-789')
    expect(parseDeviceId('12345678')).toBeNull()
  })

  it('takes an ID, an IP, or a host with a port', () => {
    expect(parseConnectTarget('123-456-789')).toEqual({ kind: 'id', id: 'WD-123-456-789' })
    expect(parseConnectTarget('192.168.1.20')).toEqual({ kind: 'address', host: '192.168.1.20', port: DEFAULT_REMOTE_PORT })
    expect(parseConnectTarget('dev-pc.local:5000')).toEqual({ kind: 'address', host: 'dev-pc.local', port: 5000 })
    expect(parseConnectTarget('[fe80::1]:47800')).toEqual({ kind: 'address', host: 'fe80::1', port: 47800 })
    expect(parseConnectTarget('a b')).toBeNull()
    expect(parseConnectTarget('host:99999')).toBeNull()
  })
})

describe('passwords', () => {
  it('rejects weak unattended passwords', () => {
    expect(passwordProblem('short')).toMatch(/at least/)
    expect(passwordProblem('aaaaaaaaaaaa')).toMatch(/repeat/)
    expect(passwordProblem('password123!')).toMatch(/easy/)
    expect(passwordProblem('abcdefgh')).toMatch(/12\+/)
    expect(passwordProblem('Office-Dev-9!')).toBeNull()
    expect(passwordProblem('a long passphrase for the office')).toBeNull()
  })
})

describe('session time', () => {
  it('formats a countdown', () => {
    expect(formatRemaining(30 * 60_000)).toBe('30:00')
    expect(formatRemaining(61_000)).toBe('1:01')
    expect(formatRemaining(3_725_000)).toBe('1:02:05')
    expect(formatRemaining(-5)).toBe('0:00')
  })
})

describe('quality profiles', () => {
  it('scales the stream to the profile height and caps fps / bitrate', () => {
    expect(encodingPlan('ultra-low', 3840, 2160)).toMatchObject({ width: 846, height: 476, maxFramerate: 12, maxBitrate: QUALITY_PROFILES['ultra-low'].maxBitrate })
    expect(encodingPlan('low', 2560, 1440)).toMatchObject({ width: 1280, height: 720 })
    expect(encodingPlan('balanced', 1920, 1080)).toMatchObject({ width: 1600, height: 900 })
    expect(encodingPlan('high', 1920, 1080)).toMatchObject({ scaleResolutionDownBy: 1, width: 1920, height: 1080 })
    expect(encodingPlan('high', 1280, 720).scaleResolutionDownBy).toBe(1)
    expect(encodingPlan('ultra', 3840, 2160).scaleResolutionDownBy).toBe(1)
  })

  it('always hands the encoder even sizes (hardware H.264 refuses odd ones)', () => {
    // The sizes that fell back to the software encoder on a real MacBook (3024×1964 Retina).
    // (Chromium fed the encoder 733×476 and 1663×1080 for these before: odd → software fallback.)
    expect(encodingPlan('ultra-low', 3024, 1964)).toMatchObject({ width: 714, height: 464 })
    expect(encodingPlan('high', 3024, 1964)).toMatchObject({ width: 1644, height: 1068 })
    for (const [w, h] of [[3024, 1964], [2560, 1600], [1920, 1200], [3440, 1440], [1366, 768], [2880, 1800], [5120, 2880], [1728, 1117]] as const) {
      for (const preset of ['ultra-low', 'low', 'balanced', 'high'] as const) {
        const plan = encodingPlan(preset, w, h)
        const outW = Math.floor(w / plan.scaleResolutionDownBy)
        const outH = Math.floor(h / plan.scaleResolutionDownBy)
        // Even whether Chromium floors or rounds.
        for (const n of [outW, outH, Math.round(w / plan.scaleResolutionDownBy), Math.round(h / plan.scaleResolutionDownBy)]) expect(n % 2, `${preset} ${w}×${h} → ${outW}×${outH}`).toBe(0)
        expect([outW, outH]).toEqual([plan.width, plan.height])
        expect(outH).toBeLessThanOrEqual(QUALITY_PROFILES[preset].maxHeight ?? h)
        expect(Math.abs(outW / outH - w / h)).toBeLessThan(0.02)
      }
    }
    expect(evenScale(1920, 1080, 2000)).toEqual({ scale: 1, width: 1920, height: 1080 })
  })

  it('Auto steps down to lighter streams and never upscales', () => {
    const steps = [0, 1, 2, 3, 4].map(n => encodingPlan('auto', 3840, 2160, n))
    expect(steps[0]).toMatchObject({ scaleResolutionDownBy: 1, maxFramerate: 60 })
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!.maxBitrate).toBeLessThan(steps[i - 1]!.maxBitrate)
      expect(steps[i]!.height).toBeLessThan(steps[i - 1]!.height)
    }
    expect(encodingPlan('auto', 800, 600, 4).height).toBe(480)
    expect(encodingPlan('auto', 640, 400, 2).scaleResolutionDownBy).toBe(1)
  })
})

describe('keyboard', () => {
  it('swaps ⌘ and Ctrl only across Mac ↔ PC, when asked', () => {
    expect(mapModifierCode('MetaLeft', 'darwin', 'win32', true)).toBe('ControlLeft')
    expect(mapModifierCode('ControlLeft', 'darwin', 'win32', true)).toBe('MetaLeft')
    expect(mapModifierCode('ControlRight', 'win32', 'darwin', true)).toBe('MetaRight')
    expect(mapModifierCode('MetaLeft', 'darwin', 'darwin', true)).toBe('MetaLeft')
    expect(mapModifierCode('ControlLeft', 'linux', 'win32', true)).toBe('ControlLeft')
    expect(mapModifierCode('MetaLeft', 'darwin', 'linux', false)).toBe('MetaLeft')
    expect(mapModifierCode('KeyC', 'darwin', 'win32', true)).toBe('KeyC')
  })

  it('knows every key a coder needs on every OS', () => {
    const needed = ['KeyC', 'KeyV', 'KeyS', 'KeyP', 'ShiftLeft', 'ControlLeft', 'AltLeft', 'MetaLeft', 'Backquote', 'Tab', 'Escape', 'Enter', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'F1', 'F5', 'F12', 'Slash', 'BracketLeft', 'Space']
    for (const code of needed) for (const os of ['darwin', 'win32', 'linux'] as const) expect(keyFor(code, os), `${code} on ${os}`).not.toBeNull()
    expect(keyFor('KeyC', 'darwin')).toBe(8)
    expect(keyFor('KeyC', 'win32')).toBe(0x2e)
    expect(keyFor('KeyC', 'linux')).toBe(46 + 8)
    expect(keyFor('ArrowUp', 'win32')).toBe(0xe048)
    expect(keyFor('NoSuchKey', 'darwin')).toBeNull()
  })

  it('has consistent scan codes (set 1 = evdev for the main block) and unique codes per OS', () => {
    for (const [code, [, win, evdev]] of Object.entries(KEYMAP)) if (win < 0x59) expect(evdev, code).toBe(win)
    for (const index of [0, 1, 2] as const) {
      const values = Object.values(KEYMAP)
        .map(e => e[index])
        .filter(v => v >= 0)
      expect(new Set(values).size, `column ${index}`).toBe(values.length)
    }
  })
})

describe('input events from the network', () => {
  it('accepts well-formed events and drops anything else', () => {
    expect(parseInputEvent({ k: 'mm', x: 0.5, y: 1 })).toEqual({ k: 'mm', x: 0.5, y: 1 })
    expect(parseInputEvent({ k: 'md', b: 2, x: 0, y: 0 })).toEqual({ k: 'md', b: 2, x: 0, y: 0 })
    expect(parseInputEvent({ k: 'kd', c: 'KeyA' })).toEqual({ k: 'kd', c: 'KeyA' })
    expect(parseInputEvent({ k: 'tx', t: 'é' })).toEqual({ k: 'tx', t: 'é' })
    expect(parseInputEvent({ k: 'mm', x: 2, y: 0 })).toBeNull()
    expect(parseInputEvent({ k: 'md', b: 7, x: 0, y: 0 })).toBeNull()
    expect(parseInputEvent({ k: 'kd', c: '../../x' })).toBeNull()
    expect(parseInputEvent({ k: 'tx', t: 'x'.repeat(65) })).toBeNull()
    expect(parseInputEvent({ k: 'wh', dx: Infinity, dy: 0 })).toBeNull()
    expect(parseInputEvent({ k: 'exec', cmd: 'rm -rf /' })).toBeNull()
    expect(parseInputEvent(null)).toBeNull()
  })

  it('maps 0–1 coordinates onto the shared display', () => {
    const display = { bounds: { x: 1920, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }
    expect(toHostPoint(0, 0, display, 'darwin')).toEqual({ x: 1920, y: 0 })
    expect(toHostPoint(0.5, 0.5, display, 'darwin')).toEqual({ x: 2640, y: 450 })
    // The far edge stays on this display.
    expect(toHostPoint(1, 1, display, 'darwin')).toEqual({ x: 3359, y: 899 })
    expect(toHostPoint(0.5, 0.5, display, 'linux')).toEqual({ x: 5280, y: 900 })
    expect(toHostPoint(0.5, 0.5, display, 'win32', p => ({ x: p.x * 1.5, y: p.y * 1.5 }))).toEqual({ x: 3960, y: 675 })
  })
})

describe('file names from the other computer', () => {
  it('cannot escape the destination folder', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('..\\..\\Windows\\System32\\evil.dll')).toBe('evil.dll')
    expect(safeFileName('/abs/path/notes.txt')).toBe('notes.txt')
    expect(safeFileName('..')).toBeNull()
    expect(safeFileName('.')).toBeNull()
    expect(safeFileName('')).toBeNull()
    expect(safeFileName(42)).toBeNull()
  })

  it('removes reserved and control characters and device names', () => {
    expect(safeFileName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt')
    expect(safeFileName('bell\u0007.txt')).toBe('bell.txt')
    expect(safeFileName('CON.txt')).toBe('_CON.txt')
    expect(safeFileName('report.pdf. . ')).toBe('report.pdf')
    expect(safeFileName(`${'x'.repeat(300)}.tar.gz`)?.length).toBe(200)
    expect(safeFileName(`${'x'.repeat(300)}.tar.gz`)?.endsWith('.gz')).toBe(true)
  })

  it('never overwrites', () => {
    const taken = new Set(['a.txt', 'a (2).txt'])
    expect(uniqueName('a.txt', n => taken.has(n))).toBe('a (3).txt')
    expect(uniqueName('b.txt', n => taken.has(n))).toBe('b.txt')
    expect(uniqueName('Makefile', n => n === 'Makefile')).toBe('Makefile (2)')
  })

  it('checks the final path is inside the folder', () => {
    expect(insideFolder('/tmp/in', '/tmp/in/a.txt')).toBe(true)
    expect(insideFolder('/tmp/in', '/tmp/in/../out/a.txt')).toBe(false)
    expect(insideFolder('/tmp/in', '/tmp/inside/a.txt')).toBe(false)
  })
})

describe('signals and discovery', () => {
  it('passes only well-formed WebRTC signals', () => {
    expect(parseSignal({ type: 'offer', sdp: 'v=0' })).toEqual({ type: 'offer', sdp: 'v=0' })
    expect(parseSignal({ type: 'candidate', candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 })).toMatchObject({ type: 'candidate' })
    expect(parseSignal({ type: 'offer', sdp: 'x'.repeat(300_000) })).toBeNull()
    expect(parseSignal({ type: 'bogus' })).toBeNull()
  })

  it('reads LAN announcements and ignores others', () => {
    const a = parseAnnouncement(Buffer.from(JSON.stringify({ app: 'featured-rd', v: 1, id: 'WD-111-222-333', name: 'Dev\u0001 PC', os: 'Windows 11', platform: 'win32', port: 47800, fp: 'AB' })))
    expect(a).toMatchObject({ id: 'WD-111-222-333', name: 'Dev PC', platform: 'win32', port: 47800, query: false })
    expect(parseAnnouncement(Buffer.from(JSON.stringify({ app: 'featured-rd', v: 1, q: 1 })))?.query).toBe(true)
    expect(parseAnnouncement(Buffer.from(JSON.stringify({ app: 'other', v: 1, id: 'WD-111-222-333', port: 1 })))).toBeNull()
    expect(parseAnnouncement(Buffer.from(JSON.stringify({ app: 'featured-rd', v: 1, id: 'nope', port: 1 })))).toBeNull()
    expect(parseAnnouncement(Buffer.from('not json'))).toBeNull()
  })
})
