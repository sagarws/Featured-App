import { useState } from 'react'
import { Button, Checkbox, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, FormControlLabel, Stack, Typography } from '@mui/material'

/** Confirm Disconnect, and whether the VPS account (and its files) goes too. */
const DisconnectDialog = ({ open, username, platform, onCancel, onConfirm }: { open: boolean; username: string; platform: string; onCancel: () => void; onConfirm: (removeUser: boolean) => void }) => {
  const [removeUser, setRemoveUser] = useState(true)
  return (
    <Dialog open={open} onClose={onCancel} maxWidth='sm' fullWidth>
      <DialogTitle>Disconnect VPS?</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <DialogContentText>
            Active SSH sessions end and no new connections are accepted. The app removes the server, its firewall rule and its login guard, and
            restores what it changed. SSH services, accounts and firewall rules that were here before are not touched.
          </DialogContentText>
          <FormControlLabel
            control={<Checkbox checked={removeUser} onChange={e => setRemoveUser(e.target.checked)} />}
            label={
              <Typography sx={{ fontSize: 14 }}>
                Also delete the account <b>{username}</b> and its home folder
              </Typography>
            }
          />
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
            {removeUser
              ? 'Files stored in that account are deleted.'
              : 'The account is disabled and kept, so its files stay. Converting again reuses it with a new password.'}{' '}
            {removeUser && platform === 'darwin' && 'If macOS refuses to delete it (it needs Full Disk Access for that), it is disabled instead. '}
            VPN connections (Tailscale, WireGuard) are not managed by this app and stay as they are.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant='contained' color='error' onClick={() => onConfirm(removeUser)}>
          Disconnect
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default DisconnectDialog
