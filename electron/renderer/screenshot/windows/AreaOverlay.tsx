import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Box, Typography } from '@mui/material'

/**
 * One display, frozen at the moment of the shortcut. Drag to pick an area —
 * it is captured on release. A loupe shows the pixels under the cursor for an
 * exact edge. Esc cancels. Coordinates are CSS px (= DIP) of this display.
 */

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const LOUPE = 120
const LOUPE_ZOOM = 6

const AreaOverlay = ({ displayId }: { displayId: string }) => {
  const overlay = window.printAgent.screenshot.overlay
  const [src, setSrc] = useState<string | null>(null)
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const dpr = window.devicePixelRatio || 1

  useEffect(() => {
    let url: string | null = null
    void overlay.image(displayId).then(result => {
      if (!result.ok || !result.value) {
        overlay.done(null)
        return
      }
      url = URL.createObjectURL(new Blob([result.value as BlobPart], { type: 'image/jpeg' }))
      const img = new Image()
      img.src = url
      void img.decode().then(() => {
        setSrc(url)
        overlay.ready()
      })
    })
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [overlay, displayId])

  useEffect(() => overlay.onReset(() => setRect(null)), [overlay])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') overlay.done(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay])

  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0) {
      overlay.done(null)
      return
    }
    ;(e.target as Element).setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, y: e.clientY }
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 })
    overlay.started()
  }

  const move = (e: ReactPointerEvent) => {
    setPointer({ x: e.clientX, y: e.clientY })
    const s = start.current
    if (!s) return
    setRect({ x: Math.min(s.x, e.clientX), y: Math.min(s.y, e.clientY), w: Math.abs(e.clientX - s.x), h: Math.abs(e.clientY - s.y) })
  }

  const up = () => {
    const r = rect
    start.current = null
    // A click without a drag is not a capture.
    if (!r || r.w < 3 || r.h < 3) {
      setRect(null)
      return
    }
    overlay.done({ displayId, x: r.x, y: r.y, width: r.w, height: r.h })
  }

  if (!src) return null

  const W = window.innerWidth
  const H = window.innerHeight
  const p = pointer
  // Loupe beside the cursor, flipped near the edges.
  const loupeX = p ? (p.x + 24 + LOUPE > W ? p.x - 24 - LOUPE : p.x + 24) : 0
  const loupeY = p ? (p.y + 24 + LOUPE + 26 > H ? p.y - 24 - LOUPE - 26 : p.y + 24) : 0

  return (
    <Box
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onContextMenu={e => e.preventDefault()}
      sx={{ position: 'fixed', inset: 0, cursor: 'crosshair', userSelect: 'none', backgroundImage: `url(${src})`, backgroundSize: '100% 100%' }}
    >
      {/* Dim everything except the selection. */}
      {rect ? (
        <Box
          sx={{
            position: 'absolute',
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            outline: '1px solid rgba(255,255,255,0.9)',
            boxShadow: '0 0 0 100vmax rgba(0,0,0,0.38)',
            pointerEvents: 'none'
          }}
        />
      ) : (
        <Box sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(0,0,0,0.18)', pointerEvents: 'none' }} />
      )}

      {/* Crosshair. */}
      {p && !rect && (
        <>
          <Box sx={{ position: 'absolute', left: 0, right: 0, top: p.y, height: '1px', bgcolor: 'rgba(255,255,255,0.55)', pointerEvents: 'none' }} />
          <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: p.x, width: '1px', bgcolor: 'rgba(255,255,255,0.55)', pointerEvents: 'none' }} />
        </>
      )}

      {/* Loupe + readout. */}
      {p && (
        <Box sx={{ position: 'absolute', left: loupeX, top: loupeY, pointerEvents: 'none' }}>
          <Box
            sx={{
              width: LOUPE,
              height: LOUPE,
              borderRadius: '50%',
              border: '2px solid #fff',
              boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
              backgroundImage: `url(${src})`,
              backgroundRepeat: 'no-repeat',
              backgroundSize: `${W * LOUPE_ZOOM}px ${H * LOUPE_ZOOM}px`,
              backgroundPosition: `${-(p.x * LOUPE_ZOOM - LOUPE / 2)}px ${-(p.y * LOUPE_ZOOM - LOUPE / 2)}px`,
              imageRendering: 'pixelated',
              position: 'relative',
              overflow: 'hidden'
            }}
          >
            <Box sx={{ position: 'absolute', left: LOUPE / 2 - 0.5, top: 0, bottom: 0, width: '1px', bgcolor: 'rgba(67,83,255,0.9)' }} />
            <Box sx={{ position: 'absolute', top: LOUPE / 2 - 0.5, left: 0, right: 0, height: '1px', bgcolor: 'rgba(67,83,255,0.9)' }} />
          </Box>
          <Typography
            sx={{ mt: 0.75, mx: 'auto', width: 'fit-content', px: 1, py: 0.25, borderRadius: 1, bgcolor: 'rgba(0,0,0,0.75)', color: '#fff', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
          >
            {rect ? `${Math.round(rect.w * dpr)} × ${Math.round(rect.h * dpr)}` : `${Math.round(p.x * dpr)}, ${Math.round(p.y * dpr)}`}
          </Typography>
        </Box>
      )}

      {!p && (
        <Box sx={{ position: 'absolute', top: 24, left: '50%', transform: 'translateX(-50%)', px: 2, py: 1, borderRadius: 2, bgcolor: 'rgba(20,20,28,0.85)', color: '#fff', pointerEvents: 'none' }}>
          <Typography sx={{ fontSize: 13 }}>Drag to capture an area · Esc to cancel</Typography>
        </Box>
      )}
    </Box>
  )
}

export default AreaOverlay
