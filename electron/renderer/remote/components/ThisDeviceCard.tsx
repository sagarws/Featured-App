import { useState } from 'react'
import { Alert, Box, Button, Chip, IconButton, Paper, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material'
import { CheckOutlined, ContentCopyOutlined, EditOutlined, KeyOutlined } from '@mui/icons-material'
import toast from 'react-hot-toast'
import { SESSION_MINUTES } from '@shared/constants/remote'
import type { RemoteStatus } from '@shared/types/remote'
import { Choice } from '../../screenshot/components/ui'
import IconTile from '../../components/IconTile'
import PasswordDialog from './PasswordDialog'

/** Left column: this computer's ID, name, status and who may connect to it. */
const ThisDeviceCard = ({ status }: { status: RemoteStatus }) => {
  const api = window.printAgent.remote
  const { identity, settings, server } = status
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(identity.name)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const online = server.listening

  const update = async (patch: Parameters<typeof api.updateSettings>[0]) => {
    const r = await api.updateSettings(patch)
    if (!r.ok) toast.error(r.error)
  }

  const copy = () => {
    void navigator.clipboard.writeText(identity.id).then(() => toast.success('Device ID copied'))
  }

  const saveName = async () => {
    await update({ deviceName: name.trim() })
    setEditing(false)
  }

  const toggleUnattended = async (on: boolean) => {
    if (on && !status.unattendedPasswordSet) {
      setPasswordOpen(true)
      return
    }
    await update({ unattendedEnabled: on })
  }

  return (
    <Paper variant='outlined' sx={{ p: 4, borderRadius: 3, height: '100%' }}>
      <Stack direction='row' spacing={2.5} alignItems='flex-start' sx={{ mb: 3 }}>
        <IconTile icon='tabler-device-desktop' />
        <Box sx={{ flex: 1, minWidth: 0, pt: 0.5 }}>
          <Typography variant='h6' sx={{ fontSize: 16, fontWeight: 600 }}>
            This device
          </Typography>
          <Typography variant='body2' color='text.secondary' sx={{ fontSize: 12.5 }}>
            Give this ID to whoever should connect to this computer.
          </Typography>
        </Box>
        <Chip size='small' color={online ? 'success' : 'default'} variant='tonal' label={online ? 'Online' : settings.enabled ? 'Offline' : 'Remote access off'} />
      </Stack>

      <Stack direction='row' alignItems='center' spacing={1} sx={{ p: 2, borderRadius: 2, bgcolor: 'action.hover', mb: 2 }}>
        <Typography sx={{ flex: 1, fontSize: 26, fontWeight: 700, letterSpacing: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{identity.id}</Typography>
        <Tooltip title='Copy device ID'>
          <IconButton onClick={copy}>
            <ContentCopyOutlined />
          </IconButton>
        </Tooltip>
      </Stack>

      <Stack direction='row' alignItems='center' spacing={1} sx={{ mb: 0.5 }}>
        {editing ? (
          <>
            <TextField size='small' value={name} autoFocus onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && void saveName()} placeholder={identity.hostname} inputProps={{ maxLength: 64 }} sx={{ flex: 1 }} />
            <IconButton onClick={() => void saveName()}>
              <CheckOutlined />
            </IconButton>
          </>
        ) : (
          <>
            <Typography sx={{ flex: 1, fontWeight: 600 }}>{identity.name}</Typography>
            <Tooltip title='Rename this device'>
              <IconButton
                size='small'
                onClick={() => {
                  setName(settings.deviceName || identity.name)
                  setEditing(true)
                }}
              >
                <EditOutlined fontSize='small' />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Stack>
      <Typography variant='body2' color='text.secondary'>
        {identity.os} · {identity.hostname}
        {identity.addresses.length ? ` · ${identity.addresses.join(', ')}` : ''}
      </Typography>
      <Typography variant='caption' color='text.secondary' component='div' sx={{ mt: 0.5, fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>
        Key fingerprint {identity.fingerprint}
      </Typography>

      {server.error && (
        <Alert severity='error' sx={{ mt: 2 }}>
          {server.error}
        </Alert>
      )}

      <Stack spacing={0} sx={{ mt: 3 }} divider={<Box sx={{ borderBlockEnd: '1px solid', borderColor: 'divider' }} />}>
        <Row title='Allow remote access' hint='Others can ask to connect. Every request needs you to press Allow, unless unattended access is on.'>
          <Switch checked={settings.enabled} onChange={e => void update({ enabled: e.target.checked })} />
        </Row>
        <Row title='Unattended access' hint={status.unattendedPasswordSet ? 'Connect with the permanent password, without anyone accepting.' : 'Off. Set a password to turn it on.'}>
          <Switch checked={settings.unattendedEnabled} disabled={!settings.enabled} onChange={e => void toggleUnattended(e.target.checked)} />
        </Row>
        <Row title='Unattended password'>
          <Button size='small' variant='outlined' startIcon={<KeyOutlined />} onClick={() => setPasswordOpen(true)}>
            {status.unattendedPasswordSet ? 'Change password' : 'Set password'}
          </Button>
        </Row>
        <Row title='Default session duration' hint='Pre-selected when you accept a request; the length of unattended sessions.'>
          <Choice value={settings.defaultMinutes} width={170} options={SESSION_MINUTES.map(m => ({ value: m.value, label: m.label }))} onChange={v => void update({ defaultMinutes: v })} />
        </Row>
      </Stack>

      <PasswordDialog open={passwordOpen} hasPassword={status.unattendedPasswordSet} onClose={() => setPasswordOpen(false)} />
    </Paper>
  )
}

const Row = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <Stack direction='row' alignItems='center' spacing={2} sx={{ py: 1.5 }}>
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography variant='body2' sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {hint && (
        <Typography variant='caption' color='text.secondary' component='div'>
          {hint}
        </Typography>
      )}
    </Box>
    {children}
  </Stack>
)

export default ThisDeviceCard
