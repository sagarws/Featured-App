import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  LinearProgress,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import {
  AttachFileOutlined,
  CallEndRounded,
  ContentPasteGoOutlined,
  FitScreenOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  InsightsOutlined,
  LockOutlined,
  MouseOutlined,
  KeyboardOutlined,
  MonitorOutlined,
  OneKOutlined,
  SpeedOutlined,
  TimerOutlined,
  VisibilityOutlined
} from '@mui/icons-material'
import { QUALITY_ORDER, QUALITY_PROFILES } from '@shared/constants/remote'
import type { FileTransferInfo, QualityPreset, QualityPriority, RemoteDisplay, RemotePermission, ViewerConfig, ViewerStats } from '@shared/types/remote'
import { formatRemaining, mapModifierCode } from '@shared/utils/remote'
import { useRemoteConnection } from './useRemoteConnection'

/*
 * The remote screen (#rd-viewer). Pointer and keyboard go to the host over
 * the WebRTC data channels; everything else (quality, display, clipboard,
 * files) through the main process and the encrypted session channel.
 *
 * Keys are sent by physical position (KeyboardEvent.code). With "Send
 * shortcuts to the remote computer" on, the main process intercepts every
 * key while the remote screen has focus — including ⌘W / ⌘Q / Ctrl+W that
 * would otherwise act on this app — and hands them here (onKey).
 */

type Fit = 'fit' | 'actual'

const SPECIAL_KEYS: { label: string; codes: string[] }[] = [
  { label: 'Alt + Tab', codes: ['AltLeft', 'Tab'] },
  { label: '⌘ / Windows key', codes: ['MetaLeft'] },
  { label: '⌘ + Tab', codes: ['MetaLeft', 'Tab'] },
  { label: '⌘ + Space', codes: ['MetaLeft', 'Space'] },
  { label: 'Ctrl + Esc', codes: ['ControlLeft', 'Escape'] },
  { label: 'Print Screen', codes: ['PrintScreen'] },
  { label: 'Ctrl + Shift + Esc', codes: ['ControlLeft', 'ShiftLeft', 'Escape'] }
]

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

const Viewer = () => {
  const api = window.printAgent.remote
  const [config, setConfig] = useState<ViewerConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const video = useRef<HTMLVideoElement | null>(null)
  const area = useRef<HTMLDivElement | null>(null)
  const { media, stats, sendInput, sendMove } = useRemoteConnection(config, video)

  const hasTurn = (config?.iceServers ?? []).some(server => [server.urls].flat().some(url => /^turns?:/i.test(url)))

  const [permission, setPermission] = useState<RemotePermission>('view')
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [displays, setDisplays] = useState<RemoteDisplay[]>([])
  const [displayId, setDisplayId] = useState('')
  const [quality, setQuality] = useState<QualityPreset>('auto')
  const [priority, setPriority] = useState<QualityPriority>('readability')
  const [fit, setFit] = useState<Fit>('fit')
  const [fullscreen, setFullscreen] = useState(false)
  const [toolbarShown, setToolbarShown] = useState(true)
  const [session, setSession] = useState<'active' | 'reconnecting' | 'ended'>('active')
  // The session is up but no picture after this long: the two networks cannot
  // open a video path (NAT / firewall). Say so instead of spinning forever.
  const VIDEO_STALL_MS = 20_000
  const [stallFlag, setStallFlag] = useState(false)
  const waitingForVideo = media !== 'connected' && session === 'active'
  useEffect(() => {
    const timer = setTimeout(() => setStallFlag(waitingForVideo), waitingForVideo ? VIDEO_STALL_MS : 0)
    return () => clearTimeout(timer)
  }, [waitingForVideo])
  const videoStalled = stallFlag && waitingForVideo
  const [endReason, setEndReason] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; severity: 'info' | 'warning' | 'error' | 'success' } | null>(null)
  const [inputProblem, setInputProblem] = useState<string | null>(null)
  const [showStats, setShowStats] = useState(false)
  const [transfers, setTransfers] = useState<FileTransferInfo[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [menu, setMenu] = useState<{ kind: 'quality' | 'display' | 'keys' | 'clipboard'; anchor: HTMLElement } | null>(null)
  // Lock screen of the host (Windows agent): a live picture shown over the video.
  const [locked, setLocked] = useState(false)
  const [secureAgent, setSecureAgent] = useState(false)
  const [secureUrl, setSecureUrl] = useState<string | null>(null)
  const secureImg = useRef<HTMLImageElement | null>(null)
  // The remote cursor is in the picture; a second (local) arrow on top is confusing.
  const [showLocalCursor, setShowLocalCursor] = useState(false)
  const [bench, setBench] = useState<{ running: boolean; progress: number; result: string | null }>({ running: false, progress: 0, result: null })

  // ── load ──
  useEffect(() => {
    void api.viewer.config().then(r => {
      if (!r.ok) return setError(r.error)
      const c = r.value
      setConfig(c)
      setPermission(c.permission)
      setExpiresAt(c.expiresAt)
      setDisplays(c.displays)
      setDisplayId(c.displayId)
      setQuality(c.quality)
      setLocked(c.locked)
      setSecureAgent(c.secureAgent)
      setPriority(c.priority)
      document.title = `${c.peerName} — Remote Desktop`
    })
  }, [api])

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  // ── session events from the main process ──
  useEffect(() => {
    const off = api.viewer.onEvent(event => {
      switch (event.type) {
        case 'timer':
          setExpiresAt(typeof event['expiresAt'] === 'number' ? event['expiresAt'] : null)
          setNotice({ text: 'The owner changed the session time.', severity: 'info' })
          break
        case 'warning':
          setNotice({ text: `The session ends in ${Math.ceil(Number(event['remainingMs']) / 60_000)} minutes. Ask the owner to extend it if you need more time.`, severity: 'warning' })
          break
        case 'permission':
          setPermission(event['permission'] === 'control' ? 'control' : 'view')
          setNotice({ text: event['permission'] === 'control' ? 'You now have full control.' : 'The owner switched this session to view only.', severity: 'info' })
          break
        case 'input-status':
          setInputProblem(typeof event['problem'] === 'string' ? event['problem'] : null)
          break
        case 'displays':
          setDisplays(event['displays'] as RemoteDisplay[])
          if (typeof event['current'] === 'string') setDisplayId(event['current'])
          break
        case 'clipboard':
          setNotice({ text: `Copied on the remote computer — ${String(event['chars'])} characters are on your clipboard.`, severity: 'success' })
          break
        case 'notice':
          setNotice({ text: typeof event['message'] === 'string' ? event['message'] : 'Notice from the remote computer.', severity: 'warning' })
          break
        case 'reconnecting':
          setSession('reconnecting')
          break
        case 'reconnected':
          setSession('active')
          setPermission(event['permission'] === 'control' ? 'control' : 'view')
          setExpiresAt(typeof event['expiresAt'] === 'number' ? event['expiresAt'] : null)
          void api.viewer.restart()
          break
        case 'locked':
          setLocked(event['locked'] === true)
          setSecureAgent(event['secure'] === true)
          if (event['locked'] !== true)
            setSecureUrl(prev => {
              if (prev) URL.revokeObjectURL(prev)
              return null
            })
          break
        case 'end':
          setSession('ended')
          setEndReason(typeof event['reason'] === 'string' ? event['reason'] : 'The session ended.')
          if (document.fullscreenElement) void document.exitFullscreen()
          break
      }
    })
    const offStatus = api.onStatus(status => setTransfers(status.transfers.filter(t => t.sessionId === config?.sessionId)))
    return () => {
      off()
      offStatus()
    }
  }, [api, config?.sessionId])

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(t)
  }, [notice])

  // Lock-screen pictures from the host.
  useEffect(
    () =>
      api.viewer.onSecureFrame(frame => {
        const url = URL.createObjectURL(new Blob([frame.jpeg as BlobPart], { type: 'image/jpeg' }))
        setSecureUrl(prev => {
          if (prev) URL.revokeObjectURL(prev)
          return url
        })
      }),
    [api]
  )
  const showSecure = locked && !!secureUrl

  const canControl = permission === 'control' && session === 'active' && media === 'connected'

  const pressed = useRef(new Set<string>())
  const releaseAll = useCallback(() => {
    if (pressed.current.size) sendInput({ k: 'rel' })
    pressed.current.clear()
  }, [sendInput])

  // ── keyboard ──
  const handleKey = useCallback(
    (type: 'down' | 'up', code: string, key: string, mods: { shift: boolean; control: boolean; alt: boolean; meta: boolean }) => {
      if (!config) return
      if (type === 'down' && code === 'Escape' && mods.shift && document.fullscreenElement) {
        void document.exitFullscreen()
        return
      }
      if (!canControl || !code) return
      if (config.keyboardMode === 'text' && key.length === 1 && !mods.control && !mods.meta && !mods.alt) {
        if (type === 'down') sendInput({ k: 'tx', t: key })
        return
      }
      const mapped = mapModifierCode(code, config.viewerPlatform, config.peerPlatform, config.mapModifiers)
      if (type === 'down') pressed.current.add(mapped)
      else pressed.current.delete(mapped)
      sendInput({ k: type === 'down' ? 'kd' : 'ku', c: mapped })
    },
    [config, canControl, sendInput]
  )

  // Keys intercepted by the main process (send-shortcuts mode).
  useEffect(() => api.viewer.onKey(k => handleKey(k.type, k.code, k.key, k)), [api, handleKey])

  // DOM keys (when the main process does not intercept).
  const onKeyDown = (e: ReactKeyboardEvent) => {
    e.preventDefault()
    handleKey('down', e.code, e.key, { shift: e.shiftKey, control: e.ctrlKey, alt: e.altKey, meta: e.metaKey })
  }
  const onKeyUp = (e: ReactKeyboardEvent) => {
    e.preventDefault()
    handleKey('up', e.code, e.key, { shift: e.shiftKey, control: e.ctrlKey, alt: e.altKey, meta: e.metaKey })
  }

  const sendCombo = (codes: string[]) => {
    if (!canControl || !codes.length) return
    for (const c of codes) sendInput({ k: 'kd', c })
    for (const c of [...codes].reverse()) sendInput({ k: 'ku', c })
    area.current?.focus()
  }

  // ── pointer ──
  const toPoint = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    // Over the lock-screen picture, coordinates are relative to it (the host's whole screen).
    const img = secureImg.current
    const v = video.current
    const el: HTMLElement | null = img && img.naturalWidth ? img : v
    const natW = img && img.naturalWidth ? img.naturalWidth : (v?.videoWidth ?? 0)
    const natH = img && img.naturalWidth ? img.naturalHeight : (v?.videoHeight ?? 0)
    if (!el || !natW || !natH) return null
    const r = el.getBoundingClientRect()
    const scale = Math.min(r.width / natW, r.height / natH)
    const w = natW * scale
    const h = natH * scale
    const x = (clientX - (r.left + (r.width - w) / 2)) / w
    const y = (clientY - (r.top + (r.height - h) / 2)) / h
    if (x < 0 || y < 0 || x > 1 || y > 1) return null
    return { x: Math.round(x * 100_000) / 100_000, y: Math.round(y * 100_000) / 100_000 }
  }, [])

  const lastPoint = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.5 })
  const pendingMove = useRef<{ x: number; y: number } | null>(null)
  const pendingWheel = useRef({ dx: 0, dy: 0 })
  const frame = useRef<number | null>(null)
  const seq = useRef(0)

  const flush = useCallback(() => {
    frame.current = null
    const p = pendingMove.current
    if (p) {
      pendingMove.current = null
      sendMove(p.x, p.y, ++seq.current)
    }
    const w = pendingWheel.current
    if (w.dx || w.dy) {
      sendInput({ k: 'wh', dx: Math.round(w.dx), dy: Math.round(w.dy) })
      pendingWheel.current = { dx: 0, dy: 0 }
    }
  }, [sendMove, sendInput])

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(flush)
  }, [flush])

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!canControl) return
    const p = toPoint(e.clientX, e.clientY)
    if (!p) return
    lastPoint.current = p
    pendingMove.current = p
    schedule()
  }

  const button = (b: number): 0 | 1 | 2 | null => (b === 0 ? 0 : b === 1 ? 1 : b === 2 ? 2 : null)

  const onPointerDown = (e: ReactPointerEvent) => {
    area.current?.focus()
    if (!canControl) return
    const b = button(e.button)
    const p = toPoint(e.clientX, e.clientY)
    if (b === null || !p) return
    e.preventDefault()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pendingMove.current = null
    lastPoint.current = p
    sendInput({ k: 'md', b, x: p.x, y: p.y })
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    if (!canControl) return
    const b = button(e.button)
    if (b === null) return
    const p = toPoint(e.clientX, e.clientY) ?? lastPoint.current
    sendInput({ k: 'mu', b, x: p.x, y: p.y })
  }

  useEffect(() => {
    const el = area.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!canControl) return
      e.preventDefault()
      const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 800 : 1
      pendingWheel.current.dx += e.deltaX * factor
      pendingWheel.current.dy += e.deltaY * factor
      schedule()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [canControl, schedule])

  // ── fullscreen / toolbar ──
  useEffect(() => {
    const onChange = () => {
      const on = !!document.fullscreenElement
      setFullscreen(on)
      setToolbarShown(!on)
      const nav = navigator as Navigator & { keyboard?: { lock?: () => Promise<void>; unlock?: () => void } }
      // Keyboard Lock: lets Alt+Tab, the Windows key, Esc… reach the remote computer in full screen where the OS allows it.
      if (on) void nav.keyboard?.lock?.().catch(() => undefined)
      else nav.keyboard?.unlock?.()
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => area.current?.focus())
  }

  const hideTimer = useRef<number | null>(null)
  const onMouseMoveAnywhere = (e: React.MouseEvent) => {
    if (!fullscreen) return
    if (e.clientY < 6) setToolbarShown(true)
  }
  const onToolbarLeave = () => {
    if (!fullscreen) return
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setToolbarShown(false), 1200)
  }
  const onToolbarEnter = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
  }

  // ── actions ──
  const pickQuality = (preset: QualityPreset, nextPriority = priority) => {
    setQuality(preset)
    setPriority(nextPriority)
    setMenu(null)
    void api.viewer.quality(preset, nextPriority)
  }
  const pickDisplay = (id: string) => {
    setMenu(null)
    releaseAll()
    void api.viewer.display(id)
  }
  const sendClipboard = async () => {
    setMenu(null)
    const r = await api.viewer.sendClipboard()
    setNotice(r.ok && r.value ? { text: 'Your clipboard was sent to the remote computer.', severity: 'success' } : { text: 'Nothing to send (clipboard empty, or not allowed).', severity: 'warning' })
  }
  const sendFiles = async () => {
    if (!config) return
    const r = await api.sendFiles(config.sessionId)
    if (!r.ok) setNotice({ text: r.error, severity: 'error' })
  }
  // Closing the viewer window ends the session (main process: viewerSession 'closed').
  const disconnect = () => window.close()

  // Benchmark: one stats sample a second for 30 s, then averages and 95th percentiles.
  const latestStats = useRef<ViewerStats | null>(null)
  useEffect(() => {
    latestStats.current = stats
  }, [stats])
  const benchTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (benchTimer.current !== null) window.clearInterval(benchTimer.current)
  }, [])
  const summarise = (samples: ViewerStats[]): string => {
    const pick = (f: (s: ViewerStats) => number | null) => samples.map(f).filter((n): n is number => n !== null)
      const line = (label: string, values: number[], unit: string) =>
        values.length ? `${label}: avg ${(values.reduce((a, c) => a + c, 0) / values.length).toFixed(1)} ${unit}, p95 ${percentile(values, 95).toFixed(1)} ${unit}` : `${label}: n/a`
    const last = samples[samples.length - 1]!
    const result = [
        `Remote Desktop benchmark — ${new Date().toLocaleString()} — ${config?.peerName ?? ''}`,
        `Route: ${last.route} · Codec: ${last.codec} · Quality: ${QUALITY_PROFILES[quality].label} (${priority})`,
        `Resolution: ${last.width}×${last.height}`,
        line('Frame rate', pick(s => s.fps), 'fps'),
        line('Bitrate', pick(s => s.bitrateKbps / 1000), 'Mbps'),
        line('Network RTT', pick(s => s.rttMs), 'ms'),
        line('Input RTT (viewer→host app→viewer)', pick(s => s.inputRttMs), 'ms'),
        line('Decode time', pick(s => s.decodeMs), 'ms'),
        line('Jitter buffer', pick(s => s.jitterBufferMs), 'ms'),
        line('Packet loss', pick(s => s.packetLossPct), '%')
      ].join('\n')
    return result
  }
  const runBenchmark = () => {
    const samples: ViewerStats[] = []
    setBench({ running: true, progress: 0, result: null })
    benchTimer.current = window.setInterval(() => {
      if (latestStats.current) samples.push(latestStats.current)
      if (samples.length < 30) return setBench(b => ({ ...b, progress: samples.length }))
      if (benchTimer.current !== null) window.clearInterval(benchTimer.current)
      benchTimer.current = null
      setBench({ running: false, progress: 30, result: summarise(samples) })
    }, 1000)
  }

  const display = useMemo(() => displays.find(d => d.id === displayId), [displays, displayId])
  const remaining = expiresAt === null ? null : expiresAt - now
  const actualSize = fit === 'actual' && display ? { width: display.width / window.devicePixelRatio, height: display.height / window.devicePixelRatio } : null

  if (error) {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity='error'>{error}</Alert>
      </Box>
    )
  }

  return (
    <Box sx={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', bgcolor: '#0d0e12', color: '#fff' }} onMouseMove={onMouseMoveAnywhere}>
      {/* ── toolbar ── */}
      <Box
        onMouseEnter={onToolbarEnter}
        onMouseLeave={onToolbarLeave}
        sx={{
          position: fullscreen ? 'absolute' : 'relative',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          transform: toolbarShown ? 'none' : 'translateY(-100%)',
          transition: 'transform .18s',
          bgcolor: 'rgba(22,24,32,.96)',
          borderBottom: '1px solid rgba(255,255,255,.08)',
          px: 1.5,
          py: 0.75
        }}
      >
        <Stack direction='row' alignItems='center' spacing={1} sx={{ minHeight: 40 }}>
          <Box sx={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, bgcolor: session !== 'active' || media !== 'connected' ? 'warning.main' : 'success.main' }} />
          <Box sx={{ minWidth: 0, mr: 1 }}>
            <Typography noWrap sx={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.2 }}>
              {config?.peerName ?? 'Connecting…'}
            </Typography>
            <Typography noWrap sx={{ fontSize: 11, color: 'rgba(255,255,255,.55)' }}>
              {config?.peerId} · {session === 'reconnecting' ? 'Reconnecting…' : media === 'connected' ? (stats?.route === 'lan' ? 'Direct LAN' : stats?.route === 'relay' ? 'Via TURN relay' : 'Connected') : 'Starting video…'}
            </Typography>
          </Box>
          {permission === 'view' && <Chip size='small' icon={<VisibilityOutlined />} label='View only' color='info' variant='outlined' />}
          {remaining !== null && (
            <Chip
              size='small'
              icon={<TimerOutlined />}
              label={formatRemaining(remaining)}
              color={remaining < 5 * 60_000 ? 'warning' : 'default'}
              variant='outlined'
              sx={{ fontVariantNumeric: 'tabular-nums', color: '#fff' }}
            />
          )}
          {expiresAt === null && <Chip size='small' icon={<TimerOutlined />} label='Unlimited' variant='outlined' sx={{ color: 'rgba(255,255,255,.7)' }} />}
          <Box sx={{ flex: 1 }} />

          {displays.length > 1 && (
            <Tooltip title='Screen'>
              <Button size='small' color='inherit' startIcon={<MonitorOutlined />} onClick={e => setMenu({ kind: 'display', anchor: e.currentTarget })}>
                {display?.label ?? 'Screen'}
              </Button>
            </Tooltip>
          )}
          <Tooltip title='Quality'>
            <Button size='small' color='inherit' startIcon={<SpeedOutlined />} onClick={e => setMenu({ kind: 'quality', anchor: e.currentTarget })}>
              {QUALITY_PROFILES[quality].label}
            </Button>
          </Tooltip>
          <Tooltip title={fit === 'fit' ? 'Actual size (1:1 pixels)' : 'Fit to window'}>
            <IconButton size='small' color='inherit' onClick={() => setFit(f => (f === 'fit' ? 'actual' : 'fit'))}>
              {fit === 'fit' ? <OneKOutlined fontSize='small' /> : <FitScreenOutlined fontSize='small' />}
            </IconButton>
          </Tooltip>
          <Tooltip title={fullscreen ? 'Exit full screen (Shift+Esc)' : 'Full screen'}>
            <IconButton size='small' color='inherit' onClick={toggleFullscreen}>
              {fullscreen ? <FullscreenExitOutlined fontSize='small' /> : <FullscreenOutlined fontSize='small' />}
            </IconButton>
          </Tooltip>
          {config?.clipboard && (
            <Tooltip title='Clipboard'>
              <IconButton size='small' color='inherit' onClick={e => setMenu({ kind: 'clipboard', anchor: e.currentTarget })}>
                <ContentPasteGoOutlined fontSize='small' />
              </IconButton>
            </Tooltip>
          )}
          {config?.fileTransfer && (
            <Tooltip title={permission === 'control' ? 'Send files' : 'Sending files needs full control'}>
              <span>
                <IconButton size='small' color='inherit' disabled={permission !== 'control' || session !== 'active'} onClick={() => void sendFiles()}>
                  <AttachFileOutlined fontSize='small' />
                </IconButton>
              </span>
            </Tooltip>
          )}
          <Tooltip title='Send keys'>
            <span>
              <IconButton size='small' color='inherit' disabled={!canControl} onClick={e => setMenu({ kind: 'keys', anchor: e.currentTarget })}>
                <KeyboardOutlined fontSize='small' />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={showLocalCursor ? 'Hide my cursor (show only the remote one)' : 'Show my cursor too'}>
            <IconButton size='small' color={showLocalCursor ? 'primary' : 'inherit'} onClick={() => setShowLocalCursor(s => !s)}>
              <MouseOutlined fontSize='small' />
            </IconButton>
          </Tooltip>
          <Tooltip title='Connection statistics'>
            <IconButton size='small' color={showStats ? 'primary' : 'inherit'} onClick={() => setShowStats(s => !s)}>
              <InsightsOutlined fontSize='small' />
            </IconButton>
          </Tooltip>
          <Divider orientation='vertical' flexItem sx={{ borderColor: 'rgba(255,255,255,.12)', mx: 0.5 }} />
          <Button size='small' variant='contained' color='error' startIcon={<CallEndRounded />} onClick={disconnect}>
            Disconnect
          </Button>
        </Stack>
      </Box>

      {/* Always-visible emergency disconnect while the toolbar is hidden. */}
      {fullscreen && !toolbarShown && (
        <Tooltip title='Disconnect'>
          <IconButton onClick={disconnect} size='small' sx={{ position: 'absolute', top: 8, right: 8, zIndex: 11, bgcolor: 'rgba(220,38,38,.75)', color: '#fff', '&:hover': { bgcolor: 'error.main' } }}>
            <CallEndRounded fontSize='small' />
          </IconButton>
        </Tooltip>
      )}

      {/* ── the remote screen ── */}
      <Box
        ref={area}
        tabIndex={0}
        onFocus={() => api.viewer.setCapture(true)}
        onBlur={() => {
          api.viewer.setCapture(false)
          releaseAll()
        }}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onContextMenu={e => e.preventDefault()}
        sx={{ flex: 1, minHeight: 0, position: 'relative', outline: 'none', overflow: fit === 'actual' ? 'auto' : 'hidden', cursor: !canControl ? 'not-allowed' : showSecure || showLocalCursor ? 'default' : 'none', userSelect: 'none' }}
      >
        <Box
          component='video'
          ref={video}
          autoPlay
          muted
          playsInline
          disablePictureInPicture
          sx={
            actualSize
              ? { display: 'block', width: actualSize.width, height: actualSize.height, objectFit: 'fill' }
              : { display: 'block', width: '100%', height: '100%', objectFit: 'contain' }
          }
        />

        {(media !== 'connected' || session !== 'active') && session !== 'ended' && (
          <Stack alignItems='center' justifyContent='center' spacing={2} sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(13,14,18,.7)' }}>
            <CircularProgress size={30} />
            <Typography sx={{ color: 'rgba(255,255,255,.8)' }}>
              {session === 'reconnecting' ? 'Connection interrupted — reconnecting…' : media === 'interrupted' ? 'Video interrupted — recovering…' : 'Starting the remote screen…'}
            </Typography>
            {videoStalled && (
              <Typography sx={{ color: 'rgba(255,255,255,.65)', fontSize: 13, maxWidth: 520, textAlign: 'center', px: 3 }}>
                {hasTurn
                  ? 'Connected, but the video cannot get through. Check that the TURN server is running and its ports (3478, 49160–49200 UDP) are open. Still trying…'
                  : 'Connected, but these two networks block a direct video path (strict NAT or firewall). Video between them needs a TURN server — set one in Remote Desktop → Settings → Network on both computers. Still trying…'}
              </Typography>
            )}
          </Stack>
        )}

        {session === 'ended' && (
          <Stack alignItems='center' justifyContent='center' spacing={2} sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(13,14,18,.92)' }}>
            <Typography sx={{ fontSize: 18, fontWeight: 600 }}>Session ended</Typography>
            <Typography sx={{ color: 'rgba(255,255,255,.7)' }}>{endReason}</Typography>
            <Button variant='contained' onClick={() => window.close()}>
              Close
            </Button>
          </Stack>
        )}

        {/* The host is locked: its lock screen (Windows agent), or what to do about it. */}
        {locked && session !== 'ended' && (
          <Box sx={{ position: 'absolute', inset: 0, bgcolor: '#0d0e12', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {showSecure ? (
              <Box component='img' ref={secureImg} src={secureUrl ?? undefined} alt='Remote lock screen' draggable={false} sx={{ width: '100%', height: '100%', objectFit: 'contain', userSelect: 'none', pointerEvents: 'none' }} />
            ) : (
              <Stack alignItems='center' spacing={1.5} sx={{ maxWidth: 520, textAlign: 'center', px: 3 }}>
                <LockOutlined sx={{ fontSize: 42, color: 'rgba(255,255,255,.7)' }} />
                <Typography sx={{ fontSize: 18, fontWeight: 600 }}>The remote computer is locked</Typography>
                <Typography sx={{ color: 'rgba(255,255,255,.7)', fontSize: 14 }}>
                  {secureAgent
                    ? 'Loading its lock screen…'
                    : config?.peerPlatform === 'darwin'
                      ? 'To see and unlock it from here, update Featured App on that Mac and keep "Unlock the lock screen remotely" on (Remote Desktop → Security), with Screen Recording and control allowed. Until then someone there has to unlock it; the picture comes back by itself.'
                      : 'To see and unlock it from here, turn on "Lock screen access" on that computer once (Remote Desktop → Security; Windows asks for administrator approval). Until then someone there has to unlock it; the picture comes back by itself.'}
                </Typography>
              </Stack>
            )}
          </Box>
        )}
        {showSecure && (
          <Chip size='small' icon={<LockOutlined />} label='Lock screen — type the Windows password or PIN' sx={{ position: 'absolute', top: 10, left: 10, bgcolor: 'rgba(0,0,0,.65)', color: '#fff' }} />
        )}

        {showStats && stats && (
          <Box sx={{ position: 'absolute', right: 12, bottom: 12, p: 1.5, borderRadius: 2, bgcolor: 'rgba(0,0,0,.72)', fontSize: 12, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', lineHeight: 1.6, minWidth: 230 }}>
            <div>
              {stats.width}×{stats.height} · {stats.fps} fps · {stats.codec || '—'}
            </div>
            <div>{(stats.bitrateKbps / 1000).toFixed(1)} Mbps · loss {stats.packetLossPct}%</div>
            <div>
              RTT {stats.rttMs ?? '—'} ms · input RTT {stats.inputRttMs ?? '—'} ms
            </div>
            <div>
              decode {stats.decodeMs ?? '—'} ms · jitter buf {stats.jitterBufferMs ?? '—'} ms
            </div>
            <div>route: {stats.route}</div>
            <Button size='small' sx={{ mt: 1 }} disabled={bench.running} onClick={runBenchmark}>
              {bench.running ? `Measuring… ${bench.progress}/30 s` : 'Run 30 s benchmark'}
            </Button>
          </Box>
        )}
      </Box>

      {/* ── transfers ── */}
      {transfers.length > 0 && (
        <Box sx={{ position: 'absolute', left: 12, bottom: 12, width: 320, zIndex: 5 }}>
          {transfers.slice(0, 3).map(t => (
            <Box key={t.transferId} sx={{ p: 1.5, mb: 1, borderRadius: 2, bgcolor: 'rgba(22,24,32,.95)', border: '1px solid rgba(255,255,255,.08)' }}>
              <Stack direction='row' alignItems='center' spacing={1}>
                <Typography noWrap sx={{ flex: 1, fontSize: 12.5 }}>
                  {t.direction === 'send' ? 'Sending' : 'Receiving'} {t.files.length === 1 ? t.files[0]?.name : `${t.files.length} files`}
                </Typography>
                {(t.state === 'transferring' || t.state === 'waiting' || t.state === 'offered') && (
                  <Button size='small' color='inherit' onClick={() => void api.cancelTransfer(t.transferId)}>
                    Cancel
                  </Button>
                )}
              </Stack>
              <LinearProgress variant='determinate' value={t.totalBytes ? (t.doneBytes / t.totalBytes) * 100 : t.state === 'done' ? 100 : 0} sx={{ my: 0.75 }} />
              <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,.6)' }}>
                {t.state === 'transferring' ? `${(t.doneBytes / 1048576).toFixed(1)} / ${(t.totalBytes / 1048576).toFixed(1)} MB · ${(t.speed / 1048576).toFixed(1)} MB/s` : t.state === 'done' ? `Done${t.folder ? ` → ${t.folder}` : ''}` : t.state === 'waiting' ? 'Waiting for the other side to accept…' : (t.error ?? t.state)}
              </Typography>
            </Box>
          ))}
        </Box>
      )}

      {(notice || inputProblem || bench.result) && (
        <Stack spacing={1} sx={{ position: 'absolute', top: fullscreen ? 12 : 64, left: '50%', transform: 'translateX(-50%)', zIndex: 9, width: 'min(640px, 90%)' }}>
          {inputProblem && permission === 'control' && <Alert severity='warning'>The remote computer cannot be controlled right now: {inputProblem}</Alert>}
          {notice && (
            <Alert severity={notice.severity} onClose={() => setNotice(null)}>
              {notice.text}
            </Alert>
          )}
          {bench.result && (
            <Alert
              severity='info'
              onClose={() => setBench(b => ({ ...b, result: null }))}
              action={
                <Button size='small' color='inherit' onClick={() => void navigator.clipboard.writeText(bench.result ?? '')}>
                  Copy
                </Button>
              }
            >
              <Box component='pre' sx={{ m: 0, fontSize: 11.5, whiteSpace: 'pre-wrap' }}>
                {bench.result}
              </Box>
            </Alert>
          )}
        </Stack>
      )}

      {/* ── menus ── */}
      <Menu anchorEl={menu?.anchor} open={menu?.kind === 'quality'} onClose={() => setMenu(null)}>
        {QUALITY_ORDER.map(q => (
          <MenuItem key={q} selected={q === quality} onClick={() => pickQuality(q)}>
            <ListItemText primary={QUALITY_PROFILES[q].label} secondary={QUALITY_PROFILES[q].hint} />
          </MenuItem>
        ))}
        <Divider />
        <MenuItem selected={priority === 'readability'} onClick={() => pickQuality(quality, 'readability')}>
          <ListItemText primary='Prioritise sharp text' secondary='Lower frame rate before blurring' />
        </MenuItem>
        <MenuItem selected={priority === 'responsiveness'} onClick={() => pickQuality(quality, 'responsiveness')}>
          <ListItemText primary='Prioritise responsiveness' secondary='Lower resolution before frame rate' />
        </MenuItem>
      </Menu>
      <Menu anchorEl={menu?.anchor} open={menu?.kind === 'display'} onClose={() => setMenu(null)}>
        {displays.map(d => (
          <MenuItem key={d.id} selected={d.id === displayId} onClick={() => pickDisplay(d.id)}>
            <ListItemText primary={`${d.label}${d.primary ? ' (main)' : ''}`} secondary={`${d.width}×${d.height}`} />
          </MenuItem>
        ))}
      </Menu>
      <Menu anchorEl={menu?.anchor} open={menu?.kind === 'keys'} onClose={() => setMenu(null)}>
        <MenuItem
          disabled={!locked || !secureAgent}
          onClick={() => {
            setMenu(null)
            void api.viewer.sendCtrlAltDel()
          }}
        >
          <ListItemText primary='Ctrl + Alt + Delete' secondary={locked && secureAgent ? 'On the lock screen' : 'Only on a locked Windows computer with lock screen access'} />
        </MenuItem>
        {SPECIAL_KEYS.map(k => (
          <MenuItem
            key={k.label}
            disabled={!k.codes.length}
            onClick={() => {
              setMenu(null)
              sendCombo(k.codes)
            }}
          >
            {k.label}
          </MenuItem>
        ))}
      </Menu>
      <Menu anchorEl={menu?.anchor} open={menu?.kind === 'clipboard'} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => void sendClipboard()} disabled={permission !== 'control'}>
          <ListItemText primary='Send my clipboard now' secondary='Text copied here also syncs by itself while this window is focused' />
        </MenuItem>
        <MenuItem disabled>
          <ListItemText primary='Remote → here' secondary='Copy on the remote computer; it lands on your clipboard' />
        </MenuItem>
      </Menu>
    </Box>
  )
}

export default Viewer
