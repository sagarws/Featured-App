import { useCallback, useEffect, useState } from 'react'
import type { ScreenshotEnvironment, ScreenshotFile, ScreenshotSettings } from '@shared/types/screenshot'

const api = () => window.printAgent.screenshot

/** Screenshot settings and environment (shortcut status, folder, permission), kept fresh. */
export const useScreenshotSettings = (): {
  settings: ScreenshotSettings | null
  env: ScreenshotEnvironment | null
  update: (patch: Partial<ScreenshotSettings>) => Promise<string | null>
  reload: () => Promise<void>
} => {
  const [settings, setSettings] = useState<ScreenshotSettings | null>(null)
  const [env, setEnv] = useState<ScreenshotEnvironment | null>(null)

  const reload = useCallback(
    () =>
      Promise.all([api().getSettings(), api().environment()]).then(([s, e]) => {
        if (s.ok) setSettings(s.value)
        if (e.ok) setEnv(e.value)
      }),
    []
  )

  useEffect(() => {
    void Promise.all([api().getSettings(), api().environment()]).then(([s, e]) => {
      if (s.ok) setSettings(s.value)
      if (e.ok) setEnv(e.value)
    })
    const off = api().onChanged(() => void reload())
    // Permission and login item can change outside the app.
    const onFocus = () => void reload()
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [reload])

  const update = useCallback(async (patch: Partial<ScreenshotSettings>) => {
    const r = await api().updateSettings(patch)
    if (!r.ok) return r.error
    setSettings(r.value)
    const e = await api().environment()
    if (e.ok) setEnv(e.value)
    return null
  }, [])

  return { settings, env, update, reload }
}

/** The newest files in the screenshots folder. */
export const useRecentScreenshots = (): { files: ScreenshotFile[] | null; refresh: () => Promise<void> } => {
  const [files, setFiles] = useState<ScreenshotFile[] | null>(null)
  const refresh = useCallback(() => api().listRecent().then(r => setFiles(r.ok ? r.value : [])), [])
  useEffect(() => {
    void api()
      .listRecent()
      .then(r => setFiles(r.ok ? r.value : []))
    const off = api().onLibraryChanged(() => void refresh())
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])
  return { files, refresh }
}
