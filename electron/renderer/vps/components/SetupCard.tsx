import { useState } from 'react'
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { CheckCircleOutlined, ErrorOutline, RadioButtonUncheckedOutlined, RemoveCircleOutline } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { VpsAccessMode, VpsNetwork, VpsStatus, VpsStep } from '@shared/types/vps'
import { VPS_DEFAULT_USERNAME } from '@shared/utils/vps'
import SectionCard from '../../components/SectionCard'
import LoginFields, { loginValid, newWebPassword, type Login } from './LoginFields'

const StepIcon = ({ state }: { state: VpsStep['state'] }) => {
  if (state === 'running') return <CircularProgress size={18} />
  if (state === 'done') return <CheckCircleOutlined color='success' sx={{ fontSize: 20 }} />
  if (state === 'failed') return <ErrorOutline color='error' sx={{ fontSize: 20 }} />
  if (state === 'skipped') return <RemoveCircleOutline sx={{ fontSize: 20, color: 'text.disabled' }} />
  return <RadioButtonUncheckedOutlined sx={{ fontSize: 20, color: 'text.disabled' }} />
}

export const StepList = ({ steps }: { steps: VpsStep[] }) => (
  <Stack spacing={1.25}>
    {steps.map(step => (
      <Stack key={step.id} direction='row' spacing={1.5} alignItems='flex-start'>
        <Box sx={{ width: 20, display: 'grid', placeItems: 'center', pt: 0.25 }}>
          <StepIcon state={step.state} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 13.5, fontWeight: step.state === 'running' ? 600 : 500, color: step.state === 'pending' ? 'text.secondary' : 'text.primary' }}>
            {step.label}
          </Typography>
          {step.detail && (
            <Typography sx={{ fontSize: 12, color: step.state === 'failed' ? 'error.main' : 'text.secondary' }}>{step.detail}</Typography>
          )}
        </Box>
      </Stack>
    ))}
  </Stack>
)

/** "Convert into VPS": the options, then the live progress of the setup. */
const SetupCard = ({ status, network }: { status: VpsStatus; network: VpsNetwork | null }) => {
  const api = window.printAgent.vps
  const [mode, setMode] = useState<VpsAccessMode>('local')
  const [firewall, setFirewall] = useState(true)
  const [login, setLogin] = useState<Login>(() => ({ username: status.keptUser ?? VPS_DEFAULT_USERNAME, password: newWebPassword() }))
  const busy = status.busy === 'convert'
  const showSteps = status.steps && (busy || status.lastError)

  const convert = async () => {
    const r = await api.convert({ accessMode: mode, firewallConsent: firewall, username: login.username, password: login.password })
    if (r.ok) toast.success('Your VPS is running')
    else toast.error(r.error, { duration: 8000 })
  }

  return (
    <SectionCard icon='tabler-power' title='Convert into VPS' subtitle='One administrator prompt sets everything up. Disconnect undoes it.'>
      {showSteps && status.steps ? (
        <Stack spacing={3}>
          <StepList steps={status.steps} />
          {!busy && status.lastError && (
            <>
              <Alert severity='error'>{status.lastError}</Alert>
              <Button variant='outlined' onClick={() => void api.clearSteps()}>
                Back
              </Button>
            </>
          )}
        </Stack>
      ) : (
        <Stack spacing={3}>
          <Box>
            <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>Who should be able to connect?</Typography>
            <ToggleButtonGroup exclusive size='small' value={mode} onChange={(_e, v: VpsAccessMode | null) => v && setMode(v)} fullWidth>
              <ToggleButton value='local'>Local network</ToggleButton>
              <ToggleButton value='vpn'>Remote via VPN</ToggleButton>
              <ToggleButton value='relay'>Internet (relay)</ToggleButton>
            </ToggleButtonGroup>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1 }}>
              {mode === 'local'
                ? 'Devices on the same Wi-Fi or office network.'
                : mode === 'vpn'
                  ? 'Anywhere, through a VPN such as Tailscale or WireGuard running on both computers.'
                  : 'Anywhere, with plain ssh and nothing to install: through the relay server, like Remote Desktop. Anyone on the internet can try the password, so use a strong one.'}
            </Typography>
            {mode === 'vpn' && network && !network.vpnIp && (
              <Alert severity='info' sx={{ mt: 1.5 }}>
                No VPN connection found yet. Install and sign in to Tailscale (or connect WireGuard) on this computer, then its VPN address will be used.
              </Alert>
            )}
          </Box>

          <Box>
            <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1.5 }}>Login</Typography>
            <LoginFields value={login} onChange={setLogin} disabled={!!status.busy} />
            {status.keptUser && login.username !== status.keptUser && (
              <Alert severity='info' sx={{ mt: 1.5 }}>
                The earlier account <b>{status.keptUser}</b> stays disabled. Use that name to reuse it instead.
              </Alert>
            )}
          </Box>

          <FormControlLabel
            control={<Checkbox checked={firewall} onChange={e => setFirewall(e.target.checked)} />}
            label={
              <Typography sx={{ fontSize: 13 }}>
                Allow the SSH port through the firewall (private and VPN networks only). Without this, other computers may be blocked.
              </Typography>
            }
          />

          <Alert severity='info' icon={false} sx={{ fontSize: 12.5 }}>
            The server logs in with a password only, for one new standard account, from private and VPN addresses only. It is never opened to the
            public internet and your existing SSH settings are not changed.
          </Alert>

          <Button variant='contained' size='large' onClick={() => void convert()} disabled={!status.support.ok || !!status.busy || !loginValid(login)}>
            Convert into VPS
          </Button>
        </Stack>
      )}
    </SectionCard>
  )
}

export default SetupCard
