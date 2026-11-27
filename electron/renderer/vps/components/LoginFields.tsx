import { useState } from 'react'
import { Button, Chip, IconButton, InputAdornment, Stack, TextField, Tooltip } from '@mui/material'
import { AutorenewOutlined, VisibilityOffOutlined, VisibilityOutlined } from '@mui/icons-material'
import { generatePassword, generateUsername, passwordProblem, passwordStrength, usernameProblem } from '@shared/utils/vps'
import { MONO } from './ui'

/** Uniform integer in [0, max) from the Web Crypto CSPRNG (rejection sampling, no modulo bias). */
const webRandomInt = (max: number): number => {
  const limit = Math.floor(0x1_0000_0000 / max) * max
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if ((buf[0] as number) < limit) return (buf[0] as number) % max
  }
}

export const newWebPassword = (): string => generatePassword(webRandomInt)
export const newWebUsername = (): string => generateUsername(webRandomInt)

export interface Login {
  username: string
  password: string
}

/** True when both fields are acceptable. */
export const loginValid = (login: Login): boolean => !usernameProblem(login.username) && !passwordProblem(login.password)

const STRENGTH = { weak: 'error', fair: 'warning', strong: 'success' } as const

/** Username + password, each editable and regenerable, plus "Regenerate both". */
const LoginFields = ({ value, onChange, disabled }: { value: Login; onChange: (next: Login) => void; disabled?: boolean }) => {
  const [show, setShow] = useState(false)
  const userError = value.username ? usernameProblem(value.username) : 'Enter a username.'
  const passError = passwordProblem(value.password)
  const strength = passwordStrength(value.password)

  return (
    <Stack spacing={2}>
      <TextField
        size='small'
        label='Username'
        value={value.username}
        disabled={disabled}
        onChange={e => onChange({ ...value, username: e.target.value })}
        error={!!userError}
        helperText={userError ?? 'Any name except root. A new standard (non-administrator) account is made with it.'}
        slotProps={{
          htmlInput: { spellCheck: false, autoCapitalize: 'none', style: { fontFamily: MONO } },
          input: {
            endAdornment: (
              <InputAdornment position='end'>
                <Tooltip title='Random username'>
                  <span>
                    <IconButton size='small' disabled={disabled} onClick={() => onChange({ ...value, username: newWebUsername() })}>
                      <AutorenewOutlined sx={{ fontSize: 18 }} />
                    </IconButton>
                  </span>
                </Tooltip>
              </InputAdornment>
            )
          }
        }}
      />
      <TextField
        size='small'
        label='Password'
        type={show ? 'text' : 'password'}
        value={value.password}
        disabled={disabled}
        autoComplete='new-password'
        onChange={e => onChange({ ...value, password: e.target.value })}
        error={!!passError}
        helperText={passError ?? 'Any password you like, or a generated one. It is never shown in the SSH configuration.'}
        slotProps={{
          htmlInput: { spellCheck: false, style: { fontFamily: MONO } },
          input: {
            endAdornment: (
              <InputAdornment position='end'>
                {!passError && <Chip size='small' variant='tonal' color={STRENGTH[strength]} label={strength} sx={{ mr: 0.5 }} />}
                <Tooltip title={show ? 'Hide' : 'Show'}>
                  <IconButton size='small' onClick={() => setShow(s => !s)}>
                    {show ? <VisibilityOffOutlined sx={{ fontSize: 18 }} /> : <VisibilityOutlined sx={{ fontSize: 18 }} />}
                  </IconButton>
                </Tooltip>
                <Tooltip title='Strong random password'>
                  <span>
                    <IconButton size='small' disabled={disabled} onClick={() => onChange({ ...value, password: newWebPassword() })}>
                      <AutorenewOutlined sx={{ fontSize: 18 }} />
                    </IconButton>
                  </span>
                </Tooltip>
              </InputAdornment>
            )
          }
        }}
      />
      <Button
        size='small'
        variant='text'
        startIcon={<AutorenewOutlined />}
        disabled={disabled}
        onClick={() => onChange({ username: newWebUsername(), password: newWebPassword() })}
        sx={{ alignSelf: 'flex-start' }}
      >
        Regenerate both
      </Button>
    </Stack>
  )
}

export default LoginFields
