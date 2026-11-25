/**
 * Auto-update: where each build of the app asks "what is the latest version?".
 *
 * Every platform/architecture has its own entry in the software-versions list
 * (check-otp → GET /api/software/<name>), which answers
 *   { softwareName, version, link, updatedAt }
 * where `link` is the installer on Google Drive. No latest.yml is involved.
 *
 * The key is `${process.platform}-${process.arch}` of the RUNNING app. A null
 * entry means "no build published for this machine yet": the app shows that
 * updates are not available instead of checking someone else's installer.
 *
 * Each entry names the installer the link must point at, so a mixed-up link
 * (a .dmg handed to Windows) is refused before anything is run. The build
 * names every installer <softwareName>.<installer> (scripts/name-installers.cjs),
 * so the file to upload matches its entry here.
 */

export const UPDATE_API_BASE = 'https://check-otp-khaki.vercel.app/api/software'

export type UpdateTarget =
  | 'win32-x64'
  | 'win32-ia32'
  | 'win32-arm64'
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64'
  | 'linux-arm64'

export type InstallerKind = 'exe' | 'dmg' | 'appimage'

export interface UpdateFeed {
  /** Name in the software-versions list. */
  softwareName: string
  /** Version-check API for this build. */
  url: string
  /** What the link must download. */
  installer: InstallerKind
}

const feed = (softwareName: string, installer: InstallerKind): UpdateFeed => ({
  softwareName,
  url: `${UPDATE_API_BASE}/${encodeURIComponent(softwareName)}`,
  installer
})

export const UPDATE_FEEDS: Record<UpdateTarget, UpdateFeed | null> = {
  /** Windows 64-bit (Intel/AMD). Installer: Featured-App-x64.exe */
  'win32-x64': feed('Featured-App-x64', 'exe'),
  /** Windows 32-bit. Not published yet. */
  'win32-ia32': null,
  /** Windows on ARM. Not published yet. */
  'win32-arm64': null,
  /** Mac, Apple Silicon (M1 and later). Installer: Featured-App-arm64.dmg */
  'darwin-arm64': feed('Featured-App-arm64', 'dmg'),
  /**
   * Mac, Intel (2019 and older MacBooks). Installer: Featured-App-mac-pro-x64.dmg.
   * Its own name in check-otp — "Featured-App-x64" is the Windows installer.
   */
  'darwin-x64': feed('Featured-App-mac-pro-x64', 'dmg'),
  /** Linux. Not published yet. */
  'linux-x64': null,
  'linux-arm64': null
}

/** The feed for this machine, or null when no build is published for it. */
export const updateFeedFor = (platform: string, arch: string): UpdateFeed | null =>
  (UPDATE_FEEDS as Record<string, UpdateFeed | null | undefined>)[`${platform}-${arch}`] ?? null

export const UPDATE_CHECK = {
  /** First check after start: late enough not to slow the start itself. */
  firstDelayMs: 10_000,
  /** Then again while the app stays open (it lives in the tray for days). */
  intervalMs: 6 * 60 * 60 * 1000,
  /** The version API. */
  timeoutMs: 15_000,
  /** The installer: no bytes for this long and the download is abandoned. */
  stallTimeoutMs: 60_000,
  /** An installer smaller than this is an error page, not an app. */
  minInstallerBytes: 5 * 1024 * 1024,
  /** Grace before the app quits to install, so the window can say so. */
  installDelayMs: 2_500,
  /**
   * Automatic installs of the SAME version before giving up on it. Stops a
   * restart loop when the server lists a version whose installer is actually
   * an older build (it installs, the app is still behind, it installs again…).
   * "Update now" always works.
   */
  maxAutoAttempts: 2
} as const
