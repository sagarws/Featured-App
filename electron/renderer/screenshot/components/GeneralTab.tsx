import { Box, Button, ButtonBase, Checkbox, FormControlLabel, Radio, RadioGroup, Stack, Typography } from '@mui/material'
import toast from 'react-hot-toast'
import type { ScreenshotEnvironment, ScreenshotSettings, ThumbnailTimeout, WindowBackground } from '@shared/types/screenshot'
import { Choice, Row, Section } from './ui'

const BACKGROUNDS: { id: WindowBackground; label: string; hint: string }[] = [
  { id: 'backdrop', label: 'Backdrop', hint: 'On a gradient' },
  { id: 'transparent', label: 'Transparent', hint: 'With its shadow' },
  { id: 'solid', label: 'Solid colour', hint: 'On your colour' },
  { id: 'trim', label: 'Trim shadow', hint: 'Window only' }
]

const preview = (id: WindowBackground, color: string): string =>
  id === 'backdrop'
    ? 'linear-gradient(135deg, #4353FF, #C084FC)'
    : id === 'solid'
      ? color
      : 'repeating-conic-gradient(rgba(128,128,128,0.25) 0% 25%, transparent 0% 50%) 50% / 12px 12px'

interface Props {
  settings: ScreenshotSettings
  env: ScreenshotEnvironment
  openAtLogin: boolean
  packaged: boolean
  onUpdate: (patch: Partial<ScreenshotSettings>) => void
}

const GeneralTab = ({ settings, env, openAtLogin, packaged, onUpdate }: Props) => {
  const api = window.printAgent.screenshot
  const mac = env.platform === 'darwin'
  const report = (r: { ok: boolean; error?: string }) => {
    if (!r.ok && r.error) toast.error(r.error)
  }

  return (
    <Stack spacing={4}>
      <Section title='Window screenshot background' subtitle='How a captured window is framed when you use “Any window” or “Active window”.'>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' }, gap: 2, py: 1.5 }}>
          {BACKGROUNDS.map(b => {
            const selected = settings.windowBackground === b.id
            return (
              <ButtonBase
                key={b.id}
                onClick={() => onUpdate({ windowBackground: b.id })}
                aria-pressed={selected}
                sx={{ flexDirection: 'column', alignItems: 'stretch', p: 1.25, borderRadius: 2, border: '1.5px solid', borderColor: selected ? 'primary.main' : 'divider', bgcolor: selected ? 'var(--mui-palette-primary-lighterOpacity)' : 'transparent' }}
              >
                <Box sx={{ height: 64, borderRadius: 1.5, background: preview(b.id, settings.backgroundColor), display: 'grid', placeItems: 'center', p: b.id === 'trim' ? 0.5 : 1.5 }}>
                  <Box
                    sx={{
                      width: '100%',
                      height: '100%',
                      borderRadius: 1,
                      bgcolor: '#2a2a32',
                      boxShadow: b.id === 'trim' ? 'none' : '0 4px 12px rgba(0,0,0,0.45)',
                      position: 'relative',
                      '&::before': { content: '""', position: 'absolute', top: 6, left: 7, width: 22, height: 6, background: 'radial-gradient(circle, #FF5F57 2.5px, transparent 3px) 0 0 / 8px 6px repeat-x' }
                    }}
                  />
                </Box>
                <Typography variant='body2' sx={{ fontWeight: 600, mt: 1 }}>
                  {b.label}
                </Typography>
                <Typography variant='caption' color='text.secondary'>
                  {b.hint}
                </Typography>
              </ButtonBase>
            )
          })}
        </Box>
        {settings.windowBackground === 'solid' && (
          <Row title='Background colour'>
            <Box
              component='input'
              type='color'
              value={settings.backgroundColor}
              onChange={e => onUpdate({ backgroundColor: e.target.value.toUpperCase() })}
              sx={{ width: 48, height: 32, p: 0, border: 0, bgcolor: 'transparent', cursor: 'pointer' }}
            />
            <Typography variant='body2' sx={{ fontFamily: 'monospace' }}>
              {settings.backgroundColor}
            </Typography>
          </Row>
        )}
        {!mac && (settings.windowBackground === 'transparent' || settings.windowBackground === 'trim') && (
          <Typography variant='caption' color='text.secondary' sx={{ py: 1 }}>
            On Windows and Linux windows are captured without their shadow, so Transparent and Trim shadow look the same.
          </Typography>
        )}
      </Section>

      <Section title='Saving' subtitle='Where screenshots go when you save them, and in what format.'>
        <Row title='Screenshots folder' hint={env.folder} wide>
          <Button size='small' variant='outlined' onClick={() => void api.chooseFolder().then(report)}>
            Change…
          </Button>
          {settings.folder && (
            <Button size='small' onClick={() => void api.resetFolder().then(report)}>
              Default
            </Button>
          )}
          <Button size='small' onClick={() => void api.openFolder().then(report)}>
            Open
          </Button>
        </Row>
        <Row title='Save format' hint='Auto keeps text and UI as sharp PNG, and saves photo-like pictures as much smaller JPEG.'>
          <RadioGroup row value={settings.saveFormat} onChange={e => onUpdate({ saveFormat: e.target.value as ScreenshotSettings['saveFormat'] })}>
            <FormControlLabel value='png' control={<Radio size='small' />} label='PNG' />
            <FormControlLabel value='auto' control={<Radio size='small' />} label='Auto (PNG/JPEG)' />
            <FormControlLabel value='jpeg' control={<Radio size='small' />} label='JPEG' sx={{ mr: 0 }} />
          </RadioGroup>
        </Row>
        <Row title='Resize Retina screenshots' hint='Halves the size of captures from a high-density (2×) display when saving and uploading.'>
          <FormControlLabel
            control={<Checkbox size='small' checked={settings.downscaleRetina} onChange={e => onUpdate({ downscaleRetina: e.target.checked })} />}
            label='Downscale to 1× when saving'
            sx={{ mr: 0 }}
          />
        </Row>
      </Section>

      <Section title='Startup & after a screenshot'>
        <Row title='Autostart' hint={packaged ? 'Starts quietly in the menu bar when you log in, so shortcuts work right away.' : 'Only available in the installed app.'}>
          <FormControlLabel
            control={
              <Checkbox
                size='small'
                checked={openAtLogin}
                disabled={!packaged}
                onChange={e =>
                  void window.printAgent.setOpenAtLogin(e.target.checked).then(r => {
                    if (!r.ok) toast.error(r.error)
                  })
                }
              />
            }
            label='Launch at startup'
            sx={{ mr: 0 }}
          />
        </Row>
        <Row title='After screenshot' hint='Upload uses the service set on the Uploading tab; its link replaces the picture on the clipboard.'>
          <FormControlLabel control={<Checkbox size='small' checked={settings.afterShow} onChange={e => onUpdate({ afterShow: e.target.checked })} />} label='Show' />
          <FormControlLabel control={<Checkbox size='small' checked={settings.afterCopy} onChange={e => onUpdate({ afterCopy: e.target.checked })} />} label='Copy' />
          <FormControlLabel control={<Checkbox size='small' checked={settings.afterSave} onChange={e => onUpdate({ afterSave: e.target.checked })} />} label='Save' />
          <FormControlLabel
            control={<Checkbox size='small' checked={settings.afterUpload} disabled={settings.upload.provider === 'none'} onChange={e => onUpdate({ afterUpload: e.target.checked })} />}
            label='Upload'
            sx={{ mr: 0 }}
          />
        </Row>
        <Row title='After area capture, show' hint='Fullscreen and window captures always open in the editor when “Show” is on.'>
          <RadioGroup row value={settings.afterAreaShow} onChange={e => onUpdate({ afterAreaShow: e.target.value as ScreenshotSettings['afterAreaShow'] })}>
            <FormControlLabel value='thumbnail' control={<Radio size='small' />} label='Thumbnail' disabled={!settings.afterShow} />
            <FormControlLabel value='editor' control={<Radio size='small' />} label='Editor' disabled={!settings.afterShow} sx={{ mr: 0 }} />
          </RadioGroup>
        </Row>
        <Row title='Hide preview thumbnail'>
          <Choice<ThumbnailTimeout>
            value={settings.thumbnailTimeout}
            options={[
              { value: 5, label: 'After 5 seconds' },
              { value: 10, label: 'After 10 seconds' },
              { value: 30, label: 'After 30 seconds' },
              { value: 0, label: 'Manually (close button)' }
            ]}
            onChange={thumbnailTimeout => onUpdate({ thumbnailTimeout })}
          />
        </Row>
      </Section>
    </Stack>
  )
}

export default GeneralTab
