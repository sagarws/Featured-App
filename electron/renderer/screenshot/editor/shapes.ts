/*
 * Annotation shapes and how they are drawn. Coordinates are in pixels of the
 * original picture (before any crop), so cropping never moves a shape.
 */

export type Tool = 'select' | 'crop' | 'arrow' | 'line' | 'rect' | 'ellipse' | 'pen' | 'highlighter' | 'text' | 'counter' | 'pixelate' | 'redact' | 'spotlight'

/** 0 small … 3 extra large. */
export type SizeLevel = 0 | 1 | 2 | 3

interface Base {
  id: string
  color: string
  size: SizeLevel
}

export type LineShape = Base & { type: 'arrow' | 'line'; x1: number; y1: number; x2: number; y2: number }
export type BoxShape = Base & { type: 'rect' | 'ellipse' | 'pixelate' | 'redact' | 'spotlight'; x: number; y: number; w: number; h: number }
export type PathShape = Base & { type: 'pen' | 'highlighter'; points: number[] }
export type TextShape = Base & { type: 'text'; x: number; y: number; text: string }
export type CounterShape = Base & { type: 'counter'; x: number; y: number; n: number }
export type Shape = LineShape | BoxShape | PathShape | TextShape | CounterShape

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Doc {
  shapes: Shape[]
  crop: Rect
}

export const COLORS = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#007AFF', '#AF52DE', '#000000', '#FFFFFF']

const STROKE = [2, 3.5, 6, 10]
const FONT = [16, 22, 32, 48]
const COUNTER_RADIUS = [11, 15, 20, 28]

/** Sizes scale with the picture's pixel density, so a Retina capture does not get hairlines. */
export const strokeWidth = (s: SizeLevel, density: number): number => STROKE[s]! * density
export const fontSize = (s: SizeLevel, density: number): number => FONT[s]! * density
export const counterRadius = (s: SizeLevel, density: number): number => COUNTER_RADIUS[s]! * density

export const isBox = (shape: Shape): shape is BoxShape =>
  shape.type === 'rect' || shape.type === 'ellipse' || shape.type === 'pixelate' || shape.type === 'redact' || shape.type === 'spotlight'
export const isLine = (shape: Shape): shape is LineShape => shape.type === 'arrow' || shape.type === 'line'

export const normaliseRect = (x1: number, y1: number, x2: number, y2: number): Rect => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  w: Math.abs(x2 - x1),
  h: Math.abs(y2 - y1)
})

export const fontFor = (size: SizeLevel, density: number): string => `600 ${fontSize(size, density)}px "Inter Variable", system-ui, -apple-system, "Segoe UI", sans-serif`

// ── measuring ───────────────────────────────────────────────────────────────

let scratch: CanvasRenderingContext2D | null = null
const measureCtx = (): CanvasRenderingContext2D => {
  scratch ??= document.createElement('canvas').getContext('2d')!
  return scratch
}

export const textBox = (shape: TextShape, density: number): Rect => {
  const ctx = measureCtx()
  ctx.font = fontFor(shape.size, density)
  const lines = shape.text.split('\n')
  const lineHeight = fontSize(shape.size, density) * 1.25
  const width = Math.max(...lines.map(line => ctx.measureText(line).width), fontSize(shape.size, density) * 0.5)
  return { x: shape.x, y: shape.y, w: width, h: lineHeight * lines.length }
}

/** The area a shape covers, for selection outlines and hit tests. */
export const bounds = (shape: Shape, density: number): Rect => {
  switch (shape.type) {
    case 'arrow':
    case 'line':
      return normaliseRect(shape.x1, shape.y1, shape.x2, shape.y2)
    case 'pen':
    case 'highlighter': {
      const xs = shape.points.filter((_, i) => i % 2 === 0)
      const ys = shape.points.filter((_, i) => i % 2 === 1)
      return normaliseRect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))
    }
    case 'text':
      return textBox(shape, density)
    case 'counter': {
      const r = counterRadius(shape.size, density)
      return { x: shape.x - r, y: shape.y - r, w: r * 2, h: r * 2 }
    }
    default:
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
  }
}

const distToSegment = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/** The top-most shape under a point. */
export const hitTest = (shapes: Shape[], x: number, y: number, density: number): Shape | null => {
  const tolerance = 8 * density
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i]!
    if (isLine(shape)) {
      if (distToSegment(x, y, shape.x1, shape.y1, shape.x2, shape.y2) <= tolerance + strokeWidth(shape.size, density)) return shape
    } else if (shape.type === 'pen' || shape.type === 'highlighter') {
      const p = shape.points
      const reach = tolerance + strokeWidth(shape.size, density) * (shape.type === 'highlighter' ? 3 : 1)
      for (let j = 0; j + 3 < p.length; j += 2) if (distToSegment(x, y, p[j]!, p[j + 1]!, p[j + 2]!, p[j + 3]!) <= reach) return shape
      if (p.length === 2 && Math.hypot(x - p[0]!, y - p[1]!) <= reach) return shape
    } else {
      const b = bounds(shape, density)
      if (x >= b.x - tolerance && x <= b.x + b.w + tolerance && y >= b.y - tolerance && y <= b.y + b.h + tolerance) return shape
    }
  }
  return null
}

export const moveShape = (shape: Shape, dx: number, dy: number): Shape => {
  switch (shape.type) {
    case 'arrow':
    case 'line':
      return { ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy }
    case 'pen':
    case 'highlighter':
      return { ...shape, points: shape.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) }
    default:
      return { ...shape, x: shape.x + dx, y: shape.y + dy }
  }
}

// ── drawing ─────────────────────────────────────────────────────────────────

const withShadow = (ctx: CanvasRenderingContext2D, density: number): void => {
  ctx.shadowColor = 'rgba(0,0,0,0.28)'
  ctx.shadowBlur = 4 * density
  ctx.shadowOffsetY = 1 * density
}

/** A tapered arrow, wide at the head — readable at any size. */
const drawArrow = (ctx: CanvasRenderingContext2D, s: LineShape, density: number): void => {
  const width = strokeWidth(s.size, density)
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const length = Math.hypot(dx, dy)
  if (length < 1) return
  const head = Math.min(length * 0.6, Math.max(12 * density, width * 4.2))
  const headHalf = head * 0.48
  const tail = width * 0.25
  const neck = width * 0.62
  const ux = dx / length
  const uy = dy / length
  const nx = -uy
  const ny = ux
  const bx = s.x2 - ux * head
  const by = s.y2 - uy * head
  ctx.beginPath()
  ctx.moveTo(s.x1 + nx * tail, s.y1 + ny * tail)
  ctx.lineTo(bx + nx * neck, by + ny * neck)
  ctx.lineTo(bx + nx * headHalf, by + ny * headHalf)
  ctx.lineTo(s.x2, s.y2)
  ctx.lineTo(bx - nx * headHalf, by - ny * headHalf)
  ctx.lineTo(bx - nx * neck, by - ny * neck)
  ctx.lineTo(s.x1 - nx * tail, s.y1 - ny * tail)
  ctx.closePath()
  ctx.fillStyle = s.color
  ctx.lineJoin = 'round'
  ctx.fill()
}

const drawPath = (ctx: CanvasRenderingContext2D, points: number[]): void => {
  ctx.beginPath()
  ctx.moveTo(points[0]!, points[1]!)
  if (points.length === 2) {
    ctx.lineTo(points[0]! + 0.01, points[1]!)
    return
  }
  // Midpoint quadratic curves: smooth without lagging behind the pointer.
  for (let i = 2; i + 3 < points.length; i += 2) {
    const mx = (points[i]! + points[i + 2]!) / 2
    const my = (points[i + 1]! + points[i + 3]!) / 2
    ctx.quadraticCurveTo(points[i]!, points[i + 1]!, mx, my)
  }
  ctx.lineTo(points[points.length - 2]!, points[points.length - 1]!)
}

const pixelate = (ctx: CanvasRenderingContext2D, base: CanvasImageSource, r: Rect, density: number): void => {
  const w = Math.round(r.w)
  const h = Math.round(r.h)
  if (w < 1 || h < 1) return
  const block = Math.max(6, Math.round(9 * density))
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.ceil(w / block))
  small.height = Math.max(1, Math.ceil(h / block))
  const sctx = small.getContext('2d')!
  sctx.drawImage(base, Math.round(r.x), Math.round(r.y), w, h, 0, 0, small.width, small.height)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(small, 0, 0, small.width, small.height, Math.round(r.x), Math.round(r.y), w, h)
  ctx.restore()
}

const roundRectPath = (ctx: CanvasRenderingContext2D, r: Rect, radius: number): void => {
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(radius, r.w / 2, r.h / 2))
}

export const drawShape = (ctx: CanvasRenderingContext2D, shape: Shape, base: CanvasImageSource, image: Rect, density: number): void => {
  ctx.save()
  switch (shape.type) {
    case 'arrow':
      withShadow(ctx, density)
      drawArrow(ctx, shape, density)
      break
    case 'line':
      withShadow(ctx, density)
      ctx.strokeStyle = shape.color
      ctx.lineWidth = strokeWidth(shape.size, density)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(shape.x1, shape.y1)
      ctx.lineTo(shape.x2, shape.y2)
      ctx.stroke()
      break
    case 'rect':
      withShadow(ctx, density)
      ctx.strokeStyle = shape.color
      ctx.lineWidth = strokeWidth(shape.size, density)
      ctx.lineJoin = 'round'
      roundRectPath(ctx, shape, strokeWidth(shape.size, density) * 1.2)
      ctx.stroke()
      break
    case 'ellipse':
      withShadow(ctx, density)
      ctx.strokeStyle = shape.color
      ctx.lineWidth = strokeWidth(shape.size, density)
      ctx.beginPath()
      ctx.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, Math.max(1, shape.w / 2), Math.max(1, shape.h / 2), 0, 0, Math.PI * 2)
      ctx.stroke()
      break
    case 'redact':
      ctx.fillStyle = shape.color
      roundRectPath(ctx, shape, 2 * density)
      ctx.fill()
      break
    case 'pixelate':
      pixelate(ctx, base, shape, density)
      break
    case 'spotlight':
      // Everything but the box goes dark.
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.beginPath()
      ctx.rect(image.x, image.y, image.w, image.h)
      ctx.roundRect(shape.x, shape.y, shape.w, shape.h, 6 * density)
      ctx.fill('evenodd')
      break
    case 'pen':
      withShadow(ctx, density)
      ctx.strokeStyle = shape.color
      ctx.lineWidth = strokeWidth(shape.size, density)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      drawPath(ctx, shape.points)
      ctx.stroke()
      break
    case 'highlighter':
      ctx.globalAlpha = 0.38
      ctx.globalCompositeOperation = 'multiply'
      ctx.strokeStyle = shape.color
      ctx.lineWidth = strokeWidth(shape.size, density) * 3.2
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      drawPath(ctx, shape.points)
      ctx.stroke()
      break
    case 'text': {
      const size = fontSize(shape.size, density)
      ctx.font = fontFor(shape.size, density)
      ctx.textBaseline = 'top'
      ctx.lineJoin = 'round'
      const light = isLight(shape.color)
      shape.text.split('\n').forEach((line, i) => {
        const y = shape.y + i * size * 1.25
        // An outline in the opposite tone keeps text readable on any background.
        ctx.strokeStyle = light ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.95)'
        ctx.lineWidth = size * 0.16
        ctx.strokeText(line, shape.x, y)
        ctx.fillStyle = shape.color
        ctx.fillText(line, shape.x, y)
      })
      break
    }
    case 'counter': {
      const r = counterRadius(shape.size, density)
      withShadow(ctx, density)
      ctx.fillStyle = shape.color
      ctx.beginPath()
      ctx.arc(shape.x, shape.y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowColor = 'transparent'
      ctx.lineWidth = Math.max(1.5, r * 0.12)
      ctx.strokeStyle = '#fff'
      ctx.stroke()
      ctx.fillStyle = isLight(shape.color) ? '#000' : '#fff'
      ctx.font = `700 ${Math.round(r * 1.15)}px "Inter Variable", system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(shape.n), shape.x, shape.y + r * 0.04)
      break
    }
  }
  ctx.restore()
}

export const isLight = (hex: string): boolean => {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return 0.299 * r + 0.587 * g + 0.114 * b > 170
}

/** The picture, cropped, with every shape — what gets copied, saved and uploaded. */
export const renderDoc = (ctx: CanvasRenderingContext2D, base: CanvasImageSource, doc: Doc, image: Rect, density: number, extra: Shape | null = null): void => {
  ctx.setTransform(1, 0, 0, 1, -doc.crop.x, -doc.crop.y)
  ctx.clearRect(doc.crop.x, doc.crop.y, doc.crop.w, doc.crop.h)
  ctx.drawImage(base, 0, 0)
  for (const shape of doc.shapes) drawShape(ctx, shape, base, image, density)
  if (extra) drawShape(ctx, extra, base, image, density)
}
