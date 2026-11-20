import type { RemotePlatform } from '@shared/types/remote'

interface DisplayLike {
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}

/** 0–1 of the shared display → the coordinates the host OS's injection API expects. */
export const toHostPoint = (
  nx: number,
  ny: number,
  display: DisplayLike,
  os: RemotePlatform,
  dipToScreen?: (p: { x: number; y: number }) => { x: number; y: number }
): { x: number; y: number } => {
  const { x, y, width, height } = display.bounds
  // Clamp inside the display so a pointer at the very edge cannot land on the neighbour.
  const dip = { x: x + Math.min(nx * width, width - 1), y: y + Math.min(ny * height, height - 1) }
  // macOS: CoreGraphics uses the same global points Electron reports.
  if (os === 'darwin') return { x: Math.round(dip.x * 100) / 100, y: Math.round(dip.y * 100) / 100 }
  // Windows / X11: physical pixels.
  if (dipToScreen) return dipToScreen(dip)
  return { x: Math.round(dip.x * display.scaleFactor), y: Math.round(dip.y * display.scaleFactor) }
}

