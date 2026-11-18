import { Box } from '@mui/material'

/** Frame around the region being recorded. Click-through and excluded from the capture. */
const RegionBorder = () => (
  <Box sx={{ position: 'fixed', inset: 0, border: '3px dashed #FF4C51', borderRadius: '2px', boxSizing: 'border-box', pointerEvents: 'none' }} />
)

export default RegionBorder
