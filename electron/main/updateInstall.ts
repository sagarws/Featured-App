import { execFile, spawn } from 'node:child_process'
import { accessSync, constants as fsConstants, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { app, net } from 'electron'
import { APP_ID } from '@shared/constants/agent'
import { UPDATE_CHECK, type InstallerKind } from '@shared/constants/updates'
import { compareVersions, directDownloadUrl } from '@shared/utils/version'
import { logger } from './logger'

/*
 * The installer half of the auto-update: download it, make sure it is really
 * the newer Featured App for THIS computer, and run it.
 *
 * There is no latest.yml and no electron-updater here. The version API gives a
 * version and a Google Drive link and nothing else — no checksum — so instead
 * of a hash the installer is checked for what it can be checked for:
 *   - it is a real installer, not Drive's HTML page (type, size, file magic),
 *   - it is the right KIND for this machine (.exe on Windows, .dmg on a Mac),
 *   - on a Mac, the app inside is com.featured.app AND its version is the newer
 *     one; on Windows the installer's own ProductVersion is read when possible.
 * Then:
 *   Windows  the one-click NSIS installer runs silently (/S), replaces the app
 *            and relaunches it (--force-run) — the same as electron-updater does.
 *   Mac      a small script waits for this process to exit, copies the new .app
 *            from the mounted .dmg over this one (keeping the old copy until the
 *            new one is in place), and opens it.
 */

const run = promisify(execFile)

const EXTENSIONS: Record<InstallerKind, string> = { exe: 'exe', dmg: 'dmg', appimage: 'AppImage' }

export const updatesDir = (): string => join(app.getPath('userData'), 'updates')

const installerPath = (version: string, kind: InstallerKind): string =>
  join(updatesDir(), `Featured-App-${version}.${EXTENSIONS[kind]}`)

/** Drop finished or abandoned downloads that are no longer newer than this app. */
export const cleanOldInstallers = (): void => {
  try {
    const dir = updatesDir()
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const version = /^Featured-App-(.+)\.(exe|dmg|AppImage)$/.exec(name)?.[1]
      const stale = name.endsWith('.part') || name.endsWith('.sh') || (version ? compareVersions(version, app.getVersion()) <= 0 : false)
      if (stale) rmSync(join(dir, name), { force: true, recursive: true })
    }
  } catch (error) {
    logger.warn('Could not clean old update downloads', error)
  }
}

/* ------------------------------------------------------------------------ */
/* Checks                                                                    */
/* ------------------------------------------------------------------------ */

const readBytes = (file: string, position: number, length: number): Buffer => {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, position)
    return buffer
  } finally {
    closeSync(fd)
  }
}

/** Size and file magic: a Windows .exe starts "MZ"; a .dmg ends with a 512-byte "koly" trailer. */
const looksLikeInstaller = (file: string, kind: InstallerKind): boolean => {
  const size = statSync(file).size
  if (size < UPDATE_CHECK.minInstallerBytes) return false
  if (kind === 'exe') return readBytes(file, 0, 2).toString('latin1') === 'MZ'
  if (kind === 'dmg') return readBytes(file, size - 512, 4).toString('latin1') === 'koly'
  return readBytes(file, 1, 3).toString('latin1') === 'ELF'
}

/** Version of the app inside a mounted .dmg, and that it is this app at all. */
const inspectMountedApp = async (mountPoint: string): Promise<{ appPath: string; version: string }> => {
  const bundle = readdirSync(mountPoint).find(name => name.endsWith('.app'))
  if (!bundle) throw new Error('The downloaded .dmg has no app inside.')
  const appPath = join(mountPoint, bundle)
  const plist = join(appPath, 'Contents', 'Info.plist')
  const read = async (key: string): Promise<string> =>
    (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim()
  const id = await read('CFBundleIdentifier')
  if (id !== APP_ID) throw new Error(`The downloaded .dmg holds a different app (${id}).`)
  return { appPath, version: await read('CFBundleShortVersionString') }
}

const attachDmg = async (dmg: string): Promise<string> => {
  const mountPoint = mkdtempSync(join(tmpdir(), 'featured-app-update-'))
  await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint, dmg], {
    timeout: 120_000
  })
  return mountPoint
}

const detachDmg = async (mountPoint: string): Promise<void> => {
  await run('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet']).catch(() =>
    run('/usr/bin/hdiutil', ['detach', mountPoint, '-force', '-quiet']).catch(() => undefined)
  )
  rmSync(mountPoint, { recursive: true, force: true })
}

/** ProductVersion that electron-builder writes into the setup .exe. Null when it cannot be read. */
const readExeVersion = async (file: string): Promise<string | null> => {
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${file.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { timeout: 20_000, windowsHide: true }
    )
    const version = stdout.trim()
    return /^\d+(\.\d+)*/.test(version) ? version : null
  } catch {
    return null
  }
}

/**
 * Is the file on disk the newer Featured App for this machine?
 * Throws with a sentence for the user when it is not.
 */
export const verifyInstaller = async (file: string, kind: InstallerKind, expectedVersion: string): Promise<void> => {
  if (!looksLikeInstaller(file, kind)) {
    throw new Error(`The downloaded file is not a ${EXTENSIONS[kind]} installer. Check the link on the update server.`)
  }

  let found: string | null = null
  if (kind === 'dmg' && process.platform === 'darwin') {
    const mountPoint = await attachDmg(file)
    try {
      found = (await inspectMountedApp(mountPoint)).version
    } finally {
      await detachDmg(mountPoint)
    }
  } else if (kind === 'exe' && process.platform === 'win32') {
    found = await readExeVersion(file)
  }

  if (found && compareVersions(found, app.getVersion()) <= 0) {
    throw new Error(
      `The update server lists ${expectedVersion}, but its installer is version ${found} — not newer than this app (${app.getVersion()}).`
    )
  }
  logger.info('Update installer verified', { file, kind, expectedVersion, found })
}

/* ------------------------------------------------------------------------ */
/* Download                                                                  */
/* ------------------------------------------------------------------------ */

export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number
}

const fileNameFrom = (disposition: string | null): string | null => {
  if (!disposition) return null
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition)?.[1]
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1]
  try {
    return decodeURIComponent((star ?? plain ?? '').trim()) || null
  } catch {
    return plain ?? null
  }
}

let downloading: Promise<string> | null = null

/**
 * Download the installer for `version` (or reuse the one already downloaded),
 * then verify it. Resolves with its path. One download at a time: a second call
 * joins the first.
 */
export const downloadInstaller = (
  link: string,
  version: string,
  kind: InstallerKind,
  onProgress: (progress: DownloadProgress) => void
): Promise<string> => {
  downloading ??= fetchAndVerify(link, version, kind, onProgress).finally(() => {
    downloading = null
  })
  return downloading
}

const fetchAndVerify = async (
  link: string,
  version: string,
  kind: InstallerKind,
  onProgress: (progress: DownloadProgress) => void
): Promise<string> => {
  const target = installerPath(version, kind)

  // Downloaded already (an earlier check, or before a restart): check it again and use it.
  if (existsSync(target)) {
    try {
      await verifyInstaller(target, kind, version)
      return target
    } catch (error) {
      logger.warn('Discarding the earlier update download', error)
      rmSync(target, { force: true })
    }
  }

  mkdirSync(updatesDir(), { recursive: true })
  const part = `${target}.part`
  const url = directDownloadUrl(link)
  logger.info('Downloading update', { version, url })

  const controller = new AbortController()
  let stall: NodeJS.Timeout | null = null
  const resetStall = (): void => {
    if (stall) clearTimeout(stall)
    stall = setTimeout(() => controller.abort(new Error('stalled')), UPDATE_CHECK.stallTimeoutMs)
  }

  try {
    resetStall()
    const response = await net.fetch(url, { cache: 'no-store', signal: controller.signal })
    if (!response.ok || !response.body) throw new Error(`The download server answered ${response.status}.`)

    const type = response.headers.get('content-type') ?? ''
    if (type.includes('text/html')) {
      throw new Error('The download link opened a web page instead of the installer. Is the Drive file shared with "Anyone with the link"?')
    }
    const name = fileNameFrom(response.headers.get('content-disposition'))
    if (name && !name.toLowerCase().endsWith(`.${EXTENSIONS[kind].toLowerCase()}`)) {
      throw new Error(`The download link is "${name}", not a .${EXTENSIONS[kind]} installer for this computer.`)
    }

    const totalBytes = Number(response.headers.get('content-length')) || 0
    const out = createWriteStream(part)
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    let receivedBytes = 0
    let lastReport = 0

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        resetStall()
        receivedBytes += value.length
        if (!out.write(value)) await new Promise<void>(resolve => out.once('drain', () => resolve()))
        const now = Date.now()
        if (now - lastReport > 250) {
          lastReport = now
          onProgress({ receivedBytes, totalBytes })
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())))
    }

    if (totalBytes && receivedBytes !== totalBytes) {
      throw new Error(`The download stopped early (${receivedBytes} of ${totalBytes} bytes).`)
    }
    onProgress({ receivedBytes, totalBytes: totalBytes || receivedBytes })
    renameSync(part, target)
  } catch (error) {
    rmSync(part, { force: true })
    if (controller.signal.aborted) throw new Error('The download stopped responding. It will be tried again.', { cause: error })
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    if (stall) clearTimeout(stall)
  }

  try {
    await verifyInstaller(target, kind, version)
  } catch (error) {
    rmSync(target, { force: true })
    throw error
  }
  return target
}

/* ------------------------------------------------------------------------ */
/* Install                                                                   */
/* ------------------------------------------------------------------------ */

/** The .app bundle this process runs from: …/Featured App.app/Contents/MacOS/Featured App */
const macBundlePath = (): string => dirname(dirname(dirname(process.execPath)))

/** Why the running Mac app cannot replace itself, or null when it can. */
export const macInstallProblem = (): string | null => {
  const bundle = macBundlePath()
  if (!bundle.endsWith('.app')) return 'This copy of the app is not an .app bundle.'
  if (bundle.startsWith('/Volumes/')) return 'The app is running from the installer disk. Drag it to Applications first.'
  if (bundle.includes('/AppTranslocation/')) return 'macOS is running the app from a temporary place. Move it to Applications and open it from there.'
  try {
    accessSync(dirname(bundle), fsConstants.W_OK)
    accessSync(bundle, fsConstants.W_OK)
  } catch {
    return `No permission to replace the app in ${dirname(bundle)}.`
  }
  return null
}

const MAC_SCRIPT = `#!/bin/bash
# Featured App update: replace the .app once the running copy has quit.
PID="$1"; SRC="$2"; DEST="$3"; MOUNT="$4"
echo "$(date) update: waiting for $PID"
for _ in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
kill -0 "$PID" 2>/dev/null && kill -9 "$PID" && sleep 1
STAGE="$DEST.updating"
OLD="$DEST.old"
rm -rf "$STAGE" "$OLD"
if /usr/bin/ditto "$SRC" "$STAGE"; then
  /usr/bin/xattr -dr com.apple.quarantine "$STAGE" 2>/dev/null
  if mv "$DEST" "$OLD" && mv "$STAGE" "$DEST"; then
    rm -rf "$OLD"
    echo "$(date) update: installed"
  else
    echo "$(date) update: swap failed, restoring"
    [ -d "$DEST" ] || mv "$OLD" "$DEST"
    rm -rf "$STAGE"
  fi
else
  echo "$(date) update: copy failed"
  rm -rf "$STAGE"
fi
/usr/bin/hdiutil detach "$MOUNT" -quiet || /usr/bin/hdiutil detach "$MOUNT" -force -quiet
rmdir "$MOUNT" 2>/dev/null
/usr/bin/open "$DEST"
`

/**
 * Start the install. The caller quits the app straight after: on Windows the
 * installer closes anything left running itself; on a Mac the script waits for
 * this process to be gone before touching the bundle.
 */
export const launchInstaller = async (file: string, kind: InstallerKind): Promise<void> => {
  if (kind === 'exe') {
    // What electron-updater passes a one-click NSIS installer on a silent update.
    spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return
  }

  if (kind === 'dmg') {
    const problem = macInstallProblem()
    if (problem) throw new Error(problem)

    const mountPoint = await attachDmg(file)
    let appPath: string
    try {
      appPath = (await inspectMountedApp(mountPoint)).appPath
    } catch (error) {
      await detachDmg(mountPoint)
      throw error
    }

    const script = join(updatesDir(), 'install-update.sh')
    writeFileSync(script, MAC_SCRIPT, { mode: 0o755 })
    const log = openSync(join(app.getPath('logs'), 'update-install.log'), 'a')
    spawn('/bin/bash', [script, String(process.pid), appPath, macBundlePath(), mountPoint], {
      detached: true,
      stdio: ['ignore', log, log]
    }).unref()
    closeSync(log)
    return
  }

  throw new Error('Installing updates is not supported on this computer yet.')
}
