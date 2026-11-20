import { globalShortcut } from 'electron'
import type { HotkeyStatus, ScreenshotAction, ScreenshotHotkeys } from '@shared/types/screenshot'
import { SCREENSHOT_ACTIONS } from '@shared/utils/screenshot'
import { logger } from '../logger'

/*
 * System-wide shortcuts. Registered whenever the settings change; a shortcut
 * another app (or the OS) already owns cannot be registered and is reported
 * back to the page as such. While a shortcut field is recording keys, all of
 * them are paused so pressing the current one records instead of capturing.
 */

let registered: string[] = []
let statuses: HotkeyStatus[] = []
let last: { hotkeys: ScreenshotHotkeys; run: (action: ScreenshotAction) => void } | null = null
let suspended = false

const unregister = (): void => {
  for (const accelerator of registered) {
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      // already gone
    }
  }
  registered = []
}

export const applyHotkeys = (hotkeys: ScreenshotHotkeys, run: (action: ScreenshotAction) => void): HotkeyStatus[] => {
  last = { hotkeys, run }
  // Paused: registered again, with these keys, when the pause ends.
  if (suspended) return statuses
  unregister()
  const seen = new Set<string>()
  statuses = SCREENSHOT_ACTIONS.map(action => {
    const accelerator = hotkeys[action]
    if (!accelerator) return { action, accelerator, registered: false }
    // The same keys on two actions: the first one wins.
    if (seen.has(accelerator)) return { action, accelerator, registered: false }
    seen.add(accelerator)
    let ok = false
    try {
      ok = globalShortcut.register(accelerator, () => run(action))
    } catch (error) {
      logger.warn(`[screenshot] shortcut ${accelerator} refused`, error)
    }
    if (ok) registered.push(accelerator)
    else logger.warn(`[screenshot] shortcut ${accelerator} for ${action} is taken`)
    return { action, accelerator, registered: ok }
  })
  return statuses
}

export const hotkeyStatuses = (): HotkeyStatus[] => statuses

export const suspendHotkeys = (pause: boolean): void => {
  if (suspended === pause) return
  suspended = pause
  if (pause) unregister()
  else if (last) applyHotkeys(last.hotkeys, last.run)
}

export const releaseHotkeys = (): void => {
  unregister()
  last = null
}
