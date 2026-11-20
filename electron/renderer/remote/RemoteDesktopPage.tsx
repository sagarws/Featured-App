import { useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, Stack, Tab, Tabs, Typography } from '@mui/material'
import ConnectCard from './components/ConnectCard'
import DevicesCard from './components/DevicesCard'
import DiagnosticsTab from './components/DiagnosticsTab'
import HistoryTab from './components/HistoryTab'
import SecurityTab from './components/SecurityTab'
import SessionsTab from './components/SessionsTab'
import SettingsTab from './components/SettingsTab'
import ThisDeviceCard from './components/ThisDeviceCard'
import { useRemoteStatus } from './hooks'

type TabId = 'connect' | 'sessions' | 'settings' | 'security' | 'history' | 'diagnostics'

/** Sidebar → Remote Desktop. */
const RemoteDesktopPage = () => {
  const status = useRemoteStatus()
  const [tab, setTab] = useState<TabId>('connect')
  const [target, setTarget] = useState('')

  if (!status) {
    return (
      <Stack alignItems='center' sx={{ py: 10 }}>
        <CircularProgress size={28} />
      </Stack>
    )
  }

  const live = status.sessions.filter(s => s.state !== 'ended')
  const incoming = live.filter(s => s.direction === 'incoming')

  return (
    <Stack spacing={4} sx={{ maxWidth: 1200, mx: 'auto' }}>
      <Box>
        <Typography variant='h4' sx={{ fontSize: 24, fontWeight: 700 }}>
          Remote Desktop
        </Typography>
        <Typography color='text.secondary' sx={{ fontSize: 14, mt: 0.5 }}>
          See and control another office computer — or let someone see and control this one. Direct and end-to-end encrypted on the office network.
        </Typography>
      </Box>

      {incoming.length > 0 && (
        <Alert
          severity='warning'
          action={
            <Button color='inherit' size='small' onClick={() => setTab('sessions')}>
              Manage
            </Button>
          }
        >
          {incoming.map(s => `${s.peerName} is ${s.permission === 'control' ? 'controlling' : 'viewing'} this computer`).join(' · ')}
        </Alert>
      )}
      {status.requests.map(r => (
        <Alert key={r.requestId} severity='info'>
          {r.peerName} ({r.peerId}) is asking for access — answer in the request window.
        </Alert>
      ))}

      <Tabs value={tab} onChange={(_e, v: TabId) => setTab(v)} sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tab value='connect' label='Connect' />
        <Tab
          value='sessions'
          label={
            <Stack direction='row' spacing={1} alignItems='center'>
              <span>Active sessions</span>
              {live.length > 0 && <Chip size='small' color='primary' label={live.length} sx={{ height: 18 }} />}
            </Stack>
          }
        />
        <Tab value='settings' label='Settings' />
        <Tab value='security' label='Security' />
        <Tab value='history' label='History' />
        <Tab value='diagnostics' label='Diagnostics' />
      </Tabs>

      {tab === 'connect' && (
        <Stack spacing={3}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 3 }}>
            <ThisDeviceCard status={status} />
            <ConnectCard status={status} target={target} onTarget={setTarget} />
          </Box>
          <DevicesCard status={status} onPick={setTarget} />
        </Stack>
      )}
      {tab === 'sessions' && <SessionsTab status={status} />}
      {tab === 'settings' && <SettingsTab status={status} />}
      {tab === 'security' && <SecurityTab status={status} />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'diagnostics' && <DiagnosticsTab status={status} />}
    </Stack>
  )
}

export default RemoteDesktopPage
