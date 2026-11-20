import type { ReactNode } from 'react'
import { Box, FormControl, MenuItem, Paper, Select, Stack, Typography } from '@mui/material'

/** Settings card: a title, a line under it, and rows split by thin lines. */
export const Section = ({ title, subtitle, action, children }: { title: string; subtitle?: ReactNode; action?: ReactNode; children: ReactNode }) => (
  <Paper variant='outlined' sx={{ p: 4, borderRadius: 3 }}>
    <Stack direction='row' alignItems='flex-start' spacing={2}>
      <Box sx={{ flex: 1 }}>
        <Typography variant='h6' sx={{ fontSize: 16, fontWeight: 600 }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography variant='body2' color='text.secondary' sx={{ mb: 1 }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {action}
    </Stack>
    <Stack divider={<Box sx={{ borderBlockEnd: '1px solid', borderColor: 'divider' }} />}>{children}</Stack>
  </Paper>
)

export const Row = ({ title, hint, children, wide }: { title: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) => (
  <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} spacing={{ xs: 1, sm: 3 }} sx={{ py: 1.75 }}>
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography variant='body2' sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {hint && (
        <Typography variant='caption' color='text.secondary' component='div'>
          {hint}
        </Typography>
      )}
    </Box>
    <Box sx={{ flexShrink: 0, minWidth: wide ? 360 : 220, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>{children}</Box>
  </Stack>
)

export const Choice = <T extends string | number>({ value, options, onChange, width = 220 }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; width?: number }) => (
  <FormControl size='small' sx={{ minWidth: width }}>
    <Select value={value} onChange={e => onChange(options.find(o => String(o.value) === String(e.target.value))?.value ?? value)}>
      {options.map(o => (
        <MenuItem key={String(o.value)} value={o.value}>
          {o.label}
        </MenuItem>
      ))}
    </Select>
  </FormControl>
)

/** A block of monospace text (request / response examples). */
export const Code = ({ children }: { children: string }) => (
  <Box
    component='pre'
    sx={{
      m: 0,
      p: 2,
      borderRadius: 2,
      bgcolor: 'action.hover',
      fontSize: 12,
      lineHeight: 1.55,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      overflowX: 'auto',
      whiteSpace: 'pre'
    }}
  >
    {children}
  </Box>
)
