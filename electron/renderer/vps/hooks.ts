import { useEffect, useState } from 'react'
import type { VpsMetrics, VpsNetwork, VpsStatus, VpsSystemInfo } from '@shared/types/vps'

const api = () => window.printAgent.vps

/** The VPS status, kept current by the main process's pushes. */
export const useVpsStatus = (): VpsStatus | null => {
  const [status, setStatus] = useState<VpsStatus | null>(null)
  useEffect(() => {
    let alive = true
    void api()
      .getStatus()
      .then(r => {
        if (alive && r.ok) setStatus(r.value)
      })
    const off = api().onStatus(next => setStatus(next))
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}

export const useSystemInfo = (): VpsSystemInfo | null => {
  const [info, setInfo] = useState<VpsSystemInfo | null>(null)
  useEffect(() => {
    void api()
      .systemInfo()
      .then(r => r.ok && setInfo(r.value))
  }, [])
  return info
}

/** Interfaces and addresses, refreshed every 15 s (local lookups only). */
export const useVpsNetwork = () => {
  const [network, setNetwork] = useState<VpsNetwork | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    let alive = true
    const load = () =>
      void api()
        .network()
        .then(r => {
          if (alive && r.ok) setNetwork(r.value)
        })
    load()
    const timer = setInterval(load, 15_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  const checkPublicIp = async () => {
    setChecking(true)
    const r = await api().checkPublicIp()
    setChecking(false)
    if (r.ok) setNetwork(r.value)
  }
  return { network, checkPublicIp, checking }
}

/** Metrics every 5 s, only while `enabled` and the window is visible. */
export const useVpsMetrics = (enabled: boolean): VpsMetrics | null => {
  const [metrics, setMetrics] = useState<VpsMetrics | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const tick = async () => {
      if (document.visibilityState !== 'visible') return
      const r = await api().metrics()
      if (alive && r.ok) setMetrics(r.value)
    }
    void tick()
    const timer = setInterval(() => void tick(), 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [enabled])
  return enabled ? metrics : null
}

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
