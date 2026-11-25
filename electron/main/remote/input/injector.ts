import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { app, screen, systemPreferences, type Display } from 'electron'
import type { InputEvent, PermissionStatus } from '@shared/types/remote'
import { logger } from '../../logger'
import { platform } from '../store'
import { toHostPoint } from './geometry'
import { keyFor } from './keymap'

/**
 * Where macOS keeps the "control this Mac" switch. macOS 27 (Darwin 27)
 * renamed Accessibility to "Device Control and Data Access".
 */
export const macControlPane = (darwinMajor = Number(release().split('.')[0])): string =>
  darwinMajor >= 27 ? 'Device Control and Data Access' : 'Accessibility'

/*
 * Keyboard and mouse on the host. A small long-running helper per OS does the
 * injection (native APIs, see native/*): macOS CoreGraphics events, Windows
 * SendInput (scan codes), Linux X11 XTEST. This module owns the helper process,
 * turns viewer events (0–1 coordinates of the shared display, physical key
 * codes) into helper commands, and is only ever called for a session the
 * host's main process has authorised for full control.
 */

/** The macOS input module (native/mac/remote-input.c built as remote-input.node). */
interface InputModule {
  handle(line: string): string | null
  trusted(prompt: boolean): boolean
  /** Screen Recording prompt; true when already allowed. */
  requestScreen(): boolean
}

/**
 * macOS: load the input code into this process, so the app itself posts the
 * events and macOS shows ONE permission entry ("Featured App"), not a second
 * one for a separate helper. Null when it cannot load: the helper is used.
 */
const loadInputModule = (): InputModule | null => {
  if (process.platform !== 'darwin') return null
  const path = app.isPackaged ? join(process.resourcesPath, 'native', 'remote-input.node') : join(app.getAppPath(), 'resources', 'native', 'mac', 'remote-input.node')
  if (!existsSync(path)) return null
  try {
    const holder: { exports: unknown } = { exports: {} }
    process.dlopen(holder, path)
    const m = holder.exports as Partial<InputModule>
    return typeof m.handle === 'function' && typeof m.trusted === 'function' && typeof m.requestScreen === 'function' ? (m as InputModule) : null
  } catch (error) {
    logger.warn('[remote] input module did not load; using the helper', error)
    return null
  }
}

const helperCommand = (): { command: string; args: string[] } | null => {
  const packaged = app.isPackaged
  const base = (...parts: string[]): string => (packaged ? join(process.resourcesPath, 'native', parts[parts.length - 1]!) : join(app.getAppPath(), ...parts))
  if (process.platform === 'darwin') {
    const path = packaged ? join(process.resourcesPath, 'native', 'remote-input') : join(app.getAppPath(), 'resources', 'native', 'mac', 'remote-input')
    return existsSync(path) ? { command: path, args: [] } : null
  }
  if (process.platform === 'win32') {
    const path = base('native', 'win', 'remote-input.ps1')
    return existsSync(path) ? { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path] } : null
  }
  const path = base('native', 'linux', 'remote-input.py')
  return existsSync(path) ? { command: 'python3', args: [path] } : null
}

/** Two clicks of the same button within this time and distance make a double click (macOS needs the count). */
const DOUBLE_CLICK_MS = 450
const DOUBLE_CLICK_PX = 6

const utf16Hex = (text: string): string => {
  let out = ''
  for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).padStart(4, '0')
  return out
}

export class InputInjector {
  private child: ChildProcessWithoutNullStreams | null = null
  private waiting: ((line: string) => void)[] = []
  private lastClick = { button: -1, at: 0, x: 0, y: 0, count: 0 }
  private status: PermissionStatus['input'] = 'unknown'
  private detail: string | null = null
  private readonly os = platform()
  /** macOS: the input code in this process (one permission entry); null → the helper process. */
  private readonly module = loadInputModule()

  private ensure(): ChildProcessWithoutNullStreams | null {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child
    const helper = helperCommand()
    if (!helper) {
      this.status = 'unsupported'
      this.detail = process.platform === 'darwin' ? 'The input helper is missing. Run `npm run native`.' : 'The input helper is missing from this install.'
      return null
    }
    const child = spawn(helper.command, helper.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data: string) => {
      buffer += data
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        this.waiting.shift()?.(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (data: string) => logger.warn(`[remote] input helper: ${data.trim().slice(0, 500)}`))
    child.on('error', error => {
      logger.error('[remote] input helper failed to start', error)
      this.status = 'unsupported'
      this.detail = process.platform === 'linux' ? 'python3 is needed for keyboard/mouse control on Linux.' : error.message
    })
    child.on('exit', code => {
      if (this.child === child) this.child = null
      for (const w of this.waiting.splice(0)) w('')
      if (code) logger.warn(`[remote] input helper exited with ${code}`)
    })
    child.stdin.on('error', () => undefined)
    return child
  }

  private write(line: string): void {
    if (this.module) {
      this.module.handle(line)
      return
    }
    const child = this.ensure()
    if (child?.stdin.writable) child.stdin.write(`${line}\n`)
  }

  private ask(command: string, timeoutMs: number): Promise<string> {
    if (this.module) return Promise.resolve(this.module.handle(command) ?? '')
    const child = this.ensure()
    if (!child) return Promise.resolve('')
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter(w => w !== done)
        resolve('')
      }, timeoutMs)
      const done = (line: string): void => {
        clearTimeout(timer)
        resolve(line)
      }
      this.waiting.push(done)
      child.stdin.write(`${command}\n`)
    })
  }

  /** Can this computer be controlled right now? Starts the helper (PowerShell needs a moment the first time). */
  async check(): Promise<{ state: PermissionStatus['input']; detail: string | null }> {
    if (process.platform === 'linux' && (process.env['XDG_SESSION_TYPE'] === 'wayland' || (!process.env['DISPLAY'] && process.env['WAYLAND_DISPLAY']))) {
      this.status = 'unsupported'
      this.detail = 'Wayland does not allow apps to control the keyboard and mouse. Log in with an "X11" / "Xorg" session to allow control; view-only works.'
      return { state: this.status, detail: this.detail }
    }
    const answer = await this.ask('a', process.platform === 'win32' ? 15_000 : 4000)
    if (answer === 'trusted') {
      this.status = 'granted'
      this.detail = null
    } else if (answer.startsWith('untrusted')) {
      this.status = 'denied'
      this.detail =
        process.platform === 'darwin'
          ? this.module
            ? `On the Mac: Remote Desktop → Set up remote control → Allow (or System Settings → Privacy & Security → ${macControlPane()} → Featured App on), then restart the session.`
            : `Allow Featured App under System Settings → Privacy & Security → ${macControlPane()} (switch on both "Featured App" entries; one is its keyboard/mouse helper), then restart the session.`
          : answer.slice('untrusted'.length).trim() || 'Keyboard/mouse control is not available.'
    } else if (this.status !== 'unsupported') {
      this.status = 'unknown'
      this.detail = 'The input helper did not answer.'
    }
    return { state: this.status, detail: this.detail }
  }

  current(): { state: PermissionStatus['input']; detail: string | null } {
    return { state: this.status, detail: this.detail }
  }

  /** macOS: show the Accessibility prompt for this app. */
  requestPermission(): void {
    if (process.platform !== 'darwin') return
    if (this.module) this.module.trusted(true)
    else systemPreferences.isTrustedAccessibilityClient(true)
  }

  /** macOS: ask for Screen Recording for this app (the system prompt shows once; later, Settings). */
  requestScreenPermission(): void {
    if (process.platform === 'darwin') this.module?.requestScreen()
  }

  inject(event: InputEvent, display: Display): void {
    const point = (nx: number, ny: number) =>
      toHostPoint(nx, ny, display, this.os, this.os === 'darwin' ? undefined : p => screen.dipToScreenPoint(p))
    switch (event.k) {
      case 'mm': {
        const p = point(event.x, event.y)
        this.write(`m ${p.x} ${p.y}`)
        return
      }
      case 'md':
      case 'mu': {
        const p = point(event.x, event.y)
        let count: number
        if (event.k === 'md') {
          const now = Date.now()
          const near = Math.abs(p.x - this.lastClick.x) <= DOUBLE_CLICK_PX && Math.abs(p.y - this.lastClick.y) <= DOUBLE_CLICK_PX
          count = this.lastClick.button === event.b && near && now - this.lastClick.at < DOUBLE_CLICK_MS ? Math.min(3, this.lastClick.count + 1) : 1
          this.lastClick = { button: event.b, at: now, x: p.x, y: p.y, count }
        } else {
          count = this.lastClick.button === event.b ? this.lastClick.count : 1
        }
        this.write(`${event.k === 'md' ? 'd' : 'u'} ${event.b} ${p.x} ${p.y} ${count}`)
        return
      }
      case 'wh':
        this.write(`w ${Math.round(event.dx)} ${Math.round(event.dy)}`)
        return
      case 'kd':
      case 'ku': {
        const code = keyFor(event.c, this.os)
        if (code !== null) this.write(`k ${code} ${event.k === 'kd' ? 1 : 0}`)
        return
      }
      case 'tx':
        this.write(`t ${utf16Hex(event.t)}`)
        return
      case 'rel':
        this.releaseAll()
        return
    }
  }

  /** Let go of every key and button the viewer was holding (session ended, control revoked, focus lost). */
  releaseAll(): void {
    if (this.module || this.child) this.write('r')
  }

  stop(): void {
    if (this.module) this.releaseAll()
    if (!this.child) return
    this.releaseAll()
    this.child.stdin.end()
    const child = this.child
    setTimeout(() => {
      if (child.exitCode === null) child.kill()
    }, 1000).unref()
    this.child = null
  }
}
