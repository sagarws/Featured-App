import { useCallback, useEffect, useState } from 'react'
import { Box, Button, Chip, IconButton, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography } from '@mui/material'
import { KeyOutlined, ReplayOutlined } from '@mui/icons-material'
import type { HistoryEntry, RemoteStatus } from '@shared/types/remote'
import { parseDeviceId } from '@shared/utils/remote'

const TONE: Partial<Record<HistoryEntry['event'], 'success' | 'error' | 'warning' | 'info'>> = {
  connected: 'success',
  accepted: 'success',
  reconnected: 'info',
  rejected: 'warning',
  'auth-failed': 'error',
  'rate-limited': 'error',
  blocked: 'error',
  revoked: 'error',
  failed: 'error',
  expired: 'warning'
}

/** The audit log: every request, login attempt, session and transfer, both directions. */
const HistoryTab = ({ status, onReconnect }: { status: RemoteStatus; onReconnect: (id: string) => void }) => {
  const api = window.printAgent.remote
  const withPassword = new Set(status.savedPasswords)
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)

  const load = useCallback(() => void api.history().then(r => r.ok && setEntries(r.value)), [api])

  useEffect(() => {
    load()
    return api.onStatus(() => load())
  }, [api, load])

  return (
    <Paper variant='outlined' sx={{ p: 4, borderRadius: 3 }}>
      <Stack direction='row' alignItems='center' sx={{ mb: 2 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant='h6' sx={{ fontSize: 16, fontWeight: 600 }}>
            Connection history
          </Typography>
          <Typography variant='body2' color='text.secondary'>
            The last 500 events, newest first. Kept on this computer only.
          </Typography>
        </Box>
        <Button size='small' color='error' onClick={() => void api.clearHistory().then(load)}>
          Clear
        </Button>
      </Stack>
      {!entries?.length ? (
        <Typography variant='body2' color='text.secondary' sx={{ py: 4, textAlign: 'center' }}>
          Nothing yet.
        </Typography>
      ) : (
        <Table size='small'>
          <TableHead>
            <TableRow>
              <TableCell>When</TableCell>
              <TableCell>Direction</TableCell>
              <TableCell>Event</TableCell>
              <TableCell>Device</TableCell>
              <TableCell>Details</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {entries.map((e, i) => {
              // Older entries hold the 9-digit form (WD-019-304-289): look them up by the 8-digit ID.
              const id = e.direction === 'outgoing' && e.peerId ? parseDeviceId(e.peerId) : null
              return (
                <TableRow key={`${e.at}-${i}`}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleString()}</TableCell>
                  <TableCell>{e.direction === 'incoming' ? 'To this PC' : 'From this PC'}</TableCell>
                  <TableCell>
                    <Chip size='small' variant='tonal' color={TONE[e.event] ?? 'default'} label={e.event} />
                  </TableCell>
                  <TableCell>
                    {e.peerName || '—'}
                    <Typography variant='caption' color='text.secondary' component='div'>
                      {e.peerId} {e.address}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 360 }}>{e.detail}</TableCell>
                  <TableCell padding='checkbox' sx={{ whiteSpace: 'nowrap', pr: 1 }}>
                    {id && (
                      <Stack direction='row' alignItems='center' spacing={0.5}>
                        {withPassword.has(id) && (
                          <Tooltip title='Password saved'>
                            <KeyOutlined color='action' sx={{ fontSize: 16 }} />
                          </Tooltip>
                        )}
                        <Tooltip title={withPassword.has(id) ? 'Reconnect with the saved password' : 'Reconnect (asks the person there to accept)'}>
                          <IconButton size='small' onClick={() => onReconnect(id)}>
                            <ReplayOutlined fontSize='small' />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </Paper>
  )
}

export default HistoryTab
