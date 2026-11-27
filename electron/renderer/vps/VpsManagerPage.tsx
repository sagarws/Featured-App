import { useState } from 'react'
import { Alert, Box, Button, CircularProgress, Grid, Stack, Typography } from '@mui/material'
import toast from 'react-hot-toast'
import type { VpsAccessMode } from '@shared/types/vps'
import { endpointForMode } from '@shared/utils/vps'
import { useSystemInfo, useVpsMetrics, useVpsNetwork, useVpsStatus } from './hooks'
import ConnectionCard from './components/ConnectionCard'
import DisconnectDialog from './components/DisconnectDialog'
import MonitoringCard from './components/MonitoringCard'
import NetworkCard from './components/NetworkCard'
import SetupCard, { StepList } from './components/SetupCard'
import SshConfigCard from './components/SshConfigCard'
import SystemInfoCard from './components/SystemInfoCard'

/** macOS only lets apps with Full Disk Access delete accounts: say what happened instead. */
const keptNotice = (user: string) =>
  toast(
    `macOS did not allow the account ${user} to be deleted (that needs Full Disk Access). It was disabled, its password scrambled, and it will be reused the next time you convert.`,
    { duration: 12000, icon: 'ℹ️' }
  )

/** Sidebar → VPS Manager. */
const VpsManagerPage = () => {
  const api = window.printAgent.vps
  const status = useVpsStatus()
  const info = useSystemInfo()
  const { network, checkPublicIp, checking } = useVpsNetwork()
  const live = status?.state === 'connected' || status?.state === 'unreachable'
  const metrics = useVpsMetrics(live)
  const [confirming, setConfirming] = useState(false)

  if (!status) {
    return (
      <Stack alignItems='center' sx={{ py: 10 }}>
        <CircularProgress size={28} />
      </Stack>
    )
  }

  const disconnect = async (removeUser: boolean) => {
    setConfirming(false)
    const r = await api.disconnect({ removeUser })
    if (!r.ok) return void toast.error(r.error, { duration: 8000 })
    toast.success('VPS disconnected')
    if (removeUser && r.value.keptUser) keptNotice(r.value.keptUser)
  }

  const recover = async () => {
    const r = await api.recover()
    if (!r.ok) return void toast.error(r.error, { duration: 8000 })
    toast.success('Cleaned up')
    if (r.value.keptUser) keptNotice(r.value.keptUser)
  }

  const setMode = async (mode: VpsAccessMode) => {
    const r = await api.setAccessMode(mode)
    if (!r.ok) toast.error(r.error)
  }

  const server = status.server
  const endpoint = server ? endpointForMode(network, status.tunnel, server.accessMode, server.port) : null
  const tearingDown = status.busy === 'disconnect' || status.busy === 'recover'

  return (
    <Stack spacing={4} sx={{ maxWidth: 1200, mx: 'auto' }}>
      <Box>
        <Typography variant='h4' sx={{ fontSize: 24, fontWeight: 700 }}>
          Personal VPS
        </Typography>
        <Typography color='text.secondary' sx={{ fontSize: 14, mt: 0.5 }}>
          Convert your computer into your own remotely accessible server.
        </Typography>
      </Box>

      {!status.support.ok && <Alert severity='warning'>{status.support.reason}</Alert>}

      {status.state === 'needs-recovery' && (
        <Alert
          severity='error'
          action={
            <Button color='inherit' size='small' onClick={() => void recover()} disabled={!!status.busy}>
              Clean up
            </Button>
          }
        >
          A previous setup did not finish (the app or the computer stopped during it). Clean up removes what it set up and restores your system.
        </Alert>
      )}

      {tearingDown && status.steps && (
        <Alert severity='info' icon={<CircularProgress size={18} />}>
          <Typography sx={{ fontSize: 13.5, fontWeight: 600, mb: 1.5 }}>Disconnecting…</Typography>
          <StepList steps={status.steps} />
        </Alert>
      )}

      {live && server ? (
        <Grid container spacing={4}>
          <Grid size={{ xs: 12, lg: 6 }}>
            <ConnectionCard status={status} network={network} metrics={metrics} endpoint={endpoint} onDisconnect={() => setConfirming(true)} />
          </Grid>
          <Grid size={{ xs: 12, lg: 6 }}>
            <Stack spacing={4}>
              <SshConfigCard
                endpoint={endpoint}
                username={server.username}
                mode={server.accessMode}
                tunnel={status.tunnel}
                passwordWeak={status.passwordWeak}
                onModeChange={m => void setMode(m)}
              />
              <NetworkCard network={network} checking={checking} onCheckPublicIp={() => void checkPublicIp()} />
            </Stack>
          </Grid>
          <Grid size={12}>
            <MonitoringCard metrics={metrics} status={status} />
          </Grid>
        </Grid>
      ) : (
        <Grid container spacing={4}>
          <Grid size={{ xs: 12, md: 6 }}>
            <SystemInfoCard info={info} network={network} />
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <SetupCard status={status} network={network} />
          </Grid>
        </Grid>
      )}

      {server && <DisconnectDialog open={confirming} username={server.username} platform={status.platform} onCancel={() => setConfirming(false)} onConfirm={removeUser => void disconnect(removeUser)} />}
    </Stack>
  )
}

export default VpsManagerPage
