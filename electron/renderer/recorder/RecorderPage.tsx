import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Alert, Box, Button, ButtonBase, Paper, Stack, Tab, Tabs, Typography } from '@mui/material'
import { DesktopWindowsOutlined, GraphicEqOutlined, VideocamOutlined } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { RecordingKind, RecordingSummary, StorageInfo } from '@shared/types/recorder'
import { useRecorderSettings, useRecorderStatus } from './hooks'
import ActiveRecordingBanner from './components/ActiveRecordingBanner'
import NewRecordingDialog, { type StartChoice } from './components/NewRecordingDialog'
import RecorderSettingsPanel from './components/RecorderSettingsPanel'
import RecordingsLibrary from './components/RecordingsLibrary'
import RecoveryBanner from './components/RecoveryBanner'

const OPTIONS: { kind: RecordingKind; title: string; hint: string; icon: ReactNode; tone: 'error' | 'primary' | 'info' }[] = [
  { kind: 'screen', title: 'Record Screen', hint: 'Full screen or a custom region, with system audio', icon: <DesktopWindowsOutlined sx={{ fontSize: 28 }} />, tone: 'error' },
  { kind: 'webcam', title: 'Record Webcam', hint: 'Camera with your microphone', icon: <VideocamOutlined sx={{ fontSize: 28 }} />, tone: 'primary' },
  { kind: 'audio', title: 'Record Audio', hint: 'System audio, microphone, or both', icon: <GraphicEqOutlined sx={{ fontSize: 28 }} />, tone: 'info' }
]

/** Recorder dashboard: start a recording, recover interrupted ones, browse the library, settings. */
const RecorderPage = () => {
  const recorder = window.printAgent.recorder
  const status = useRecorderStatus()
  const { settings, update } = useRecorderSettings()
  const [tab, setTab] = useState<'record' | 'settings'>('record')
  const [dialog, setDialog] = useState<RecordingKind | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recordings, setRecordings] = useState<RecordingSummary[]>([])
  const [interrupted, setInterrupted] = useState<RecordingSummary[]>([])
  const [storage, setStorage] = useState<StorageInfo | null>(null)

  const refresh = useCallback(async () => {
    const [list, broken, info] = await Promise.all([recorder.list(), recorder.listInterrupted(), recorder.storageInfo()])
    if (list.ok) setRecordings(list.value)
    if (broken.ok) setInterrupted(broken.value)
    if (info.ok) setStorage(info.value)
  }, [recorder])

  useEffect(() => {
    void refresh()
    return recorder.onLibraryChanged(() => void refresh())
  }, [refresh, recorder])

  // Tell the user how the last recording ended.
  const last = status?.lastResult
  useEffect(() => {
    if (!last) return
    if (last.error && !last.file) toast.error(last.error, { id: last.sessionId, duration: 8000 })
    else if (last.file) toast.success(last.error ? `Saved. ${last.error}` : 'Recording saved.', { id: last.sessionId, duration: 6000 })
    else toast.success('Recording stopped. Its segments are in the library.', { id: last.sessionId })
    if (last.warning) toast(last.warning, { id: `${last.sessionId}-warning`, icon: '⚠️', duration: 15_000 })
  }, [last])

  const start = async (choice: StartChoice) => {
    setError(null)
    setDialog(null)
    setStarting(true)
    try {
      let area = choice.displayId ? ({ type: 'display', displayId: choice.displayId } as const) : undefined
      if (choice.kind === 'screen' && choice.areaMode === 'region') {
        const picked = await recorder.selectRegion()
        if (!picked.ok) throw new Error(picked.error)
        if (!picked.value) return
        area = picked.value as never
      }
      const result = await recorder.start({
        kind: choice.kind,
        audio: choice.audio,
        ...(choice.kind === 'screen' && area ? { area } : {}),
        micDeviceId: choice.micDeviceId,
        cameraDeviceId: choice.cameraDeviceId,
        webcamOverlay: choice.webcamOverlay
      })
      if (!result.ok) throw new Error(result.error)
      // Remember the choices for next time.
      void update({ micDeviceId: choice.micDeviceId, cameraDeviceId: choice.cameraDeviceId, ...(choice.kind === 'screen' ? { areaMode: choice.areaMode } : {}) })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
      void refresh()
    }
  }

  const live = !!status?.active || status?.phase === 'merging'

  return (
    <Stack spacing={4} sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Stack direction='row' alignItems='flex-end'>
        <Box sx={{ flex: 1 }}>
          <Typography variant='h4' sx={{ fontSize: 24, fontWeight: 700 }}>
            Recorder
          </Typography>
          <Typography color='text.secondary' sx={{ fontSize: 14, mt: 0.5 }}>
            Record your screen, webcam or audio. Long recordings are saved in parts as they go, so nothing is lost if the app closes.
          </Typography>
        </Box>
        <Tabs value={tab} onChange={(_e, v: 'record' | 'settings') => setTab(v)}>
          <Tab value='record' label='Recordings' />
          <Tab value='settings' label='Settings' />
        </Tabs>
      </Stack>

      {status && <ActiveRecordingBanner status={status} />}
      <RecoveryBanner sessions={interrupted} onChanged={() => void refresh()} />
      {error && (
        <Alert
          severity='error'
          onClose={() => setError(null)}
          action={
            /permission|access|privacy/i.test(error) && storage?.platform !== 'linux' ? (
              <Button color='inherit' size='small' onClick={() => void recorder.openPrivacy(/microphone/i.test(error) ? 'microphone' : /camera/i.test(error) ? 'camera' : /system audio/i.test(error) ? 'audio' : 'screen')}>
                Open settings
              </Button>
            ) : undefined
          }
        >
          {error}
        </Alert>
      )}

      {tab === 'record' && (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' }, gap: 3 }}>
            {OPTIONS.map(o => (
              <Paper key={o.kind} variant='outlined' sx={{ borderRadius: 3, overflow: 'hidden', opacity: live || starting ? 0.6 : 1 }}>
                <ButtonBase
                  disabled={live || starting || !settings}
                  onClick={() => setDialog(o.kind)}
                  sx={{ width: '100%', p: 4, flexDirection: 'column', alignItems: 'flex-start', gap: 2, textAlign: 'start', '&:hover': { bgcolor: 'action.hover' } }}
                >
                  <Box sx={{ width: 52, height: 52, borderRadius: '50%', display: 'grid', placeItems: 'center', color: `${o.tone}.main`, bgcolor: `var(--mui-palette-${o.tone}-lightOpacity)` }}>
                    {o.icon}
                  </Box>
                  <Box>
                    <Typography sx={{ fontWeight: 600, fontSize: 16, color: 'text.primary' }}>{o.title}</Typography>
                    <Typography variant='body2' color='text.secondary'>
                      {o.hint}
                    </Typography>
                  </Box>
                </ButtonBase>
              </Paper>
            ))}
          </Box>
          <RecordingsLibrary recordings={recordings} onChanged={() => void refresh()} />
        </>
      )}

      {tab === 'settings' && settings && <RecorderSettingsPanel settings={settings} storage={storage} onUpdate={update} onStorageChanged={() => void refresh()} />}

      {settings && (
        <NewRecordingDialog
          kind={dialog}
          settings={settings}
          storage={storage}
          busy={starting}
          error={null}
          onClose={() => setDialog(null)}
          onStart={choice => void start(choice)}
          onSaveDefaults={patch => void update(patch)}
        />
      )}
    </Stack>
  )
}

export default RecorderPage
