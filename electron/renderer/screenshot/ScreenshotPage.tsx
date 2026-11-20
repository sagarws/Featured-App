import { useState, type ReactNode } from 'react'
import { Alert, Box, Button, ButtonBase, Chip, CircularProgress, IconButton, Paper, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material'
import { ContentCopy, CropFree, DeleteOutline, FolderOpenOutlined, Replay, ScreenshotMonitorOutlined, WebAssetOutlined } from '@mui/icons-material'
import toast from 'react-hot-toast'
import type { AgentState } from '@shared/types/agent'
import type { ScreenshotAction, ScreenshotSettings } from '@shared/types/screenshot'
import { formatAccelerator } from '@shared/utils/screenshot'
import { formatBytes } from '@shared/utils/recorder'
import AdvancedTab from './components/AdvancedTab'
import GeneralTab from './components/GeneralTab'
import HotkeysTab from './components/HotkeysTab'
import UploadTab from './components/UploadTab'
import { useRecentScreenshots, useScreenshotSettings } from './hooks'

type TabId = 'capture' | 'general' | 'hotkeys' | 'upload' | 'advanced'

const CAPTURES: { action: ScreenshotAction; title: string; hint: string; icon: ReactNode; tone: 'primary' | 'info' | 'success' | 'warning' }[] = [
  { action: 'area', title: 'Area', hint: 'Drag over part of the screen', icon: <CropFree sx={{ fontSize: 26 }} />, tone: 'primary' },
  { action: 'fullscreen', title: 'Fullscreen', hint: 'The whole display under the pointer', icon: <ScreenshotMonitorOutlined sx={{ fontSize: 26 }} />, tone: 'info' },
  { action: 'window', title: 'Window', hint: 'Pick any open window', icon: <WebAssetOutlined sx={{ fontSize: 26 }} />, tone: 'success' },
  { action: 'repeatArea', title: 'Repeat area', hint: 'The same area as last time', icon: <Replay sx={{ fontSize: 26 }} />, tone: 'warning' }
]

const timeAgo = (iso: string): string => {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

const Recent = () => {
  const api = window.printAgent.screenshot
  const { files } = useRecentScreenshots()
  const act = async (call: Promise<{ ok: boolean; error?: string }>, done?: string) => {
    const r = await call
    if (!r.ok) toast.error(r.error ?? 'Failed')
    else if (done) toast.success(done)
  }

  return (
    <Paper variant='outlined' sx={{ p: 4, borderRadius: 3 }}>
      <Stack direction='row' alignItems='center' sx={{ mb: 3 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant='h6' sx={{ fontSize: 16, fontWeight: 600 }}>
            Recent screenshots
          </Typography>
          <Typography variant='body2' color='text.secondary'>
            Saved in your screenshots folder. Click one to open it in the editor.
          </Typography>
        </Box>
        <Button size='small' startIcon={<FolderOpenOutlined />} onClick={() => void act(api.openFolder())}>
          Open folder
        </Button>
      </Stack>
      {!files && (
        <Stack alignItems='center' sx={{ py: 6 }}>
          <CircularProgress size={24} />
        </Stack>
      )}
      {files && !files.length && (
        <Typography variant='body2' color='text.secondary' sx={{ py: 4, textAlign: 'center' }}>
          Nothing saved yet. Save from the editor (⌘S / Ctrl+S), or turn on General → After screenshot → Save.
        </Typography>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 2 }}>
        {files?.map(file => (
          <Paper key={file.path} variant='outlined' sx={{ borderRadius: 2, overflow: 'hidden', position: 'relative', '&:hover .actions': { opacity: 1 } }}>
            <ButtonBase onClick={() => void act(api.openFile(file.path))} sx={{ display: 'block', width: '100%' }}>
              <Box
                sx={{
                  height: 120,
                  bgcolor: 'action.hover',
                  backgroundImage: file.thumbnail ? `url("${file.thumbnail}")` : undefined,
                  backgroundSize: 'contain',
                  backgroundPosition: 'center',
                  backgroundRepeat: 'no-repeat'
                }}
              />
            </ButtonBase>
            <Box sx={{ px: 1.5, py: 1 }}>
              <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 500 }} title={file.name}>
                {file.name}
              </Typography>
              <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                {timeAgo(file.modifiedAt)} · {formatBytes(file.size)}
              </Typography>
            </Box>
            <Stack className='actions' direction='row' spacing={0.5} sx={{ position: 'absolute', top: 6, right: 6, opacity: 0, transition: 'opacity .15s' }}>
              {[
                { title: 'Copy', icon: <ContentCopy sx={{ fontSize: 15 }} />, run: () => act(api.copyFile(file.path), 'Copied') },
                { title: 'Show in folder', icon: <FolderOpenOutlined sx={{ fontSize: 15 }} />, run: () => act(api.revealFile(file.path)) },
                { title: 'Move to trash', icon: <DeleteOutline sx={{ fontSize: 15 }} />, run: () => act(api.deleteFile(file.path)) }
              ].map(b => (
                <Tooltip key={b.title} title={b.title}>
                  <IconButton size='small' onClick={() => void b.run()} sx={{ bgcolor: 'rgba(0,0,0,0.6)', color: '#fff', '&:hover': { bgcolor: 'rgba(0,0,0,0.8)' } }}>
                    {b.icon}
                  </IconButton>
                </Tooltip>
              ))}
            </Stack>
          </Paper>
        ))}
      </Box>
    </Paper>
  )
}

/** Screenshots: capture buttons, recent files, and every screenshot setting. */
const ScreenshotPage = ({ state }: { state: AgentState }) => {
  const api = window.printAgent.screenshot
  const { settings, env, update } = useScreenshotSettings()
  const [tab, setTab] = useState<TabId>('capture')
  const mac = env?.platform === 'darwin'

  const set = (patch: Partial<ScreenshotSettings>) =>
    void update(patch).then(error => {
      if (error) toast.error(error)
    })

  const capture = async (action: ScreenshotAction) => {
    const r = await api.capture(action)
    if (!r.ok) toast.error(r.error)
  }

  return (
    <Stack spacing={4} sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ md: 'flex-end' }} spacing={2}>
        <Box sx={{ flex: 1 }}>
          <Typography variant='h4' sx={{ fontSize: 24, fontWeight: 700 }}>
            Screenshots
          </Typography>
          <Typography color='text.secondary' sx={{ fontSize: 14, mt: 0.5 }}>
            Capture, mark up and share. Shortcuts and the {mac ? 'menu bar' : 'tray'} icon work with this window closed.
          </Typography>
        </Box>
        <Tabs value={tab} onChange={(_e, v: TabId) => setTab(v)} variant='scrollable'>
          <Tab value='capture' label='Capture' />
          <Tab value='general' label='General' />
          <Tab value='hotkeys' label='Hotkeys' />
          <Tab value='upload' label='Uploading' />
          <Tab value='advanced' label='Advanced' />
        </Tabs>
      </Stack>

      {env?.platform === 'darwin' && env.screenPermission !== 'granted' && (
        <Alert
          severity='warning'
          action={
            <Button color='inherit' size='small' onClick={() => void api.openScreenPrivacy()}>
              Open settings
            </Button>
          }
        >
          Screen Recording permission is {env.screenPermission.replace('-', ' ')}. macOS asks the first time you take a screenshot; after allowing Featured App, restart it.
        </Alert>
      )}

      {(!settings || !env) && (
        <Stack alignItems='center' sx={{ py: 8 }}>
          <CircularProgress size={28} />
        </Stack>
      )}

      {settings && env && tab === 'capture' && (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 3 }}>
            {CAPTURES.map(c => {
              const keys = settings.hotkeys[c.action]
              return (
                <Paper key={c.action} variant='outlined' sx={{ borderRadius: 3, overflow: 'hidden' }}>
                  <ButtonBase
                    onClick={() => void capture(c.action)}
                    sx={{ width: '100%', height: '100%', p: 3, flexDirection: 'column', alignItems: 'flex-start', gap: 1.5, textAlign: 'start', '&:hover': { bgcolor: 'action.hover' } }}
                  >
                    <Stack direction='row' alignItems='center' sx={{ width: '100%' }}>
                      <Box sx={{ width: 46, height: 46, borderRadius: '50%', display: 'grid', placeItems: 'center', color: `${c.tone}.main`, bgcolor: `var(--mui-palette-${c.tone}-lightOpacity)` }}>{c.icon}</Box>
                      <Box sx={{ flex: 1 }} />
                      {keys && <Chip size='small' label={formatAccelerator(keys, mac)} sx={{ fontWeight: 600, letterSpacing: mac ? 1 : 0 }} />}
                    </Stack>
                    <Box>
                      <Typography sx={{ fontWeight: 600, fontSize: 15, color: 'text.primary' }}>{c.title}</Typography>
                      <Typography variant='body2' color='text.secondary'>
                        {c.hint}
                      </Typography>
                    </Box>
                  </ButtonBase>
                </Paper>
              )
            })}
          </Box>
          <Recent />
        </>
      )}

      {settings && env && tab === 'general' && <GeneralTab settings={settings} env={env} openAtLogin={state.openAtLogin} packaged={state.packaged} onUpdate={set} />}
      {settings && env && tab === 'hotkeys' && <HotkeysTab settings={settings} env={env} onUpdate={set} />}
      {settings && env && tab === 'upload' && <UploadTab upload={settings.upload} env={env} onSave={upload => update({ upload })} />}
      {settings && env && tab === 'advanced' && <AdvancedTab settings={settings} env={env} onUpdate={set} />}
    </Stack>
  )
}

export default ScreenshotPage
