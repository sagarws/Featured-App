import { useEffect, useState } from 'react'
import { Box, Button, ButtonBase, CircularProgress, Stack, Typography } from '@mui/material'
import type { WindowChoice } from '@shared/types/screenshot'

/** Windows / Linux: pick the window to capture (macOS uses its own hover-and-click picker). */
const WindowPicker = () => {
  const api = window.printAgent.screenshot
  const [windows, setWindows] = useState<WindowChoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.listWindows().then(r => {
      if (r.ok) setWindows(r.value)
      else setError(r.error)
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void api.pickWindow(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api])

  return (
    <Stack sx={{ height: '100vh', bgcolor: '#1e1e24', color: '#eee' }}>
      <Stack direction='row' alignItems='center' sx={{ px: 3, py: 2, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <Box sx={{ flex: 1 }}>
          <Typography sx={{ fontWeight: 600 }}>Choose a window to capture</Typography>
          <Typography sx={{ fontSize: 12.5, opacity: 0.7 }}>Click a window. Esc to cancel.</Typography>
        </Box>
        <Button color='inherit' onClick={() => void api.pickWindow(null)}>
          Cancel
        </Button>
      </Stack>
      <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
        {!windows && !error && (
          <Stack alignItems='center' sx={{ mt: 8 }}>
            <CircularProgress size={28} />
          </Stack>
        )}
        {error && <Typography color='error'>{error}</Typography>}
        {windows && !windows.length && <Typography sx={{ opacity: 0.7 }}>No windows to capture.</Typography>}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 2 }}>
          {windows?.map(w => (
            <ButtonBase
              key={w.id}
              onClick={() => void api.pickWindow(w.id)}
              sx={{ flexDirection: 'column', alignItems: 'stretch', p: 1.5, borderRadius: 2, border: '1px solid rgba(255,255,255,0.1)', '&:hover': { bgcolor: 'rgba(255,255,255,0.06)', borderColor: 'primary.main' } }}
            >
              <Box component='img' src={w.thumbnail} alt='' sx={{ width: '100%', height: 120, objectFit: 'contain', bgcolor: 'rgba(0,0,0,0.3)', borderRadius: 1 }} />
              <Stack direction='row' spacing={1} alignItems='center' sx={{ mt: 1, minWidth: 0 }}>
                {w.appIcon && <Box component='img' src={w.appIcon} alt='' sx={{ width: 16, height: 16 }} />}
                <Typography noWrap sx={{ fontSize: 13, textAlign: 'start' }} title={w.name}>
                  {w.name}
                </Typography>
              </Stack>
            </ButtonBase>
          ))}
        </Box>
      </Box>
    </Stack>
  )
}

export default WindowPicker
