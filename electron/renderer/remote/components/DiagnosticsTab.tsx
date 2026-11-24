import { useState } from 'react'
import { Alert, Box, Button, Chip, Stack, TextField, Typography } from '@mui/material'
import type { RemoteStatus } from '@shared/types/remote'
import { Code, Row, Section } from '../../screenshot/components/ui'

interface CodecSupport {
  mime: string
  send: boolean
  receive: boolean
  hardware: boolean | null
}

/** Supported codecs and whether the encoder is hardware-backed (power-efficient), measured in this window. */
const probeCodecs = async (): Promise<CodecSupport[]> => {
  const send = RTCRtpSender.getCapabilities('video')?.codecs.map(c => c.mimeType) ?? []
  const receive = RTCRtpReceiver.getCapabilities('video')?.codecs.map(c => c.mimeType) ?? []
  const out: CodecSupport[] = []
  for (const [mime, contentType] of [
    ['video/H264', 'video/mp4; codecs="avc1.640028"'],
    ['video/VP9', 'video/webm; codecs="vp09.00.10.08"'],
    ['video/AV1', 'video/mp4; codecs="av01.0.08M.08"'],
    ['video/VP8', 'video/webm; codecs="vp8"']
  ] as const) {
    let hardware: boolean | null = null
    try {
      const info = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType: mime, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 60 } })
      hardware = info.supported ? info.powerEfficient : null
    } catch {
      void contentType
    }
    out.push({ mime: mime.replace('video/', ''), send: send.includes(mime), receive: receive.includes(mime), hardware })
  }
  return out
}

/** Permissions, network, codec support, and a "can I reach that computer?" test. */
const DiagnosticsTab = ({ status }: { status: RemoteStatus }) => {
  const api = window.printAgent.remote
  const [report, setReport] = useState<Record<string, unknown> | null>(null)
  const [codecs, setCodecs] = useState<CodecSupport[] | null>(null)
  const [target, setTarget] = useState('')
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const platform = status.identity.platform
  const p = status.permissions

  const run = async () => {
    setBusy(true)
    const r = await api.diagnostics()
    if (r.ok) setReport(r.value)
    setCodecs(await probeCodecs())
    setBusy(false)
  }

  const test = async () => {
    setProbe(null)
    const r = await api.probe(target.trim())
    if (!r.ok) return setProbe({ ok: false, text: r.error })
    const v = r.value
    setProbe({
      ok: true,
      text: `${v.name} (${v.id}) · ${v.os}\nReached via ${v.route} — secure handshake in ${v.ms} ms\nAccepts requests: ${v.attended ? 'yes' : 'no'} · Unattended: ${v.unattended ? 'yes' : 'no'}${v.busy ? ' · busy (in a session)' : ''}\nKey fingerprint: ${v.fingerprint}`
    })
  }

  const chip = (state: string) => <Chip size='small' variant='tonal' color={state === 'granted' ? 'success' : state === 'unknown' || state === 'not-determined' ? 'warning' : 'error'} label={state} />

  return (
    <Stack spacing={3}>
      <Section title='Permissions on this computer' subtitle='Needed for others to see and control this computer.'>
        <Row title='Screen recording' hint={platform === 'darwin' ? 'macOS → Privacy & Security → Screen & System Audio Recording' : 'Not needed on this system.'}>
          {chip(p.screen)}
          {platform === 'darwin' && (
            <Button size='small' onClick={() => void api.openPrivacy('screen')}>
              Open settings
            </Button>
          )}
        </Row>
        <Row title='Keyboard and mouse control' hint={p.inputDetail ?? (platform === 'darwin' ? 'macOS → Privacy & Security → Accessibility' : platform === 'linux' ? 'X11 sessions only; Wayland allows view only.' : 'Works for normal windows; not for admin windows or the secure desktop.')}>
          {chip(p.input)}
          {platform === 'darwin' && p.input !== 'granted' && (
            <>
              <Button size='small' onClick={() => void api.requestAccessibility()}>
                Ask macOS
              </Button>
              <Button size='small' onClick={() => void api.openPrivacy('accessibility')}>
                Open settings
              </Button>
            </>
          )}
        </Row>
      </Section>

      <Section title='Reach another computer' subtitle='Checks the network path and the secure handshake, without logging in.'>
        <Stack direction='row' spacing={1} sx={{ py: 1.5 }}>
          <TextField size='small' placeholder='8-digit ID, e.g. 19304289' value={target} onChange={e => setTarget(e.target.value)} sx={{ flex: 1 }} />
          <Button variant='outlined' disabled={!target.trim()} onClick={() => void test()}>
            Test
          </Button>
        </Stack>
        {probe && (
          <Alert severity={probe.ok ? 'success' : 'error'} sx={{ whiteSpace: 'pre-line' }}>
            {probe.text}
          </Alert>
        )}
      </Section>

      <Section
        title='Connection diagnostics'
        action={
          <Button variant='contained' disabled={busy} onClick={() => void run()}>
            {busy ? 'Checking…' : 'Run diagnostics'}
          </Button>
        }
      >
        {report ? (
          <Box sx={{ pt: 1 }}>
            <Code>{Object.entries(report).map(([k, v]) => `${k.padEnd(18)} ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('\n')}</Code>
          </Box>
        ) : (
          <Typography variant='body2' color='text.secondary' sx={{ py: 2 }}>
            Shows the listening port, discovery, relay, permissions, displays and video codec support.
          </Typography>
        )}
        {codecs && (
          <Box sx={{ pt: 2 }}>
            <Typography variant='body2' sx={{ fontWeight: 600, mb: 1 }}>
              Video codecs (1080p60 for WebRTC)
            </Typography>
            <Code>{codecs.map(c => `${c.mime.padEnd(6)} send ${c.send ? 'yes' : 'no '}  receive ${c.receive ? 'yes' : 'no '}  hardware ${c.hardware === null ? 'unknown' : c.hardware ? 'yes' : 'no'}`).join('\n')}</Code>
          </Box>
        )}
      </Section>

      <Section title='Firewall'>
        <Typography variant='body2' color='text.secondary' sx={{ py: 1.5 }}>
          Other computers must reach TCP port {status.settings.port} (sessions) and UDP port {status.settings.port + 1} (discovery) on this computer, plus the WebRTC media ports (UDP, chosen
          automatically). Windows asks once when the app first listens — choose “Private networks”.
        </Typography>
        {platform !== 'linux' && (
          <Stack direction='row'>
            <Button size='small' onClick={() => void api.openPrivacy('firewall')}>
              Open firewall settings
            </Button>
          </Stack>
        )}
      </Section>
    </Stack>
  )
}

export default DiagnosticsTab
