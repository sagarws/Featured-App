import { Alert, Button, Chip, CircularProgress, Stack } from '@mui/material'
import type { VpsNetwork } from '@shared/types/vps'
import SectionCard from '../../components/SectionCard'
import { InfoRow } from './ui'

/** Addresses and what they mean for reaching this computer. */
const NetworkCard = ({ network, checking, onCheckPublicIp }: { network: VpsNetwork | null; checking: boolean; onCheckPublicIp: () => void }) => {
  if (!network) return null
  return (
    <SectionCard
      icon='tabler-wifi'
      title='Network accessibility'
      subtitle='How other computers can reach this one.'
      action={<Chip size='small' variant='tonal' color={network.online ? 'success' : 'error'} label={network.online ? 'Online' : 'Offline'} />}
    >
      <InfoRow label='Local IPv4' mono value={network.lanIp ? `${network.lanIp} (${network.lanInterface})` : '—'} />
      <InfoRow label='VPN' mono value={network.vpnIp ? `${network.vpnIp} (${network.vpnInterface})` : 'Not detected'} />
      <InfoRow label='IPv6' mono value={network.ipv6 ?? '—'} />
      <InfoRow
        label='Public IPv4'
        mono
        value={network.publicIp ?? network.publicIpError ?? 'Not checked'}
        action={
          <Button size='small' onClick={onCheckPublicIp} disabled={checking} startIcon={checking ? <CircularProgress size={14} /> : undefined}>
            Check
          </Button>
        }
      />
      <Stack spacing={1.5} sx={{ mt: 2 }}>
        <Alert severity='success' icon={false} sx={{ fontSize: 12.5 }}>
          <b>Local network:</b> {network.lanIp ? 'devices on the same network can connect.' : 'not connected to a local network.'}
        </Alert>
        <Alert severity={network.vpnIp ? 'success' : 'info'} icon={false} sx={{ fontSize: 12.5 }}>
          <b>Remote:</b>{' '}
          {network.vpnIp
            ? 'reachable from other devices on your VPN — the recommended way to connect from anywhere.'
            : 'set up Tailscale or WireGuard on both computers to connect from anywhere.'}
        </Alert>
        <Alert severity='warning' icon={false} sx={{ fontSize: 12.5 }}>
          <b>Public internet:</b>{' '}
          {network.nat === 'behind-nat'
            ? 'this computer is behind NAT / CGNAT, so incoming connections from the internet are blocked. '
            : network.nat === 'direct'
              ? 'this computer has a public address. '
              : ''}
          Password logins from public addresses are refused by the server, and no router port forwarding is set up.
        </Alert>
      </Stack>
    </SectionCard>
  )
}

export default NetworkCard
