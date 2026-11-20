import { useState } from 'react'
import { Alert, Box, Button, Chip, LinearProgress, Menu, MenuItem, Paper, Stack, Typography } from '@mui/material'
import { CallEndRounded, MoreTimeOutlined, OpenInNewOutlined, StopCircleOutlined } from '@mui/icons-material'
import toast from 'react-hot-toast'
import { SESSION_MINUTES } from '@shared/constants/remote'
import type { RemoteSessionInfo, RemoteStatus } from '@shared/types/remote'
import { formatRemaining } from '@shared/utils/remote'
import { useNow } from '../hooks'

const formatBytes = (n: number): string => (n > 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`)

/** Active sessions both ways, plus file transfers. */
const SessionsTab = ({ status }: { status: RemoteStatus }) => {
  const api = window.printAgent.remote
  const now = useNow()
  const [extend, setExtend] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const incoming = status.sessions.filter(s => s.direction === 'incoming')
  const outgoing = status.sessions.filter(s => s.direction === 'outgoing')

  const act = async (call: Promise<{ ok: boolean; error?: string }>) => {
    const r = await call
    if (!r.ok) toast.error(r.error ?? 'Failed')
  }

  const timer = (s: RemoteSessionInfo) => (s.expiresAt === null ? 'Unlimited' : `${formatRemaining(s.expiresAt - now)} left`)
  const stateChip = (s: RemoteSessionInfo) => (
    <Chip size='small' variant='tonal' color={s.state === 'active' ? 'success' : s.state === 'ended' ? 'default' : 'warning'} label={s.state === 'reconnecting' ? 'Reconnecting' : s.state === 'ended' ? 'Ended' : 'Connected'} />
  )

  return (
    <Stack spacing={3}>
      <Paper variant='outlined' sx={{ p: 4, borderRadius: 3 }}>
        <Stack direction='row' alignItems='center' sx={{ mb: 2 }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant='h6' sx={{ fontSize: 16, fontWeight: 600 }}>
              Connected to this computer
            </Typography>
            <Typography variant='body2' color='text.secondary'>
              You can stop, limit or extend these at any time. A bar at the top of the screen shows while one is active.
            </Typography>
          </Box>
          {incoming.some(s => s.state !== 'ended') && (
            <Button color='error' variant='contained' startIcon={<StopCircleOutlined />} onClick={() => void act(api.endAllIncoming())}>
              Stop all
            </Button>
          )}
        </Stack>
        {!incoming.length && (
          <Typography variant='body2' color='text.secondary' sx={{ py: 3, textAlign: 'center' }}>
            Nobody is connected to this computer.
          </Typography>
        )}
        {incoming.map(s => (
          <Box key={s.sessionId} sx={{ py: 1.5, borderBlockStart: '1px solid', borderColor: 'divider' }}>
            <Stack direction='row' alignItems='center' spacing={1.5}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 600 }}>
                  {s.peerName} <Typography component='span' variant='caption' color='text.secondary'>{s.peerId} · {s.address}</Typography>
                </Typography>
                <Typography variant='caption' color='text.secondary'>
                  {s.method === 'password' ? 'Unattended' : 'Accepted by you'} · {s.permission === 'control' ? 'Full control' : 'View only'} · {timer(s)}
                </Typography>
              </Box>
              {stateChip(s)}
              {s.state !== 'ended' && (
                <>
                  <Button size='small' onClick={() => void act(api.setSessionPermission(s.sessionId, s.permission === 'control' ? 'view' : 'control'))}>
                    {s.permission === 'control' ? 'View only' : 'Allow control'}
                  </Button>
                  <Button size='small' startIcon={<MoreTimeOutlined />} onClick={e => setExtend({ id: s.sessionId, anchor: e.currentTarget })}>
                    Extend
                  </Button>
                  <Button size='small' color='error' variant='outlined' startIcon={<StopCircleOutlined />} onClick={() => void act(api.endIncoming(s.sessionId))}>
                    Disconnect
                  </Button>
                </>
              )}
            </Stack>
            {s.inputProblem && s.state === 'active' && (
              <Alert severity='warning' sx={{ mt: 1 }}>
                Keyboard/mouse control is not working: {s.inputProblem}
              </Alert>
            )}
          </Box>
        ))}
      </Paper>

      <Paper variant='outlined' sx={{ p: 4, borderRadius: 3 }}>
        <Typography variant='h6' sx={{ fontSize: 16, fontWeight: 600, mb: 2 }}>
          Your connections to other computers
        </Typography>
        {!outgoing.length && (
          <Typography variant='body2' color='text.secondary' sx={{ py: 3, textAlign: 'center' }}>
            You are not connected to another computer.
          </Typography>
        )}
        {outgoing.map(s => (
          <Stack key={s.sessionId} direction='row' alignItems='center' spacing={1.5} sx={{ py: 1.5, borderBlockStart: '1px solid', borderColor: 'divider' }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600 }}>
                {s.peerName} <Typography component='span' variant='caption' color='text.secondary'>{s.peerId}{s.viaRelay ? ' · via relay' : ''}</Typography>
              </Typography>
              <Typography variant='caption' color='text.secondary'>
                {s.permission === 'control' ? 'Full control' : 'View only'} · {timer(s)}
                {s.endReason ? ` · ${s.endReason}` : ''}
              </Typography>
            </Box>
            {stateChip(s)}
            {s.state !== 'ended' && (
              <>
                <Button size='small' startIcon={<OpenInNewOutlined />} onClick={() => void act(api.focusViewer(s.sessionId))}>
                  Show
                </Button>
                <Button size='small' color='error' variant='outlined' startIcon={<CallEndRounded />} onClick={() => void act(api.disconnect(s.sessionId))}>
                  Disconnect
                </Button>
              </>
            )}
          </Stack>
        ))}
      </Paper>

      <Paper variant='outlined' sx={{ p: 4, borderRadius: 3 }}>
        <Typography variant='h6' sx={{ fontSize: 16, fontWeight: 600, mb: 2 }}>
          File transfers
        </Typography>
        {!status.transfers.length && (
          <Typography variant='body2' color='text.secondary' sx={{ py: 2, textAlign: 'center' }}>
            No transfers yet. Use the paperclip in the viewer toolbar (or on the host bar) to send files.
          </Typography>
        )}
        {status.transfers.map(t => (
          <Box key={t.transferId} sx={{ py: 1.5, borderBlockStart: '1px solid', borderColor: 'divider' }}>
            <Stack direction='row' alignItems='center' spacing={1}>
              <Typography sx={{ flex: 1, fontWeight: 600, fontSize: 14 }} noWrap>
                {t.direction === 'send' ? 'To' : 'From'} {t.peerName}: {t.files.length === 1 ? t.files[0]?.name : `${t.files.length} files`} · {formatBytes(t.totalBytes)}
              </Typography>
              <Chip size='small' variant='tonal' color={t.state === 'done' ? 'success' : t.state === 'failed' ? 'error' : t.state === 'transferring' ? 'primary' : 'default'} label={t.state} />
              {(t.state === 'transferring' || t.state === 'waiting' || t.state === 'offered') && (
                <Button size='small' onClick={() => void act(api.cancelTransfer(t.transferId))}>
                  Cancel
                </Button>
              )}
            </Stack>
            <LinearProgress variant='determinate' value={t.totalBytes ? (t.doneBytes / t.totalBytes) * 100 : t.state === 'done' ? 100 : 0} sx={{ my: 1 }} />
            <Typography variant='caption' color='text.secondary'>
              {formatBytes(t.doneBytes)} of {formatBytes(t.totalBytes)}
              {t.state === 'transferring' ? ` · ${formatBytes(t.speed)}/s` : ''}
              {t.folder ? ` · saved in ${t.folder}` : ''}
              {t.error ? ` · ${t.error}` : ''}
            </Typography>
          </Box>
        ))}
      </Paper>

      <Menu anchorEl={extend?.anchor} open={!!extend} onClose={() => setExtend(null)}>
        {SESSION_MINUTES.map(m => (
          <MenuItem
            key={m.value}
            onClick={() => {
              if (extend) void act(api.extendSession(extend.id, m.value))
              setExtend(null)
            }}
          >
            {m.value === 0 ? 'Remove the time limit' : `+ ${m.label}`}
          </MenuItem>
        ))}
      </Menu>
    </Stack>
  )
}

export default SessionsTab
