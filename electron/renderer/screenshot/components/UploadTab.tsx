import { useState, type ReactNode } from 'react'
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, IconButton, Link, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material'
import { Add, CheckCircle, Close } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { ApiConfig, GoogleDriveConfig, S3Config, ScreenshotEnvironment, UploadProvider, UploadSettings } from '@shared/types/screenshot'
import { Choice, Code, Row, Section } from './ui'

const PROVIDERS: { value: UploadProvider; label: string }[] = [
  { value: 'none', label: 'Off' },
  { value: 's3', label: 'S3 (Amazon, Cloudflare R2, Backblaze, …)' },
  { value: 'google-drive', label: 'Google Drive' },
  { value: 'api', label: 'Your own API (HTTP POST)' }
]

const Field = ({ label, value, onChange, placeholder, type, helper, width = 360 }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; helper?: ReactNode; width?: number }) => (
  <Row title={label} hint={helper}>
    <TextField size='small' value={value} type={type} placeholder={placeholder} onChange={e => onChange(e.target.value)} sx={{ width }} autoComplete='off' slotProps={{ htmlInput: { spellCheck: false } }} />
  </Row>
)

// ── S3 ──────────────────────────────────────────────────────────────────────

const S3Form = ({ s3, set }: { s3: S3Config; set: (patch: Partial<S3Config>) => void }) => (
  <>
    <Field label='Access key' value={s3.accessKeyId} onChange={accessKeyId => set({ accessKeyId })} />
    <Field label='Secret key' type='password' value={s3.secretAccessKey} onChange={secretAccessKey => set({ secretAccessKey })} helper='Stored encrypted on this computer.' />
    <Field label='Bucket' value={s3.bucket} onChange={bucket => set({ bucket })} />
    <Row title='Service'>
      <RadioGroup row value={s3.service} onChange={e => set({ service: e.target.value as S3Config['service'] })}>
        <FormControlLabel value='aws' control={<Radio size='small' />} label='Amazon (AWS)' />
        <FormControlLabel value='other' control={<Radio size='small' />} label='Other' sx={{ mr: 0 }} />
      </RadioGroup>
    </Row>
    {s3.service === 'other' && (
      <Field
        label='Endpoint'
        value={s3.endpoint}
        onChange={endpoint => set({ endpoint })}
        placeholder='https://<account>.r2.cloudflarestorage.com'
        helper='Cloudflare R2: https://<account id>.r2.cloudflarestorage.com · Backblaze: https://s3.<region>.backblazeb2.com'
      />
    )}
    <Field label='Region' value={s3.region} onChange={region => set({ region })} placeholder='us-east-1' helper={s3.service === 'other' ? '“auto” for Cloudflare R2.' : undefined} />
    <Field label='Key prefix (path)' value={s3.keyPrefix} onChange={keyPrefix => set({ keyPrefix })} placeholder='Optional, e.g. screenshots/' />
    <Row title='Link sharing' hint={s3.linkSharing === 'presigned' ? 'A private link that works for a limited time, even on a private bucket.' : undefined}>
      <Choice
        width={360}
        value={s3.linkSharing}
        options={[
          { value: 'public', label: 'Generate public bucket URL' },
          { value: 'presigned', label: 'Generate presigned (expiring) URL' },
          { value: 'none', label: 'No link' }
        ]}
        onChange={linkSharing => set({ linkSharing })}
      />
    </Row>
    {s3.linkSharing === 'public' && (
      <Field label='Public bucket URL' value={s3.publicBaseUrl} onChange={publicBaseUrl => set({ publicBaseUrl })} placeholder='https://cdn.example.com' helper='Will only work if your bucket is public. Empty: the bucket’s own address.' />
    )}
    {s3.linkSharing === 'presigned' && (
      <Row title='Link valid for'>
        <Choice
          width={360}
          value={s3.presignHours}
          options={[
            { value: 1, label: '1 hour' },
            { value: 24, label: '1 day' },
            { value: 72, label: '3 days' },
            { value: 168, label: '7 days (longest S3 allows)' }
          ]}
          onChange={presignHours => set({ presignHours })}
        />
      </Row>
    )}
  </>
)

// ── Google Drive ────────────────────────────────────────────────────────────

const GoogleForm = ({ google, set, dirty, onConnected }: { google: GoogleDriveConfig; set: (patch: Partial<GoogleDriveConfig>) => void; dirty: boolean; onConnected: () => void }) => {
  const api = window.printAgent.screenshot
  const [connecting, setConnecting] = useState(false)

  const connect = async () => {
    setConnecting(true)
    const r = await api.googleConnect()
    setConnecting(false)
    if (r.ok) {
      toast.success(`Connected as ${r.value.email}`)
      onConnected()
    } else toast.error(r.error, { duration: 8000 })
  }
  const disconnect = async () => {
    const r = await api.googleDisconnect()
    if (!r.ok) toast.error(r.error)
    onConnected()
  }

  return (
    <>
      <Box sx={{ py: 2 }}>
        <Typography variant='body2' sx={{ fontWeight: 600, mb: 1 }}>
          One-time setup (about 3 minutes)
        </Typography>
        <Box component='ol' sx={{ m: 0, pl: 2.5, '& li': { fontSize: 13, color: 'text.secondary', mb: 0.5 } }}>
          <li>
            Open{' '}
            <Link href='https://console.cloud.google.com/apis/library/drive.googleapis.com' target='_blank' rel='noreferrer'>
              Google Cloud Console → Google Drive API
            </Link>{' '}
            and click <b>Enable</b> (create a project if asked).
          </li>
          <li>
            In{' '}
            <Link href='https://console.cloud.google.com/auth/overview' target='_blank' rel='noreferrer'>
              Google Auth Platform
            </Link>
            , set up the consent screen (External), and add your Google address under <b>Audience → Test users</b>.
          </li>
          <li>
            Under{' '}
            <Link href='https://console.cloud.google.com/apis/credentials' target='_blank' rel='noreferrer'>
              Credentials
            </Link>
            , <b>Create credentials → OAuth client ID</b>, type <b>Desktop app</b>.
          </li>
          <li>Paste its Client ID and Client secret below, Save, then Connect.</li>
        </Box>
        <Typography variant='caption' color='text.secondary' component='div' sx={{ mt: 1 }}>
          The app only asks for the <code>drive.file</code> scope: it can see and change the files it uploads, nothing else in your Drive. While the consent screen is in “Testing”, Google signs you out
          after 7 days — publish it (no review is needed for this scope) to stay connected.
        </Typography>
      </Box>
      <Field label='Client ID' value={google.clientId} onChange={clientId => set({ clientId })} placeholder='…apps.googleusercontent.com' />
      <Field label='Client secret' type='password' value={google.clientSecret} onChange={clientSecret => set({ clientSecret })} helper='Stored encrypted on this computer.' />
      <Field label='Folder in My Drive' value={google.folderName} onChange={folderName => set({ folderName })} helper='Created on the first upload.' />
      <Row title='Sharing'>
        <FormControlLabel control={<Checkbox size='small' checked={google.makePublic} onChange={e => set({ makePublic: e.target.checked })} />} label='Anyone with the link can view' sx={{ mr: 0 }} />
      </Row>
      <Row title='Google account' hint={google.account ? `${google.account.name ? `${google.account.name} · ` : ''}${google.account.email}` : 'Opens your browser to sign in and allow access.'}>
        {google.account ? (
          <>
            <CheckCircle color='success' fontSize='small' />
            <Typography variant='body2' sx={{ mr: 1 }}>
              Connected
            </Typography>
            <Button size='small' color='error' onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button
            variant='contained'
            size='small'
            disabled={connecting || dirty || !google.clientId || !google.clientSecret}
            onClick={() => void connect()}
            startIcon={connecting ? <CircularProgress size={14} color='inherit' /> : undefined}
          >
            {connecting ? 'Waiting for the browser…' : dirty ? 'Save first' : 'Connect Google account'}
          </Button>
        )}
      </Row>
    </>
  )
}

// ── your own API ────────────────────────────────────────────────────────────

const multipartExample = (api: ApiConfig): string => `${api.method} ${api.url || 'https://your-server.example.com/upload'}
Content-Type: multipart/form-data; boundary=…
${api.headers.map(h => `${h.name}: ${h.name.toLowerCase() === 'authorization' ? '•••' : h.value}`).join('\n')}${api.headers.length ? '\n' : ''}
Fields:
  ${api.fileField.padEnd(12)}  the image file (Content-Type image/png or image/jpeg)
  fileName      "Screenshot 2026-11-20 at 12.14.33.png"
  mimeType      "image/png"
  width         1920
  height        1080
  capturedAt    "2026-11-20T06:44:33.000Z"
  source        "featured-app"`

const jsonExample = (api: ApiConfig): string => `${api.method} ${api.url || 'https://your-server.example.com/upload'}
Content-Type: application/json
${api.headers.map(h => `${h.name}: ${h.name.toLowerCase() === 'authorization' ? '•••' : h.value}`).join('\n')}${api.headers.length ? '\n' : ''}
{
  "${api.fileField}": "iVBORw0KGgoAAAANSUhEUgAA…",   // base64 of the image
  "fileName": "Screenshot 2026-11-20 at 12.14.33.png",
  "mimeType": "image/png",
  "width": 1920,
  "height": 1080,
  "capturedAt": "2026-11-20T06:44:33.000Z",
  "source": "featured-app"
}`

const responseExample = (path: string): string => {
  const parts = (path || 'url').split('.')
  const build = (i: number): string => {
    const part = parts[i]!
    const inner = i === parts.length - 1 ? '"https://files.example.com/abc123.png"' : build(i + 1)
    return /^\d+$/.test(part) ? `[ ${inner} ]` : `{ "${part}": ${inner} }`
  }
  return `HTTP/1.1 200 OK        (any 2xx)
Content-Type: application/json

${build(0)}

— or a plain-text body that is only the link:
https://files.example.com/abc123.png`
}

const ApiForm = ({ api, set }: { api: ApiConfig; set: (patch: Partial<ApiConfig>) => void }) => {
  const headers = api.headers
  return (
    <>
      <Field label='Upload URL' value={api.url} onChange={url => set({ url })} placeholder='https://your-server.example.com/upload' width={420} />
      <Row title='Method'>
        <RadioGroup row value={api.method} onChange={e => set({ method: e.target.value as ApiConfig['method'] })}>
          <FormControlLabel value='POST' control={<Radio size='small' />} label='POST' />
          <FormControlLabel value='PUT' control={<Radio size='small' />} label='PUT' sx={{ mr: 0 }} />
        </RadioGroup>
      </Row>
      <Row title='Body format'>
        <Choice
          width={360}
          value={api.bodyType}
          options={[
            { value: 'multipart', label: 'multipart/form-data (file upload)' },
            { value: 'json', label: 'application/json (base64 image)' }
          ]}
          onChange={bodyType => set({ bodyType })}
        />
      </Row>
      <Field label='Image field name' value={api.fileField} onChange={fileField => set({ fileField })} placeholder='file' />
      <Row title='Headers' hint='e.g. Authorization: Bearer <token>. Stored encrypted on this computer.' wide>
        <Stack spacing={1} sx={{ width: 420 }}>
          {headers.map((h, i) => (
            <Stack key={i} direction='row' spacing={1}>
              <TextField size='small' placeholder='Name' value={h.name} onChange={e => set({ headers: headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} sx={{ width: 150 }} />
              <TextField
                size='small'
                placeholder='Value'
                type={h.name.toLowerCase() === 'authorization' || /token|key|secret/i.test(h.name) ? 'password' : 'text'}
                value={h.value}
                onChange={e => set({ headers: headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                sx={{ flex: 1 }}
              />
              <IconButton size='small' onClick={() => set({ headers: headers.filter((_, j) => j !== i) })} aria-label='Remove header'>
                <Close fontSize='small' />
              </IconButton>
            </Stack>
          ))}
          <Box>
            <Button size='small' startIcon={<Add />} onClick={() => set({ headers: [...headers, { name: headers.length ? '' : 'Authorization', value: headers.length ? '' : 'Bearer ' }] })}>
              Add header
            </Button>
          </Box>
        </Stack>
      </Row>
      <Field label='Link in the response' value={api.urlPath} onChange={urlPath => set({ urlPath })} placeholder='url' helper='Dot path to the link in the JSON answer: url, data.link, files.0.url' />

      <Box sx={{ py: 2 }}>
        <Typography variant='body2' sx={{ fontWeight: 600, mb: 1 }}>
          What your API receives
        </Typography>
        <Code>{api.bodyType === 'json' ? jsonExample(api) : multipartExample(api)}</Code>
        <Typography variant='body2' sx={{ fontWeight: 600, mt: 2.5, mb: 1 }}>
          What it must answer
        </Typography>
        <Code>{responseExample(api.urlPath)}</Code>
        <Typography variant='caption' color='text.secondary' component='div' sx={{ mt: 1.5 }}>
          Any other status is shown as an error with the first 200 characters of the body. Requests time out after 2 minutes. The full contract, with a server example, is in{' '}
          <code>docs/SCREENSHOT_UPLOAD_API.md</code>.
        </Typography>
      </Box>
    </>
  )
}

// ── tab ─────────────────────────────────────────────────────────────────────

interface Props {
  upload: UploadSettings
  env: ScreenshotEnvironment
  onSave: (upload: UploadSettings) => Promise<string | null>
  onReload: () => void
}

const UploadTab = ({ upload, env, onSave, onReload }: Props) => {
  const api = window.printAgent.screenshot
  const [draft, setDraft] = useState<UploadSettings>(upload)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  // Saved (and normalised by the main process), or a Google sign-in changed the account: show what is stored.
  const saved = JSON.stringify(upload)
  const [syncedFrom, setSyncedFrom] = useState(saved)
  if (saved !== syncedFrom) {
    setSyncedFrom(saved)
    setDraft(upload)
  }

  const dirty = JSON.stringify({ ...draft, google: { ...draft.google, account: null } }) !== JSON.stringify({ ...upload, google: { ...upload.google, account: null } })

  const save = async (): Promise<boolean> => {
    setSaving(true)
    const error = await onSave(draft)
    setSaving(false)
    if (error) toast.error(error)
    return !error
  }

  const test = async () => {
    setResult(null)
    if (dirty && !(await save())) return
    setTesting(true)
    const r = await api.testUpload()
    setTesting(false)
    setResult(r.ok ? { ok: true, text: r.value } : { ok: false, text: r.error })
  }

  const setProvider = (provider: UploadProvider) => {
    setResult(null)
    setDraft(d => ({ ...d, provider }))
  }

  return (
    <Stack spacing={4}>
      {!env.encryption && (
        <Alert severity='warning'>This system has no keychain to encrypt saved keys with, so they are stored as plain text in the app’s settings folder.</Alert>
      )}
      <Section
        title='Image uploading & link sharing'
        subtitle='Upload from the editor (⌘U / Ctrl+U), the thumbnail, or after every screenshot (General → After screenshot). The link is copied when the upload finishes.'
        action={
          <Stack direction='row' spacing={1}>
            {draft.provider !== 'none' && (
              <Button size='small' variant='outlined' onClick={() => void test()} disabled={testing || saving} startIcon={testing ? <CircularProgress size={14} /> : undefined}>
                Test connection
              </Button>
            )}
            <Button size='small' variant='contained' onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </Button>
          </Stack>
        }
      >
        <Row title='Upload to'>
          <Choice width={360} value={draft.provider} options={PROVIDERS} onChange={setProvider} />
        </Row>
        {draft.provider !== 'none' && (
          <Row title='After upload'>
            <FormControlLabel control={<Checkbox size='small' checked={draft.copyLink} onChange={e => setDraft(d => ({ ...d, copyLink: e.target.checked }))} />} label='Copy the link to the clipboard' sx={{ mr: 0 }} />
          </Row>
        )}
        {draft.provider === 's3' && <S3Form s3={draft.s3} set={patch => setDraft(d => ({ ...d, s3: { ...d.s3, ...patch } }))} />}
        {draft.provider === 'google-drive' && (
          <GoogleForm google={draft.google} dirty={dirty} set={patch => setDraft(d => ({ ...d, google: { ...d.google, ...patch } }))} onConnected={onReload} />
        )}
        {draft.provider === 'api' && <ApiForm api={draft.api} set={patch => setDraft(d => ({ ...d, api: { ...d.api, ...patch } }))} />}
      </Section>
      {result && (
        <Alert severity={result.ok ? 'success' : 'error'} onClose={() => setResult(null)}>
          {result.text}
        </Alert>
      )}
    </Stack>
  )
}

export default UploadTab
