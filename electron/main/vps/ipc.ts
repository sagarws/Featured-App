import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { VPS_IPC } from '@shared/constants/channels'
import type { Result } from '@shared/types/agent'
import type { VpsConvertOptions, VpsDisconnectOptions, VpsLoginChange } from '@shared/types/vps'
import { isAccessMode, isVpsPassword, isVpsUsername } from '@shared/utils/vps'
import { logger } from '../logger'
import { getWindow, isRendererUrl } from '../window'
import * as manager from './manager'
import { checkPublicIp, getNetwork } from './network'

/*
 * VPS Manager IPC: the main window only, a fixed set of operations, every
 * argument checked here. There is no way to send a command, a path or a
 * script from the window — the main process builds those itself.
 */

const allowed = (event: IpcMainInvokeEvent): boolean =>
  isRendererUrl(event.senderFrame?.url ?? '') && !event.sender.isDestroyed() && getWindow()?.webContents.id === event.sender.id

const handle = <T>(channel: string, fn: (...args: unknown[]) => T | Promise<T>): void => {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<Result<T>> => {
    if (!allowed(event)) {
      logger.warn(`[vps] refused ${channel} from an unexpected window`)
      return { ok: false, error: 'Not allowed.' }
    }
    try {
      return { ok: true, value: await fn(...args) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`[vps] ${channel} failed: ${message}`)
      return { ok: false, error: message }
    }
  })
}

const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid request.')
  return v as Record<string, unknown>
}

const optionalPassword = (v: unknown): string | undefined => {
  if (v === undefined) return undefined
  if (!isVpsPassword(v)) throw new Error('That password is not allowed (8–128 characters, no spaces, quotes, backslash or colon).')
  return v
}

const username = (v: unknown): string => {
  if (!isVpsUsername(v)) throw new Error('That username is not allowed.')
  return v
}

const convertOptions = (v: unknown): VpsConvertOptions => {
  const o = record(v)
  if (!isAccessMode(o['accessMode']) || typeof o['firewallConsent'] !== 'boolean') throw new Error('Invalid request.')
  const password = optionalPassword(o['password'])
  return { accessMode: o['accessMode'], firewallConsent: o['firewallConsent'], username: username(o['username']), ...(password ? { password } : {}) }
}

const loginChange = (v: unknown): VpsLoginChange => {
  const o = record(v)
  const password = optionalPassword(o['password'])
  return { username: username(o['username']), ...(password ? { password } : {}) }
}

const disconnectOptions = (v: unknown): VpsDisconnectOptions => {
  const o = record(v)
  if (typeof o['removeUser'] !== 'boolean') throw new Error('Invalid request.')
  return { removeUser: o['removeUser'] }
}

export const registerVpsIpc = (): void => {
  handle(VPS_IPC.getStatus, async () => {
    await manager.probe()
    return manager.status()
  })
  handle(VPS_IPC.systemInfo, () => manager.systemInfo())
  handle(VPS_IPC.network, () => getNetwork())
  handle(VPS_IPC.checkPublicIp, async () => {
    await checkPublicIp()
    return getNetwork()
  })
  handle(VPS_IPC.metrics, () => manager.metrics())
  handle(VPS_IPC.convert, options => manager.convert(convertOptions(options)))
  handle(VPS_IPC.disconnect, options => manager.disconnect(disconnectOptions(options)))
  handle(VPS_IPC.recover, () => manager.recover())
  handle(VPS_IPC.regeneratePassword, password => manager.regeneratePassword(optionalPassword(password)))
  handle(VPS_IPC.changeLogin, change => manager.changeLogin(loginChange(change)))
  handle(VPS_IPC.revealPassword, () => manager.revealPassword())
  handle(VPS_IPC.setAccessMode, mode => {
    if (!isAccessMode(mode)) throw new Error('Invalid request.')
    return manager.setAccessMode(mode)
  })
  handle(VPS_IPC.clearSteps, () => manager.clearSteps())
}
