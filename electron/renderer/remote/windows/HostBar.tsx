import { useEffect, useState } from 'react'
import { Box, Button, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material'
import { AttachFileOutlined, MoreTimeOutlined, StopCircleOutlined, VisibilityOutlined, MouseOutlined } from '@mui/icons-material'
import { SESSION_MINUTES } from '@shared/constants/remote'
import type { RemoteSessionInfo } from '@shared/types/remote'
import { formatRemaining } from '@shared/utils/remote'

/*
 * #rd-hostbar: always on top while this computer is shared. Says who is
 * watching or controlling, how long is left, and gives the owner the controls
 * they must always have: view only / allow control, extend, send files, stop.
 */
const HostBar = () => {
  const api = window.printAgent.remote
  const [sessions, setSessions] = useState<RemoteSessionInfo[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [extendAnchor, setExtendAnchor] = useState<HTMLElement | null>(null)

  useEffect(() => {
    const apply = (list: RemoteSessionInfo[]) => setSessions(list.filter(s => s.direction === 'incoming' && s.state !== 'ended'))
    const off = api.onStatus(status => apply(status.sessions))
    void api.getStatus().then(r => r.ok && apply(r.value.sessions))
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      off()
      window.clearInterval(t)
    }
  }, [api])

  const s = sessions[0]
  if (!s) return null
  const remaining = s.expiresAt === null ? null : s.expiresAt - now
  const controlling = s.permission === 'control' && !s.inputProblem

  return (
    <Box sx={{ height: '100%', p: '4px' }}>
      <Stack
        direction='row'
        alignItems='center'
        spacing={1}
        sx={{
          height: '100%',
          px: 1.5,
          borderRadius: '12px',
          bgcolor: 'rgba(24,24,30,.96)',
          color: '#fff',
          border: '1px solid rgba(255,255,255,.12)',
          boxShadow: '0 8px 24px rgba(0,0,0,.35)',
          WebkitAppRegion: 'drag'
        }}
      >
        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: s.state === 'reconnecting' ? 'warning.main' : 'error.main', animation: 'pulse 1.6s infinite', '@keyframes pulse': { '50%': { opacity: 0.35 } } }} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.25 }}>
            {s.peerName} is {controlling ? 'controlling' : 'viewing'} this computer
          </Typography>
          <Typography noWrap sx={{ fontSize: 11, color: 'rgba(255,255,255,.6)', fontVariantNumeric: 'tabular-nums' }}>
            {s.state === 'reconnecting' ? 'Connection interrupted…' : remaining === null ? 'No time limit' : `${formatRemaining(remaining)} left`} · {s.peerId}
          </Typography>
        </Box>
        <Stack direction='row' spacing={0.5} sx={{ WebkitAppRegion: 'no-drag' }}>
          <Tooltip title={s.permission === 'control' ? 'Switch to view only' : 'Allow control'}>
            <Button size='small' color='inherit' onClick={() => void api.setSessionPermission(s.sessionId, s.permission === 'control' ? 'view' : 'control')} startIcon={s.permission === 'control' ? <VisibilityOutlined /> : <MouseOutlined />}>
              {s.permission === 'control' ? 'View only' : 'Allow control'}
            </Button>
          </Tooltip>
          <Tooltip title='Extend the session'>
            <Button size='small' color='inherit' startIcon={<MoreTimeOutlined />} onClick={e => setExtendAnchor(e.currentTarget)}>
              Extend
            </Button>
          </Tooltip>
          {s.fileTransfer && (
            <Tooltip title='Send files to the viewer'>
              <Button size='small' color='inherit' sx={{ minWidth: 0 }} onClick={() => void api.sendFiles(s.sessionId)}>
                <AttachFileOutlined fontSize='small' />
              </Button>
            </Tooltip>
          )}
          <Button size='small' variant='contained' color='error' startIcon={<StopCircleOutlined />} onClick={() => void api.endIncoming(s.sessionId)}>
            Stop
          </Button>
        </Stack>
      </Stack>
      <Menu anchorEl={extendAnchor} open={!!extendAnchor} onClose={() => setExtendAnchor(null)}>
        {SESSION_MINUTES.map(m => (
          <MenuItem
            key={m.value}
            onClick={() => {
              setExtendAnchor(null)
              void api.extendSession(s.sessionId, m.value)
            }}
          >
            <ListItemText primary={m.value === 0 ? 'Remove the time limit' : `+ ${m.label}`} />
          </MenuItem>
        ))}
      </Menu>
    </Box>
  )
}

export default HostBar
