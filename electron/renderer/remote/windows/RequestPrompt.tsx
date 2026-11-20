import { useEffect, useState } from 'react'
import { Alert, Box, Button, FormControl, FormControlLabel, InputLabel, MenuItem, Radio, RadioGroup, Select, Stack, Typography } from '@mui/material'
import { SESSION_MINUTES } from '@shared/constants/remote'
import type { IncomingRequest, RemotePermission, SessionMinutes } from '@shared/types/remote'

/*
 * #rd-request: someone asks to see or control this computer. Nothing is
 * shared until the person here presses Allow; closing the window rejects.
 */
const RequestPrompt = ({ requestId }: { requestId: string }) => {
  const api = window.printAgent.remote
  const [info, setInfo] = useState<(IncomingRequest & { defaultMinutes: SessionMinutes; controlDisabled: boolean }) | null>(null)
  const [permission, setPermission] = useState<RemotePermission>('control')
  const [minutes, setMinutes] = useState<SessionMinutes>(30)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void api.requestInfo(requestId).then(r => {
      if (!r.ok || !r.value) return window.close()
      setInfo(r.value)
      setMinutes(r.value.defaultMinutes)
      if (r.value.controlDisabled) setPermission('view')
    })
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [api, requestId])

  if (!info) return null
  const secondsLeft = Math.max(0, Math.ceil((info.expiresAt - now) / 1000))
  const answer = (allow: boolean) => void api.answerRequest(requestId, { allow, permission, minutes }).then(() => window.close())

  return (
    <Box sx={{ p: 3, height: '100vh', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <Typography variant='h6' sx={{ fontWeight: 700, fontSize: 18 }}>
        Remote access request
      </Typography>
      <Typography color='text.secondary' sx={{ fontSize: 13, mb: 2 }}>
        Answer within {secondsLeft} s — otherwise it is declined.
      </Typography>

      <Box sx={{ p: 2, borderRadius: 2, bgcolor: 'action.hover', mb: 2 }}>
        <Typography sx={{ fontWeight: 600 }}>{info.peerName}</Typography>
        <Typography sx={{ fontSize: 13, fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>{info.peerId}</Typography>
        <Typography color='text.secondary' sx={{ fontSize: 12.5 }}>
          {info.peerOs} · {info.address}
        </Typography>
        <Typography sx={{ fontSize: 12.5, mt: 1 }}>
          Verification code: <b style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 14 }}>{info.verificationCode}</b>
        </Typography>
        <Typography color='text.secondary' sx={{ fontSize: 11.5 }}>
          The person connecting sees the same code. If it differs, someone is in between — reject.
        </Typography>
      </Box>

      {info.firstTime && (
        <Alert severity='warning' sx={{ mb: 2, py: 0 }}>
          This device has never connected before. Only allow people you know.
        </Alert>
      )}

      <RadioGroup value={permission} onChange={e => setPermission(e.target.value === 'view' ? 'view' : 'control')}>
        <FormControlLabel value='control' disabled={info.controlDisabled} control={<Radio size='small' />} label='Full control (keyboard and mouse)' />
        <FormControlLabel value='view' control={<Radio size='small' />} label='View only' />
      </RadioGroup>

      <FormControl size='small' sx={{ mt: 1.5 }}>
        <InputLabel>Allow for</InputLabel>
        <Select label='Allow for' value={minutes} onChange={e => setMinutes(Number(e.target.value) as SessionMinutes)}>
          {SESSION_MINUTES.map(m => (
            <MenuItem key={m.value} value={m.value}>
              {m.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Box sx={{ flex: 1 }} />
      <Stack direction='row' spacing={1.5} justifyContent='flex-end'>
        <Button variant='outlined' color='error' onClick={() => answer(false)}>
          Reject
        </Button>
        <Button variant='contained' onClick={() => answer(true)}>
          Allow
        </Button>
      </Stack>
    </Box>
  )
}

export default RequestPrompt
