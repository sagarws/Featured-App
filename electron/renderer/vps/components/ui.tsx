import type { ReactNode } from 'react'
import { Box, Stack, Typography } from '@mui/material'

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** A label / value row inside a card. */
export const InfoRow = ({ label, value, mono, action }: { label: string; value: ReactNode; mono?: boolean; action?: ReactNode }) => (
  <Stack direction='row' alignItems='center' spacing={2} sx={{ py: 1, borderBottom: '1px solid', borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
    <Typography sx={{ fontSize: 13, color: 'text.secondary', width: 150, flexShrink: 0 }}>{label}</Typography>
    <Box sx={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 500, fontFamily: mono ? MONO : undefined, overflowWrap: 'anywhere' }}>{value}</Box>
    {action}
  </Stack>
)

/** A small metric tile: label, big value, optional bar. */
export const Metric = ({ label, value, sub, percent }: { label: string; value: string; sub?: string; percent?: number | null }) => (
  <Box sx={{ p: 2.5, borderRadius: 2, bgcolor: 'action.hover', height: '100%' }}>
    <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{label}</Typography>
    <Typography sx={{ fontSize: 20, fontWeight: 700, mt: 0.5 }}>{value}</Typography>
    {sub && <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{sub}</Typography>}
    {percent !== undefined && percent !== null && (
      <Box sx={{ mt: 1.5, height: 6, borderRadius: 3, bgcolor: 'divider', overflow: 'hidden' }}>
        <Box
          sx={{
            height: '100%',
            width: `${Math.min(100, Math.max(0, percent))}%`,
            bgcolor: percent > 90 ? 'error.main' : percent > 70 ? 'warning.main' : 'primary.main',
            transition: 'width 0.4s'
          }}
        />
      </Box>
    )}
  </Box>
)
