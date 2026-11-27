import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Chip, CircularProgress, IconButton, Stack, Tooltip } from '@mui/material'
import { ContentCopyOutlined, ManageAccountsOutlined, PowerSettingsNewOutlined, RefreshOutlined, VisibilityOffOutlined, VisibilityOutlined } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { VpsMetrics, VpsNetwork, VpsStatus } from '@shared/types/vps'
import { formatDuration } from '@shared/utils/vps'
import SectionCard from '../../components/SectionCard'
import { InfoRow } from './ui'
import ChangeLoginDialog from './ChangeLoginDialog'
import type { Login } from './LoginFields'

const REVEAL_MS = 30_000

/** Connected state: where to connect, the account, and the server's actions. */
const ConnectionCard = ({
  status,
  network,
  metrics,
  endpoint,
  onDisconnect
}: {
  status: VpsStatus
  network: VpsNetwork | null
  metrics: VpsMetrics | null
  /** Where visitors connect in the current access mode (the relay's host / port in relay mode). */
  endpoint: { host: string; port: number } | null
  onDisconnect: () => void
}) => {
  const api = window.printAgent.vps
  const server = status.server
  const [password, setPassword] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connected = status.state === 'connected'

  const hide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = null
    setPassword(null)
  }
  // Never keep the password in the window longer than needed.
  useEffect(() => hide, [])

  if (!server) return null

  const reveal = async () => {
    if (password) return hide()
    const r = await api.revealPassword()
    if (!r.ok) return void toast.error(r.error)
    setPassword(r.value)
    hideTimer.current = setTimeout(hide, REVEAL_MS)
  }

  const copyPassword = async () => {
    const r = await api.revealPassword()
    if (!r.ok) return void toast.error(r.error)
    await navigator.clipboard.writeText(r.value)
    toast.success('Password copied')
  }

  const regenerate = async () => {
    hide()
    const r = await api.regeneratePassword()
    if (r.ok) toast.success('New password set')
    else toast.error(r.error)
  }

  const changeLogin = async (login: Login) => {
    setChanging(false)
    hide()
    const r =
      login.username === server.username
        ? await api.regeneratePassword(login.password)
        : await api.changeLogin({ username: login.username, password: login.password })
    if (r.ok) toast.success(login.username === server.username ? 'Password changed' : `Login changed to ${login.username}`)
    else toast.error(r.error, { duration: 8000 })
  }

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  }
  const copyButton = (text: string | null, what: string) =>
    text ? (
      <Tooltip title={`Copy ${what.toLowerCase()}`}>
        <IconButton size='small' onClick={() => void copy(text, what)}>
          <ContentCopyOutlined sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
    ) : null

  const lockedUntil = status.lockout?.lockedUntil
  const host = endpoint?.host ?? null

  return (
    <SectionCard
      icon='tabler-activity'
      tone={connected ? 'success' : 'warning'}
      title='Personal VPS'
      subtitle={connected ? 'Running and accepting SSH connections.' : 'Set up, but the server is not answering.'}
      action={<Chip size='small' variant='tonal' color={connected ? 'success' : 'warning'} label={connected ? 'Connected' : 'Not answering'} />}
    >
      {!connected && (
        <Alert severity='warning' sx={{ mb: 2 }}>
          The SSH service is not responding on port {server.port}. It may have been stopped by the system. Disconnect and convert again to repair it.
        </Alert>
      )}
      {lockedUntil && (
        <Alert severity='error' sx={{ mb: 2 }}>
          Too many wrong passwords: the account is locked until {new Date(lockedUntil).toLocaleTimeString()}. Regenerating the password unlocks it.
        </Alert>
      )}
      <InfoRow label='VPS status' value={connected ? 'Connected' : 'Not answering'} />
      <InfoRow label='Host IP' mono value={host ?? '—'} action={copyButton(host, 'Host')} />
      <InfoRow label='Local IP' mono value={network?.lanIp ?? '—'} />
      <InfoRow label='Public IP' mono value={network?.publicIp ?? 'Not checked'} />
      <InfoRow label='VPN IP' mono value={network?.vpnIp ?? 'No VPN detected'} />
      <InfoRow label='Username' mono value={server.username} action={copyButton(server.username, 'Username')} />
      <InfoRow
        label='Password'
        mono
        value={password ?? (status.passwordAvailable ? '•'.repeat(16) : 'Not stored — regenerate to see it')}
        action={
          <Stack direction='row'>
            <Tooltip title={password ? 'Hide' : 'Show for 30 seconds'}>
              <span>
                <IconButton size='small' onClick={() => void reveal()} disabled={!status.passwordAvailable}>
                  {password ? <VisibilityOffOutlined sx={{ fontSize: 16 }} /> : <VisibilityOutlined sx={{ fontSize: 16 }} />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title='Copy password'>
              <span>
                <IconButton size='small' onClick={() => void copyPassword()} disabled={!status.passwordAvailable}>
                  <ContentCopyOutlined sx={{ fontSize: 16 }} />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        }
      />
      <InfoRow label='SSH port' mono value={endpoint && endpoint.port !== server.port ? `${endpoint.port} (relay → ${server.port} on this computer)` : server.port} />
      <InfoRow label='Authentication' value='Password' />
      <InfoRow label='Host key' mono value={server.hostKeyFingerprint ?? '—'} />
      <InfoRow label='Server uptime' value={metrics && metrics.serverUptime !== null ? formatDuration(metrics.serverUptime) : '—'} />
      <InfoRow
        label='Firewall'
        value={
          server.firewall === 'rule-added'
            ? 'Allowed for private and VPN networks'
            : server.firewall === 'declined'
              ? 'Not changed (you declined) — other computers may be blocked'
              : server.firewall === 'no-firewall'
                ? 'No active firewall'
                : '—'
        }
      />

      <Stack direction='row' spacing={1.5} sx={{ mt: 3 }} flexWrap='wrap' useFlexGap>
        <Button
          variant='outlined'
          startIcon={status.busy === 'password' ? <CircularProgress size={16} /> : <RefreshOutlined />}
          onClick={() => void regenerate()}
          disabled={!!status.busy}
        >
          Regenerate password
        </Button>
        <Button variant='outlined' startIcon={<ManageAccountsOutlined />} onClick={() => setChanging(true)} disabled={!!status.busy}>
          Change username / password
        </Button>
        <Button
          variant='contained'
          color='error'
          startIcon={status.busy === 'disconnect' ? <CircularProgress size={16} color='inherit' /> : <PowerSettingsNewOutlined />}
          onClick={onDisconnect}
          disabled={!!status.busy}
        >
          Disconnect VPS
        </Button>
      </Stack>
      {changing && <ChangeLoginDialog open current={server.username} onCancel={() => setChanging(false)} onSave={login => void changeLogin(login)} />}
    </SectionCard>
  )
}

export default ConnectionCard
