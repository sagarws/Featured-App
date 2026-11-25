import { BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { REMOTE_IPC } from '@shared/constants/channels'
import type { Result } from '@shared/types/agent'
import type { ConnectRequest, QualityPreset, RemotePermission, RemoteSettings } from '@shared/types/remote'
import { isDeviceId, isSessionMinutes, parseInputEvent, QUALITY_PRESETS, stripControl } from '@shared/utils/remote'
import { logger } from '../logger'
import { getWindow, isRendererUrl } from '../window'
import { parseSignal } from './signal'
import * as service from './service'
import * as store from './store'

/*
 * Remote Desktop IPC. Every call must come from this app's own page, and each
 * group is further limited to the window that owns it:
 *
 *   management   the main window only (settings, passwords, connect, revoke)
 *   host bar     the host bar or the main window (stop, view-only, extend)
 *   request      the request window for *its* request, or the main window
 *   viewer       a viewer window, for *its own* session only
 *   engine       a capture window, for *its own* session only — and input it
 *                forwards is still checked against the session (hostSession.ts)
 */

type Role = 'main' | 'hostbar'

const fromApp = (sender: WebContents, url: string): boolean => isRendererUrl(url) && !sender.isDestroyed()
const isMain = (sender: WebContents): boolean => getWindow()?.webContents.id === sender.id

const handle = <T>(channel: string, roles: Role[] | null, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>): void => {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<Result<T>> => {
    if (!fromApp(event.sender, event.senderFrame?.url ?? '')) return { ok: false, error: 'Not allowed.' }
    if (roles) {
      const allowed = (roles.includes('main') && isMain(event.sender)) || (roles.includes('hostbar') && service.isHostBar(event.sender))
      if (!allowed) {
        logger.warn(`[remote] refused ${channel} from an unexpected window`)
        return { ok: false, error: 'Not allowed.' }
      }
    }
    try {
      return { ok: true, value: await fn(event, ...args) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!(error as { code?: string }).code) logger.warn(`[remote] ${channel} failed: ${message}`)
      return { ok: false, error: message }
    }
  })
}

const listen = (channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void): void => {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    if (fromApp(event.sender, event.senderFrame?.url ?? '')) fn(event, ...args)
  })
}

const sessionId = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[0-9a-f]{32}$/.test(v)) throw new Error('Unknown session.')
  return v
}
const shortId = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[0-9a-f]{24}$/.test(v)) throw new Error('Unknown item.')
  return v
}
const deviceId = (v: unknown): string => {
  if (!isDeviceId(v)) throw new Error('Unknown device.')
  return v
}
const permission = (v: unknown): RemotePermission => (v === 'view' ? 'view' : 'control')

const viewerOf = (event: IpcMainInvokeEvent | IpcMainEvent) => {
  const session = service.viewerSessionForWindow(event.sender)
  if (!session) throw new Error('Not allowed.')
  return session
}
const engineOf = (event: IpcMainInvokeEvent | IpcMainEvent) => {
  const session = service.hostSessionForEngine(event.sender)
  if (!session) throw new Error('Not allowed.')
  return session
}

/** Only known settings, with known types; the rest is ignored (and sanitised again by the store). */
const settingsPatch = (raw: unknown): Partial<RemoteSettings> => {
  if (!raw || typeof raw !== 'object') throw new Error('Expected settings.')
  const keys: (keyof RemoteSettings)[] = Object.keys(store.getRemoteSettings()) as (keyof RemoteSettings)[]
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (keys.includes(k as keyof RemoteSettings)) out[k] = v
  return out
}

const PRIVACY: Record<string, Partial<Record<NodeJS.Platform, string>>> = {
  screen: { darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' },
  accessibility: { darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' },
  firewall: { darwin: 'x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall', win32: 'ms-settings:windowsdefender' }
}

export const registerRemoteIpc = (): void => {
  // ── management (main window) ──
  handle(REMOTE_IPC.getStatus, ['main', 'hostbar'], () => service.status())
  handle(REMOTE_IPC.history, ['main'], () => store.readHistory(500))
  handle(REMOTE_IPC.clearHistory, ['main'], () => store.clearHistory())
  handle(REMOTE_IPC.updateSettings, ['main'], (_e, patch) => service.updateSettings(settingsPatch(patch)))
  handle(REMOTE_IPC.setPassword, ['main'], (_e, password) => {
    if (typeof password !== 'string') throw new Error('Expected a password.')
    return service.setPassword(password)
  })
  handle(REMOTE_IPC.clearPassword, ['main'], () => service.clearPassword())
  handle(REMOTE_IPC.setTurnCredential, ['main'], (_e, value) => {
    if (typeof value !== 'string') throw new Error('Expected text.')
    store.setTurnCredential(value)
  })
  handle(REMOTE_IPC.connect, ['main'], (event, request, attemptId) => {
    const r = request as Partial<ConnectRequest> | null
    if (!r || typeof r.target !== 'string' || r.target.length > 300) throw new Error('Enter a device ID.')
    if (r.password !== undefined && (typeof r.password !== 'string' || r.password.length > 256)) throw new Error('Bad password.')
    if (r.useSavedPassword !== undefined && typeof r.useSavedPassword !== 'boolean') throw new Error('Bad request.')
    if (r.remember !== undefined && typeof r.remember !== 'boolean') throw new Error('Bad request.')
    return service.connect(
      {
        target: r.target,
        ...(r.password ? { password: r.password } : {}),
        ...(r.useSavedPassword ? { useSavedPassword: true } : {}),
        ...(r.remember !== undefined ? { remember: r.remember } : {})
      },
      event.sender,
      shortId(attemptId)
    )
  })
  handle(REMOTE_IPC.cancelConnect, ['main'], (_e, attemptId) => service.cancelConnect(shortId(attemptId)))
  handle(REMOTE_IPC.disconnect, ['main'], (_e, id) => service.disconnectOutgoing(sessionId(id)))
  handle(REMOTE_IPC.focusViewer, ['main'], (_e, id) => service.viewerSession(sessionId(id))?.openWindow())
  handle(REMOTE_IPC.refreshDiscovery, ['main'], () => service.refreshDiscovery())
  handle(REMOTE_IPC.updateDevice, ['main'], (_e, id, patch) => {
    const p = (patch ?? {}) as { name?: unknown; favorite?: unknown }
    store.updateSavedDevice(deviceId(id), {
      ...(typeof p.name === 'string' ? { name: stripControl(p.name).trim() } : {}),
      ...(typeof p.favorite === 'boolean' ? { favorite: p.favorite } : {})
    })
    service.notify()
  })
  handle(REMOTE_IPC.forgetDevice, ['main'], (_e, id) => {
    const device = deviceId(id)
    store.forgetDevice(device)
    store.forgetSavedPassword(device)
    service.notify()
  })
  handle(REMOTE_IPC.forgetSavedPassword, ['main'], (_e, id) => {
    store.forgetSavedPassword(deviceId(id))
    service.notify()
  })
  handle(REMOTE_IPC.forgetAllSavedPasswords, ['main'], () => {
    store.forgetAllSavedPasswords()
    service.notify()
  })
  handle(REMOTE_IPC.revokeDevice, ['main'], (_e, id) => service.revokeDevice(deviceId(id)))
  handle(REMOTE_IPC.revokeAll, ['main'], () => service.revokeAll())
  handle(REMOTE_IPC.unblockDevice, ['main'], (_e, id) => {
    store.unblockDevice(deviceId(id))
    service.notify()
  })
  handle(REMOTE_IPC.probe, ['main'], (_e, target) => {
    if (typeof target !== 'string' || target.length > 300) throw new Error('Enter a device ID.')
    return service.probe(target)
  })
  handle(REMOTE_IPC.diagnostics, ['main'], () => service.diagnostics())
  handle(REMOTE_IPC.openPrivacy, ['main'], async (_e, pane) => {
    const url = PRIVACY[String(pane)]?.[process.platform]
    if (!url) throw new Error('Open the settings from your system menu.')
    await shell.openExternal(url)
  })
  handle(REMOTE_IPC.requestAccessibility, ['main'], () => service.requestInputPermission())
  handle(REMOTE_IPC.installSecureAgent, ['main'], () => service.installSecureAgent())
  handle(REMOTE_IPC.removeSecureAgent, ['main'], () => service.removeSecureAgent())
  handle(REMOTE_IPC.chooseTrustedFolder, ['main'], async event => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { title: 'Folder for files from trusted transfers', defaultPath: store.getRemoteSettings().trustedFolder || service.defaultTransferFolder(), properties: ['openDirectory', 'createDirectory'] }
    const pick = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const folder = pick.canceled ? null : (pick.filePaths[0] ?? null)
    if (folder) service.updateSettings({ trustedFolder: folder })
    return folder
  })
  handle(REMOTE_IPC.cancelTransfer, ['main', 'hostbar'], (_e, id) => service.cancelTransfer(shortId(id)))

  // ── host-side session controls (main window or host bar) ──
  handle(REMOTE_IPC.endIncoming, ['main', 'hostbar'], (_e, id) => service.endIncoming(sessionId(id)))
  handle(REMOTE_IPC.endAllIncoming, ['main', 'hostbar'], () => service.endAllIncoming())
  handle(REMOTE_IPC.setSessionPermission, ['main', 'hostbar'], (_e, id, p) => service.hostSession(sessionId(id))?.setPermission(permission(p)))
  handle(REMOTE_IPC.extendSession, ['main', 'hostbar'], (_e, id, minutes) => {
    if (!isSessionMinutes(minutes)) throw new Error('Unknown duration.')
    service.hostSession(sessionId(id))?.extend(minutes)
  })

  // ── send files: main window / host bar for host sessions, a viewer for its own session ──
  handle(REMOTE_IPC.sendFiles, null, async (event, id) => {
    const sid = sessionId(id)
    const viewer = service.viewerSessionForWindow(event.sender)
    if (!(isMain(event.sender) || service.isHostBar(event.sender) || viewer?.id === sid)) throw new Error('Not allowed.')
    await service.sendFiles(sid, BrowserWindow.fromWebContents(event.sender))
  })

  // ── incoming request window ──
  handle(REMOTE_IPC.requestInfo, null, (event, id) => {
    const rid = shortId(id)
    if (!isMain(event.sender) && service.requestForWindow(event.sender) !== rid) throw new Error('Not allowed.')
    return service.requestInfo(rid)
  })
  handle(REMOTE_IPC.answerRequest, null, (event, id, answer) => {
    const rid = shortId(id)
    if (!isMain(event.sender) && service.requestForWindow(event.sender) !== rid) throw new Error('Not allowed.')
    const a = (answer ?? {}) as { allow?: unknown; permission?: unknown; minutes?: unknown }
    if (a.allow === true && !isSessionMinutes(a.minutes)) throw new Error('Choose how long.')
    service.answerRequest(rid, { allow: a.allow === true, permission: permission(a.permission), minutes: isSessionMinutes(a.minutes) ? a.minutes : 30 })
  })

  // ── viewer window ──
  handle(REMOTE_IPC.viewerConfig, null, event => viewerOf(event).config())
  handle(REMOTE_IPC.viewerReady, null, event => viewerOf(event).viewerReady())
  handle(REMOTE_IPC.viewerRestart, null, event => viewerOf(event).restartMedia())
  handle(REMOTE_IPC.viewerCtrlAltDel, null, event => viewerOf(event).sendCtrlAltDel())
  handle(REMOTE_IPC.viewerQuality, null, (event, preset, priority) => {
    if (!QUALITY_PRESETS.includes(preset as QualityPreset)) throw new Error('Unknown quality.')
    viewerOf(event).setQuality(preset as QualityPreset, priority === 'responsiveness' ? 'responsiveness' : 'readability')
  })
  handle(REMOTE_IPC.viewerDisplay, null, (event, id) => {
    if (typeof id !== 'string' || id.length > 64) throw new Error('Unknown display.')
    viewerOf(event).setDisplay(id)
  })
  handle(REMOTE_IPC.viewerClipboard, null, event => viewerOf(event).sendClipboard())
  listen(REMOTE_IPC.viewerSignal, (event, signal) => {
    const parsed = parseSignal(signal)
    const session = service.viewerSessionForWindow(event.sender)
    if (parsed && session) session.signal(parsed)
  })
  listen(REMOTE_IPC.viewerCapture, (event, on) => {
    const session = service.viewerSessionForWindow(event.sender)
    if (session) session.capture = on === true
  })

  // ── host capture window ──
  handle(REMOTE_IPC.engineConfig, null, event => {
    const session = engineOf(event)
    const s = store.getRemoteSettings()
    return {
      sessionId: session.id,
      displayId: session.displayId,
      quality: session.quality,
      priority: s.priority,
      codec: s.codec,
      hardwareAcceleration: s.hardwareAcceleration,
      iceServers: service.iceServers()
    }
  })
  handle(REMOTE_IPC.engineArm, null, (event, displayId) => {
    if (typeof displayId !== 'string') throw new Error('Unknown display.')
    if (!engineOf(event).armCapture(displayId)) throw new Error('That display is not available.')
  })
  listen(REMOTE_IPC.engineSignal, (event, signal) => {
    const parsed = parseSignal(signal)
    const session = service.hostSessionForEngine(event.sender)
    if (parsed && session) session.engineSignal(parsed)
  })
  listen(REMOTE_IPC.engineState, (event, state) => {
    const session = service.hostSessionForEngine(event.sender)
    if (!session || !state || typeof state !== 'object') return
    const s = state as { kind?: unknown; id?: unknown; message?: unknown }
    if (s.kind === 'ready') return session.engineLoaded()
    session.engineState({
      kind: String(s.kind),
      ...(typeof s.id === 'string' ? { id: s.id } : {}),
      ...(typeof s.message === 'string' ? { message: s.message } : {})
    })
  })
  // Input is high-frequency: one-way, parsed and permission-checked per event.
  listen(REMOTE_IPC.engineInput, (event, raw) => {
    const session = service.hostSessionForEngine(event.sender)
    if (!session || !Array.isArray(raw) || raw.length > 64) return
    const events = raw.map(parseInputEvent).filter((e): e is NonNullable<typeof e> => e !== null)
    if (events.length) session.inject(events)
  })
}
