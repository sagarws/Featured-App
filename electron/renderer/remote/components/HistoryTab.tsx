import { useCallback, useEffect, useState } from 'react'
import { Box, Button, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material'
import type { HistoryEntry } from '@shared/types/remote'

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
const HistoryTab = () => {
  const api = window.printAgent.remote
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
            </TableRow>
          </TableHead>
          <TableBody>
            {entries.map((e, i) => (
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Paper>
  )
}

export default HistoryTab
