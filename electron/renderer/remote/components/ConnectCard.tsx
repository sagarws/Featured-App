import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Paper, Stack, TextField, Typography } from '@mui/material'
import { LinkOutlined } from '@mui/icons-material'
import type { RemoteStatus } from '@shared/types/remote'
import { parseDeviceId } from '@shared/utils/remote'
import IconTile from '../../components/IconTile'

const newAttemptId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')

interface Progress {
  stage: string
  message: string
  verificationCode?: string
}

/** Right column: dial a device by ID (or IP), with or without its unattended password. */
const ConnectCard = ({ status, target, onTarget }: { status: RemoteStatus; target: string; onTarget: (value: string) => void }) => {
  const api = window.printAgent.remote
  const [password, setPassword] = useState('')
  const [attempt, setAttempt] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const attemptRef = useRef<string | null>(null)

  useEffect(
    () =>
      api.onConnectProgress(p => {
        if (p.attemptId === attemptRef.current) setProgress(p)
      }),
    [api]
  )

  const connect = async () => {
    const id = newAttemptId()
    attemptRef.current = id
    setAttempt(id)
    setError(null)
    setProgress({ stage: 'connecting', message: 'Looking for the computer…' })
    const r = await api.connect({ target: target.trim(), ...(password ? { password } : {}) }, id)
    if (attemptRef.current !== id) return
    attemptRef.current = null
    setAttempt(null)
    setProgress(null)
    if (r.ok) setPassword('')
    else if (r.error !== 'Cancelled.') setError(r.error)
  }

  const cancel = () => {
    if (attempt) void api.cancelConnect(attempt)
    attemptRef.current = null
    setAttempt(null)
    setProgress(null)
  }

  const found = status.discovered.find(d => d.id === target.trim().toUpperCase())

  return (
    <Paper variant='outlined' sx={{ p: 4, borderRadius: 3, height: '100%' }}>
      <Stack direction='row' spacing={2.5} alignItems='flex-start' sx={{ mb: 3 }}>
        <IconTile icon='tabler-arrow-right' tone='info' />
        <Box sx={{ flex: 1, pt: 0.5 }}>
          <Typography variant='h6' sx={{ fontSize: 16, fontWeight: 600 }}>
            Connect to a device
          </Typography>
          <Typography variant='body2' color='text.secondary' sx={{ fontSize: 12.5 }}>
            Enter the other computer’s ID. Leave the password empty to ask the person there.
          </Typography>
        </Box>
      </Stack>

      <Stack spacing={2}>
        <TextField
          label='Remote device ID'
          placeholder='8-digit ID, e.g. 19304289'
          value={target}
          // Digits only, 8 of them. A pasted old ID (WD-019-304-289) becomes its 8-digit form (19304289).
          onChange={e => onTarget(parseDeviceId(e.target.value) ?? e.target.value.replace(/\D/g, '').slice(0, 8))}
          disabled={!!attempt}
          inputProps={{
            inputMode: 'numeric',
            maxLength: 14,
            style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 18, letterSpacing: 3 }
          }}
          helperText={found ? `${found.name} — on this network (${found.address})` : ' '}
          onKeyDown={e => e.key === 'Enter' && target.trim() && !attempt && void connect()}
        />
        <TextField
          label='Password (unattended access)'
          type='password'
          autoComplete='off'
          value={password}
          disabled={!!attempt}
          onChange={e => setPassword(e.target.value)}
          helperText='Optional. Without it, the other computer shows a request to Allow or Reject.'
          onKeyDown={e => e.key === 'Enter' && target.trim() && !attempt && void connect()}
        />

        {progress && (
          <Alert severity='info' icon={<CircularProgress size={18} />} action={<Button color='inherit' size='small' onClick={cancel}>Cancel</Button>}>
            {progress.message}
            {progress.verificationCode && (
              <Box sx={{ mt: 0.5 }}>
                Verification code <b style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>{progress.verificationCode}</b> — the other screen shows the same one.
              </Box>
            )}
          </Alert>
        )}
        {error && (
          <Alert severity='error' onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Stack direction='row' justifyContent='flex-end'>
          <Button variant='contained' size='large' startIcon={<LinkOutlined />} disabled={!target.trim() || !!attempt} onClick={() => void connect()}>
            Connect
          </Button>
        </Stack>
      </Stack>
    </Paper>
  )
}

export default ConnectCard
