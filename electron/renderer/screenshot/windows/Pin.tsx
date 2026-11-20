import { useEffect, useState } from 'react'
import { Box, IconButton, Stack, Tooltip } from '@mui/material'
import { Close, ContentCopy } from '@mui/icons-material'
import { useCaptureUrl } from './useCapture'

/** A screenshot floating above every window, to compare or copy from. Drag to move; Esc or × to close. */
const Pin = ({ id }: { id: string }) => {
  const api = window.printAgent.screenshot
  const { url, error } = useCaptureUrl(id)
  const [hover, setHover] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void api.closeSelf()
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') void api.exportImage(id, 'copy')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api, id])

  useEffect(() => {
    if (error) void api.closeSelf()
  }, [error, api])

  return (
    <Box
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      sx={{ position: 'fixed', inset: 0, borderRadius: 1.5, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.25)', WebkitAppRegion: 'drag' }}
    >
      {url && <Box component='img' src={url} alt='Pinned screenshot' draggable={false} sx={{ width: '100%', height: '100%', display: 'block', objectFit: 'fill' }} />}
      {hover && (
        <Stack direction='row' spacing={0.5} sx={{ position: 'absolute', top: 6, right: 6, WebkitAppRegion: 'no-drag' }}>
          <Tooltip title='Copy'>
            <IconButton size='small' onClick={() => void api.exportImage(id, 'copy')} sx={{ color: '#fff', bgcolor: 'rgba(0,0,0,0.6)', '&:hover': { bgcolor: 'rgba(0,0,0,0.8)' } }}>
              <ContentCopy sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title='Close (Esc)'>
            <IconButton size='small' onClick={() => void api.closeSelf()} sx={{ color: '#fff', bgcolor: 'rgba(0,0,0,0.6)', '&:hover': { bgcolor: 'rgba(0,0,0,0.8)' } }}>
              <Close sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        </Stack>
      )}
    </Box>
  )
}

export default Pin
