import { Chip, Skeleton } from '@mui/material'
import type { VpsNetwork, VpsSystemInfo } from '@shared/types/vps'
import SectionCard from '../../components/SectionCard'
import { formatBytes } from '../hooks'
import { InfoRow, MONO } from './ui'

/** What was detected about this computer, before converting it. */
const SystemInfoCard = ({ info, network }: { info: VpsSystemInfo | null; network: VpsNetwork | null }) => (
  <SectionCard icon='tabler-device-desktop' title='This computer' subtitle='Detected automatically.'>
    {!info ? (
      <Skeleton variant='rounded' height={240} />
    ) : (
      <>
        <InfoRow label='Operating system' value={`${info.os} ${info.osVersion}`} />
        <InfoRow label='Architecture' value={info.arch} />
        <InfoRow label='CPU' value={`${info.cpuModel} · ${info.cpuCores} cores`} />
        <InfoRow label='Total RAM' value={formatBytes(info.totalMemory)} />
        <InfoRow label='Available storage' value={info.disk ? `${formatBytes(info.disk.free)} of ${formatBytes(info.disk.total)}` : '—'} />
        <InfoRow label='Local network IP' mono value={<span style={{ fontFamily: MONO }}>{network?.lanIp ?? 'Not connected to a local network'}</span>} />
        <InfoRow
          label='Network'
          value={
            network ? (
              <Chip size='small' variant='tonal' color={network.online ? 'success' : 'error'} label={network.online ? 'Online' : 'Offline'} />
            ) : (
              '—'
            )
          }
        />
      </>
    )}
  </SectionCard>
)

export default SystemInfoCard
