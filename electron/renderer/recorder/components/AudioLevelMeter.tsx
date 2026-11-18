import { Box } from '@mui/material'

/** Segmented input-level bar (0–1): green, then amber, then red near clipping. */
const AudioLevelMeter = ({ level, segments = 24 }: { level: number; segments?: number }) => (
  <Box sx={{ display: 'flex', gap: '3px', height: 10 }} role='meter' aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} aria-label='Input level'>
    {Array.from({ length: segments }, (_, i) => {
      const lit = level * segments > i
      const color = i >= segments * 0.85 ? 'error.main' : i >= segments * 0.65 ? 'warning.main' : 'success.main'
      return <Box key={i} sx={{ flex: 1, borderRadius: '2px', bgcolor: lit ? color : 'action.hover', transition: 'background-color 60ms' }} />
    })}
  </Box>
)

export default AudioLevelMeter
