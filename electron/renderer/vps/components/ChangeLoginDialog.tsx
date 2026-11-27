import { useState } from 'react'
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack } from '@mui/material'
import LoginFields, { loginValid, newWebPassword, type Login } from './LoginFields'

/** Change the password, the username, or both, while the VPS is running. */
const ChangeLoginDialog = ({
  open,
  current,
  onCancel,
  onSave
}: {
  open: boolean
  current: string
  onCancel: () => void
  onSave: (login: Login) => void
}) => {
  const [login, setLogin] = useState<Login>(() => ({ username: current, password: newWebPassword() }))
  const renaming = login.username !== current

  return (
    <Dialog open={open} onClose={onCancel} maxWidth='sm' fullWidth>
      <DialogTitle>Change username / password</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <LoginFields value={login} onChange={setLogin} />
          {renaming ? (
            <Alert severity='warning'>
              A new username sets the server up again for <b>{login.username}</b>: you are asked for the administrator password twice, open SSH sessions
              end, and the account <b>{current}</b> is removed (on macOS it is disabled instead if deleting is not allowed).
            </Alert>
          ) : (
            <Alert severity='info'>Only the password changes. Open SSH sessions stay connected.</Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant='contained' disabled={!loginValid(login)} onClick={() => onSave(login)}>
          {renaming ? 'Change username and password' : 'Change password'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default ChangeLoginDialog
