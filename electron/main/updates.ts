import { join } from 'node:path'
import { app, net, shell } from 'electron'
import { APP_NAME } from '@shared/constants/agent'
import { UPDATE_CHECK, updateFeedFor, type UpdateFeed } from '@shared/constants/updates'
import type { UpdateStatus } from '@shared/types/agent'
import { compareVersions, parseUpdateInfo } from '@shared/utils/version'
import { readDurableJson, writeDurableJson } from './durableJson'
import { logger } from './logger'
import { notifyUser } from './notify'
import { hasActiveRecording } from './recorder/session'
import { getSettings } from './settings'
import { getUpdateStatus, setUpdateStatus } from './state'
import { cleanOldInstallers, downloadInstaller, launchInstaller, macInstallProblem } from './updateInstall'

/*
 * Auto-update, without latest.yml.
 *
 * Each build asks ITS OWN entry in the software-versions list (the URL per
 * platform/arch is in shared/constants/updates.ts) for { version, link }.
 *
 *   Auto update ON (Settings → Updates, the default)
 *     On every start: check → newer? download → verify → quit, install, relaunch.
 *     While the app stays open (every few hours): check → download → verify, and
 *     leave it READY: it installs on the next start, or now with "Restart & update".
 *     The app never restarts by itself in the middle of someone's day, except
 *     right after starting, and never during a recording.
 *
 *   Auto update OFF
 *     Still checks (start + every few hours) and says when a newer version is
 *     out — window, tray, one notification — but downloads nothing until the
 *     user presses "Update now".
 *
 * Settings → Updates also has "Check for updates" for a check on demand.
 */

let firstTimer: NodeJS.Timeout | null = null
let interval: NodeJS.Timeout | null = null
let deferTimer: NodeJS.Timeout | null = null
let checking: Promise<UpdateStatus> | null = null
let installing = false
/** One "update available" notification per version, not one per check. */
let notifiedVersion: string | null = null

const feed = (): UpdateFeed | null => updateFeedFor(process.platform, process.arch)
const now = (): string => new Date().toISOString()

const unsupported = (): UpdateStatus => ({
  state: 'unsupported',
  reason: `No update is published for ${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'} (${process.arch}) yet.`
})

/* ----- restart-loop guard ------------------------------------------------ */

interface Attempt {
  version: string
  count: number
}
const attemptsFile = (): string => join(app.getPath('userData'), 'update-attempts.json')

const readAttempt = (): Attempt | null => {
  try {
    const value = readDurableJson<Attempt>(attemptsFile(), v => typeof v?.version === 'string' && typeof v.count === 'number')
    return value
  } catch {
    return null
  }
}

const recordAttempt = (version: string): void => {
  const previous = readAttempt()
  const count = previous?.version === version ? previous.count + 1 : 1
  try {
    writeDurableJson(attemptsFile(), { version, count })
  } catch (error) {
    logger.warn('Could not record the update attempt', error)
  }
}

/** True when this version was already installed automatically enough times and the app is still behind. */
const autoAttemptsUsed = (version: string): boolean => {
  const attempt = readAttempt()
  return attempt?.version === version && attempt.count >= UPDATE_CHECK.maxAutoAttempts
}

/* ----- check ------------------------------------------------------------- */

const describeError = (error: unknown): string => {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'The update server did not answer in time.'
  return 'Could not reach the update server.'
}

const askServer = async (source: UpdateFeed): Promise<UpdateStatus> => {
  try {
    const response = await net.fetch(source.url, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(UPDATE_CHECK.timeoutMs)
    })
    if (response.status === 404) {
      return { state: 'error', error: `${source.softwareName} is not listed on the update server.`, checkedAt: now() }
    }
    if (!response.ok) return { state: 'error', error: `The update server answered ${response.status}.`, checkedAt: now() }

    const info = parseUpdateInfo(await response.json().catch(() => null))
    if (!info) return { state: 'error', error: 'The update server sent an answer the app could not read.', checkedAt: now() }
    if (info.softwareName && info.softwareName !== source.softwareName) {
      return { state: 'error', error: `The update server answered for ${info.softwareName}, not ${source.softwareName}.`, checkedAt: now() }
    }
    if (compareVersions(info.version, app.getVersion()) > 0) {
      return { state: 'available', latestVersion: info.version, link: info.link, checkedAt: now() }
    }
    return { state: 'current', latestVersion: info.version, checkedAt: now() }
  } catch (error) {
    logger.warn('Update check failed', { url: source.url, error: error instanceof Error ? error.message : String(error) })
    return { state: 'error', error: describeError(error), checkedAt: now() }
  }
}

const runCheck = async (source: UpdateFeed, onStart: boolean): Promise<UpdateStatus> => {
  const previous = getUpdateStatus()
  // A download or install under way is not interrupted by a check.
  if (previous.state === 'downloading' || previous.state === 'installing') return previous

  setUpdateStatus({ state: 'checking', ...('checkedAt' in previous && previous.checkedAt ? { checkedAt: previous.checkedAt } : {}) })
  const next = await askServer(source)

  // Already downloaded this exact version: stay ready rather than offering it again.
  if (next.state === 'available' && previous.state === 'ready' && previous.latestVersion === next.latestVersion) {
    setUpdateStatus(previous)
  } else {
    setUpdateStatus(next)
  }
  logger.info('Update check', { current: app.getVersion(), result: next.state, latest: 'latestVersion' in next ? next.latestVersion : undefined })

  if (next.state !== 'available') return getUpdateStatus()

  if (getSettings().autoUpdate && app.isPackaged) {
    if (autoAttemptsUsed(next.latestVersion)) {
      setUpdateStatus({
        ...next,
        state: 'error',
        error: `Version ${next.latestVersion} was installed but the app is still ${app.getVersion()}. Press Update now to try again.`
      })
      return getUpdateStatus()
    }
    // On start: install straight away. Later in the day: get it ready for the next start.
    void downloadAndMaybeInstall(onStart ? 'now' : 'next-start')
  } else if (notifiedVersion !== next.latestVersion) {
    notifiedVersion = next.latestVersion
    notifyUser('Update available', `${APP_NAME} ${next.latestVersion} is ready to install (you have ${app.getVersion()}). Open Settings → Updates.`)
  }
  return getUpdateStatus()
}

/** Check now. A check already running is joined, not repeated. */
export const checkForUpdates = (onStart = false): Promise<UpdateStatus> => {
  const source = feed()
  if (!source) {
    const status = unsupported()
    setUpdateStatus(status)
    return Promise.resolve(status)
  }
  checking ??= runCheck(source, onStart).finally(() => {
    checking = null
  })
  return checking
}

/* ----- download + install ------------------------------------------------ */

type When = 'now' | 'next-start'

const downloadAndMaybeInstall = async (when: When): Promise<void> => {
  const source = feed()
  const status = getUpdateStatus()
  if (!source) return
  const target =
    status.state === 'available' || status.state === 'ready' || (status.state === 'error' && status.link && status.latestVersion)
      ? { version: status.latestVersion as string, link: status.link as string }
      : null
  if (!target) return

  if (status.state !== 'ready') {
    setUpdateStatus({ state: 'downloading', latestVersion: target.version, link: target.link, percent: -1, receivedBytes: 0, totalBytes: 0 })
  }

  let file: string
  try {
    file = await downloadInstaller(target.link, target.version, source.installer, ({ receivedBytes, totalBytes }) => {
      setUpdateStatus({
        state: 'downloading',
        latestVersion: target.version,
        link: target.link,
        receivedBytes,
        totalBytes,
        percent: totalBytes ? Math.min(100, Math.floor((receivedBytes / totalBytes) * 100)) : -1
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('Update download failed', { version: target.version, error: message })
    setUpdateStatus({ state: 'error', error: message, checkedAt: now(), latestVersion: target.version, link: target.link })
    return
  }

  setUpdateStatus({ state: 'ready', latestVersion: target.version, link: target.link })

  if (when === 'next-start') {
    if (notifiedVersion !== target.version) {
      notifiedVersion = target.version
      notifyUser('Update ready', `${APP_NAME} ${target.version} is downloaded and installs the next time the app starts.`)
    }
    return
  }
  await install(file, source, target.version, target.link)
}

const install = async (file: string, source: UpdateFeed, version: string, link: string): Promise<void> => {
  if (installing) return
  // Never pull the app out from under a recording: wait for it to finish.
  if (hasActiveRecording()) {
    logger.info('Update ready; waiting for the recording to finish')
    if (deferTimer) clearTimeout(deferTimer)
    deferTimer = setTimeout(() => void install(file, source, version, link), 30_000)
    return
  }

  installing = true
  setUpdateStatus({ state: 'installing', latestVersion: version })
  try {
    await new Promise(resolve => setTimeout(resolve, UPDATE_CHECK.installDelayMs))
    recordAttempt(version)
    await launchInstaller(file, source.installer)
    logger.info('Installing update and quitting', { from: app.getVersion(), to: version })
    app.quit()
    // A backstop, not the mechanism: if the normal quit hangs, leave anyway so the installer can work.
    setTimeout(() => app.exit(0), 10_000).unref()
  } catch (error) {
    installing = false
    const message = error instanceof Error ? error.message : String(error)
    logger.error('Update install failed', { version, error: message })
    setUpdateStatus({ state: 'error', error: message, checkedAt: now(), latestVersion: version, link })
  }
}

const getLink = (): string | undefined => {
  const status = getUpdateStatus()
  return 'link' in status ? status.link : undefined
}

/**
 * "Update now" / "Restart & update": download (if not yet) and install the
 * newer version right away, whatever the Auto update setting says.
 */
export const installUpdate = (): void => {
  if (!app.isPackaged) throw new Error('Installing updates works only in the installed app.')
  const source = feed()
  if (!source) throw new Error('No update is published for this computer yet.')
  if (source.installer === 'dmg') {
    const problem = macInstallProblem()
    if (problem) throw new Error(problem)
  }
  const status = getUpdateStatus()
  if (status.state === 'downloading' || status.state === 'installing') return
  const hasTarget = status.state === 'available' || status.state === 'ready' || (status.state === 'error' && !!status.link)
  if (!hasTarget) throw new Error('No newer version to install. Check for updates first.')
  void downloadAndMaybeInstall('now')
}

/** Open the installer link in the browser — the manual way when installing here fails. */
export const openUpdateLink = async (): Promise<void> => {
  const link = getLink()
  if (!link) throw new Error('No update to download.')
  await shell.openExternal(link)
}

/** Settings → Auto update was turned on: act on a version already known to be newer. */
export const onAutoUpdateChanged = (enabled: boolean): void => {
  const status = getUpdateStatus()
  if (enabled && app.isPackaged && status.state === 'available') void downloadAndMaybeInstall('next-start')
}

export const startUpdateChecks = (): void => {
  if (!feed()) {
    setUpdateStatus(unsupported())
    return
  }
  cleanOldInstallers()
  firstTimer = setTimeout(() => void checkForUpdates(true), UPDATE_CHECK.firstDelayMs)
  interval = setInterval(() => void checkForUpdates(false), UPDATE_CHECK.intervalMs)
}

export const stopUpdateChecks = (): void => {
  if (firstTimer) clearTimeout(firstTimer)
  if (interval) clearInterval(interval)
  if (deferTimer) clearTimeout(deferTimer)
  firstTimer = null
  interval = null
  deferTimer = null
}
