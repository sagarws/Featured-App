import { useState } from 'react'
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material'
import { CheckCircleRounded, RadioButtonUncheckedRounded } from '@mui/icons-material'
import type { RemoteStatus } from '@shared/types/remote'

/**
 * macOS one-time setup for being viewed and controlled. Both permissions are
 * asked for with one button and both belong to "Featured App" itself (the
 * keyboard/mouse code runs inside the app, so there is no second entry for a
 * helper). Shown only on a Mac, only while something is missing — and right
 * after granting, until the restart that Screen Recording needs.
 */
const MacSetupCard = ({ status }: { status: RemoteStatus }) => {
  const api = window.printAgent.remote
  const [asked, setAsked] = useState(false)
  const p = status.permissions
  const screen = p.screen === 'granted'
  const control = p.input === 'granted'
  if (status.identity.platform !== 'darwin' || (screen && control && !asked)) return null

  const step = (done: boolean, title: string, hint: string, pane: 'screen' | 'accessibility') => (
    <Stack direction='row' spacing={1.5} alignItems='center'>
      {done ? <CheckCircleRounded color='success' /> : <RadioButtonUncheckedRounded color='disabled' />}
      <Box sx={{ flex: 1 }}>
        <Typography variant='body2' sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        <Typography variant='caption' color='text.secondary'>
          {hint}
        </Typography>
      </Box>
      {!done && (
        <Button size='small' onClick={() => void api.openPrivacy(pane)}>
          Open settings
        </Button>
      )}
    </Stack>
  )

  return (
    <Paper variant='outlined' sx={{ p: 3, borderRadius: 3, borderColor: screen && control ? 'success.main' : 'warning.main' }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant='h6' sx={{ fontSize: 16, fontWeight: 600 }}>
            {screen && control ? 'Remote control is set up' : 'Set up remote control (one time)'}
          </Typography>
          <Typography variant='body2' color='text.secondary'>
            {screen && control
              ? 'Restart Featured App once so macOS applies Screen Recording. After that, other devices can see and control this Mac.'
              : 'So your phone or another computer can see and control this Mac, macOS needs two switches for Featured App. Press Allow, then switch Featured App on in each list that opens.'}
          </Typography>
        </Box>
        {step(screen, 'See the screen', 'Privacy & Security → Screen & System Audio Recording', 'screen')}
        {step(control, 'Control the keyboard and mouse', 'Privacy & Security → Device Control and Data Access (Accessibility before macOS 27)', 'accessibility')}
        {asked && !(screen && control) && (
          <Alert severity='info' variant='outlined'>
            This card turns green by itself when each switch is on. If Featured App is not in a list, press Open settings, then + and choose Featured App from Applications.
          </Alert>
        )}
        <Stack direction='row' spacing={1}>
          {!(screen && control) && (
            <Button
              variant='contained'
              onClick={() => {
                setAsked(true)
                void api.setupPermissions()
              }}
            >
              Allow
            </Button>
          )}
          {screen && (asked || !control) && (
            <Button variant={screen && control ? 'contained' : 'outlined'} onClick={() => void api.relaunch()}>
              Restart Featured App
            </Button>
          )}
        </Stack>
      </Stack>
    </Paper>
  )
}

export default MacSetupCard
