import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Box, Button, ButtonBase, CircularProgress, Divider, IconButton, Popover, Stack, Tooltip, Typography } from '@mui/material'
import {
  ArrowOutward,
  BlurOn,
  BorderColor,
  CircleOutlined,
  CloudUploadOutlined,
  ContentCopy,
  Crop,
  CropSquare,
  DeleteOutline,
  FitScreen,
  Gesture,
  HighlightAlt,
  HorizontalRule,
  LooksOne,
  NorthWest,
  PushPinOutlined,
  Rectangle,
  Redo,
  SaveAs,
  SaveOutlined,
  TextFields,
  Undo,
  ZoomIn,
  ZoomOut
} from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { CaptureInfo, ExportAction } from '@shared/types/screenshot'
import {
  bounds,
  COLORS,
  fontSize,
  hitTest,
  isBox,
  isLine,
  moveShape,
  normaliseRect,
  renderDoc,
  type Doc,
  type Rect,
  type Shape,
  type SizeLevel,
  type TextShape,
  type Tool
} from './shapes'

type Prefs = { preferActualSize: boolean; escCopy: boolean; escSave: boolean; uploadReady: boolean; uploadProblem: string | null; platform: 'darwin' | 'win32' | 'linux' }

const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode }[] = [
  { id: 'select', label: 'Select & move', key: 'V', icon: <NorthWest fontSize='small' /> },
  { id: 'crop', label: 'Crop', key: 'K', icon: <Crop fontSize='small' /> },
  { id: 'arrow', label: 'Arrow', key: 'A', icon: <ArrowOutward fontSize='small' /> },
  { id: 'line', label: 'Line', key: 'L', icon: <HorizontalRule fontSize='small' sx={{ transform: 'rotate(-45deg)' }} /> },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: <CropSquare fontSize='small' /> },
  { id: 'ellipse', label: 'Ellipse', key: 'O', icon: <CircleOutlined fontSize='small' /> },
  { id: 'pen', label: 'Pen', key: 'P', icon: <Gesture fontSize='small' /> },
  { id: 'highlighter', label: 'Highlighter', key: 'H', icon: <BorderColor fontSize='small' /> },
  { id: 'text', label: 'Text', key: 'T', icon: <TextFields fontSize='small' /> },
  { id: 'counter', label: 'Step number', key: 'N', icon: <LooksOne fontSize='small' /> },
  { id: 'pixelate', label: 'Pixelate (hide text)', key: 'B', icon: <BlurOn fontSize='small' /> },
  { id: 'redact', label: 'Filled box', key: 'F', icon: <Rectangle fontSize='small' /> },
  { id: 'spotlight', label: 'Spotlight', key: 'S', icon: <HighlightAlt fontSize='small' /> }
]

const SIZE_LABEL = ['S', 'M', 'L', 'XL']
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4, 6, 8]
const TOOLBAR = 52
const STATUS = 30

let nextId = 0
const newId = (): string => `s${Date.now().toString(36)}${(nextId++).toString(36)}`

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'p1' | 'p2'
type Drag =
  | { mode: 'create'; x: number; y: number; before: Doc }
  | { mode: 'move'; x: number; y: number; origin: Shape; before: Doc; moved: boolean }
  | { mode: 'handle'; handle: Handle; origin: Shape; before: Doc }
  | { mode: 'crop-new'; x: number; y: number }
  | { mode: 'crop-move'; x: number; y: number; origin: Rect }
  | { mode: 'crop-handle'; handle: Handle; origin: Rect }

const clampRect = (r: Rect, area: Rect): Rect => {
  const x = Math.max(area.x, Math.min(r.x, area.x + area.w - 1))
  const y = Math.max(area.y, Math.min(r.y, area.y + area.h - 1))
  return { x, y, w: Math.max(1, Math.min(r.w, area.x + area.w - x)), h: Math.max(1, Math.min(r.h, area.y + area.h - y)) }
}

const resizeRect = (o: Rect, handle: Handle, x: number, y: number): Rect => {
  const left = handle.includes('w') ? x : o.x
  const right = handle.includes('e') ? x : o.x + o.w
  const top = handle.includes('n') ? y : o.y
  const bottom = handle.includes('s') ? y : o.y + o.h
  return normaliseRect(left, top, right, bottom)
}

const snapAngle = (x1: number, y1: number, x2: number, y2: number): [number, number] => {
  const angle = Math.round(Math.atan2(y2 - y1, x2 - x1) / (Math.PI / 4)) * (Math.PI / 4)
  const length = Math.hypot(x2 - x1, y2 - y1)
  return [x1 + Math.cos(angle) * length, y1 + Math.sin(angle) * length]
}

const toHex = (r: number, g: number, b: number): string => `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()

const Editor = ({ id }: { id: string }) => {
  const api = window.printAgent.screenshot
  const [info, setInfo] = useState<CaptureInfo | null>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [doc, setDoc] = useState<Doc | null>(null)
  const past = useRef<Doc[]>([])
  const future = useRef<Doc[]>([])
  // Undo / redo availability, as state: the stacks themselves are refs.
  const [history, setHistory] = useState({ past: 0, future: 0 })
  const syncHistory = useCallback(() => setHistory({ past: past.current.length, future: future.current.length }), [])
  const [tool, setTool] = useState<Tool>('arrow')
  const [color, setColor] = useState<string>(COLORS[0]!)
  const [size, setSize] = useState<SizeLevel>(1)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Shape | null>(null)
  const [cropDraft, setCropDraft] = useState<Rect | null>(null)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [viewport, setViewport] = useState({ width: 800, height: 600 })
  const [textEdit, setTextEdit] = useState<{ x: number; y: number; text: string; editingId: string | null } | null>(null)
  const [hoverHex, setHoverHex] = useState<string | null>(null)
  const [busy, setBusy] = useState<ExportAction | null>(null)
  const [colorAnchor, setColorAnchor] = useState<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const pixels = useRef<CanvasRenderingContext2D | null>(null)
  const drag = useRef<Drag | null>(null)
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  const mac = prefs?.platform === 'darwin'
  const density = info?.scaleFactor ?? 1

  // ── load ──
  useEffect(() => {
    let url: string | null = null
    let active = true
    void Promise.all([api.getCapture(id), api.editorSettings()]).then(async ([capture, settings]) => {
      if (!active) return
      if (settings.ok) setPrefs(settings.value)
      if (!capture.ok || !capture.value) {
        setError(capture.ok ? 'This screenshot is no longer available.' : capture.error)
        return
      }
      const { png, ...rest } = capture.value
      url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }))
      const img = new Image()
      img.src = url
      await img.decode()
      if (!active) return
      const sampler = document.createElement('canvas')
      sampler.width = img.naturalWidth
      sampler.height = img.naturalHeight
      pixels.current = sampler.getContext('2d', { willReadFrequently: true })
      pixels.current?.drawImage(img, 0, 0)
      // First view: 100% when it fits in the window and that is preferred.
      const fits = img.naturalWidth / rest.scaleFactor <= window.innerWidth - 48 && img.naturalHeight / rest.scaleFactor <= window.innerHeight - TOOLBAR - STATUS - 48
      if (settings.ok && settings.value.preferActualSize && fits) setZoom(1)
      setInfo(rest)
      setImage(img)
      setDoc({ shapes: [], crop: { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight } })
    })
    const off = api.onCaptureUpdated(next => {
      if (next.id === id) setInfo(next)
    })
    return () => {
      active = false
      off()
      if (url) URL.revokeObjectURL(url)
    }
  }, [api, id])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewport({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [image])

  const imageRect = useMemo<Rect>(() => ({ x: 0, y: 0, w: image?.naturalWidth ?? 1, h: image?.naturalHeight ?? 1 }), [image])
  // While cropping the whole picture shows, so the crop can grow again.
  const view = tool === 'crop' ? imageRect : (doc?.crop ?? imageRect)
  const fitZoom = Math.min(1, (viewport.width - 48) / (view.w / density), (viewport.height - 48) / (view.h / density))
  const zoomValue = zoom === 'fit' ? Math.max(0.05, fitZoom) : zoom
  /** CSS px per picture px. */
  const scale = zoomValue / density


  // ── history ──
  const commit = useCallback((next: Doc, before: Doc) => {
    past.current.push(before)
    if (past.current.length > 200) past.current.shift()
    future.current = []
    setDoc(next)
    syncHistory()
  }, [syncHistory])

  const undo = useCallback(() => {
    const previous = past.current.pop()
    if (!previous || !doc) return
    future.current.push(doc)
    setDoc(previous)
    setSelected(null)
    syncHistory()
  }, [doc, syncHistory])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next || !doc) return
    past.current.push(doc)
    setDoc(next)
    setSelected(null)
    syncHistory()
  }, [doc, syncHistory])

  const selectedShape = doc?.shapes.find(s => s.id === selected) ?? null

  const updateSelected = (patch: Partial<Pick<Shape, 'color' | 'size'>>) => {
    if (!doc || !selectedShape) return
    commit({ ...doc, shapes: doc.shapes.map(s => (s.id === selectedShape.id ? { ...s, ...patch } : s)) }, doc)
  }

  const deleteSelected = useCallback(() => {
    if (!doc || !selected) return
    commit({ ...doc, shapes: doc.shapes.filter(s => s.id !== selected) }, doc)
    setSelected(null)
  }, [doc, selected, commit])

  // ── draw ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image || !doc) return
    const shown: Doc = {
      crop: view,
      shapes: textEdit?.editingId ? doc.shapes.filter(s => s.id !== textEdit.editingId) : doc.shapes
    }
    if (canvas.width !== Math.round(view.w)) canvas.width = Math.round(view.w)
    if (canvas.height !== Math.round(view.h)) canvas.height = Math.round(view.h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    renderDoc(ctx, image, shown, imageRect, density, draft)
    // Selection outline, in screen-sized lines.
    if (tool === 'select' && selectedShape) {
      const b = bounds(selectedShape, density)
      const pad = 4 / scale
      ctx.save()
      ctx.lineWidth = 1.5 / scale
      ctx.setLineDash([5 / scale, 4 / scale])
      ctx.strokeStyle = '#4353FF'
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2)
      ctx.setLineDash([])
      const handles: [number, number][] = isLine(selectedShape)
        ? [
            [selectedShape.x1, selectedShape.y1],
            [selectedShape.x2, selectedShape.y2]
          ]
        : isBox(selectedShape)
          ? [
              [b.x, b.y],
              [b.x + b.w, b.y],
              [b.x, b.y + b.h],
              [b.x + b.w, b.y + b.h]
            ]
          : []
      for (const [hx, hy] of handles) {
        ctx.fillStyle = '#fff'
        ctx.strokeStyle = '#4353FF'
        ctx.beginPath()
        ctx.arc(hx, hy, 5 / scale, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
      ctx.restore()
    }
  }, [image, doc, draft, view, imageRect, density, tool, selectedShape, scale, textEdit])

  // ── pointer ──
  const toImage = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: (e.clientX - rect.left) / scale + view.x, y: (e.clientY - rect.top) / scale + view.y }
  }

  const handleAt = (x: number, y: number, shape: Shape | null, rect: Rect | null): Handle | null => {
    const reach = 9 / scale
    const near = (hx: number, hy: number) => Math.hypot(x - hx, y - hy) <= reach
    if (shape && isLine(shape)) {
      if (near(shape.x1, shape.y1)) return 'p1'
      if (near(shape.x2, shape.y2)) return 'p2'
      return null
    }
    const r = rect ?? (shape && isBox(shape) ? shape : null)
    if (!r) return null
    if (near(r.x, r.y)) return 'nw'
    if (near(r.x + r.w, r.y)) return 'ne'
    if (near(r.x, r.y + r.h)) return 'sw'
    if (near(r.x + r.w, r.y + r.h)) return 'se'
    return null
  }

  const commitText = useCallback(() => {
    if (!textEdit || !doc) return
    const text = textEdit.text.replace(/\s+$/, '')
    const existing = textEdit.editingId ? doc.shapes.find(s => s.id === textEdit.editingId) : null
    setTextEdit(null)
    if (existing && existing.type === 'text') {
      if (text === existing.text) return
      commit({ ...doc, shapes: text ? doc.shapes.map(s => (s.id === existing.id ? { ...existing, text } : s)) : doc.shapes.filter(s => s.id !== existing.id) }, doc)
    } else if (text) {
      commit({ ...doc, shapes: [...doc.shapes, { id: newId(), type: 'text', x: textEdit.x, y: textEdit.y, text, color, size }] }, doc)
    }
  }, [textEdit, doc, commit, color, size])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!doc || e.button !== 0) return
    if (textEdit) {
      commitText()
      return
    }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const { x, y } = toImage(e)

    if (tool === 'select') {
      const handle = handleAt(x, y, selectedShape, null)
      if (selectedShape && handle) {
        drag.current = { mode: 'handle', handle, origin: selectedShape, before: doc }
        return
      }
      const hit = hitTest(doc.shapes, x, y, density)
      setSelected(hit?.id ?? null)
      if (hit) drag.current = { mode: 'move', x, y, origin: hit, before: doc, moved: false }
      return
    }

    if (tool === 'crop') {
      const current = cropDraft ?? doc.crop
      const handle = handleAt(x, y, null, current)
      if (handle) drag.current = { mode: 'crop-handle', handle, origin: current }
      else if (x >= current.x && x <= current.x + current.w && y >= current.y && y <= current.y + current.h && cropDraft)
        drag.current = { mode: 'crop-move', x, y, origin: current }
      else {
        drag.current = { mode: 'crop-new', x, y }
        setCropDraft({ x, y, w: 0, h: 0 })
      }
      return
    }

    if (tool === 'text') {
      const hit = hitTest(doc.shapes, x, y, density)
      if (hit?.type === 'text') setTextEdit({ x: hit.x, y: hit.y, text: hit.text, editingId: hit.id })
      else setTextEdit({ x, y: y - fontSize(size, density) * 0.6, text: '', editingId: null })
      return
    }

    if (tool === 'counter') {
      const n = Math.max(0, ...doc.shapes.filter(s => s.type === 'counter').map(s => (s.type === 'counter' ? s.n : 0))) + 1
      commit({ ...doc, shapes: [...doc.shapes, { id: newId(), type: 'counter', x, y, n, color, size }] }, doc)
      return
    }

    const base = { id: newId(), color, size }
    if (tool === 'arrow' || tool === 'line') setDraft({ ...base, type: tool, x1: x, y1: y, x2: x, y2: y })
    else if (tool === 'pen' || tool === 'highlighter') setDraft({ ...base, type: tool, points: [x, y] })
    else setDraft({ ...base, type: tool as 'rect', x, y, w: 0, h: 0 })
    drag.current = { mode: 'create', x, y, before: doc }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const { x, y } = toImage(e)
    const sample = pixels.current
    if (sample && x >= 0 && y >= 0 && x < imageRect.w && y < imageRect.h) {
      const [r = 0, g = 0, b = 0] = sample.getImageData(Math.floor(x), Math.floor(y), 1, 1).data
      setHoverHex(toHex(r, g, b))
    }
    const d = drag.current
    if (!d || !doc) return

    switch (d.mode) {
      case 'create':
        setDraft(current => {
          if (!current) return current
          if (isLine(current)) {
            const [x2, y2] = e.shiftKey ? snapAngle(current.x1, current.y1, x, y) : [x, y]
            return { ...current, x2, y2 }
          }
          if (current.type === 'pen' || current.type === 'highlighter') {
            const p = current.points
            if (Math.hypot(x - p[p.length - 2]!, y - p[p.length - 1]!) < 1.5 * density) return current
            return { ...current, points: [...p, x, y] }
          }
          if (isBox(current)) {
            let r = normaliseRect(d.x, d.y, x, y)
            if (e.shiftKey) {
              const side = Math.max(r.w, r.h)
              r = normaliseRect(d.x, d.y, d.x + Math.sign(x - d.x || 1) * side, d.y + Math.sign(y - d.y || 1) * side)
            }
            return { ...current, ...r }
          }
          return current
        })
        break
      case 'move': {
        const moved = moveShape(d.origin, x - d.x, y - d.y)
        d.moved = true
        setDoc({ ...doc, shapes: doc.shapes.map(s => (s.id === moved.id ? moved : s)) })
        break
      }
      case 'handle': {
        const o = d.origin
        let next: Shape = o
        if (isLine(o)) next = d.handle === 'p1' ? { ...o, x1: x, y1: y } : { ...o, x2: x, y2: y }
        else if (isBox(o)) next = { ...o, ...resizeRect(o, d.handle, x, y) }
        setDoc({ ...doc, shapes: doc.shapes.map(s => (s.id === next.id ? next : s)) })
        break
      }
      case 'crop-new':
        setCropDraft(clampRect(normaliseRect(d.x, d.y, x, y), imageRect))
        break
      case 'crop-move':
        setCropDraft(clampRect({ ...d.origin, x: d.origin.x + x - d.x, y: d.origin.y + y - d.y }, imageRect))
        break
      case 'crop-handle':
        setCropDraft(clampRect(resizeRect(d.origin, d.handle, x, y), imageRect))
        break
    }
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d || !doc) return
    if (d.mode === 'create' && draft) {
      const min = 3 * density
      const b = bounds(draft, density)
      const big = isLine(draft) ? Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > min : draft.type === 'pen' || draft.type === 'highlighter' ? true : b.w > min && b.h > min
      if (big) commit({ ...doc, shapes: [...doc.shapes, draft] }, d.before)
      setDraft(null)
    } else if ((d.mode === 'move' && d.moved) || d.mode === 'handle') {
      commit(doc, d.before)
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!doc || tool !== 'select') return
    const { x, y } = toImage(e)
    const hit = hitTest(doc.shapes, x, y, density)
    if (hit?.type === 'text') setTextEdit({ x: hit.x, y: hit.y, text: hit.text, editingId: hit.id })
  }

  const applyCrop = useCallback(() => {
    if (!doc) return
    if (cropDraft && cropDraft.w >= 4 && cropDraft.h >= 4) {
      const r = { x: Math.round(cropDraft.x), y: Math.round(cropDraft.y), w: Math.round(cropDraft.w), h: Math.round(cropDraft.h) }
      commit({ ...doc, crop: r }, doc)
    }
    setCropDraft(null)
    setTool('select')
  }, [doc, cropDraft, commit])

  const chooseTool = useCallback(
    (next: Tool) => {
      if (textEdit) commitText()
      setCropDraft(next === 'crop' && doc ? doc.crop : null)
      setSelected(null)
      setTool(next)
    },
    [textEdit, commitText, doc]
  )

  // ── export ──
  const exportPng = useCallback(async (): Promise<Uint8Array | undefined> => {
    if (!doc || !image) return undefined
    const untouched = !doc.shapes.length && doc.crop.x === 0 && doc.crop.y === 0 && doc.crop.w === image.naturalWidth && doc.crop.h === image.naturalHeight
    // Unchanged: the main process uses the picture it holds, no re-encode.
    if (untouched) return undefined
    const canvas = document.createElement('canvas')
    canvas.width = doc.crop.w
    canvas.height = doc.crop.h
    renderDoc(canvas.getContext('2d')!, image, doc, imageRect, density)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Could not render the picture.')
    return new Uint8Array(await blob.arrayBuffer())
  }, [doc, image, imageRect, density])

  const run = useCallback(
    async (action: ExportAction, quiet = false): Promise<boolean> => {
      if (busy) return false
      if (action === 'upload' && prefs && !prefs.uploadReady) {
        toast.error(prefs.uploadProblem ?? 'Set up uploading first.')
        return false
      }
      setBusy(action)
      try {
        const png = await exportPng()
        const result = await api.exportImage(id, action, png)
        if (!result.ok) throw new Error(result.error)
        if (quiet) return true
        if (action === 'copy') toast.success('Copied to clipboard')
        if ((action === 'save' || action === 'saveAs') && result.value.path) toast.success(`Saved ${result.value.path.split(/[\\/]/).pop()}`)
        if (action === 'upload') toast.success(result.value.link ? 'Uploaded — link copied' : 'Uploaded')
        return true
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err), { duration: 6000 })
        return false
      } finally {
        setBusy(null)
      }
    },
    [busy, prefs, exportPng, api, id]
  )

  const closeWithEsc = useCallback(async () => {
    if (prefs?.escCopy) await run('copy', true)
    if (prefs?.escSave) await run('save', true)
    void api.closeSelf()
  }, [prefs, run, api])

  // ── zoom ──
  const stepZoom = useCallback(
    (direction: 1 | -1) => {
      const current = zoomValue
      const next = direction > 0 ? ZOOMS.find(z => z > current + 0.001) : [...ZOOMS].reverse().find(z => z < current - 0.001)
      if (next) setZoom(next)
    },
    [zoomValue]
  )

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom(z => {
        const current = z === 'fit' ? zoomValue : z
        return Math.min(8, Math.max(0.05, current * Math.exp(-e.deltaY * 0.01)))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomValue])

  // ── keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (textEdit) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && key === 'y') {
        e.preventDefault()
        redo()
      } else if (mod && key === 'c') {
        e.preventDefault()
        void run('copy')
      } else if (mod && key === 's') {
        e.preventDefault()
        void run(e.shiftKey ? 'saveAs' : 'save')
      } else if (mod && key === 'u') {
        e.preventDefault()
        void run('upload')
      } else if (mod && (key === '=' || key === '+')) {
        e.preventDefault()
        stepZoom(1)
      } else if (mod && key === '-') {
        e.preventDefault()
        stepZoom(-1)
      } else if (mod && key === '0') {
        e.preventDefault()
        setZoom('fit')
      } else if (mod && key === '1') {
        e.preventDefault()
        setZoom(1)
      } else if (key === 'escape') {
        e.preventDefault()
        if (tool === 'crop') {
          setCropDraft(null)
          setTool('select')
        } else if (selected) setSelected(null)
        else void closeWithEsc()
      } else if (key === 'enter' && tool === 'crop') {
        e.preventDefault()
        applyCrop()
      } else if ((key === 'delete' || key === 'backspace') && selected) {
        e.preventDefault()
        deleteSelected()
      } else if (key === 'tab') {
        e.preventDefault()
        if (hoverHex) {
          void navigator.clipboard.writeText(hoverHex).then(() => toast.success(`${hoverHex} copied`))
        }
      } else if (!mod && !e.altKey && /^[1-4]$/.test(key)) {
        const level = (Number(key) - 1) as SizeLevel
        setSize(level)
        updateSelected({ size: level })
      } else if (!mod && !e.altKey) {
        const match = TOOLS.find(t => t.key.toLowerCase() === key)
        if (match) chooseTool(match.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (textEdit) setTimeout(() => textRef.current?.focus(), 0)
  }, [textEdit])

  if (error) {
    return (
      <Stack alignItems='center' justifyContent='center' sx={{ height: '100vh', gap: 2 }}>
        <Typography>{error}</Typography>
        <Button variant='outlined' onClick={() => void api.closeSelf()}>
          Close
        </Button>
      </Stack>
    )
  }
  if (!doc || !image || !info) {
    return (
      <Stack alignItems='center' justifyContent='center' sx={{ height: '100vh' }}>
        <CircularProgress size={28} />
      </Stack>
    )
  }

  const canvasW = view.w * scale
  const canvasH = view.h * scale
  const activeColor = selectedShape?.color ?? color
  const activeSize = selectedShape?.size ?? size
  const crop = tool === 'crop' ? cropDraft : null
  const cursor = tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair'

  const actionButton = (action: ExportAction, title: string, icon: ReactNode) => (
    <Tooltip key={action} title={title}>
      <span>
        <IconButton size='small' onClick={() => void run(action)} disabled={!!busy} sx={{ color: 'text.primary', WebkitAppRegion: 'no-drag' }}>
          {busy === action ? <CircularProgress size={18} /> : icon}
        </IconButton>
      </span>
    </Tooltip>
  )

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bgcolor: '#1e1e24', color: '#eee', userSelect: 'none' }}>
      {/* toolbar — also the window's drag handle on macOS (hidden title bar) */}
      <Stack
        direction='row'
        alignItems='center'
        spacing={0.5}
        sx={{
          height: TOOLBAR,
          flexShrink: 0,
          px: 1.5,
          pl: mac ? '84px' : 1.5,
          bgcolor: '#2a2a32',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          WebkitAppRegion: 'drag',
          overflowX: 'auto',
          '&::-webkit-scrollbar': { display: 'none' }
        }}
      >
        {TOOLS.map(t => (
          <Tooltip key={t.id} title={`${t.label} (${t.key})`}>
            <IconButton
              size='small'
              onClick={() => chooseTool(t.id)}
              sx={{
                WebkitAppRegion: 'no-drag',
                borderRadius: 1.5,
                color: tool === t.id ? '#fff' : 'rgba(255,255,255,0.75)',
                bgcolor: tool === t.id ? 'primary.main' : 'transparent',
                '&:hover': { bgcolor: tool === t.id ? 'primary.main' : 'rgba(255,255,255,0.08)' }
              }}
            >
              {t.icon}
            </IconButton>
          </Tooltip>
        ))}
        <Divider orientation='vertical' flexItem sx={{ mx: 1, borderColor: 'rgba(255,255,255,0.12)' }} />
        <Tooltip title='Colour'>
          <ButtonBase
            onClick={e => setColorAnchor(e.currentTarget)}
            sx={{ WebkitAppRegion: 'no-drag', width: 26, height: 26, borderRadius: '50%', bgcolor: activeColor, border: '2px solid rgba(255,255,255,0.85)', flexShrink: 0 }}
          />
        </Tooltip>
        <Stack direction='row' sx={{ WebkitAppRegion: 'no-drag', ml: 1 }}>
          {SIZE_LABEL.map((label, i) => (
            <Tooltip key={label} title={`Size ${label} (${i + 1})`}>
              <ButtonBase
                onClick={() => {
                  setSize(i as SizeLevel)
                  updateSelected({ size: i as SizeLevel })
                }}
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: 1.5,
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: activeSize === i ? '#fff' : 'rgba(255,255,255,0.6)',
                  bgcolor: activeSize === i ? 'rgba(255,255,255,0.14)' : 'transparent'
                }}
              >
                {label}
              </ButtonBase>
            </Tooltip>
          ))}
        </Stack>
        <Divider orientation='vertical' flexItem sx={{ mx: 1, borderColor: 'rgba(255,255,255,0.12)' }} />
        <Tooltip title='Undo (⌘Z / Ctrl+Z)'>
          <span>
            <IconButton size='small' onClick={undo} disabled={!history.past} sx={{ color: '#fff', WebkitAppRegion: 'no-drag' }}>
              <Undo fontSize='small' />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title='Redo'>
          <span>
            <IconButton size='small' onClick={redo} disabled={!history.future} sx={{ color: '#fff', WebkitAppRegion: 'no-drag' }}>
              <Redo fontSize='small' />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title='Delete selected (⌫)'>
          <span>
            <IconButton size='small' onClick={deleteSelected} disabled={!selected} sx={{ color: '#fff', WebkitAppRegion: 'no-drag' }}>
              <DeleteOutline fontSize='small' />
            </IconButton>
          </span>
        </Tooltip>
        <Box sx={{ flex: 1, minWidth: 12 }} />
        {actionButton('pin', 'Pin above all windows', <PushPinOutlined fontSize='small' />)}
        {actionButton('upload', prefs?.uploadReady ? 'Upload and copy link (⌘U / Ctrl+U)' : (prefs?.uploadProblem ?? 'Upload'), <CloudUploadOutlined fontSize='small' />)}
        {actionButton('saveAs', 'Save as… (⇧⌘S / Ctrl+Shift+S)', <SaveAs fontSize='small' />)}
        {actionButton('save', 'Save to screenshots folder (⌘S / Ctrl+S)', <SaveOutlined fontSize='small' />)}
        <Button
          size='small'
          variant='contained'
          startIcon={busy === 'copy' ? <CircularProgress size={14} color='inherit' /> : <ContentCopy sx={{ fontSize: 16 }} />}
          onClick={() => void run('copy')}
          disabled={!!busy}
          sx={{ WebkitAppRegion: 'no-drag', ml: 0.5, flexShrink: 0, textTransform: 'none' }}
        >
          Copy
        </Button>
      </Stack>

      {/* canvas */}
      <Box ref={viewportRef} sx={{ flex: 1, overflow: 'auto', position: 'relative', bgcolor: '#141418' }}>
        <Box sx={{ minWidth: '100%', minHeight: '100%', display: 'grid', placeItems: 'center', p: 3, boxSizing: 'border-box', width: canvasW + 48, height: canvasH + 48 }}>
          <Box
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHoverHex(null)}
            onDoubleClick={onDoubleClick}
            sx={{ position: 'relative', width: canvasW, height: canvasH, cursor, boxShadow: '0 8px 30px rgba(0,0,0,0.5)', touchAction: 'none' }}
          >
            <canvas
              ref={canvasRef}
              style={{
                width: canvasW,
                height: canvasH,
                display: 'block',
                imageRendering: zoomValue >= 2 ? 'pixelated' : 'auto',
                // Checkerboard under transparent window shadows.
                backgroundImage: 'repeating-conic-gradient(#2c2c34 0% 25%, #24242b 0% 50%)',
                backgroundSize: '16px 16px'
              }}
            />
            {crop && (
              <>
                <Box
                  sx={{
                    position: 'absolute',
                    left: (crop.x - view.x) * scale,
                    top: (crop.y - view.y) * scale,
                    width: crop.w * scale,
                    height: crop.h * scale,
                    border: '1.5px solid #fff',
                    boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                    pointerEvents: 'none',
                    backgroundImage:
                      'linear-gradient(to right, rgba(255,255,255,0.3) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.3) 1px, transparent 1px)',
                    backgroundSize: `${(crop.w * scale) / 3}px ${(crop.h * scale) / 3}px`
                  }}
                >
                  {(['nw', 'ne', 'sw', 'se'] as const).map(h => (
                    <Box
                      key={h}
                      sx={{
                        position: 'absolute',
                        width: 12,
                        height: 12,
                        bgcolor: '#fff',
                        borderRadius: '3px',
                        ...(h.includes('n') ? { top: -6 } : { bottom: -6 }),
                        ...(h.includes('w') ? { left: -6 } : { right: -6 })
                      }}
                    />
                  ))}
                </Box>
                <Stack
                  direction='row'
                  spacing={1}
                  onPointerDown={e => e.stopPropagation()}
                  sx={{
                    position: 'absolute',
                    left: Math.max(0, (crop.x - view.x) * scale),
                    top: Math.min(canvasH - 40, (crop.y - view.y + crop.h) * scale + 8),
                    p: 0.75,
                    borderRadius: 2,
                    bgcolor: 'rgba(20,20,28,0.92)',
                    zIndex: 2
                  }}
                >
                  <Typography sx={{ fontSize: 12, px: 1, alignSelf: 'center', fontVariantNumeric: 'tabular-nums' }}>
                    {Math.round(crop.w)} × {Math.round(crop.h)}
                  </Typography>
                  <Button size='small' color='inherit' onClick={() => chooseTool('select')} sx={{ textTransform: 'none' }}>
                    Cancel
                  </Button>
                  <Button size='small' variant='contained' onClick={applyCrop} sx={{ textTransform: 'none' }}>
                    Crop (↩)
                  </Button>
                </Stack>
              </>
            )}
            {textEdit && (
              <Box
                component='textarea'
                ref={textRef}
                value={textEdit.text}
                rows={Math.max(1, textEdit.text.split('\n').length)}
                onChange={e => setTextEdit({ ...textEdit, text: e.target.value })}
                onPointerDown={e => e.stopPropagation()}
                onBlur={commitText}
                onKeyDown={e => {
                  e.stopPropagation()
                  if (e.key === 'Escape') setTextEdit(null)
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    commitText()
                  }
                }}
                placeholder='Type…'
                sx={{
                  position: 'absolute',
                  left: (textEdit.x - view.x) * scale,
                  top: (textEdit.y - view.y) * scale,
                  minWidth: 80,
                  width: Math.max(80, (Math.max(4, ...textEdit.text.split('\n').map(l => l.length)) + 1) * fontSize(activeSize, density) * scale * 0.62),
                  font: `600 ${fontSize(activeSize, density) * scale}px "Inter Variable", system-ui, sans-serif`,
                  lineHeight: 1.25,
                  color: textEdit.editingId ? (doc.shapes.find(s => s.id === textEdit.editingId) as TextShape | undefined)?.color : color,
                  bgcolor: 'rgba(0,0,0,0.25)',
                  border: '1px dashed rgba(255,255,255,0.7)',
                  borderRadius: 1,
                  outline: 'none',
                  resize: 'none',
                  overflow: 'hidden',
                  p: 0,
                  m: 0,
                  whiteSpace: 'pre'
                }}
              />
            )}
          </Box>
        </Box>
      </Box>

      {/* status bar */}
      <Stack direction='row' alignItems='center' spacing={2} sx={{ height: STATUS, flexShrink: 0, px: 2, bgcolor: '#2a2a32', borderTop: '1px solid rgba(255,255,255,0.08)', fontSize: 12 }}>
        <Stack direction='row' alignItems='center' spacing={1} sx={{ minWidth: 170 }}>
          <Box sx={{ width: 12, height: 12, borderRadius: '3px', bgcolor: hoverHex ?? 'transparent', border: '1px solid rgba(255,255,255,0.3)' }} />
          <Typography sx={{ fontSize: 12, fontFamily: 'monospace' }}>{hoverHex ?? '—'}</Typography>
          <Typography sx={{ fontSize: 11, opacity: 0.55 }}>Tab to copy</Typography>
        </Stack>
        <Typography noWrap sx={{ fontSize: 12, opacity: 0.7, flex: 1, minWidth: 0 }} title={info.link ?? info.savedPath ?? ''}>
          {info.link ? `Link: ${info.link}` : info.savedPath ? `Saved: ${info.savedPath}` : ''}
        </Typography>
        <Typography sx={{ fontSize: 12, opacity: 0.8, fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(doc.crop.w)}×{Math.round(doc.crop.h)} px
        </Typography>
        <Stack direction='row' alignItems='center'>
          <IconButton size='small' onClick={() => stepZoom(-1)} sx={{ color: '#ddd', p: 0.25 }}>
            <ZoomOut sx={{ fontSize: 16 }} />
          </IconButton>
          <ButtonBase onClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')} sx={{ fontSize: 12, px: 0.75, minWidth: 44, fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(zoomValue * 100)}%
          </ButtonBase>
          <IconButton size='small' onClick={() => stepZoom(1)} sx={{ color: '#ddd', p: 0.25 }}>
            <ZoomIn sx={{ fontSize: 16 }} />
          </IconButton>
          <Tooltip title='Fit (⌘0 / Ctrl+0)'>
            <IconButton size='small' onClick={() => setZoom('fit')} sx={{ color: '#ddd', p: 0.25, ml: 0.5 }}>
              <FitScreen sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      <Popover
        open={!!colorAnchor}
        anchorEl={colorAnchor}
        onClose={() => setColorAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { p: 1.5, bgcolor: '#2a2a32' } } }}
      >
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 28px)', gap: 1 }}>
          {COLORS.map(c => (
            <ButtonBase
              key={c}
              onClick={() => {
                setColor(c)
                updateSelected({ color: c })
                setColorAnchor(null)
              }}
              sx={{ width: 28, height: 28, borderRadius: '50%', bgcolor: c, border: c === activeColor ? '3px solid #fff' : '1px solid rgba(255,255,255,0.3)' }}
            />
          ))}
        </Box>
        <Stack direction='row' alignItems='center' spacing={1} sx={{ mt: 1.5 }}>
          <Box
            component='input'
            type='color'
            value={activeColor}
            onChange={e => {
              const value = e.target.value.toUpperCase()
              setColor(value)
              updateSelected({ color: value })
            }}
            sx={{ width: 32, height: 24, p: 0, border: 0, bgcolor: 'transparent', cursor: 'pointer' }}
          />
          <Typography sx={{ fontSize: 12, color: '#ccc' }}>Custom</Typography>
        </Stack>
      </Popover>
    </Box>
  )
}

export default Editor
