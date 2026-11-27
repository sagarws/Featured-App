import { execFile } from 'node:child_process'
import { readFile, statfs } from 'node:fs/promises'
import { cpus, freemem, totalmem, uptime } from 'node:os'
import { promisify } from 'node:util'
import { isVpsPort } from '@shared/utils/vps'

/*
 * Light, on-demand metrics: nothing runs in the background. The window asks
 * every few seconds while the VPS page is open and connected; each sample is
 * a couple of OS counters and at most two short, fixed commands (no shell,
 * no input from the window).
 */

const run = promisify(execFile)
const OPTS = { timeout: 3000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }

let lastCpu: { idle: number; total: number } | null = null
let lastNet: { rx: number; tx: number; at: number } | null = null

const cpuTimes = () =>
  cpus().reduce(
    (acc, cpu) => {
      const t = cpu.times
      acc.idle += t.idle
      acc.total += t.user + t.nice + t.sys + t.idle + t.irq
      return acc
    },
    { idle: 0, total: 0 }
  )

export const cpuPercent = (): number => {
  const now = cpuTimes()
  const prev = lastCpu
  lastCpu = now
  if (!prev || now.total <= prev.total) return 0
  return Math.round((1 - (now.idle - prev.idle) / (now.total - prev.total)) * 1000) / 10
}

export const diskUsage = async (): Promise<{ used: number; total: number } | null> => {
  try {
    const root = process.platform === 'win32' ? `${process.env['SystemDrive'] ?? 'C:'}\\` : '/'
    const s = await statfs(root)
    const total = s.blocks * s.bsize
    return { total, used: total - s.bavail * s.bsize }
  } catch {
    return null
  }
}

/** Total bytes received / sent on all non-loopback interfaces. */
export const netCounters = async (): Promise<{ rx: number; tx: number } | null> => {
  try {
    if (process.platform === 'linux') {
      const text = await readFile('/proc/net/dev', 'utf8')
      return parseProcNetDev(text)
    }
    if (process.platform === 'darwin') return parseNetstatIb((await run('/usr/sbin/netstat', ['-ibn'], OPTS)).stdout)
    if (process.platform === 'win32') return parseNetstatE((await run('netstat.exe', ['-e'], OPTS)).stdout)
  } catch {
    // Counters unavailable: shown as "—".
  }
  return null
}

export const parseProcNetDev = (text: string): { rx: number; tx: number } => {
  let rx = 0
  let tx = 0
  for (const line of text.split('\n').slice(2)) {
    const [name, rest] = line.split(':')
    if (!rest || name?.trim() === 'lo') continue
    const cols = rest.trim().split(/\s+/).map(Number)
    rx += cols[0] ?? 0
    tx += cols[8] ?? 0
  }
  return { rx, tx }
}

/** macOS `netstat -ibn`: one <Link#n> row per interface; Ibytes / Obytes counted from the end (Address may be empty). */
export const parseNetstatIb = (text: string): { rx: number; tx: number } => {
  let rx = 0
  let tx = 0
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 8 || !cols[2]?.startsWith('<Link#') || cols[0]?.startsWith('lo')) continue
    rx += Number(cols[cols.length - 5]) || 0
    tx += Number(cols[cols.length - 2]) || 0
  }
  return { rx, tx }
}

/** Windows `netstat -e`: the "Bytes  <received>  <sent>" row. */
export const parseNetstatE = (text: string): { rx: number; tx: number } | null => {
  const m = /^\s*Bytes\s+(\d+)\s+(\d+)/m.exec(text)
  return m ? { rx: Number(m[1]), tx: Number(m[2]) } : null
}

export const netRates = async (): Promise<{ rxPerSec: number; txPerSec: number } | null> => {
  const now = await netCounters()
  if (!now) return null
  const prev = lastNet
  lastNet = { ...now, at: Date.now() }
  if (!prev) return { rxPerSec: 0, txPerSec: 0 }
  const seconds = Math.max(0.5, (lastNet.at - prev.at) / 1000)
  return { rxPerSec: Math.max(0, (now.rx - prev.rx) / seconds), txPerSec: Math.max(0, (now.tx - prev.tx) / seconds) }
}

/** Established TCP connections whose local port is `port`, from `netstat -an` / `ss` output. */
export const countEstablished = (text: string, port: number, platform: NodeJS.Platform): number => {
  const suffix = platform === 'darwin' ? `.${port}` : `:${port}`
  let count = 0
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (platform === 'linux') {
      // ss -Htn state established: Recv-Q Send-Q Local Peer
      if (cols[2]?.endsWith(suffix)) count++
    } else if (platform === 'darwin') {
      // tcp4 0 0 192.168.1.5.2222 192.168.1.9.53122 ESTABLISHED
      if (cols[0]?.startsWith('tcp') && cols[3]?.endsWith(suffix) && cols[5] === 'ESTABLISHED') count++
    } else if (cols[0] === 'TCP' && cols[1]?.endsWith(suffix) && cols[3] === 'ESTABLISHED') {
      count++
    }
  }
  return count
}

export const activeConnections = async (port: number): Promise<number | null> => {
  if (!isVpsPort(port)) return null
  try {
    if (process.platform === 'linux') {
      return countEstablished((await run('ss', ['-Htn', 'state', 'established'], OPTS)).stdout, port, 'linux')
    }
    if (process.platform === 'darwin') return countEstablished((await run('/usr/sbin/netstat', ['-anp', 'tcp'], OPTS)).stdout, port, 'darwin')
    if (process.platform === 'win32') return countEstablished((await run('netstat.exe', ['-an', '-p', 'TCP'], OPTS)).stdout + (await run('netstat.exe', ['-an', '-p', 'TCPv6'], OPTS)).stdout, port, 'win32')
  } catch {
    // Not available: shown as "—".
  }
  return null
}

export const memory = (): { used: number; total: number } => ({ total: totalmem(), used: totalmem() - freemem() })
export const systemUptime = (): number => uptime()
