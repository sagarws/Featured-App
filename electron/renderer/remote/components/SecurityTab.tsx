import { useState } from 'react'
import { Alert, Box, Button, Stack, Switch, Typography } from '@mui/material'
import { GppMaybeOutlined, KeyOutlined } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { RemotePermission, RemoteSettings, RemoteStatus } from '@shared/types/remote'
import { Choice, Row, Section } from '../../screenshot/components/ui'
import { timeAgo } from '../hooks'
import PasswordDialog from './PasswordDialog'

/** Who may connect and what they may do; authorised and blocked devices. */
const SecurityTab = ({ status }: { status: RemoteStatus }) => {
  const api = window.printAgent.remote
  const s = status.settings
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [agentBusy, setAgentBusy] = useState(false)

  const agent = async (install: boolean) => {
    setAgentBusy(true)
    const r = await (install ? api.installSecureAgent() : api.removeSecureAgent())
    setAgentBusy(false)
    if (!r.ok) toast.error(r.error)
    else toast.success(install ? 'Lock screen access is on' : 'Lock screen access removed')
  }

  const act = async (call: Promise<{ ok: boolean; error?: string }>, done?: string) => {
    const r = await call
    if (!r.ok) toast.error(r.error ?? 'Failed')
    else if (done) toast.success(done)
  }
  const update = (patch: Partial<RemoteSettings>) => act(api.updateSettings(patch))

  return (
    <Stack spacing={3}>
      {!status.encryption && (
        <Alert severity='warning'>
          This system has no keychain/credential store available to the app, so the device key and password hash are protected by file permissions only.
        </Alert>
      )}

      <Section title='Access to this computer'>
        <Row title='Allow remote access' hint='Off = this computer does not listen at all; sessions in progress end.'>
          <Switch checked={s.enabled} onChange={e => void update({ enabled: e.target.checked })} />
        </Row>
        <Row title='Disable remote control' hint='Kill switch: every session (new and running) becomes view-only. Keyboard and mouse stop at once.'>
          <Switch color='error' checked={s.controlDisabled} onChange={e => void update({ controlDisabled: e.target.checked })} />
        </Row>
      </Section>

      <Section title='Unattended access' subtitle='Connect with the device ID and a permanent password, without anyone at this computer accepting. Off by default.'>
        <Row title='Unattended access' hint={status.unattendedPasswordSet ? 'A password is set.' : 'Set a password first.'}>
          <Switch
            checked={s.unattendedEnabled}
            disabled={!s.enabled}
            onChange={e => {
              if (e.target.checked && !status.unattendedPasswordSet) setPasswordOpen(true)
              else void update({ unattendedEnabled: e.target.checked })
            }}
          />
        </Row>
        <Row title='Password'>
          <Button size='small' variant='outlined' startIcon={<KeyOutlined />} onClick={() => setPasswordOpen(true)}>
            {status.unattendedPasswordSet ? 'Change / remove' : 'Set password'}
          </Button>
        </Row>
        <Row title='Unattended sessions may' hint='What someone connecting with the password can do.'>
          <Choice<RemotePermission>
            value={s.unattendedPermission}
            options={[
              { value: 'control', label: 'Control keyboard and mouse' },
              { value: 'view', label: 'View only' }
            ]}
            onChange={v => void update({ unattendedPermission: v })}
            width={260}
          />
        </Row>
        <Typography variant='caption' color='text.secondary' sx={{ pt: 1.5 }}>
          Wrong passwords are throttled: after 3 failures a device waits 30 s, doubling up to 15 min, and more than 20 failures a minute from anywhere pause all attempts for a minute.
        </Typography>
      </Section>

      <Section
        title='Lock screen access (Windows)'
        subtitle='Lets a full-control session see this computer’s lock screen and unlock it (type the Windows password or PIN), and keeps the picture working when another remote tool locks the screen — without AnyDesk.'
      >
        {status.secureAgent === 'unsupported' ? (
          <Typography variant='body2' color='text.secondary' sx={{ py: 1.5 }}>
            Windows only. macOS and Linux do not allow remote apps to use the lock screen; the viewer shows that the computer is locked, and the picture returns after someone unlocks it.
          </Typography>
        ) : (
          <>
            <Row
              title={status.secureAgent === 'running' ? 'On' : 'Off'}
              hint='Installs a small SYSTEM agent (like AnyDesk’s service) once, with an administrator prompt. It acts only while this computer is locked and never on UAC prompts or an unlocked desktop.'
            >
              {status.secureAgent === 'running' ? (
                <Button size='small' color='error' disabled={agentBusy} onClick={() => void agent(false)}>
                  Remove
                </Button>
              ) : (
                <Button size='small' variant='contained' disabled={agentBusy} onClick={() => void agent(true)}>
                  {agentBusy ? 'Waiting for approval…' : 'Turn on'}
                </Button>
              )}
            </Row>
            <Typography variant='caption' color='text.secondary' sx={{ pt: 1 }}>
              Works once someone has signed in to Windows (the app runs in that session). After a restart, sign in once — or enable automatic sign-in — before connecting.
            </Typography>
          </>
        )}
      </Section>

      <Section
        title='Devices that used the unattended password'
        subtitle='Revoke one to block it (even with the password) and end its sessions.'
        action={
          status.authorized.length || status.unattendedPasswordSet ? (
            <Button color='error' startIcon={<GppMaybeOutlined />} onClick={() => void act(api.revokeAll(), 'All unattended access revoked')}>
              Revoke all
            </Button>
          ) : undefined
        }
      >
        {!status.authorized.length && (
          <Typography variant='body2' color='text.secondary' sx={{ py: 2 }}>
            None yet.
          </Typography>
        )}
        {status.authorized.map(d => (
          <Row key={d.id} title={`${d.name} · ${d.id}`} hint={`Last connected ${timeAgo(d.lastSeen)} · key ${d.fingerprint}`}>
            <Button size='small' color='error' variant='outlined' onClick={() => void act(api.revokeDevice(d.id), `${d.name} revoked`)}>
              Revoke
            </Button>
          </Row>
        ))}
      </Section>

      <Section title='Blocked devices' subtitle='These cannot connect or send requests.'>
        {!status.blocked.length && (
          <Typography variant='body2' color='text.secondary' sx={{ py: 2 }}>
            None.
          </Typography>
        )}
        {status.blocked.map(d => (
          <Row key={d.id} title={`${d.name} · ${d.id}`} hint={`Blocked ${timeAgo(d.firstSeen)}`}>
            <Button size='small' onClick={() => void act(api.unblockDevice(d.id))}>
              Unblock
            </Button>
          </Row>
        ))}
      </Section>

      <Section title='How sessions are protected'>
        <Box component='ul' sx={{ m: 0, pl: 2.5, '& li': { fontSize: 13, color: 'text.secondary', mb: 0.5 } }}>
          <li>Every computer has its own Ed25519 key; the device ID is derived from it, and the key is pinned on the first connection.</li>
          <li>Each connection uses a fresh X25519 key exchange and AES-256-GCM with replay protection; video and input use WebRTC (DTLS-SRTP) negotiated over that channel.</li>
          <li>Passwords are never sent or stored: the host keeps an Argon2id hash; the client proves it knows the password for that one connection.</li>
          <li>Permission, time limits and revocation are enforced on this computer, not by the viewer. A bar at the top of the screen shows whenever this computer is shared.</li>
        </Box>
      </Section>

      <PasswordDialog open={passwordOpen} hasPassword={status.unattendedPasswordSet} onClose={() => setPasswordOpen(false)} />
    </Stack>
  )
}

export default SecurityTab
