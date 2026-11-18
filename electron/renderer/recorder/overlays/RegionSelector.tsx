import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Box, Button, Stack, Typography } from '@mui/material'
import { FiberManualRecord } from '@mui/icons-material'

/**
 * Full-display overlay for picking a region: drag to draw, drag inside to
 * move, drag a handle to resize, Enter / "Record this area" to confirm,
 * Esc / Cancel to cancel. One of these covers each display; starting a
 * selection on one clears the others. Coordinates are CSS px = DIP relative
 * to this display, which is what the main process expects.
 */

interface Rect {
  x: number
  y: number
  width: number
  height: number
}
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
type Drag = { mode: 'draw' | 'move' | Handle; startX: number; startY: number; origin: Rect }

const MIN = 64
const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

const clampRect = (r: Rect, w: number, h: number): Rect => {
  const width = Math.min(Math.max(r.width, 1), w)
  const height = Math.min(Math.max(r.height, 1), h)
  return { x: Math.min(Math.max(0, r.x), w - width), y: Math.min(Math.max(0, r.y), h - height), width, height }
}

const normalise = (x1: number, y1: number, x2: number, y2: number): Rect => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  width: Math.abs(x2 - x1),
  height: Math.abs(y2 - y1)
})

const handleStyle = (h: Handle): Record<string, string | number> => {
  const s: Record<string, string | number> = { position: 'absolute', width: 12, height: 12, background: '#fff', border: '2px solid #7367F0', borderRadius: 3 }
  if (h.includes('n')) s['top'] = -7
  if (h.includes('s')) s['bottom'] = -7
  if (h.includes('w')) s['left'] = -7
  if (h.includes('e')) s['right'] = -7
  if (h === 'n' || h === 's') s['left'] = 'calc(50% - 6px)'
  if (h === 'e' || h === 'w') s['top'] = 'calc(50% - 6px)'
  s['cursor'] = `${h}-resize`
  return s
}

const RegionSelector = ({ displayId }: { displayId: string }) => {
  const [rect, setRect] = useState<Rect | null>(null)
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)
  const region = window.printAgent.recorder.region

  useEffect(() => region.onReset(() => setRect(null)), [region])

  const confirm = useCallback(() => {
    if (!rect || rect.width < MIN || rect.height < MIN) return
    region.done({ type: 'region', displayId, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) })
  }, [rect, displayId, region])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') region.done(null)
      if (e.key === 'Enter') confirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, region])

  const begin = (mode: Drag['mode'], e: ReactPointerEvent) => {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const origin = mode === 'draw' ? { x: e.clientX, y: e.clientY, width: 0, height: 0 } : (rect ?? { x: 0, y: 0, width: 0, height: 0 })
    drag.current = { mode, startX: e.clientX, startY: e.clientY, origin }
    setDragging(true)
    if (mode === 'draw') {
      region.started()
      setRect(origin)
    }
  }

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const W = window.innerWidth
    const H = window.innerHeight
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    const o = d.origin
    if (d.mode === 'draw') {
      setRect(clampRect(normalise(d.startX, d.startY, e.clientX, e.clientY), W, H))
    } else if (d.mode === 'move') {
      setRect(clampRect({ ...o, x: o.x + dx, y: o.y + dy }, W, H))
    } else {
      let { x, y, width, height } = o
      if (d.mode.includes('e')) width = o.width + dx
      if (d.mode.includes('s')) height = o.height + dy
      if (d.mode.includes('w')) {
        x = o.x + dx
        width = o.width - dx
      }
      if (d.mode.includes('n')) {
        y = o.y + dy
        height = o.height - dy
      }
      setRect(clampRect(normalise(x, y, x + width, y + height), W, H))
    }
  }

  const end = () => {
    drag.current = null
    setDragging(false)
  }

  const valid = !!rect && rect.width >= MIN && rect.height >= MIN
  // Controls below the selection, or above it when there is no room.
  const barTop = rect ? (rect.y + rect.height + 56 < window.innerHeight ? rect.y + rect.height + 12 : Math.max(12, rect.y - 56)) : 0

  return (
    <Box
      onPointerDown={e => begin('draw', e)}
      onPointerMove={onMove}
      onPointerUp={end}
      sx={{ position: 'fixed', inset: 0, cursor: 'crosshair', userSelect: 'none', bgcolor: rect ? 'transparent' : 'rgba(0,0,0,0.35)' }}
    >
      {!rect && (
        <Stack alignItems='center' justifyContent='center' sx={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <Box sx={{ px: 3, py: 2, borderRadius: 3, bgcolor: 'rgba(20,20,28,0.85)', color: '#fff', textAlign: 'center' }}>
            <Typography sx={{ fontWeight: 600 }}>Drag to select the area to record</Typography>
            <Typography sx={{ fontSize: 13, opacity: 0.75 }}>Esc to cancel</Typography>
          </Box>
        </Stack>
      )}
      {rect && (
        <>
          <Box
            onPointerDown={e => begin('move', e)}
            sx={{
              position: 'absolute',
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              border: '2px solid #7367F0',
              boxSizing: 'border-box',
              // Dims everything outside the selection.
              boxShadow: '0 0 0 100vmax rgba(0,0,0,0.45)',
              cursor: 'move'
            }}
          >
            {HANDLES.map(h => (
              <Box key={h} onPointerDown={e => begin(h, e)} sx={handleStyle(h)} />
            ))}
            <Box sx={{ position: 'absolute', top: 6, left: 8, px: 1, borderRadius: 1, bgcolor: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(rect.width)} × {Math.round(rect.height)}
            </Box>
          </Box>
          {!dragging && (
            <Stack
              direction='row'
              spacing={1}
              onPointerDown={e => e.stopPropagation()}
              sx={{ position: 'absolute', top: barTop, left: Math.max(12, Math.min(rect.x, window.innerWidth - 330)), p: 1, borderRadius: 2.5, bgcolor: 'rgba(20,20,28,0.92)', cursor: 'default' }}
            >
              <Button size='small' color='inherit' sx={{ color: '#fff' }} onClick={() => region.done(null)}>
                Cancel
              </Button>
              <Button size='small' variant='contained' color='error' startIcon={<FiberManualRecord />} disabled={!valid} onClick={confirm}>
                {valid ? 'Record this area' : `At least ${MIN}×${MIN}`}
              </Button>
            </Stack>
          )}
        </>
      )}
    </Box>
  )
}

export default RegionSelector
