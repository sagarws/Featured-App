import { useState } from 'react'
import { Button, Stack, Switch, TextField, Typography } from '@mui/material'
import toast from 'react-hot-toast'
import { QUALITY_ORDER, QUALITY_PROFILES, SESSION_MINUTES } from '@shared/constants/remote'
import type { CodecPreference, IncomingFilePolicy, KeyboardMode, QualityPreset, QualityPriority, RemoteSettings, RemoteStatus } from '@shared/types/remote'
import { Choice, Row, Section } from '../../screenshot/components/ui'

/** Connection, quality, input, clipboard / files and network settings. */
const SettingsTab = ({ status }: { status: RemoteStatus }) => {
  const api = window.printAgent.remote
  const s = status.settings
  const [port, setPort] = useState(String(s.port))
  const [relay, setRelay] = useState(s.relay)
  const [turnUrl, setTurnUrl] = useState(s.turnUrl)
  const [turnUser, setTurnUser] = useState(s.turnUsername)
  const [turnSecret, setTurnSecret] = useState('')

  const update = async (patch: Partial<RemoteSettings>) => {
    const r = await api.updateSettings(patch)
    if (!r.ok) toast.error(r.error)
    return r.ok
  }

  const saveNetwork = async () => {
    const p = Number(port)
    if (!Number.isInteger(p) || p < 1024 || p > 65534) return toast.error('Use a port between 1024 and 65534.')
    const ok = await update({ port: p, relay: relay.trim(), turnUrl: turnUrl.trim(), turnUsername: turnUser.trim() })
    if (turnSecret) await api.setTurnCredential(turnSecret)
    if (ok) {
      setTurnSecret('')
      toast.success('Network settings saved')
    }
    const fresh = await api.getStatus()
    if (fresh.ok) {
      if (relay.trim() && !fresh.value.settings.relay) toast.error('The relay must be wss://name or host:port.')
      if (turnUrl.trim() && !fresh.value.settings.turnUrl) toast.error('The TURN/STUN URL must start with turn:, turns: or stun:.')
    }
  }

  return (
    <Stack spacing={3}>
      <Section title='Screen quality' subtitle='What you see when you connect to another computer. Can be changed during a session from the viewer toolbar.'>
        <Row title='Default quality' hint={QUALITY_PROFILES[s.defaultQuality].hint}>
          <Choice<QualityPreset> value={s.defaultQuality} options={QUALITY_ORDER.map(q => ({ value: q, label: `${QUALITY_PROFILES[q].label} — ${QUALITY_PROFILES[q].hint}` }))} onChange={v => void update({ defaultQuality: v })} width={300} />
        </Row>
        <Row title='When the network is slow' hint='Sharp text keeps code and terminals readable; responsiveness keeps scrolling smooth.'>
          <Choice<QualityPriority>
            value={s.priority}
            options={[
              { value: 'readability', label: 'Keep text sharp (lower fps)' },
              { value: 'responsiveness', label: 'Keep it smooth (lower resolution)' }
            ]}
            onChange={v => void update({ priority: v })}
            width={300}
          />
        </Row>
        <Row title='Video codec' hint='Auto picks H.264 (hardware encoder on most PCs) with VP9 as fallback.'>
          <Choice<CodecPreference>
            value={s.codec}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'h264', label: 'H.264' },
              { value: 'vp9', label: 'VP9 (good for text, more CPU)' },
              { value: 'av1', label: 'AV1 (newest, most CPU)' }
            ]}
            onChange={v => void update({ codec: v })}
          />
        </Row>
        <Row title='Hardware acceleration' hint='Prefer the hardware video encoder/decoder where the computer has one (lower CPU and latency).'>
          <Switch checked={s.hardwareAcceleration} onChange={e => void update({ hardwareAcceleration: e.target.checked })} />
        </Row>
      </Section>

      <Section title='Keyboard and mouse' subtitle='How your keys reach the other computer.'>
        <Row title='Send shortcuts to the remote computer' hint='⌘W / Ctrl+W, ⌘Q, ⌘Tab-style shortcuts go to the remote computer while its screen has focus, not to this app.'>
          <Switch checked={s.sendShortcuts} onChange={e => void update({ sendShortcuts: e.target.checked })} />
        </Row>
        <Row title='Map ⌘ ↔ Ctrl between Mac and PC' hint='⌘C on a Mac copies on a Windows/Linux computer, and Ctrl+C on a PC copies on a Mac.'>
          <Switch checked={s.mapModifiers} onChange={e => void update({ mapModifiers: e.target.checked })} />
        </Row>
        <Row title='Keyboard mode' hint='Physical keys is best for coding and shortcuts (the remote layout applies). Characters types exactly what your layout shows.'>
          <Choice<KeyboardMode>
            value={s.keyboardMode}
            options={[
              { value: 'positional', label: 'Physical keys (recommended)' },
              { value: 'text', label: 'Characters (different layouts)' }
            ]}
            onChange={v => void update({ keyboardMode: v })}
            width={280}
          />
        </Row>
      </Section>

      <Section title='Clipboard and files' subtitle='What may move between this computer and the other one during a session.'>
        <Row title='Clipboard sharing' hint='Copied text goes both ways (never what was already on the clipboard before the session).'>
          <Switch checked={s.clipboardSync} onChange={e => void update({ clipboardSync: e.target.checked })} />
        </Row>
        <Row title='Files sent to this computer' hint='"Ask" shows a prompt for every transfer. Files are only saved — never opened or run.'>
          <Choice<IncomingFilePolicy>
            value={s.incomingFiles}
            options={[
              { value: 'ask', label: 'Ask me every time' },
              { value: 'trusted-folder', label: 'Accept into a trusted folder' },
              { value: 'off', label: 'Refuse all files' }
            ]}
            onChange={v => void update({ incomingFiles: v })}
            width={260}
          />
        </Row>
        {s.incomingFiles === 'trusted-folder' && (
          <Row title='Trusted folder' hint={s.trustedFolder || 'Downloads/Remote Transfers'}>
            <Button size='small' variant='outlined' onClick={() => void api.chooseTrustedFolder()}>
              Choose…
            </Button>
          </Row>
        )}
      </Section>

      <Section title='Sessions'>
        <Row title='Default session duration' hint='30 minutes unless you change it. Unattended sessions use this length.'>
          <Choice value={s.defaultMinutes} options={SESSION_MINUTES.map(m => ({ value: m.value, label: m.label }))} onChange={v => void update({ defaultMinutes: v })} />
        </Row>
      </Section>

      <Section title='Network' subtitle='On the office LAN nothing needs configuring: computers connect directly and no traffic leaves the network.'>
        <Row title='LAN discovery' hint={`Announce this computer and list the others on the same network (UDP port ${s.port + 1}).`}>
          <Switch checked={s.lanDiscovery} onChange={e => void update({ lanDiscovery: e.target.checked })} />
        </Row>
        <Row title='Port' hint='TCP port other computers connect to. Allow it (and the UDP port after it) in the firewall.'>
          <TextField size='small' value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ''))} sx={{ width: 120 }} />
        </Row>
        <Row
          title='Relay (other networks)'
          hint='Leave empty to use the built-in server. Or wss://name (Cloudflare Tunnel) or host:port of your own relay (tools/remote-relay). Sessions stay end-to-end encrypted.'
          wide
        >
          <TextField size='small' placeholder='wss://relay.example.com' value={relay} onChange={e => setRelay(e.target.value)} sx={{ width: 360 }} />
        </Row>
        <Row title='TURN / STUN server' hint='Optional, for video outside the office (self-hosted coturn). Example: turn:turn.example.com:3478' wide>
          <Stack spacing={1} sx={{ width: 360 }}>
            <TextField size='small' placeholder='turn:turn.example.com:3478' value={turnUrl} onChange={e => setTurnUrl(e.target.value)} />
            <Stack direction='row' spacing={1}>
              <TextField size='small' placeholder='Username' value={turnUser} onChange={e => setTurnUser(e.target.value)} />
              <TextField size='small' type='password' placeholder='Credential (kept encrypted)' value={turnSecret} onChange={e => setTurnSecret(e.target.value)} />
            </Stack>
          </Stack>
        </Row>
        <Stack direction='row' justifyContent='flex-end' sx={{ pt: 2 }}>
          <Button variant='contained' onClick={() => void saveNetwork()}>
            Save network settings
          </Button>
        </Stack>
        {(s.relay || s.turnUrl || status.server.relay !== 'off') && (
          <Typography variant='caption' color='text.secondary' sx={{ pt: 1 }}>
            Relay: {status.server.relay}
            {status.server.relayError ? ` (${status.server.relayError})` : ''}
          </Typography>
        )}
      </Section>
    </Stack>
  )
}

export default SettingsTab
