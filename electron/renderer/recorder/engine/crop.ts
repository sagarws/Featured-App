import type { CaptureArea } from '@shared/types/recorder'
import { evenCrop } from '@shared/utils/recorder'

/*
 * Crops a display capture to the selected region.
 *
 * Preferred: Chromium's MediaStreamTrackProcessor / Generator. Each frame is
 * re-wrapped as a VideoFrame with a smaller visibleRect — no pixels are copied
 * on the CPU, the encoder reads only the region.
 *
 * Fallback: draw into a canvas at the target frame rate.
 *
 * The region is in DIP relative to the display; captured frames are in
 * physical pixels. The scale is read from each frame, so HiDPI displays and a
 * resolution change mid-recording are both handled.
 */

type Region = Extract<CaptureArea, { type: 'region' }>

interface ProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> }
}
interface GeneratorCtor {
  new (init: { kind: 'video' }): MediaStreamTrack & { writable: WritableStream<VideoFrame> }
}

export const cropVideoTrack = (
  track: MediaStreamTrack,
  region: Region,
  display: { width: number; height: number },
  fps: number
): { track: MediaStreamTrack; stop: () => void } => {
  const g = globalThis as unknown as { MediaStreamTrackProcessor?: ProcessorCtor; MediaStreamTrackGenerator?: GeneratorCtor }
  if (g.MediaStreamTrackProcessor && g.MediaStreamTrackGenerator) {
    const processor = new g.MediaStreamTrackProcessor({ track })
    const generator = new g.MediaStreamTrackGenerator({ kind: 'video' })
    const abort = new AbortController()
    const transform = new TransformStream<VideoFrame, VideoFrame>({
      transform(frame, controller) {
        try {
          const scale = frame.displayWidth / display.width
          const visible = frame.visibleRect
          const offsetX = visible?.x ?? 0
          const offsetY = visible?.y ?? 0
          const rect = evenCrop(region, scale, { width: frame.displayWidth, height: frame.displayHeight })
          const cropped = new VideoFrame(frame, {
            visibleRect: { x: offsetX + rect.x, y: offsetY + rect.y, width: rect.width, height: rect.height },
            displayWidth: rect.width,
            displayHeight: rect.height
          })
          controller.enqueue(cropped)
        } finally {
          frame.close()
        }
      }
    })
    void processor.readable
      .pipeThrough(transform)
      .pipeTo(generator.writable, { signal: abort.signal })
      .catch(() => undefined)
    // The source ending (display unplugged) ends the cropped track too.
    track.addEventListener('ended', () => generator.stop())
    return {
      track: generator,
      stop: () => {
        abort.abort()
        generator.stop()
        track.stop()
      }
    }
  }

  // Canvas fallback.
  const video = document.createElement('video')
  video.muted = true
  video.srcObject = new MediaStream([track])
  void video.play()
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Cannot crop the screen on this computer.')
  const timer = window.setInterval(() => {
    if (!video.videoWidth) return
    const scale = video.videoWidth / display.width
    const rect = evenCrop(region, scale, { width: video.videoWidth, height: video.videoHeight })
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width
      canvas.height = rect.height
    }
    ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)
  }, 1000 / fps)
  const out = canvas.captureStream(fps).getVideoTracks()[0]
  if (!out) throw new Error('Cannot crop the screen on this computer.')
  track.addEventListener('ended', () => out.stop())
  return {
    track: out,
    stop: () => {
      window.clearInterval(timer)
      out.stop()
      track.stop()
    }
  }
}
