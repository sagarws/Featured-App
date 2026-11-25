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

  const [agentBusy, setAgentBusy] = useState(false)

  /** Windows: the SYSTEM agent that lets a full-control session see and unlock the lock screen (one administrator prompt). */
  const setLockScreenAccess = async (on: boolean) => {
    setAgentBusy(true)
    const r = await (on ? api.installSecureAgent() : api.removeSecureAgent())
    setAgentBusy(false)
    if (!r.ok) toast.error(r.error)
    else toast.success(on ? 'Lock screen access is on' : 'Lock screen access removed')
  }

  const toggleUnattended = async (on: boolean) => {
    if (on && !status.unattendedPasswordSet) {
      setPasswordOpen(true)
      return
    }
    await update({ unattendedEnabled: on })
    // Full access without anyone at the computer is only useful if the lock screen can be unlocked too.
    if (on && settings.unattendedPermission === 'control' && status.secureAgent === 'not-installed') await setLockScreenAccess(true)
  }

  const reach =
    server.relay === 'online'
      ? 'Reachable from any network.'
      : server.relay === 'connecting'
        ? 'Connecting to the remote server…'
        : server.relay === 'error'
          ? `Remote server unreachable${server.relayError ? ` (${server.relayError})` : ''} — same network only for now.`
          : 'Reachable from this network only.'

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
        <Typography sx={{ flex: 1, fontSize: 28, fontWeight: 700, letterSpacing: 4, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{identity.id}</Typography>
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
      {settings.enabled && (
        <Typography variant='caption' color={server.relay === 'error' ? 'warning.main' : 'text.secondary'} component='div' sx={{ mt: 0.5 }}>
          {reach}
        </Typography>
      )}

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
        {status.secureAgent !== 'unsupported' && (
          <Row
            title='Unlock the lock screen remotely'
            hint={
              status.identity.platform === 'darwin'
                ? status.secureAgent === 'running'
                  ? 'On. A full-control session can see the Mac lock screen and type your password. Built in, nothing to install.'
                  : 'Off. Turn on to let a full-control session unlock this Mac.'
                : status.secureAgent === 'running'
                  ? 'On. A full-control session can see the Windows lock screen and type the password or PIN.'
                  : 'Off. Turn on to let a full-control session unlock this PC (asks for administrator approval once).'
            }
          >
            <Switch
              checked={status.secureAgent === 'running'}
              disabled={agentBusy}
              onChange={e => void setLockScreenAccess(e.target.checked)}
              slotProps={{ input: { 'aria-label': 'Unlock the lock screen remotely' } }}
            />
          </Row>
        )}
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
