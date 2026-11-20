import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from '@shared/constants/agent'
import type { AgentState } from '@shared/types/agent'
import type { ScreenshotAction } from '@shared/types/screenshot'
import { getScreenshotSettings, screenshotsFolder } from './screenshot/config'
import { takeScreenshot } from './screenshot/service'
import { showWindow } from './window'

/*
 * The menu-bar (macOS) / notification-area (Windows) icon: screenshots one
 * click away, the agent's status, and Quit. It can be hidden from
 * Screenshots → Advanced; the app is then opened by launching it again.
 */

type TrayActions = { toggleOpenAtLogin: (enabled: boolean) => void; quit: () => void }

let tray: Tray | null = null
let last: { state: AgentState; actions: TrayActions } | null = null
let visible = true

const iconPath = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'trayIcon.png') : join(app.getAppPath(), 'build', 'icon.png')

const statusLine = (state: AgentState): string => {
  switch (state.server.state) {
    case 'listening': {
      const problems = state.printers.filter(printer => ['offline', 'paused', 'error'].includes(printer.status.state))
      if (problems.length === 1 && problems[0]) return `${problems[0].displayName}: ${problems[0].status.message}`
      if (problems.length > 1) return `Ready — ${problems.length} printers need attention`
      return `Ready — ${state.printers.length} printer(s)`
    }
    case 'failed':
      return 'Not running — open for details'
    default:
      return 'Starting…'
  }
}

const shotItem = (label: string, action: ScreenshotAction): MenuItemConstructorOptions => {
  const accelerator = getScreenshotSettings().hotkeys[action]
  return {
    label,
    // Shown next to the item only; the real shortcut is registered globally.
    ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
    click: () => void takeScreenshot(action, 'tray')
  }
}

const buildMenu = (state: AgentState, actions: TrayActions): Menu =>
  Menu.buildFromTemplate([
    shotItem('Capture Area', 'area'),
    shotItem('Capture Fullscreen', 'fullscreen'),
    shotItem('Capture Window', 'window'),
    shotItem('Capture Active Window', 'activeWindow'),
    shotItem('Repeat Last Area', 'repeatArea'),
    {
      label: 'Open Screenshots Folder',
      click: () => {
        const folder = screenshotsFolder()
        mkdirSync(folder, { recursive: true })
        void shell.openPath(folder)
      }
    },
    { type: 'separator' },
    { label: statusLine(state), enabled: false },
    { label: `Open ${APP_NAME}`, click: () => showWindow() },
    {
      label: 'Start when I log in',
      type: 'checkbox',
      checked: state.openAtLogin,
      enabled: app.isPackaged,
      click: item => actions.toggleOpenAtLogin(item.checked)
    },
    { type: 'separator' },
    { label: 'Quit (printing stops)', click: () => actions.quit() }
  ])

const build = (): void => {
  if (!last) return
  if (!visible) {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    const image = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 })
    tray = new Tray(image)
    tray.setToolTip(APP_NAME)
    tray.on('click', () => {
      // Windows opens on a left click; macOS shows the menu, as menu-bar apps do.
      if (process.platform === 'win32') showWindow()
    })
  }
  tray.setContextMenu(buildMenu(last.state, last.actions))
}

export const createTray = (state: AgentState, actions: TrayActions): void => {
  last = { state, actions }
  build()
}

export const updateTray = (state: AgentState, actions: TrayActions): void => {
  last = { state, actions }
  if (tray) tray.setContextMenu(buildMenu(state, actions))
}

/** Show or hide the icon; also rebuilds the menu (the shortcuts shown in it may have changed). */
export const setTrayVisible = (show: boolean): void => {
  visible = show
  build()
}

export const destroyTray = (): void => {
  tray?.destroy()
  tray = null
  last = null
}
