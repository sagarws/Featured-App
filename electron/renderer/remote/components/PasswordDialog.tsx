import { useState } from 'react'
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material'
import toast from 'react-hot-toast'
import { passwordProblem } from '@shared/utils/remote'

/** Set / change the unattended-access password. Only its Argon2id verifier is stored. */
const PasswordDialog = ({ open, hasPassword, onClose }: { open: boolean; hasPassword: boolean; onClose: () => void }) => {
  const api = window.printAgent.remote
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const problem = password ? passwordProblem(password) : null
  const mismatch = confirm.length > 0 && confirm !== password

  const close = () => {
    setPassword('')
    setConfirm('')
    onClose()
  }

  const save = async () => {
    setBusy(true)
    const r = await api.setPassword(password)
    if (r.ok) {
      await api.updateSettings({ unattendedEnabled: true })
      toast.success('Unattended password saved')
      close()
    } else toast.error(r.error)
    setBusy(false)
  }

  const remove = async () => {
    const r = await api.clearPassword()
    if (r.ok) toast.success('Password removed; unattended access is off')
    close()
  }

  return (
    <Dialog open={open} onClose={close} maxWidth='xs' fullWidth>
      <DialogTitle>{hasPassword ? 'Change the unattended password' : 'Set an unattended password'}</DialogTitle>
      <DialogContent>
        <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
          Anyone with this computer’s ID and this password can connect without someone accepting. Use a long, unique password. It is never stored or sent — only a
          one-way Argon2id hash is kept, encrypted.
        </Typography>
        <TextField fullWidth type='password' label='New password' autoComplete='new-password' value={password} onChange={e => setPassword(e.target.value)} error={!!problem} helperText={problem ?? ' '} sx={{ mb: 1 }} />
        <TextField fullWidth type='password' label='Repeat it' autoComplete='new-password' value={confirm} onChange={e => setConfirm(e.target.value)} error={mismatch} helperText={mismatch ? 'The passwords differ.' : ' '} />
        {hasPassword && (
          <Alert severity='info' sx={{ mt: 1 }}>
            Changing the password does not end sessions already running.
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        {hasPassword && (
          <Button color='error' onClick={() => void remove()} sx={{ mr: 'auto' }}>
            Remove password
          </Button>
        )}
        <Button onClick={close}>Cancel</Button>
        <Button variant='contained' disabled={busy || !password || !!problem || confirm !== password} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default PasswordDialog
