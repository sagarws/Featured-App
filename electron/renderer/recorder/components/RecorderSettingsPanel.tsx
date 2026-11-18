import type { ReactNode } from 'react'
import { Alert, Box, Button, FormControl, MenuItem, Paper, Select, Slider, Stack, Switch, Typography } from '@mui/material'
import toast from 'react-hot-toast'
import { FRAME_RATES, RESOLUTION_SIZE, RESOLUTIONS, SEGMENT_MINUTE_OPTIONS } from '@shared/constants/recorder'
import type { AudioSource, RecorderSettings, StorageInfo } from '@shared/types/recorder'
import { formatBytes } from '@shared/utils/recorder'
import { useMediaDevices } from '../hooks'

const Section = ({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) => (
  <Paper variant='outlined' sx={{ p: 4, borderRadius: 3 }}>
    <Typography variant='h6' sx={{ fontSize: 16, fontWeight: 600 }}>
      {title}
    </Typography>
    <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
      {subtitle}
    </Typography>
    <Stack divider={<Box sx={{ borderBlockEnd: '1px solid', borderColor: 'divider' }} />}>{children}</Stack>
  </Paper>
)

const Row = ({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) => (
  <Stack direction='row' alignItems='center' spacing={3} sx={{ py: 1.75 }}>
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography variant='body2' sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {hint && (
        <Typography variant='caption' color='text.secondary' component='div'>
          {hint}
        </Typography>
      )}
    </Box>
    <Box sx={{ flexShrink: 0, minWidth: 200, display: 'flex', justifyContent: 'flex-end' }}>{children}</Box>
  </Stack>
)

const Choice = <T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) => (
  <FormControl size='small' sx={{ minWidth: 200 }}>
    <Select value={value} onChange={e => onChange(options.find(o => String(o.value) === String(e.target.value))?.value ?? value)}>
      {options.map(o => (
        <MenuItem key={String(o.value)} value={o.value}>
          {o.label}
        </MenuItem>
      ))}
    </Select>
  </FormControl>
)

const AUDIO_SOURCES: { value: AudioSource; label: string }[] = [
  { value: 'system', label: 'System audio' },
  { value: 'mic', label: 'Microphone' },
  { value: 'system+mic', label: 'System + Microphone' },
  { value: 'none', label: 'No audio' }
]

interface Props {
  settings: RecorderSettings
  storage: StorageInfo | null
  onUpdate: (patch: Partial<RecorderSettings>) => Promise<string | null>
  onStorageChanged: () => void
}

const RecorderSettingsPanel = ({ settings, storage, onUpdate, onStorageChanged }: Props) => {
  const recorder = window.printAgent.recorder
  const devices = useMediaDevices(null)
  const set = (patch: Partial<RecorderSettings>) =>
    void onUpdate(patch).then(error => {
      if (error) toast.error(error)
    })

  const chooseDir = async () => {
    const r = await recorder.chooseOutputDir()
    if (!r.ok) toast.error(r.error)
    onStorageChanged()
  }
  const resetDir = async () => {
    const r = await recorder.resetOutputDir()
    if (!r.ok) toast.error(r.error)
    onStorageChanged()
  }

  return (
    <Stack spacing={4}>
      {storage && !storage.ffmpeg.found && (
        <Alert severity='error'>
          ffmpeg was not found. It is needed to save, split and join recordings. Install it (macOS: <code>brew install ffmpeg</code>, Windows: winget install
          ffmpeg) or set FFMPEG_PATH and FFPROBE_PATH. Packaged builds include it.
        </Alert>
      )}
      {storage?.platform === 'darwin' && storage.screenPermission !== 'granted' && (
        <Alert
          severity='warning'
          action={
            <Button color='inherit' size='small' onClick={() => void recorder.openPrivacy('screen')}>
              Open settings
            </Button>
          }
        >
          Screen Recording permission is {storage.screenPermission.replace('-', ' ')}. macOS asks the first time you record; after allowing it, restart the app.
        </Alert>
      )}

      <Section title='Video' subtitle='Quality and what a screen recording captures by default.'>
        <Row title='Resolution' hint='Upper limit; a smaller display is recorded at its own size. A custom region is recorded at full sharpness.'>
          <Choice value={settings.resolution} options={RESOLUTIONS.map(r => ({ value: r, label: RESOLUTION_SIZE[r].label }))} onChange={resolution => set({ resolution })} />
        </Row>
        <Row title='Frame rate'>
          <Choice value={settings.fps} options={FRAME_RATES.map(f => ({ value: f, label: `${f} FPS` }))} onChange={fps => set({ fps })} />
        </Row>
        <Row title='Default area'>
          <Choice
            value={settings.areaMode}
            options={[
              { value: 'display', label: 'Full screen' },
              { value: 'region', label: 'Custom region' }
            ]}
            onChange={areaMode => set({ areaMode })}
          />
        </Row>
        <Row title='Video format' hint='MP4 (H.264 + AAC) plays everywhere. MKV keeps the original audio untouched.'>
          <Choice
            value={settings.videoFormat}
            options={[
              { value: 'mp4', label: 'MP4' },
              { value: 'mkv', label: 'MKV' }
            ]}
            onChange={videoFormat => set({ videoFormat })}
          />
        </Row>
      </Section>

      <Section title='Audio' subtitle='Sources and microphone defaults.'>
        <Row title='Default audio source' hint='System audio records what this computer plays: meetings, browser, apps.'>
          <Choice value={settings.defaultAudioSource} options={AUDIO_SOURCES} onChange={defaultAudioSource => set({ defaultAudioSource })} />
        </Row>
        <Row title='Microphone'>
          <FormControl size='small' sx={{ minWidth: 200, maxWidth: 280 }}>
            <Select
              value={settings.micDeviceId ?? ''}
              displayEmpty
              onOpen={() => !devices.labelled && void devices.refresh('audio')}
              onChange={e => set({ micDeviceId: e.target.value || null })}
            >
              <MenuItem value=''>System default</MenuItem>
              {devices.microphones.map(d => (
                <MenuItem key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microphone'}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Row>
        <Row
          title='System audio device'
          hint={
            storage?.systemAudio.supported === false
              ? storage.systemAudio.reason
              : 'All sound sent to the system output is captured. Picking a single output device is not supported by the capture API.'
          }
        >
          <FormControl size='small' sx={{ minWidth: 200 }}>
            <Select value='default' disabled>
              <MenuItem value='default'>{storage?.systemAudio.supported === false ? 'Not available' : 'All system output'}</MenuItem>
            </Select>
          </FormControl>
        </Row>
        <Row title='Microphone volume' hint={`${settings.micVolume}%`}>
          <Slider
            size='small'
            sx={{ width: 200 }}
            min={0}
            max={200}
            step={5}
            defaultValue={settings.micVolume}
            key={settings.micVolume}
            onChangeCommitted={(_e, v) => set({ micVolume: v })}
            aria-label='Microphone volume'
          />
        </Row>
        <Row title='Audio quality'>
          <Choice
            value={settings.audioQuality}
            options={[
              { value: 'standard', label: 'Standard (128 kbps)' },
              { value: 'high', label: 'High (256 kbps)' }
            ]}
            onChange={audioQuality => set({ audioQuality })}
          />
        </Row>
      </Section>

      <Section title='Webcam overlay' subtitle='The camera bubble on screen recordings.'>
        <Row title='Show by default'>
          <Switch checked={settings.webcamOverlay} onChange={e => set({ webcamOverlay: e.target.checked })} />
        </Row>
        <Row title='Position'>
          <Choice
            value={settings.overlayCorner}
            options={[
              { value: 'bottom-right', label: 'Bottom right' },
              { value: 'bottom-left', label: 'Bottom left' },
              { value: 'top-right', label: 'Top right' },
              { value: 'top-left', label: 'Top left' }
            ]}
            onChange={overlayCorner => set({ overlayCorner })}
          />
        </Row>
        <Row title='Size'>
          <Choice
            value={settings.overlaySize}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'medium', label: 'Medium' },
              { value: 'large', label: 'Large' }
            ]}
            onChange={overlaySize => set({ overlaySize })}
          />
        </Row>
      </Section>

      <Section title='Storage and recovery' subtitle='Long recordings are written in parts so a crash never loses more than the part in progress.'>
        <Row title='Automatic segmentation' hint='Save the recording as it goes, in files of the length below.'>
          <Switch checked={settings.autoSegment} onChange={e => set({ autoSegment: e.target.checked })} />
        </Row>
        <Row title='Segment duration'>
          <Choice
            value={settings.segmentMinutes}
            options={SEGMENT_MINUTE_OPTIONS.map(m => ({ value: m, label: `${m} minutes${m === 30 ? ' (default)' : ''}` }))}
            onChange={segmentMinutes => set({ segmentMinutes })}
          />
        </Row>
        <Row title='Merge segments after stopping' hint='Join the parts into one file. Off: keep the parts and merge later from the library.'>
          <Switch checked={settings.autoMerge} onChange={e => set({ autoMerge: e.target.checked })} />
        </Row>
        <Row title='Keep segment files after merging' hint='Off: they are deleted once the merged file is verified.'>
          <Switch checked={settings.keepSegments} onChange={e => set({ keepSegments: e.target.checked })} />
        </Row>
        <Row title='Recover interrupted sessions' hint='Offer to recover a recording the app could not finish (crash, power cut).'>
          <Switch checked={settings.recoverInterrupted} onChange={e => set({ recoverInterrupted: e.target.checked })} />
        </Row>
        <Row
          title='Recording folder'
          hint={
            <>
              <Box component='span' sx={{ wordBreak: 'break-all' }}>
                {storage?.dir ?? '…'}
              </Box>
              <br />
              {storage?.freeBytes !== null && storage?.freeBytes !== undefined ? `${formatBytes(storage.freeBytes)} free` : 'Free space unknown'}
            </>
          }
        >
          <Stack direction='row' spacing={1}>
            {settings.outputDir && (
              <Button size='small' onClick={() => void resetDir()}>
                Default
              </Button>
            )}
            <Button size='small' variant='tonal' onClick={() => void chooseDir()}>
              Change…
            </Button>
          </Stack>
        </Row>
        <Row title='ffmpeg' hint={storage?.ffmpeg.found ? `${storage.ffmpeg.version ?? ''} — ${storage.ffmpeg.path ?? ''}` : 'Not found'}>
          <Typography variant='body2' color={storage?.ffmpeg.found ? 'success.main' : 'error.main'} sx={{ fontWeight: 600 }}>
            {storage?.ffmpeg.found ? 'Ready' : 'Missing'}
          </Typography>
        </Row>
      </Section>
    </Stack>
  )
}

export default RecorderSettingsPanel
