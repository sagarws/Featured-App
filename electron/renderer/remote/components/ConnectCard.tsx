import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, FormControlLabel, Link, Paper, Stack, Switch, TextField, Typography } from '@mui/material'
import { KeyOutlined, LinkOutlined } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { RemoteStatus } from '@shared/types/remote'
import { parseDeviceId } from '@shared/utils/remote'
import IconTile from '../../components/IconTile'

const newAttemptId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')

interface Progress {
  stage: string
  message: string
  verificationCode?: string
}

/**
 * Right column: dial a device by ID (or IP), with or without its unattended
 * password. "Remember password" keeps the password (OS-encrypted, in the main
 * process) so the next connection — or Reconnect — does not ask for it.
 */
const ConnectCard = ({
  status,
  target,
  onTarget,
  reconnect,
  onReconnectStarted
}: {
  status: RemoteStatus
  target: string
  onTarget: (value: string) => void
  /** Set by Reconnect (Devices / History): dial this ID now, with its saved password when there is one. */
  reconnect: { id: string; nonce: number } | null
  onReconnectStarted: () => void
}) => {
  const api = window.printAgent.remote
  const [password, setPassword] = useState('')
  const passwordRef = useRef<HTMLInputElement>(null)
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

  const canRemember = status.encryption
  const remember = canRemember && status.settings.rememberPasswords
  const typedId = parseDeviceId(target)
  const hasSaved = !!typedId && status.savedPasswords.includes(typedId)

  const connect = async (to = target.trim(), typed = password) => {
    const id = newAttemptId()
    attemptRef.current = id
    setAttempt(id)
    setError(null)
    setProgress({ stage: 'connecting', message: 'Looking for the computer…' })
    const r = await api.connect(
      {
        target: to,
        ...(typed ? { password: typed } : { useSavedPassword: true }),
        ...(canRemember ? { remember } : {})
      },
      id
    )
    if (attemptRef.current !== id) return
    attemptRef.current = null
    setAttempt(null)
    setProgress(null)
    if (r.ok) setPassword('')
    else if (r.error !== 'Cancelled.') setError(r.error)
  }

  // Reconnect from another card: dial once per request (the main process falls back to an attended request without a saved password).
  const connectRef = useRef(connect)
  useEffect(() => {
    connectRef.current = connect
  })
  useEffect(() => {
    if (!reconnect) return
    onReconnectStarted()
    if (attemptRef.current) return
    setPassword('')
    void connectRef.current(reconnect.id, '')
  }, [reconnect, onReconnectStarted])

  const forgetSaved = async () => {
    if (!typedId) return
    const r = await api.forgetSavedPassword(typedId)
    if (!r.ok) toast.error(r.error)
    else {
      toast.success('Saved password forgotten')
      passwordRef.current?.focus()
    }
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
          inputRef={passwordRef}
          value={password}
          disabled={!!attempt}
          placeholder={hasSaved ? 'Saved password will be used' : undefined}
          InputLabelProps={hasSaved ? { shrink: true } : undefined}
          onChange={e => setPassword(e.target.value)}
          helperText={
            hasSaved && !password ? (
              <Stack component='span' direction='row' spacing={0.75} alignItems='center'>
                <KeyOutlined sx={{ fontSize: 14 }} />
                <span>Saved password will be used.</span>
                <Link component='button' type='button' variant='caption' onClick={() => void forgetSaved()} disabled={!!attempt}>
                  Forget
                </Link>
              </Stack>
            ) : hasSaved ? (
              'This password replaces the saved one if it works.'
            ) : (
              'Optional. Without it, the other computer shows a request to Allow or Reject.'
            )
          }
          onKeyDown={e => e.key === 'Enter' && target.trim() && !attempt && void connect()}
        />
        <Box sx={{ mt: '-4px !important' }}>
          <FormControlLabel
            disabled={!canRemember || !!attempt}
            control={<Switch size='small' checked={remember} onChange={e => void api.updateSettings({ rememberPasswords: e.target.checked })} />}
            label={<Typography variant='body2'>Remember password</Typography>}
          />
          <Typography variant='caption' color='text.secondary' component='div'>
            {canRemember
              ? 'Kept encrypted on this computer after a successful unattended connection. Manage in Security.'
              : 'Unavailable: this system has no keychain/credential store to encrypt saved passwords.'}
          </Typography>
        </Box>

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
