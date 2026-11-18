import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Box, Typography } from '@mui/material'

const drag = { WebkitAppRegion: 'drag' } as CSSProperties

/**
 * Round webcam preview floating over the screen. Unlike the toolbar it is
 * NOT excluded from the capture — it is how the camera gets into a screen
 * recording. Drag to move; drag the window edge to resize.
 */
const CameraBubble = () => {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stream: MediaStream | null = null
    let stopped = false
    void (async () => {
      const device = await window.printAgent.recorder.cameraDevice()
      const deviceId = device.ok ? device.value : null
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 640 }, height: { ideal: 640 } },
          audio: false
        })
        if (stopped) return stream.getTracks().forEach(t => t.stop())
        if (video.current) video.current.srcObject = stream
      } catch (err) {
        setError((err as Error).message || 'Camera unavailable')
      }
    })()
    return () => {
      stopped = true
      stream?.getTracks().forEach(t => t.stop())
    }
  }, [])

  return (
    <Box style={drag} sx={{ position: 'fixed', inset: 0, borderRadius: '50%', overflow: 'hidden', border: '3px solid #fff', boxSizing: 'border-box', bgcolor: '#111', cursor: 'move' }}>
      {error ? (
        <Typography sx={{ color: '#fff', fontSize: 12, p: 3, textAlign: 'center', mt: '35%' }}>{error}</Typography>
      ) : (
        <video ref={video} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
      )}
    </Box>
  )
}

export default CameraBubble
