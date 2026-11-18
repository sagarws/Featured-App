import { useEffect, useState } from 'react'
import { Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Stack, Typography } from '@mui/material'
import { GraphicEqOutlined } from '@mui/icons-material'
import toast from 'react-hot-toast'
import { useRecorderSettings, useSystemAudioPermission } from '../hooks'

/**
 * On launch (macOS): asks for the "System Audio Recording" permission, which
 * the recorder needs to hear other people in calls, videos and apps. Until it
 * is granted the System audio options stay disabled in the recorder.
 */
const SystemAudioPermissionDialog = () => {
  const { settings, update } = useRecorderSettings()
  const { permission, request } = useSystemAudioPermission()
  const [open, setOpen] = useState(false)
  const [decided, setDecided] = useState(false)
  const [asking, setAsking] = useState(false)
  const [dontAsk, setDontAsk] = useState(false)
  // macOS answered without granting (or showed no prompt): guide the user to System Settings.
  const [notGranted, setNotGranted] = useState(false)

  // Decide once per launch, when both the setting and the permission are known.
  useEffect(() => {
    if (decided || !settings || permission === null) return
    setDecided(true)
    if (settings.askSystemAudioOnLaunch && (permission === 'not-determined' || permission === 'denied')) setOpen(true)
  }, [decided, settings, permission])

  // Turned on in System Settings and came back: done.
  useEffect(() => {
    if (open && permission === 'granted') {
      setOpen(false)
      toast.success('System audio is allowed. Recordings can now include sound from this computer.')
    }
  }, [open, permission])

  const close = () => {
    if (dontAsk) void update({ askSystemAudioOnLaunch: false })
    setOpen(false)
  }

  const allow = async () => {
    setAsking(true)
    try {
      const next = await request()
      if (next !== 'granted') setNotGranted(true)
    } finally {
      setAsking(false)
    }
  }

  const denied = permission === 'denied' || notGranted
  return (
    <Dialog open={open} onClose={asking ? undefined : close} maxWidth='xs' fullWidth>
      <DialogTitle>
        <Stack direction='row' spacing={1.5} alignItems='center'>
          <GraphicEqOutlined color='primary' />
          <span>Allow system audio</span>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography variant='body2'>
            To record what you hear — other people in Google Meet or Zoom, videos, apps — the recorder needs macOS permission to record system
            audio. Without it, System audio stays off and only your microphone can be recorded.
          </Typography>
          {denied ? (
            <Typography variant='body2' color='text.secondary'>
              macOS has not given this app system-audio access. Click <b>Open System Settings</b>. Under <b>System Audio Recording Only</b> (the
              lower list), click <b>+</b> and add <b>Featured App</b>, or switch it on if it is already there. Then come back here.
              Being switched on in the upper <b>Screen &amp; System Audio Recording</b> list alone is not enough: that covers the screen, and
              system audio is checked separately.
            </Typography>
          ) : (
            <Typography variant='body2' color='text.secondary'>
              Click <b>Allow system audio</b>, then choose <b>Allow</b> in the macOS prompt.
            </Typography>
          )}
          <FormControlLabel
            control={<Checkbox size='small' checked={dontAsk} onChange={e => setDontAsk(e.target.checked)} />}
            label={<Typography variant='body2'>Don’t ask when the app starts</Typography>}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color='secondary' disabled={asking} onClick={close}>
          Not now
        </Button>
        {denied ? (
          <Button variant='contained' onClick={() => void window.printAgent.recorder.openPrivacy('audio')}>
            Open System Settings
          </Button>
        ) : (
          <Button variant='contained' disabled={asking} onClick={() => void allow()}>
            {asking ? 'Waiting for macOS…' : 'Allow system audio'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}

export default SystemAudioPermissionDialog
