import { useState } from 'react'
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Switch, TextField, Typography } from '@mui/material'
import toast from 'react-hot-toast'
import type { FeatureAccess, SidebarFeature } from '@shared/constants/sidebarFeatures'
import { ALL_NAV } from './Sidebar'

/**
 * Hidden admin dialog (sidebar logo clicked 5 times): enter the access password,
 * then switch each sidebar tab on or off. The password is checked in the main
 * process and sent again with every change; it is forgotten when the dialog closes.
 */
const FeatureAccessDialog = ({ open, access, onClose }: { open: boolean; access: FeatureAccess; onClose: () => void }) => {
  const api = window.printAgent
  const [password, setPassword] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const close = () => {
    setPassword('')
    setUnlocked(false)
    setError(null)
    onClose()
  }

  const unlock = async () => {
    setBusy('unlock')
    const r = await api.checkAccessPassword(password)
    setBusy(null)
    if (r.ok) {
      setUnlocked(true)
      setError(null)
    } else setError(r.error)
  }

  const toggle = async (id: SidebarFeature, enabled: boolean) => {
    setBusy(id)
    const r = await api.setFeatureAccess(password, id, enabled)
    setBusy(null)
    if (!r.ok) toast.error(r.error)
  }

  return (
    <Dialog open={open} onClose={close} maxWidth='xs' fullWidth>
      <DialogTitle>Manage tab access</DialogTitle>
      <DialogContent>
        {!unlocked ? (
          <Box
            component='form'
            onSubmit={e => {
              e.preventDefault()
              void unlock()
            }}
          >
            <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
              Enter the access password to choose which tabs show in the sidebar.
            </Typography>
            <TextField
              fullWidth
              autoFocus
              type='password'
              label='Password'
              autoComplete='off'
              value={password}
              onChange={e => {
                setPassword(e.target.value)
                setError(null)
              }}
              error={!!error}
              helperText={error ?? ' '}
            />
          </Box>
        ) : (
          <Stack spacing={0.5}>
            {ALL_NAV.map(item => (
              <Stack key={item.id} direction='row' alignItems='center' justifyContent='space-between' sx={{ py: 0.5 }}>
                <Stack direction='row' spacing={1.5} alignItems='center'>
                  {typeof item.icon === 'string' ? <i className={item.icon} style={{ fontSize: 20 }} /> : item.icon}
                  <Typography>{item.label}</Typography>
                </Stack>
                <Switch
                  checked={access[item.id]}
                  disabled={busy === item.id}
                  onChange={e => void toggle(item.id, e.target.checked)}
                  inputProps={{ 'aria-label': `Show ${item.label}` }}
                />
              </Stack>
            ))}
            {!Object.values(access).some(Boolean) && (
              <Alert severity='warning' sx={{ mt: 1 }}>
                Every tab is off. Click the logo 5 times again to turn one back on.
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {!unlocked ? (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant='contained' disabled={!password || busy === 'unlock'} onClick={() => void unlock()}>
              Unlock
            </Button>
          </>
        ) : (
          <Button variant='contained' onClick={close}>
            Done
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}

export default FeatureAccessDialog
