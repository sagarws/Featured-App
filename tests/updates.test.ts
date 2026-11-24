import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { UpdateStatus } from '@shared/types/agent'

interface Holder {
  fetch: Mock<(url: string) => Promise<Response>>
  openExternal: Mock<(url: string) => Promise<void>>
  notifyUser: Mock<(title: string, body: string) => void>
  downloadInstaller: Mock<(...args: unknown[]) => Promise<string>>
  launchInstaller: Mock<(...args: unknown[]) => Promise<void>>
  quit: Mock<() => void>
  status: UpdateStatus
  autoUpdate: boolean
  packaged: boolean
}

const h = vi.hoisted(
  (): Holder => ({
    fetch: vi.fn<(url: string) => Promise<Response>>(),
    openExternal: vi.fn<(url: string) => Promise<void>>(),
    notifyUser: vi.fn<(title: string, body: string) => void>(),
    downloadInstaller: vi.fn<(...args: unknown[]) => Promise<string>>(),
    launchInstaller: vi.fn<(...args: unknown[]) => Promise<void>>(),
    quit: vi.fn<() => void>(),
    status: { state: 'idle' },
    autoUpdate: true,
    packaged: true
  })
)

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.1.4',
    getPath: () => '/tmp/featured-app-test',
    get isPackaged() {
      return h.packaged
    },
    quit: h.quit,
    exit: vi.fn()
  },
  net: { fetch: h.fetch },
  shell: { openExternal: h.openExternal }
}))
vi.mock('../electron/main/notify', () => ({ notifyUser: h.notifyUser }))
vi.mock('../electron/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../electron/main/settings', () => ({ getSettings: () => ({ autoUpdate: h.autoUpdate }) }))
vi.mock('../electron/main/recorder/session', () => ({ hasActiveRecording: () => false }))
vi.mock('../electron/main/durableJson', () => ({
  readDurableJson: () => {
    throw new Error('none')
  },
  writeDurableJson: vi.fn()
}))
vi.mock('../electron/main/updateInstall', () => ({
  cleanOldInstallers: vi.fn(),
  downloadInstaller: h.downloadInstaller,
  launchInstaller: h.launchInstaller,
  macInstallProblem: () => null
}))
vi.mock('../electron/main/state', () => ({
  getUpdateStatus: () => h.status,
  setUpdateStatus: (next: UpdateStatus) => (h.status = next)
}))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const load = async () => import('../electron/main/updates')
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  h.fetch.mockReset()
  h.openExternal.mockReset()
  h.notifyUser.mockReset()
  h.downloadInstaller.mockReset().mockResolvedValue('/tmp/featured-app-test/updates/Featured-App-0.2.0.dmg')
  h.launchInstaller.mockReset().mockResolvedValue(undefined)
  h.quit.mockReset()
  h.status = { state: 'idle' }
  h.autoUpdate = true
  h.packaged = true
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  Object.defineProperty(process, 'arch', { value: 'arm64' })
})

afterEach(() => {
  vi.useRealTimers()
})

const newer = { softwareName: 'Featured-App-arm64', version: '0.2.0', link: 'https://drive.google.com/file/d/abcdefghijkl/view' }

describe('checkForUpdates', () => {
  it("asks this machine's own feed", async () => {
    h.autoUpdate = false
    h.fetch.mockResolvedValue(json(newer))
    const { checkForUpdates } = await load()

    const status = await checkForUpdates()
    await checkForUpdates()

    expect(h.fetch.mock.calls[0]?.[0]).toBe('https://check-otp-khaki.vercel.app/api/software/Featured-App-arm64')
    expect(status).toMatchObject({ state: 'available', latestVersion: '0.2.0' })
    // Auto update off: offered once, nothing downloaded.
    expect(h.notifyUser).toHaveBeenCalledTimes(1)
    expect(h.downloadInstaller).not.toHaveBeenCalled()
  })

  it('is current when the listed version is the same or older', async () => {
    h.fetch.mockResolvedValue(json({ ...newer, version: '0.1.4' }))
    const { checkForUpdates } = await load()
    expect(await checkForUpdates()).toMatchObject({ state: 'current', latestVersion: '0.1.4' })
    expect(h.downloadInstaller).not.toHaveBeenCalled()
  })

  it('refuses an answer meant for a different build', async () => {
    h.fetch.mockResolvedValue(json({ ...newer, softwareName: 'Featured-App-x64' }))
    const { checkForUpdates } = await load()
    expect(await checkForUpdates()).toMatchObject({ state: 'error' })
  })

  it('explains a missing entry, a bad answer and an unreachable server', async () => {
    const { checkForUpdates } = await load()
    const errorOf = (status: UpdateStatus): string => (status.state === 'error' ? status.error : `not an error: ${status.state}`)

    h.fetch.mockResolvedValueOnce(json({ error: 'not found' }, 404))
    expect(errorOf(await checkForUpdates())).toContain('not listed')

    h.fetch.mockResolvedValueOnce(json({ version: '9.9.9', link: 'file:///bad' }))
    expect(errorOf(await checkForUpdates())).toContain('could not read')

    h.fetch.mockRejectedValueOnce(new TypeError('net::ERR_CONNECTION_REFUSED'))
    expect(await checkForUpdates()).toMatchObject({ state: 'error', error: 'Could not reach the update server.' })
  })

  it('is unsupported where no build is published', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    Object.defineProperty(process, 'arch', { value: 'x64' })
    const { checkForUpdates } = await load()
    expect(await checkForUpdates()).toMatchObject({ state: 'unsupported' })
    expect(h.fetch).not.toHaveBeenCalled()
  })
})

describe('auto update', () => {
  it('on start: downloads, then quits to install', async () => {
    h.fetch.mockResolvedValue(json(newer))
    const { checkForUpdates } = await load()

    await checkForUpdates(true)
    await flush()
    expect(h.downloadInstaller).toHaveBeenCalledWith(newer.link, '0.2.0', 'dmg', expect.any(Function))
    expect(h.status).toMatchObject({ state: 'installing', latestVersion: '0.2.0' })

    await vi.runAllTimersAsync()
    expect(h.launchInstaller).toHaveBeenCalledWith('/tmp/featured-app-test/updates/Featured-App-0.2.0.dmg', 'dmg')
    expect(h.quit).toHaveBeenCalled()
  })

  it('later in the day: downloads and waits for the next start', async () => {
    h.fetch.mockResolvedValue(json(newer))
    const { checkForUpdates } = await load()

    await checkForUpdates(false)
    await flush()
    expect(h.status).toMatchObject({ state: 'ready', latestVersion: '0.2.0' })
    expect(h.launchInstaller).not.toHaveBeenCalled()
    expect(h.quit).not.toHaveBeenCalled()
  })

  it('reports a failed download and keeps the link for a retry', async () => {
    h.fetch.mockResolvedValue(json(newer))
    h.downloadInstaller.mockRejectedValue(new Error('The downloaded file is not a dmg installer.'))
    const { checkForUpdates } = await load()

    await checkForUpdates(true)
    await flush()
    expect(h.status).toMatchObject({ state: 'error', error: 'The downloaded file is not a dmg installer.', link: newer.link })
    expect(h.quit).not.toHaveBeenCalled()
  })

  it('never installs from a dev run', async () => {
    h.packaged = false
    h.fetch.mockResolvedValue(json(newer))
    const { checkForUpdates, installUpdate } = await load()

    expect(await checkForUpdates(true)).toMatchObject({ state: 'available' })
    expect(h.downloadInstaller).not.toHaveBeenCalled()
    expect(() => installUpdate()).toThrow('installed app')
  })
})

describe('installUpdate (Update now)', () => {
  it('installs an available version even with auto update off', async () => {
    h.autoUpdate = false
    h.fetch.mockResolvedValue(json(newer))
    const { checkForUpdates, installUpdate } = await load()

    await checkForUpdates()
    installUpdate()
    await flush()
    await vi.runAllTimersAsync()
    expect(h.launchInstaller).toHaveBeenCalled()
    expect(h.quit).toHaveBeenCalled()
  })

  it('refuses when there is nothing newer', async () => {
    const { installUpdate } = await load()
    expect(() => installUpdate()).toThrow('No newer version')
  })
})

describe('openUpdateLink', () => {
  it('opens only the link the server gave', async () => {
    const { openUpdateLink } = await load()
    await expect(openUpdateLink()).rejects.toThrow('No update')

    h.status = { state: 'available', latestVersion: '0.2.0', link: 'https://dl.test/a.dmg', checkedAt: 'x' }
    await openUpdateLink()
    expect(h.openExternal).toHaveBeenCalledWith('https://dl.test/a.dmg')
  })
})
