import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Slider,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import { CropFreeOutlined, DesktopWindowsOutlined, FiberManualRecord, MicOutlined } from '@mui/icons-material'
import type { AudioSource, DisplayInfo, RecorderSettings, RecordingKind, StorageInfo } from '@shared/types/recorder'
import { wantsMic, wantsSystemAudio } from '@shared/utils/recorder'
import { useMediaDevices, useMicLevel } from '../hooks'
import AudioLevelMeter from './AudioLevelMeter'

const TITLES: Record<RecordingKind, string> = { screen: 'Record Screen', webcam: 'Record Webcam', audio: 'Record Audio' }

const AUDIO_OPTIONS: Record<RecordingKind, { id: AudioSource; label: string; hint: string }[]> = {
  screen: [
    { id: 'system', label: 'System audio', hint: 'Sound from this computer: meetings, browser, apps' },
    { id: 'mic', label: 'Microphone', hint: 'Your voice' },
    { id: 'system+mic', label: 'System + Microphone', hint: 'Both, mixed' },
    { id: 'none', label: 'No audio', hint: 'Video only' }
  ],
  webcam: [
    { id: 'mic', label: 'Microphone', hint: 'Your voice' },
    { id: 'none', label: 'No audio', hint: 'Video only' }
  ],
  audio: [
    { id: 'system', label: 'System audio', hint: 'Sound from this computer' },
    { id: 'mic', label: 'Microphone', hint: 'Your voice' },
    { id: 'system+mic', label: 'System + Microphone', hint: 'Both, mixed' }
  ]
}

export interface StartChoice {
  kind: RecordingKind
  audio: AudioSource
  areaMode: 'display' | 'region'
  displayId: string | null
  micDeviceId: string | null
  cameraDeviceId: string | null
  webcamOverlay: boolean
}

interface Props {
  kind: RecordingKind | null
  settings: RecorderSettings
  storage: StorageInfo | null
  busy: boolean
  error: string | null
  onClose: () => void
  onStart: (choice: StartChoice) => void
  onSaveDefaults: (patch: Partial<RecorderSettings>) => void
}

const NewRecordingDialog = ({ kind, settings, storage, busy, error, onClose, onStart, onSaveDefaults }: Props) => {
  const open = kind !== null
  const k: RecordingKind = kind ?? 'screen'
  const defaultAudio = (): AudioSource => {
    const options = AUDIO_OPTIONS[k].map(o => o.id)
    // System audio is the default for screen and audio recordings.
    return options.includes(settings.defaultAudioSource) ? settings.defaultAudioSource : (options[0] ?? 'none')
  }
  const [audio, setAudio] = useState<AudioSource>(defaultAudio)
  const [areaMode, setAreaMode] = useState(settings.areaMode)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [displayId, setDisplayId] = useState<string | null>(null)
  const [micId, setMicId] = useState<string | null>(settings.micDeviceId)
  const [camId, setCamId] = useState<string | null>(settings.cameraDeviceId)
  const [overlay, setOverlay] = useState(settings.webcamOverlay)
  const [volume, setVolume] = useState(settings.micVolume)

  // Reset to the saved defaults each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setAudio(defaultAudio())
    setAreaMode(settings.areaMode)
    setMicId(settings.micDeviceId)
    setCamId(settings.cameraDeviceId)
    setOverlay(settings.webcamOverlay)
    setVolume(settings.micVolume)
    void window.printAgent.recorder.listDisplays().then(r => {
      if (!r.ok) return
      setDisplays(r.value)
      setDisplayId(r.value.find(d => d.primary)?.id ?? r.value[0]?.id ?? null)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, k])

  const needMic = open && (wantsMic(audio) || (k === 'webcam' && audio !== 'none'))
  const needCam = open && (k === 'webcam' || (k === 'screen' && overlay))
  const devices = useMediaDevices(needMic && needCam ? 'both' : needMic ? 'audio' : needCam ? 'video' : null)
  const { level, error: micError } = useMicLevel(needMic, micId, volume)

  // Live camera preview for webcam recordings.
  const preview = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (!open || k !== 'webcam') return
    let stream: MediaStream | null = null
    let stopped = false
    void navigator.mediaDevices
      .getUserMedia({ video: camId ? { deviceId: { exact: camId } } : true, audio: false })
      .then(s => {
        if (stopped) return s.getTracks().forEach(t => t.stop())
        stream = s
        if (preview.current) preview.current.srcObject = s
      })
      .catch(() => undefined)
    return () => {
      stopped = true
      stream?.getTracks().forEach(t => t.stop())
    }
  }, [open, k, camId])

  const systemUnsupported = wantsSystemAudio(audio) && storage && !storage.systemAudio.supported
  const start = () =>
    onStart({ kind: k, audio, areaMode, displayId, micDeviceId: micId, cameraDeviceId: camId, webcamOverlay: k === 'screen' && overlay })

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth='sm' fullWidth>
      <DialogTitle>{TITLES[k]}</DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ pt: 1 }}>
          {k === 'screen' && (
            <Box>
              <Typography variant='subtitle2' sx={{ mb: 1 }}>
                What to record
              </Typography>
              <ToggleButtonGroup exclusive fullWidth value={areaMode} onChange={(_e, v: 'display' | 'region' | null) => v && setAreaMode(v)}>
                <ToggleButton value='display' sx={{ gap: 1 }}>
                  <DesktopWindowsOutlined fontSize='small' /> Full screen
                </ToggleButton>
                <ToggleButton value='region' sx={{ gap: 1 }}>
                  <CropFreeOutlined fontSize='small' /> Custom region
                </ToggleButton>
              </ToggleButtonGroup>
              {areaMode === 'display' && displays.length > 1 && (
                <FormControl fullWidth size='small' sx={{ mt: 2 }}>
                  <InputLabel>Display</InputLabel>
                  <Select label='Display' value={displayId ?? ''} onChange={e => setDisplayId(e.target.value)}>
                    {displays.map(d => (
                      <MenuItem key={d.id} value={d.id}>
                        {d.label} — {d.bounds.width}×{d.bounds.height} @{d.scaleFactor}x{d.primary ? ' (main)' : ''}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
              {areaMode === 'region' && (
                <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 1 }}>
                  After Start, drag over any display to choose the area. You can move and resize it before recording.
                </Typography>
              )}
            </Box>
          )}

          {k === 'webcam' && (
            <Box>
              <Box sx={{ borderRadius: 2, overflow: 'hidden', bgcolor: '#000', aspectRatio: '16 / 9', mb: 2 }}>
                <video ref={preview} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
              </Box>
            </Box>
          )}

          {needCam && (
            <FormControl fullWidth size='small'>
              <InputLabel>Camera</InputLabel>
              <Select label='Camera' value={camId ?? ''} displayEmpty onChange={e => setCamId(e.target.value || null)}>
                <MenuItem value=''>Default camera</MenuItem>
                {devices.cameras.map(d => (
                  <MenuItem key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Camera'}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}

          <Box>
            <Typography variant='subtitle2' sx={{ mb: 1 }}>
              Audio
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 1 }}>
              {AUDIO_OPTIONS[k].map(o => (
                <Box
                  key={o.id}
                  role='radio'
                  aria-checked={audio === o.id}
                  tabIndex={0}
                  onClick={() => setAudio(o.id)}
                  onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setAudio(o.id)}
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    cursor: 'pointer',
                    border: '1.5px solid',
                    borderColor: audio === o.id ? 'primary.main' : 'divider',
                    bgcolor: audio === o.id ? 'var(--mui-palette-primary-lighterOpacity)' : 'transparent'
                  }}
                >
                  <Typography variant='body2' sx={{ fontWeight: 600 }}>
                    {o.label}
                    {o.id === 'system' && k !== 'webcam' ? ' (default)' : ''}
                  </Typography>
                  <Typography variant='caption' color='text.secondary'>
                    {o.hint}
                  </Typography>
                </Box>
              ))}
            </Box>
            {systemUnsupported && (
              <Alert severity='warning' sx={{ mt: 1.5 }}>
                {storage?.systemAudio.reason}
              </Alert>
            )}
            {wantsSystemAudio(audio) && storage?.platform === 'linux' && storage.systemAudio.reason && (
              <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 1 }}>
                {storage.systemAudio.reason}
              </Typography>
            )}
          </Box>

          {needMic && (
            <Box>
              <FormControl fullWidth size='small'>
                <InputLabel>Microphone</InputLabel>
                <Select label='Microphone' value={micId ?? ''} displayEmpty onChange={e => setMicId(e.target.value || null)}>
                  <MenuItem value=''>System default microphone</MenuItem>
                  {devices.microphones.map(d => (
                    <MenuItem key={d.deviceId} value={d.deviceId}>
                      {d.label || 'Microphone'}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Stack direction='row' spacing={2} alignItems='center' sx={{ mt: 2 }}>
                <MicOutlined fontSize='small' color='action' />
                <Box sx={{ flex: 1 }}>
                  <AudioLevelMeter level={level} />
                </Box>
              </Stack>
              <Typography variant='caption' color={micError ? 'error' : 'text.secondary'}>
                {micError ?? 'Speak to test the microphone — the bar should move.'}
              </Typography>
              <Stack direction='row' spacing={2} alignItems='center' sx={{ mt: 1 }}>
                <Typography variant='body2' sx={{ minWidth: 120 }}>
                  Mic volume {volume}%
                </Typography>
                <Slider
                  size='small'
                  min={0}
                  max={200}
                  step={5}
                  value={volume}
                  onChange={(_e, v) => setVolume(v)}
                  onChangeCommitted={(_e, v) => onSaveDefaults({ micVolume: v })}
                  aria-label='Microphone volume'
                />
              </Stack>
            </Box>
          )}

          {k === 'screen' && (
            <FormControlLabel
              control={<Switch checked={overlay} onChange={e => setOverlay(e.target.checked)} />}
              label={
                <Box>
                  <Typography variant='body2'>Show webcam overlay</Typography>
                  <Typography variant='caption' color='text.secondary'>
                    A round camera bubble in the {settings.overlayCorner.replace('-', ' ')} corner, included in the video. Drag or resize it while recording.
                  </Typography>
                </Box>
              }
            />
          )}

          {devices.error && (needMic || needCam) && (
            <Alert
              severity='error'
              action={
                <Button color='inherit' size='small' onClick={() => void window.printAgent.recorder.openPrivacy(needCam ? 'camera' : 'microphone')}>
                  Open settings
                </Button>
              }
            >
              {devices.error}
            </Alert>
          )}
          {storage && !storage.ffmpeg.found && <Alert severity='error'>ffmpeg was not found, so recordings cannot be saved. See Recorder → Settings.</Alert>}
          {error && <Alert severity='error'>{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant='contained'
          color='error'
          startIcon={<FiberManualRecord />}
          disabled={busy || !!systemUnsupported || (storage !== null && !storage.ffmpeg.found)}
          onClick={start}
        >
          {busy ? 'Starting…' : k === 'screen' && areaMode === 'region' ? 'Select region' : 'Start recording'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default NewRecordingDialog
