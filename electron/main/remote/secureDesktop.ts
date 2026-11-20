import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { InputEvent } from '@shared/types/remote'
import { logger } from '../logger'
import { keyFor } from './input/keymap'

/*
 * Windows lock screen (and sign-in desktop) access through the SYSTEM agent in
 * native/win/RemoteSecureAgent.cs. The agent answers on a named pipe and acts
 * only while the session is locked; this module installs / removes it (with an
 * administrator prompt) and talks to it.
 *
 * Other systems: macOS does not let any app see or type into the login window
 * remotely like this; Linux lock screens vary. Both report 'unsupported'.
 */

export type SecureAgentState = 'unsupported' | 'not-installed' | 'running'

const PIPE = '\\\\.\\pipe\\featured-remote-secure'
const TASK = 'FeaturedAppRemoteAgent'
const INSTALL_DIR_NAME = 'Featured App Remote Agent'

const agentSources = (): string => (app.isPackaged ? join(process.resourcesPath, 'native') : join(app.getAppPath(), 'native', 'win'))

const utf16Hex = (text: string): string => {
  let out = ''
  for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).padStart(4, '0')
  return out
}

export interface SecureFrame {
  width: number
  height: number
  jpeg: Buffer
}

export class SecureDesktop {
  private socket: Socket | null = null
  private connecting: Promise<Socket | null> | null = null
  private buffer = ''
  private waiting: ((line: string) => void)[] = []
  private state: SecureAgentState = process.platform === 'win32' ? 'not-installed' : 'unsupported'

  agentState(): SecureAgentState {
    return this.state
  }

  available(): boolean {
    return this.state === 'running'
  }

  private connectPipe(): Promise<Socket | null> {
    if (process.platform !== 'win32') return Promise.resolve(null)
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (this.connecting) return this.connecting
    this.connecting = new Promise<Socket | null>(resolve => {
      const socket = connect(PIPE)
      const timer = setTimeout(() => {
        socket.destroy()
        resolve(null)
      }, 2000)
      socket.once('connect', () => {
        clearTimeout(timer)
        this.socket = socket
        this.buffer = ''
        socket.setEncoding('utf8')
        socket.on('data', (data: string) => {
          this.buffer += data
          let index: number
          while ((index = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, index).trim()
            this.buffer = this.buffer.slice(index + 1)
            this.waiting.shift()?.(line)
          }
        })
        socket.on('close', () => {
          if (this.socket === socket) this.socket = null
          for (const w of this.waiting.splice(0)) w('')
        })
        resolve(socket)
      })
      socket.once('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
    }).finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async ask(line: string, timeoutMs: number): Promise<string> {
    const socket = await this.connectPipe()
    if (!socket) return ''
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter(w => w !== done)
        resolve('')
      }, timeoutMs)
      const done = (reply: string): void => {
        clearTimeout(timer)
        resolve(reply)
      }
      this.waiting.push(done)
      socket.write(`${line}\n`)
    })
  }

  private tell(line: string): void {
    if (this.socket && !this.socket.destroyed) this.socket.write(`${line}\n`)
    else void this.connectPipe().then(s => s?.write(`${line}\n`))
  }

  /** Is the agent there, and is this Windows session locked? */
  async refresh(): Promise<{ state: SecureAgentState; locked: boolean | null }> {
    if (process.platform !== 'win32') return { state: 'unsupported', locked: null }
    const reply = await this.ask('status', 2000)
    this.state = reply === 'locked' || reply === 'unlocked' ? 'running' : 'not-installed'
    return { state: this.state, locked: reply === 'locked' ? true : reply === 'unlocked' ? false : null }
  }

  /** The lock screen as JPEG (whole virtual screen), or null when not locked / no agent. */
  async frame(maxWidth: number, quality: number): Promise<SecureFrame | null> {
    if (!this.available()) return null
    const reply = await this.ask(`frame ${Math.round(maxWidth)} ${Math.round(quality)}`, 5000)
    const m = /^frame (\d+) (\d+) ([A-Za-z0-9+/=]+)$/.exec(reply)
    if (!m) return null
    return { width: Number(m[1]), height: Number(m[2]), jpeg: Buffer.from(m[3]!, 'base64') }
  }

  /** Input for the lock screen. Coordinates are 0–1 of the frame (= the whole virtual screen). */
  inject(event: InputEvent): void {
    if (!this.available()) return
    const n = (v: number): string => v.toFixed(5)
    switch (event.k) {
      case 'mm':
        return this.tell(`m ${n(event.x)} ${n(event.y)}`)
      case 'md':
      case 'mu':
        return this.tell(`${event.k === 'md' ? 'd' : 'u'} ${event.b} ${n(event.x)} ${n(event.y)}`)
      case 'wh':
        return this.tell(`w ${Math.round(event.dx)} ${Math.round(event.dy)}`)
      case 'kd':
      case 'ku': {
        const sc = keyFor(event.c, 'win32')
        if (sc !== null) this.tell(`k ${sc} ${event.k === 'kd' ? 1 : 0}`)
        return
      }
      case 'tx':
        return this.tell(`t ${utf16Hex(event.t)}`)
      case 'rel':
        return this.tell('r')
    }
  }

  sendCtrlAltDel(): void {
    if (this.available()) this.tell('sas')
  }

  releaseAll(): void {
    if (this.available()) this.tell('r')
  }

  /** Install (or update) and start the agent. Shows the Windows administrator prompt. */
  async install(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('Lock screen access is available on Windows only.')
    const src = agentSources()
    for (const file of ['remote-secure-agent.ps1', 'RemoteSecureAgent.cs']) {
      if (!existsSync(join(src, file))) throw new Error(`The agent file ${file} is missing from this install.`)
    }
    await runElevated(`
$ErrorActionPreference = 'Stop'
$src = ${psString(src)}
$dir = Join-Path $env:ProgramFiles ${psString(INSTALL_DIR_NAME)}
Get-ScheduledTask -TaskName ${psString(TASK)} -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like '*remote-secure-agent.ps1*' } | Invoke-CimMethod -MethodName Terminate | Out-Null
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# Program Files: only administrators can change what SYSTEM will run.
Copy-Item -Force -Path (Join-Path $src 'remote-secure-agent.ps1'), (Join-Path $src 'RemoteSecureAgent.cs') -Destination $dir
$script = Join-Path $dir 'remote-secure-agent.ps1'
$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$action = New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '" -Mode service')
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName ${psString(TASK)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName ${psString(TASK)}
`)
    // The agent compiles itself and starts its session copy: give it a moment.
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      if ((await this.refresh()).state === 'running') return
    }
    throw new Error('The agent was installed but did not start. See Task Scheduler → FeaturedAppRemoteAgent.')
  }

  /** Stop and remove the agent. Shows the administrator prompt. */
  async uninstall(): Promise<void> {
    if (process.platform !== 'win32') return
    this.socket?.destroy()
    await runElevated(`
$ErrorActionPreference = 'Continue'
Get-ScheduledTask -TaskName ${psString(TASK)} -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName ${psString(TASK)} -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like '*remote-secure-agent.ps1*' } | Invoke-CimMethod -MethodName Terminate | Out-Null
Start-Sleep -Seconds 1
Remove-Item -Recurse -Force -Path (Join-Path $env:ProgramFiles ${psString(INSTALL_DIR_NAME)}) -ErrorAction SilentlyContinue
`)
    this.state = 'not-installed'
  }

  close(): void {
    this.socket?.destroy()
    this.socket = null
  }
}

const psString = (value: string): string => `'${value.replace(/'/g, "''")}'`

/** Run a PowerShell script as administrator (UAC prompt) and wait for it. */
const runElevated = (script: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'featured-agent-'))
    const file = join(dir, 'setup.ps1')
    writeFileSync(file, script, 'utf8')
    const outer = `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psString(`"${file}"`)}; exit $p.ExitCode`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', error => reject(error))
    child.on('exit', code => {
      rmSync(dir, { recursive: true, force: true })
      if (code === 0) return resolve()
      logger.warn('[remote] elevated agent setup failed', { code, stderr: stderr.slice(0, 2000) })
      reject(new Error(/cancel/i.test(stderr) ? 'The administrator prompt was declined.' : 'Setting up lock screen access failed. See the log for details.'))
    })
  })
