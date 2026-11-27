import { Grid, Skeleton } from '@mui/material'
import type { VpsMetrics, VpsStatus } from '@shared/types/vps'
import { formatDuration } from '@shared/utils/vps'
import SectionCard from '../../components/SectionCard'
import { formatBytes } from '../hooks'
import { Metric } from './ui'

const pct = (used: number, total: number): number => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0)

/** Live resources, refreshed every 5 s while this page is open. */
const MonitoringCard = ({ metrics, status }: { metrics: VpsMetrics | null; status: VpsStatus }) => (
  <SectionCard icon='tabler-activity' title='Monitoring' subtitle='Refreshed every 5 seconds while this page is open.'>
    {!metrics ? (
      <Skeleton variant='rounded' height={180} />
    ) : (
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 3 }}>
          <Metric label='CPU' value={`${metrics.cpuPercent}%`} percent={metrics.cpuPercent} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Metric
            label='RAM'
            value={`${pct(metrics.memory.used, metrics.memory.total)}%`}
            sub={`${formatBytes(metrics.memory.used)} of ${formatBytes(metrics.memory.total)}`}
            percent={pct(metrics.memory.used, metrics.memory.total)}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Metric
            label='Disk'
            value={metrics.disk ? `${pct(metrics.disk.used, metrics.disk.total)}%` : '—'}
            sub={metrics.disk ? `${formatBytes(metrics.disk.used)} of ${formatBytes(metrics.disk.total)}` : undefined}
            percent={metrics.disk ? pct(metrics.disk.used, metrics.disk.total) : null}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Metric
            label='Network'
            value={metrics.network ? `↓ ${formatBytes(metrics.network.rxPerSec)}/s` : '—'}
            sub={metrics.network ? `↑ ${formatBytes(metrics.network.txPerSec)}/s` : undefined}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Metric label='SSH service' value={metrics.serviceRunning ? 'Running' : 'Stopped'} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Metric label='Active SSH connections' value={metrics.activeConnections !== null ? String(metrics.activeConnections) : '—'} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Metric label='Server uptime' value={metrics.serverUptime !== null ? formatDuration(metrics.serverUptime) : '—'} sub={`System: ${formatDuration(metrics.systemUptime)}`} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Metric
            label='Failed logins (10 min)'
            value={status.lockout ? String(status.lockout.recentFailures) : '—'}
            sub={status.lockout?.lockedUntil ? 'Account locked' : 'Locks after 10'}
          />
        </Grid>
      </Grid>
    )}
  </SectionCard>
)

export default MonitoringCard
