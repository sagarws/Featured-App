import { useEffect, useState } from 'react'
import type { RemoteStatus } from '@shared/types/remote'

/** The Remote Desktop status, kept current by the main process's push. */
export const useRemoteStatus = (): RemoteStatus | null => {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  useEffect(() => {
    const api = window.printAgent.remote
    let active = true
    const off = api.onStatus(next => active && setStatus(next))
    void api.getStatus().then(r => {
      if (active && r.ok) setStatus(r.value)
    })
    return () => {
      active = false
      off()
    }
  }, [])
  return status
}

/** Re-renders every second (countdowns). */
export const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

export const timeAgo = (at: number | null): string => {
  if (!at) return 'never'
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return new Date(at).toLocaleDateString()
}
