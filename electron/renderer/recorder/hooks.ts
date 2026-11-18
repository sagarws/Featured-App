import { useCallback, useEffect, useRef, useState } from 'react'
import type { RecorderSettings, RecorderStatus, SystemAudioPermission } from '@shared/types/recorder'

const recorder = () => window.printAgent.recorder

/** Live recorder status: fetched once, then pushed by the main process. */
export const useRecorderStatus = (): RecorderStatus | null => {
  const [status, setStatus] = useState<RecorderStatus | null>(null)
  useEffect(() => {
    let active = true
    const off = recorder().onStatus(next => active && setStatus(next))
    void recorder()
      .getStatus()
      .then(r => {
        if (active && r.ok) setStatus(current => current ?? r.value)
      })
    return () => {
      active = false
      off()
    }
  }, [])
  return status
}

/** Recorder settings with an update that saves and returns the stored result. */
export const useRecorderSettings = (): {
  settings: RecorderSettings | null
  update: (patch: Partial<RecorderSettings>) => Promise<string | null>
  reload: () => Promise<void>
} => {
  const [settings, setSettings] = useState<RecorderSettings | null>(null)
  const reload = useCallback(async () => {
    const r = await recorder().getSettings()
    if (r.ok) setSettings(r.value)
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])
  const update = useCallback(async (patch: Partial<RecorderSettings>) => {
    const r = await recorder().updateSettings(patch)
    if (r.ok) {
      setSettings(r.value)
      return null
    }
    return r.error
  }, [])
  return { settings, update, reload }
}

export interface MediaDeviceLists {
  microphones: MediaDeviceInfo[]
  cameras: MediaDeviceInfo[]
  /** Labels are hidden by the browser until access is granted once. */
  labelled: boolean
  error: string | null
  refresh: (unlock?: 'audio' | 'video' | 'both') => Promise<void>
}

/** Microphones and cameras, refreshed when devices are plugged in or out. */
export const useMediaDevices = (unlock: 'audio' | 'video' | 'both' | null): MediaDeviceLists => {
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [labelled, setLabelled] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (want?: 'audio' | 'video' | 'both') => {
    try {
      if (want) {
        // A short-lived stream unlocks device names, then is closed at once.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: want !== 'video', video: want !== 'audio' })
        stream.getTracks().forEach(t => t.stop())
      }
      const devices = await navigator.mediaDevices.enumerateDevices()
      // Linux lists system-audio monitors as inputs; they are not microphones.
      setMicrophones(devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && !/monitor of/i.test(d.label)))
      setCameras(devices.filter(d => d.kind === 'videoinput'))
      setLabelled(devices.some(d => d.label))
      setError(null)
    } catch (err) {
      const e = err as DOMException
      setError(e?.name === 'NotAllowedError' ? 'Access was refused. Allow it in your privacy settings.' : e?.message || String(err))
    }
  }, [])

  useEffect(() => {
    void refresh(unlock ?? undefined)
    const onChange = () => void refresh()
    navigator.mediaDevices.addEventListener('devicechange', onChange)
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange)
  }, [refresh, unlock])

  return { microphones, cameras, labelled, error, refresh }
}

/**
 * Live input level (0–1) of a microphone, for the meter and the mic test.
 * Opens its own stream; closes it when `enabled` turns off or the device changes.
 */
export const useMicLevel = (enabled: boolean, deviceId: string | null, volume: number): { level: number; error: string | null } => {
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const volumeRef = useRef(volume)
  useEffect(() => {
    volumeRef.current = volume
  }, [volume])

  useEffect(() => {
    if (!enabled) {
      setLevel(0)
      return
    }
    let stopped = false
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let timer = 0
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true })
        if (stopped) {
          stream.getTracks().forEach(t => t.stop())
          return
        }
        ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        ctx.createMediaStreamSource(stream).connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        timer = window.setInterval(() => {
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          for (const v of buf) sum += v * v
          const rms = Math.sqrt(sum / buf.length) * (volumeRef.current / 100)
          // Roughly perceptual: -60 dB … 0 dB → 0 … 1.
          const db = 20 * Math.log10(Math.max(rms, 1e-6))
          setLevel(Math.min(1, Math.max(0, (db + 60) / 60)))
        }, 60)
        setError(null)
      } catch (err) {
        const e = err as DOMException
        setError(e?.name === 'NotAllowedError' ? 'Microphone access was refused.' : e?.name === 'NotFoundError' ? 'Microphone not found.' : e?.message || String(err))
      }
    })()
    return () => {
      stopped = true
      window.clearInterval(timer)
      stream?.getTracks().forEach(t => t.stop())
      void ctx?.close()
      setLevel(0)
    }
  }, [enabled, deviceId])

  return { level, error }
}

/**
 * The OS permission to record system audio (macOS), null while checking.
 * Checked again whenever the window regains focus, so turning it on in System
 * Settings and coming back is picked up without a restart.
 */
export const useSystemAudioPermission = (): {
  permission: SystemAudioPermission | null
  /** Shows the macOS prompt if the user has not decided yet. */
  request: () => Promise<SystemAudioPermission | null>
  refresh: () => Promise<void>
} => {
  const [permission, setPermission] = useState<SystemAudioPermission | null>(null)
  const refresh = useCallback(async () => {
    const r = await recorder().systemAudioPermission()
    setPermission(r.ok ? r.value : 'unknown')
  }, [])
  const request = useCallback(async () => {
    const r = await recorder().requestSystemAudioPermission()
    const next = r.ok ? r.value : 'unknown'
    setPermission(next)
    return next
  }, [])
  useEffect(() => {
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])
  return { permission, request, refresh }
}

/** System audio may be recorded. 'unknown' (could not check) is let through; the silence warning still guards it. */
export const systemAudioAllowed = (permission: SystemAudioPermission | null): boolean => permission === 'granted' || permission === 'unknown'
