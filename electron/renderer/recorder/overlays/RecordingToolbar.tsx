import type { CSSProperties } from 'react'
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { MicOffOutlined, MicOutlined, PauseRounded, PlayArrowRounded, StopRounded, VolumeOffOutlined, VolumeUpOutlined, WarningAmberRounded } from '@mui/icons-material'
import { formatDuration } from '@shared/utils/recorder'
import { useRecorderStatus } from '../hooks'

const drag = { WebkitAppRegion: 'drag' } as CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

/**
 * The floating control panel while recording: REC ● 00:35:24 · Segment 2 ·
 * system audio · microphone · pause/resume · stop. Excluded from the capture
 * by the main process (content protection). The bar itself drags the window.
 */
const RecordingToolbar = () => {
  const status = useRecorderStatus()
  const recorder = window.printAgent.recorder
  const paused = status?.phase === 'paused'
  const stopping = status?.phase === 'stopping' || status?.phase === 'merging'
  const segmentLabel = status?.segmentSeconds ? `Segment ${status.segment} · ${formatDuration(status.segmentElapsed)}` : 'Single file'

  return (
    <Stack
      direction='row'
      alignItems='center'
      spacing={1.5}
      style={drag}
      sx={{
        height: '100%',
        boxSizing: 'border-box',
        px: 2,
        borderRadius: '16px',
        bgcolor: 'rgba(24, 24, 32, 0.92)',
        border: '1px solid rgba(255,255,255,0.12)',
        color: '#fff',
        userSelect: 'none'
      }}
    >
      <Stack direction='row' alignItems='center' spacing={1} sx={{ minWidth: 128 }}>
        <Box
          sx={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            bgcolor: paused ? 'warning.main' : 'error.main',
            animation: paused ? 'none' : 'recPulse 1.2s ease-in-out infinite',
            '@keyframes recPulse': { '50%': { opacity: 0.25 } }
          }}
        />
        <Typography sx={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.5 }}>{paused ? 'PAUSED' : stopping ? 'SAVING' : 'REC'}</Typography>
        <Typography sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: 15 }}>{formatDuration(status?.elapsed ?? 0)}</Typography>
      </Stack>

      {status?.systemAudioSilent ? (
        // The toolbar is short, so the warning itself is the button (a tooltip would be clipped).
        <Box
          component='button'
          style={noDrag}
          onClick={() => void recorder.openPrivacy('audio')}
          title='System audio is silent. If sound is playing, the OS is blocking it. Click to open the privacy settings.'
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            px: 1,
            py: 0.5,
            border: 0,
            borderRadius: '8px',
            cursor: 'pointer',
            bgcolor: 'rgba(255,180,0,0.18)',
            color: '#FFB400',
            font: 'inherit',
            fontSize: 12,
            fontWeight: 600,
            whiteSpace: 'nowrap'
          }}
        >
          <WarningAmberRounded sx={{ fontSize: 16 }} />
          No system sound · Fix
        </Box>
      ) : (
        <>
          <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', minWidth: 120 }} noWrap>
            {segmentLabel}
          </Typography>
          <Tooltip title={status?.systemAudio ? 'System audio: on' : 'System audio: off'}>
            <Box sx={{ display: 'flex', color: status?.systemAudio ? '#56CA00' : 'rgba(255,255,255,0.4)' }}>
              {status?.systemAudio ? <VolumeUpOutlined fontSize='small' /> : <VolumeOffOutlined fontSize='small' />}
            </Box>
          </Tooltip>
        </>
      )}
      <Tooltip title={status?.microphone === 'on' ? 'Microphone: on' : status?.microphone === 'lost' ? 'Microphone disconnected' : 'Microphone: off'}>
        <Box sx={{ display: 'flex', color: status?.microphone === 'on' ? '#56CA00' : status?.microphone === 'lost' ? '#FFB400' : 'rgba(255,255,255,0.4)' }}>
          {status?.microphone === 'off' ? <MicOffOutlined fontSize='small' /> : <MicOutlined fontSize='small' />}
        </Box>
      </Tooltip>

      <Box sx={{ flex: 1 }} />

      <Stack direction='row' spacing={1} style={noDrag}>
        <Tooltip title={paused ? 'Resume' : 'Pause'}>
          <span>
            <IconButton
              size='small'
              disabled={stopping || !status?.active}
              onClick={() => void (paused ? recorder.resume() : recorder.pause())}
              sx={{ bgcolor: 'rgba(255,255,255,0.1)', color: '#fff' }}
              aria-label={paused ? 'Resume recording' : 'Pause recording'}
            >
              {paused ? <PlayArrowRounded /> : <PauseRounded />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title='Stop and save'>
          <span>
            <IconButton
              size='small'
              disabled={stopping || !status?.active}
              onClick={() => void recorder.stop()}
              sx={{ bgcolor: 'error.main', color: '#fff', '&:hover': { bgcolor: 'error.dark' } }}
              aria-label='Stop recording'
            >
              <StopRounded />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    </Stack>
  )
}

export default RecordingToolbar
