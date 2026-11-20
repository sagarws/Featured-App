import { Alert, Avatar, Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material'
import { Google } from '@mui/icons-material'
import type { GoogleStatus } from '@shared/types/google'

/** The big "connect your Drive first" card. Opens Google's consent screen in the browser. */
export const ConnectDriveCard = ({ status, onConnect, onCancel, purpose }: { status: GoogleStatus; onConnect: () => void; onCancel: () => void; purpose: string }) => (
  <Paper variant='outlined' sx={{ p: { xs: 4, md: 6 }, borderRadius: 3, textAlign: 'center' }}>
    <Box sx={{ width: 64, height: 64, mx: 'auto', mb: 2.5, borderRadius: '50%', display: 'grid', placeItems: 'center', bgcolor: 'var(--mui-palette-primary-lightOpacity)', color: 'primary.main' }}>
      <Google sx={{ fontSize: 32 }} />
    </Box>
    <Typography variant='h5' sx={{ fontWeight: 700, fontSize: 20 }}>
      Connect your Google Drive
    </Typography>
    <Typography color='text.secondary' sx={{ mt: 1, mb: 3, maxWidth: 520, mx: 'auto', fontSize: 14 }}>
      {purpose} Your browser opens Google’s sign-in, where you choose the account and allow access. Only your own Drive is used — files go into folders this app creates there, and it
      cannot see anything else in your Drive.
    </Typography>
    {!status.configured ? (
      <Alert severity='error' sx={{ textAlign: 'start', maxWidth: 560, mx: 'auto' }}>
        This build has no Google sign-in set up. Add MAIN_VITE_GOOGLE_CLIENT_ID and MAIN_VITE_GOOGLE_CLIENT_SECRET to .env and rebuild.
      </Alert>
    ) : status.connecting ? (
      <Stack alignItems='center' spacing={2}>
        <Stack direction='row' spacing={1.5} alignItems='center'>
          <CircularProgress size={20} />
          <Typography>Waiting for you in the browser… choose your account and click Allow.</Typography>
        </Stack>
        <Stack direction='row' spacing={1}>
          <Button onClick={onConnect}>Open the browser again</Button>
          <Button color='inherit' onClick={onCancel}>
            Cancel
          </Button>
        </Stack>
      </Stack>
    ) : (
      <Button variant='contained' size='large' startIcon={<Google />} onClick={onConnect} sx={{ px: 4 }}>
        Allow Google Drive access
      </Button>
    )}
    <Typography variant='caption' color='text.secondary' component='div' sx={{ mt: 3 }}>
      Google sends the sign-in back to {status.redirectUri}, so nothing else may be using that port while you sign in.
    </Typography>
  </Paper>
)

/** Who is connected, with Disconnect. */
export const DriveAccountBar = ({ status, onDisconnect, onSwitch }: { status: GoogleStatus; onDisconnect: () => void; onSwitch: () => void }) => {
  const a = status.account
  if (!a) return null
  return (
    <Stack direction='row' spacing={1.5} alignItems='center'>
      <Avatar src={a.picture || undefined} alt='' sx={{ width: 32, height: 32, fontSize: 14 }} slotProps={{ img: { referrerPolicy: 'no-referrer' } }}>
        {(a.name || a.email).slice(0, 1).toUpperCase()}
      </Avatar>
      <Box sx={{ minWidth: 0 }}>
        <Typography noWrap sx={{ fontSize: 13.5, fontWeight: 600 }}>
          {a.name}
        </Typography>
        <Typography noWrap sx={{ fontSize: 12, color: 'text.secondary' }}>
          {a.email}
        </Typography>
      </Box>
      <Button size='small' onClick={onSwitch} disabled={status.connecting}>
        Switch account
      </Button>
      <Button size='small' color='error' onClick={onDisconnect}>
        Disconnect
      </Button>
    </Stack>
  )
}
