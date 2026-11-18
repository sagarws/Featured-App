import { Alert, Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material'
import { MicOffOutlined, MicOutlined, PauseRounded, PlayArrowRounded, StopRounded, VolumeOffOutlined, VolumeUpOutlined } from '@mui/icons-material'
import type { RecorderStatus } from '@shared/types/recorder'
import { formatDuration } from '@shared/utils/recorder'

const KIND_LABEL = { screen: 'Screen', webcam: 'Webcam', audio: 'Audio' } as const

/** The live session in the app window: same controls as the floating toolbar. */
const ActiveRecordingBanner = ({ status }: { status: RecorderStatus }) => {
  const recorder = window.printAgent.recorder

  if (!status.active && status.phase === 'merging') {
    return (
      <Alert severity='info' icon={<CircularProgress size={18} />}>
        Saving the last recording — checking and joining its segments…
      </Alert>
    )
  }
  if (!status.active) return null

  const paused = status.phase === 'paused'
  const busy = status.phase === 'starting' || status.phase === 'stopping'
  return (
    <Paper variant='outlined' sx={{ p: 3, borderRadius: 3, borderColor: 'error.main', bgcolor: 'var(--mui-palette-error-lighterOpacity)' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems={{ md: 'center' }}>
        <Stack direction='row' spacing={1.5} alignItems='center'>
          <Box
            sx={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              bgcolor: paused ? 'warning.main' : 'error.main',
              animation: paused || busy ? 'none' : 'recPulse 1.2s ease-in-out infinite',
              '@keyframes recPulse': { '50%': { opacity: 0.25 } }
            }}
          />
          <Typography sx={{ fontWeight: 700 }}>
            {status.phase === 'starting' ? 'Starting…' : status.phase === 'stopping' ? 'Saving…' : paused ? 'Paused' : 'Recording'}
          </Typography>
          <Typography sx={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatDuration(status.elapsed)}</Typography>
        </Stack>
        <Stack direction='row' spacing={2.5} alignItems='center' sx={{ color: 'text.secondary', fontSize: 13, flexWrap: 'wrap' }}>
          <span>{status.kind ? KIND_LABEL[status.kind] : ''}</span>
          <span>{status.segmentSeconds ? `Segment ${status.segment} · ${formatDuration(status.segmentElapsed)}` : 'Single file'}</span>
          <Stack direction='row' spacing={0.5} alignItems='center'>
            {status.systemAudioSilent ? (
              <VolumeOffOutlined fontSize='small' color='warning' />
            ) : status.systemAudio ? (
              <VolumeUpOutlined fontSize='small' color='success' />
            ) : (
              <VolumeOffOutlined fontSize='small' />
            )}
            <span>System audio {status.systemAudioSilent ? 'silent' : status.systemAudio ? 'on' : 'off'}</span>
          </Stack>
          <Stack direction='row' spacing={0.5} alignItems='center'>
            {status.microphone === 'off' ? <MicOffOutlined fontSize='small' /> : <MicOutlined fontSize='small' color={status.microphone === 'lost' ? 'warning' : 'success'} />}
            <span>Microphone {status.microphone === 'lost' ? 'disconnected' : status.microphone}</span>
          </Stack>
        </Stack>
        <Box sx={{ flex: 1 }} />
        <Stack direction='row' spacing={1.5}>
          <Button
            variant='tonal'
            color='secondary'
            disabled={busy}
            startIcon={paused ? <PlayArrowRounded /> : <PauseRounded />}
            onClick={() => void (paused ? recorder.resume() : recorder.pause())}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button variant='contained' color='error' disabled={busy} startIcon={<StopRounded />} onClick={() => void recorder.stop()}>
            Stop
          </Button>
        </Stack>
      </Stack>
      {status.systemAudioSilent && (
        <Alert
          severity='warning'
          sx={{ mt: 2 }}
          action={
            <Button color='inherit' size='small' onClick={() => void recorder.openPrivacy('audio')}>
              Open settings
            </Button>
          }
        >
          No sound is coming through system audio, so other people in a call or video are not being recorded. If something is playing,
          the operating system is blocking it. On a Mac, allow this app (or the terminal/IDE that started it) under Privacy &amp; Security →
          Screen &amp; System Audio Recording, then restart it. Your microphone is still recorded.
        </Alert>
      )}
      {status.error && (
        <Alert severity='warning' sx={{ mt: 2 }}>
          {status.error}
        </Alert>
      )}
    </Paper>
  )
}

export default ActiveRecordingBanner
