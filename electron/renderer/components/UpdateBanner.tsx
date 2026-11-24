import { useState } from 'react'
import { Box, Button, LinearProgress, Paper, Typography } from '@mui/material'
import type { AgentState } from '@shared/types/agent'
import IconTile from './IconTile'

/** Shown on Home while a newer version is available, downloading, ready or installing. */
const UpdateBanner = ({ state }: { state: AgentState }) => {
  const [error, setError] = useState<string | null>(null)
  const { update } = state
  if (update.state !== 'available' && update.state !== 'downloading' && update.state !== 'ready' && update.state !== 'installing') {
    return null
  }

  const install = async () => {
    setError(null)
    const result = await window.printAgent.installUpdate()
    if (!result.ok) setError(result.error)
  }

  const title =
    update.state === 'installing'
      ? `Installing version ${update.latestVersion}…`
      : update.state === 'downloading'
        ? `Downloading version ${update.latestVersion}${update.percent >= 0 ? ` — ${update.percent}%` : '…'}`
        : update.state === 'ready'
          ? `Version ${update.latestVersion} is ready to install`
          : `Update available: version ${update.latestVersion}`

  const hint =
    update.state === 'installing'
      ? 'The app closes, updates and opens again by itself.'
      : update.state === 'downloading'
        ? 'You can keep working while it downloads.'
        : update.state === 'ready'
          ? 'It installs the next time the app starts, or restart now.'
          : `You have ${state.version}.`

  return (
    <Paper
      variant='outlined'
      sx={{
        px: 3,
        py: 2,
        borderRadius: 3,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        borderColor: 'info.main',
        bgcolor: 'var(--mui-palette-info-lighterOpacity)'
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2.5 }}>
        <IconTile icon='tabler-cloud-download' tone='info' size={36} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant='body2' sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
          <Typography variant='caption' color={error ? 'error.main' : 'text.secondary'}>
            {error ?? hint}
          </Typography>
        </Box>
        {(update.state === 'available' || update.state === 'ready') && (
          <Button
            variant='contained'
            color='info'
            size='small'
            disabled={!state.packaged}
            title={state.packaged ? undefined : 'Only in the installed app.'}
            startIcon={<i className='tabler-download' style={{ fontSize: 16 }} />}
            onClick={() => void install()}
            sx={{ flexShrink: 0 }}
          >
            {update.state === 'ready' ? 'Restart & update' : 'Update now'}
          </Button>
        )}
      </Box>
      {update.state === 'downloading' && (
        <LinearProgress
          color='info'
          variant={update.percent >= 0 ? 'determinate' : 'indeterminate'}
          value={Math.max(0, update.percent)}
          sx={{ borderRadius: 1 }}
        />
      )}
    </Paper>
  )
}

export default UpdateBanner
